/*
 * @file TelemetryService：链路追踪生命周期编排
 * @description 启用时在模块初始化期完成 SDK 装配（懒加载 optional peer）：
 *   注册日志 span 桥接 → 校验导出端点 → 构造 NodeTracerProvider（资源含 service.name）→
 *   挂载尾采样处理器 → register 全局 tracer provider 与 W3C 传播器。
 *   停机时 shutdown（flush 后释放）。未启用时全部动作短路，零开销。
 *
 *   时序说明：SDK 在 onModuleInit 装配，早于 listen 与首个请求；其他模块初始化期
 *   极少数早于本模块的 span 会因 SDK 未就绪而丢失（非记录 span），属可接受取舍。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 updateRuntimeOptions——采样比例经共享引用热更即时生效（处理器 onEnd 逐次读取）
 * @module @fw/telemetry
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Logger } from '@fw/logger';
import { TelemetryConfigError } from './errors.js';
import { loadOtelSdk, loadOtlpExporter, type NodeTracerProviderLike, type OtlpTraceExporterLike } from './otel-loader.js';
import { RatioErrorSamplingProcessor } from './sampling.js';
import { registerLoggerSpanBridge } from './span-bridge.js';
import { TELEMETRY_OPTIONS } from './tokens.js';
import type { TelemetryRuntimeOptions } from './types.js';

/** 服务版本（与框架版本对齐；采集端可按版本筛选回归） */
const SERVICE_VERSION = '0.1.0';

const logger = Logger.for('telemetry');

/**
 * 链路追踪服务（生命周期编排）
 */
@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private provider?: NodeTracerProviderLike;
  private started = false;

  /** 尾采样处理器持有的可变采样选项（同一引用——热更 sampleRatio 即时生效，PRD-009 FR-09） */
  private readonly samplingOptions: { sampleRatio: number; sampleErrors: boolean };

  /**
   * @param options 运行时配置（TelemetryModule.forRoot 解析后注入）
   */
  constructor(@Inject(TELEMETRY_OPTIONS) private readonly options: TelemetryRuntimeOptions) {
    this.samplingOptions = { sampleRatio: options.sampleRatio, sampleErrors: options.sampleErrors };
  }

  /** 是否已启用（SDK 装配成功） */
  get enabled(): boolean {
    return this.started;
  }

  /** 运行时配置（诊断用） */
  get runtimeOptions(): TelemetryRuntimeOptions {
    return this.options;
  }

  /**
   * 运行时更新采样比例（M9/PRD-009 FR-09：由配置中心 onChange 订阅调用，禁止业务侧自行轮询）。
   * 尾采样处理器每次 onEnd 都读取 samplingOptions 引用字段，热更即改即生效；
   * 未启用（OTEL_ENABLED=false）时仅同步记录，SDK 未装配无生效面。
   * @param patch 待更新字段（采样比例）
   */
  updateRuntimeOptions(patch: { sampleRatio?: number }): void {
    if (patch.sampleRatio !== undefined) {
      this.samplingOptions.sampleRatio = patch.sampleRatio;
      this.options.sampleRatio = patch.sampleRatio;
      logger.info('链路追踪采样比例已热更', { sampleRatio: patch.sampleRatio, enabled: this.started });
    }
  }

  /**
   * 模块初始化：装配 SDK（启用时）
   * @throws TelemetryConfigError 启用后缺导出端点
   * @throws TelemetryUnavailableError SDK / 导出器未安装
   */
  async onModuleInit(): Promise<void> {
    if (!this.options.enabled) {
      logger.debug('链路追踪未启用（OTEL_ENABLED=false）');
      return;
    }
    // 配置守卫：启用即要求端点可达语义明确（缺端点启动失败，不静默丢span）
    if (!this.options.exporterUrl) {
      throw new TelemetryConfigError(
        'OTEL_ENABLED=true 时必须配置 OTEL_EXPORTER_URL（如 http://otel-collector:4318/v1/traces）',
      );
    }
    // 日志桥接先注册：SDK 装配期间的日志即可携带活跃 span ID
    registerLoggerSpanBridge();

    const sdk = await loadOtelSdk();
    const exporterModule = await loadOtlpExporter();
    const exporter: OtlpTraceExporterLike = new exporterModule.OTLPTraceExporter({
      url: this.options.exporterUrl,
    });

    // 尾采样处理器：错误全采 + traceId 确定性比例（同链路跨服务决策一致）。
    // 传入 samplingOptions 本体（非拷贝）：onEnd 每次读引用字段，配置中心热更即改即生效
    const processor = new RatioErrorSamplingProcessor(exporter, this.samplingOptions);

    // 资源属性：service.name 是采集端按服务聚合的最小必需字段
    const resource = sdk.resources?.resourceFromAttributes
      ? sdk.resources.resourceFromAttributes({
          'service.name': this.options.serviceName,
          'service.version': SERVICE_VERSION,
        })
      : undefined;

    // 0.223 起处理器经构造配置注入（addSpanProcessor 方法已移除）
    const provider = new sdk.node.NodeTracerProvider({
      ...(resource ? { resource } : {}),
      spanProcessors: [processor],
    });

    // 显式注册 W3C traceparent + baggage 组合传播器：register() 不装默认传播器（实测 0.223），
    // 不注册则跨进程 inject/extract 静默变 no-op，traceId 贯通失效。
    // register({ propagator }) 是 SDK 官方注册通道（内部即 setGlobalPropagator）
    const w3c = sdk.core?.W3CTraceContextPropagator;
    const baggage = sdk.core?.W3CBaggagePropagator;
    const composite = sdk.core?.CompositePropagator;
    const propagator: unknown = w3c
      ? baggage && composite
        // 注意：CompositePropagator 收配置对象 { propagators }，位置参数数组会被静默忽略（实测 0.223）
        ? new composite({ propagators: [new w3c(), new baggage()] })
        : new w3c()
      : undefined;

    provider.register(propagator ? { propagator } : {});
    this.provider = provider;
    this.started = true;
    logger.info('链路追踪已启用', {
      service: this.options.serviceName,
      exporterUrl: this.options.exporterUrl,
      sampleRatio: this.options.sampleRatio,
      sampleErrors: this.options.sampleErrors,
    });
  }

  /**
   * 模块销毁：flush 在途 span 后关闭 provider
   */
  async onModuleDestroy(): Promise<void> {
    const provider = this.provider;
    this.provider = undefined;
    this.started = false;
    if (!provider) return;
    try {
      await provider.shutdown();
      logger.info('链路追踪已停机（在途 span 已 flush）');
    } catch (error) {
      // 停机路径不得因 flush 失败而中断优雅停机
      logger.warn('链路追踪停机时 flush 失败', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
