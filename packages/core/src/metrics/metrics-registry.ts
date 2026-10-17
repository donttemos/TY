/*
 * @file 指标段注册表
 * @description M12 W2（PRD-012 OBS-12）：跨包指标段的进程级注册点——各域包（如 @fw/auth 的
 *   fw_auth_* / fw_security_* 段）把自己的 Prometheus 文本渲染器注册进来，由 /metrics 控制器
 *   （@fw/cache）在输出尾部统一追加。设计约束：
 *   - 零依赖、零存储：只做「注册 → 渲染时回调」，不做指标聚合（与 NG12-3 不引 prom-client 一致）；
 *   - 模块级汇（先例：E-12 SSE 模块级 sink）——绕开静态装配点拿不到 DI 的限制，不污染驱动构造签名；
 *   - 段名唯一，后注册覆盖先注册（幂等）。
 * @author donttemo
 * @created 2026-10-17
 * @module core
 */

/** 指标段渲染器：返回 Prometheus 文本段（含 # HELP / # TYPE 与样本行；末尾无空行） */
export type MetricsSectionRenderer = () => string;

/** 已注册段（段名 → 渲染器；模块级单例） */
const sections = new Map<string, MetricsSectionRenderer>();

/**
 * 注册指标段（幂等，后注册覆盖）
 * @param name 段名（如 'auth_security'）
 * @param renderer 渲染器（每次 /metrics 请求时调用）
 */
export function registerMetricsSection(name: string, renderer: MetricsSectionRenderer): void {
  sections.set(name, renderer);
}

/** 注销指标段（测试 / 关闭用） */
export function unregisterMetricsSection(name: string): void {
  sections.delete(name);
}

/**
 * 渲染全部已注册段（按段名字典序，输出稳定）
 * @returns 拼接后的文本（各段间空行分隔；无段时为空串）
 */
export function renderExtraMetricSections(): string {
  if (sections.size === 0) return '';
  const parts: string[] = [];
  for (const name of [...sections.keys()].sort()) {
    const renderer = sections.get(name)!;
    try {
      const text = renderer();
      if (text) parts.push(text);
    } catch {
      // 渲染异常不得拖垮 /metrics 整体输出（该段静默缺席）
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}
