<!--
@file 修复项登记：/ready 的 db 就绪探针非实时（启动期一次性标志）
@description 独立登记，**不与 Redis 双节点验收混在一起**（后者是缓存/锁/令牌一致性验证，已 20/20 通过）。
  本文只跟踪「数据库 readiness 探针语义」这一个问题：现象、证据、根因、建议修法与验收标准。
@author donttemo
@created 2026-10-18
-->

# 修复项：`/ready` 的 db 就绪探针是启动期一次性标志，不是实时探测

- 状态：**待修**（2026-10-18 登记；双节点实测中暴露，独立于 Redis 验收项）
- 优先级：P2（不影响正确性；影响运维观测可信度与故障自愈判定）
- 关联：`packages/db/src/observability.ts`（`createDbReadinessProbe`）、`packages/core/src/health/health.controller.ts`（探针注册与 `/ready` 渲染）

## 1. 问题

`/ready` 的 `db` 探针返回的是**启动期一次性的 `connected` 布尔**，而非实时连通性：

```ts
// packages/db/src/observability.ts
export function createDbReadinessProbe(provider: string, slowQueryThresholdMs: number) {
  let connected = false;
  return {
    name: 'db',
    check: async (): Promise<boolean> => connected,   // ← 直接返回启动期标志
    markConnected(): void { connected = true; },      // ← 仅 DbModule 启动连接成功时调用一次
    ...
  };
}
```

两个方向的失真：

| 方向 | 现象 | 后果 |
|---|---|---|
| 启动时 DB 不可达 | 即使随后 DB 恢复、SQL 实际可用，`/ready` **永久** `db:fail` | K8s/探针会持续摘流量；必须重启进程才恢复（真机实测复现） |
| 运行期 DB 断连 | `markConnected` 已置位且不再更新，`/ready` 仍报 `db:ok` | 故障期间 readiness 谎报健康，流量继续打进连不上库的实例 |

同场景下 cache / queue / transport 探针是**实时 ping**（真机实测：隧道中断时 A 的 `/ready` 正确报 `cache:fail`），唯独 db 是标志位——语义不一致。

## 2. 证据（2026-10-18 真机双节点实测，A=Windows 经 SSH 隧道）

1. A 在隧道断开瞬间启动 → db 连接失败 → 隧道恢复后 SQL 实际可用（`SELECT 1` 直连成功、业务登录成功），`/ready` 仍 `db:fail`；重启 A 后才恢复 `ok`。
2. 隧道中断后 A 的 `/ready` 输出 `{"db":"ok","cache":"fail"}`——db 报 ok 但 PG 端口实际不可达（cache 探针如实报 fail），证明该标志不反映实时状态。

## 3. 建议修法

在 `createDbReadinessProbe` 内改为**带超时的实时探测**（与 cache 探针对齐）：

- 注入一个轻量 `ping()`（`SELECT 1`，或 `$queryRaw\`SELECT 1\``），`check()` 每次调用执行并加 1~2s 超时；
- 连续失败 N 次才翻 `fail`（防慢查询抖动误报），成功后立即回 `ok`；
- 保留 `markConnected()` 作为启动期标记（观测用），但 `check()` 不再直接读它；
- 补充单测：启动失败→恢复→check 转 ok；运行期断连→check 转 fail；慢查询不误判（超时边界）。

验收标准：`/ready` 的 db 项在「启动时不可达后恢复」「运行期断连」两种时序下均在 N 秒内反映真实状态；既有 health 契约测试不回退。

## 4. 边界（明确不混入本项）

- Redis 双节点验收（缓存共享/标签失效/锁互斥/令牌一致性）已于 `c192885` 真机 20/20 通过，记录见《Redis 多实例测试.md》§12；**本修复项不依赖也不阻塞那一项**。
- 本项不改任何契约/API，仅 readiness 语义修正。
