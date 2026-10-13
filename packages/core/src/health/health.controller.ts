/*
 * @file 健康检查与就绪探针
 * @description /health 只探进程存活（不依赖任何外部组件）；/ready 逐项执行注册的就绪探针（DB/Redis 等由 M2/M4 注册），任一失败返回 503，供负载均衡摘流量。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';

/** 就绪探针注册 token（M2/M4 通过 provider 注入 DB/Redis 探针） */
export const READINESS_PROBES = Symbol('READINESS_PROBES');

/** 单个就绪探针定义 */
export interface ReadinessProbe {
  /** 探针名（展示用，如 db / redis） */
  name: string;
  /** 探测函数：返回 true/ok 表示就绪；抛异常或 false 视为不可用 */
  check: () => Promise<boolean>;
}

/** /ready 响应体 */
interface ReadyBody {
  status: 'ok' | 'fail';
  checks: Record<string, 'ok' | 'fail'>;
}

/**
 * 运维端点：存活与就绪探针（公开访问，不走统一响应包装）
 */
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_PROBES) private readonly probes: ReadinessProbe[]) {}

  /**
   * 存活探针：进程在即返回 ok
   * @returns 固定 JSON：{ status, uptime }
   */
  @Get('/health')
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * 就绪探针：逐项执行注册探针，任一失败即 503
   * @param res HTTP 响应（按结果写状态码）
   * @returns 逐项状态 JSON
   */
  @Get('/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyBody> {
    const checks: Record<string, 'ok' | 'fail'> = {};
    let allOk = true;
    // 顺序执行保证输出稳定；探针自身必须带超时（工程规范 §1.1）
    for (const probe of this.probes) {
      try {
        checks[probe.name] = (await probe.check()) ? 'ok' : 'fail';
      } catch {
        checks[probe.name] = 'fail';
      }
      if (checks[probe.name] !== 'ok') allOk = false;
    }
    res.status(allOk ? 200 : 503);
    return { status: allOk ? 'ok' : 'fail', checks };
  }
}
