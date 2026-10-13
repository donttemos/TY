# PRD-007 · 队列与定时任务

> 里程碑：M7 ｜ 状态：**实现完成，重启恢复验收通过（2026-10-13，未发版）** ｜ 优先级：P2 ｜ 依赖：M1、M4 ｜ 负责人：donttemo ｜ 更新：2026-10-13
>
> 变更记录：2026-10-13 donttemo M7 实现交付并新增实现记录（§10），Kafka 保持接口预留（M8 触发）；文档复核后将重启恢复 AC 调整为待演练，不以停机单测替代进程重启证据。
> 变更记录：2026-10-13 donttemo TC-JOB-008 真实 Redis 失速恢复演练通过（smoke-queue 阶段 F），新增 `MQ_STALLED_MS` 失速检测间隔配置；M3 遗留④ refresh 过期清理任务落地（`auth.refresh-cleanup`）。

## 1. 背景与目标

中型以上系统必然出现异步需求（发通知、导出报表、数据同步、定时结算）。若没有统一抽象，小系统用 `setInterval`、大系统用 Kafka，代码又要重写一次。

目标：提供统一的 Job 抽象与定时调度，小系统进程内执行、中大型系统切到 Redis 队列 / Kafka，业务代码不变。

衡量：同一份 Job 代码在 `MQ_DRIVER=memory|bullmq` 两种模式下均可运行（`kafka` 仅预留接口与配置位，见 ADR 与范围说明）。

## 2. 范围

**做**：统一 Job 接口、多驱动（memory / bullmq）、定时任务（cron）、重试与退避、幂等支持、延时任务、失败 dead-letter 与告警、队列状态查看、分布式锁防重复调度（与 PRD-004 联动）。

**不做**：Kafka 首发实现（仅预留适配接口与配置位）、流式计算、复杂工作流编排（DAG）。

## 3. 用户故事

- 作为开发，我定义一个 Job 类并调用 `queue.dispatch(job)`，不关心底层是谁在执行。
- 作为开发，我用 `@Cron('0 2 * * *')` 声明定时任务，集群部署时只跑一次。
- 作为运维，任务失败会自动重试并在多次失败后进 dead-letter，我能看到并手动重放。
- 作为开发，导出大报表是异步的，前端拿任务 ID 轮询进度。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 统一 Job 接口 | `Job` 含 `name / payload / options(attempts, backoff, delay, idempotencyKey)`；处理器实现 `handle(payload, ctx)` |
| FR-02 | 驱动适配 | `memory`（进程内，小系统零依赖）、`bullmq`（Redis，中大型）；`kafka` 预留接口与配置位，M8 落地 |
| FR-03 | 定时任务 | `@Cron(expr, { lock: true })` 或配置式 cron 列表；默认加分布式锁，集群内只执行一次 |
| FR-04 | 重试与退避 | 默认最多执行 4 次（含首次），重试等待 1s/5s/30s（可配）；区分可重试异常与终态失败 |
| FR-05 | 幂等 | 支持 `idempotencyKey`，同一 key 在窗口期内只执行一次；提供 `Idempotent` 装饰器 |
| FR-06 | 延时与计划任务 | `dispatch(job, { delay })` 或指定执行时间，用于预约、超时关闭等场景 |
| FR-07 | 死信与重放 | 耗尽重试进 dead-letter 列表；支持查看失败原因、手动重放、批量清理 |
| FR-08 | 并发与限流 | 每队列可配并发数与速率（如 10/s），防止打垮下游 |
| FR-09 | 可观测与管理 | 队列长度、成功率、平均耗时、积压量暴露到 `/metrics`；后台队列管理页（暂停/恢复/重放/清空） |
| FR-10 | 优雅停机 | 停机时等待在途任务完成（超时策略可配）；memory 超时重新放回进程内队列但退出后不持久化，bullmq 由 Redis 和失速检测恢复 |

## 5. 非功能需求（NFR）

- memory 驱动下任务延迟 ≤ 1s；bullmq 下入队到执行 P95 ≤ 3s（无积压）。
- 任务处理必须可重入：崩溃后重启能续跑或重放，不丢任务（bullmq 持久化）。
- 单个任务执行超时默认 60s，超时按失败处理并记录。
- 任务日志带 `jobId` 与 traceId，可独立检索。

## 6. 关键设计

**配置**

```
MQ_DRIVER=memory        # memory | bullmq
MQ_CONCURRENCY=10       MQ_MAX_ATTEMPTS=4  # 含首次，最多重试 3 次
MQ_CRON_ENABLED=true    MQ_STALLED_MS=30000  # bullmq 失速检测间隔（毫秒）
```

**用法**

```ts
@JobHandler('order.timeout')
export class OrderTimeoutJob implements Job<{ orderId: string }> {
  async handle(p: { orderId: string }) { ... }
}

await this.queue.dispatch('order.timeout', { orderId }, { delay: '30m', idempotencyKey: orderId });

@Cron('0 2 * * *', { lock: true })
async dailySettle() { ... }
```

**失败处理链路**：失败 → 记录原因 → 退避重试 → 耗尽 → dead-letter → 告警（日志 + 可选 webhook）。

## 7. 验收标准（AC）

> 八条中八条已验收（2026-10-13）。现有证据：`@fw/queue` 单测 135/135（覆盖率 93.1%/86.6%，门禁 85/85/65/85）、`apps/example-api/scripts/smoke-queue.mjs` **31/31**（含真实 Redis 的 bullmq 阶段与失速恢复演练阶段 F）、`apps/admin-web` mock 冒烟 57/57。

- [x] 同一份 Job 代码在 memory 与 bullmq 两种驱动下行为一致（切换仅改配置）。—— AC-001：同一套退避序列（bullmq 经 `settings.backoffStrategy` 复用任务内序列）；冒烟阶段 A / D 用同一组 demo 任务在两驱动下断言一致行为，切换仅改 `MQ_DRIVER`。
- [x] 集群 3 实例下，定时任务只在其中 1 个实例执行（分布式锁生效）。—— TC-JOB-002：单测用三个调度器共享同一守卫存储断言 `runs=1 / lockedOut=2`；锁复用 `@fw/cache` CacheService（redis 驱动天然分布式），HTTP 层无法在同一进程内制造多副本，故以单测承载。
- [x] 人为让任务抛异常，观察到按配置序列退避重试后进 dead-letter，且可手动重放成功。—— TC-JOB-003/004/005：默认最多重试 3 次（1s/5s/30s）；memory 与 bullmq 双驱动单测 + 冒烟（失败 2 次退避后成功、`PermanentJobError` 不重试直接死信、重放接口返回成功且重新执行）。
- [x] 同一 `idempotencyKey` 重复 dispatch，实际只执行一次。—— TC-JOB-006：单测（显式键 / 载荷哈希键 / 失败不置位）+ 冒烟（两次派发 count=1、`idempotentSkipped≥1`、不同键互不影响）。
- [x] 使用 bullmq 时，服务重启后未完成的任务可恢复；memory 不承诺重启不丢。—— TC-JOB-008：真实 Redis 演练通过（smoke-queue 阶段 F，2026-10-13）：在途任务执行中 SIGKILL 消费进程，重启后由失速检测搬回等待区并完成（恢复窗口 ≈ lockDuration 30s + MQ_STALLED_MS 检测间隔），任务不丢失、无死信。演练同时暴露并修复两个框架缺陷：① `register()` 未把默认队列告知驱动，新消费进程在首次 dispatch 前不建消费器、失速检查器不存在（在途任务永远无人恢复）；② `getQueue → ensureWorker` 自递归死锁与同队列重复建 3 个消费器的并发竞态。
- [x] 队列积压时按配置限速，下游不被打垮。—— TC-JOB-007：令牌桶限速冒烟（`MQ_RATE_LIMIT=5` 下 10 任务耗时 1045ms ≥ 800ms）+ 并发上限冒烟（`MQ_CONCURRENCY=2` 下峰值 ≤ 2）；双驱动单测覆盖。
- [x] 后台队列页可查看积压、暂停队列、重放失败任务。—— T-M7-06：`/system/queue` 页（积压总览/暂停恢复/死信重放与清理/cron 手动触发），mock 冒烟 17 项断言含 `system:queue:*` 双向越权拦截；生产端点 `/api/v1/admin/queue/*` 受 RBAC 保护（冒烟断言未携带凭证返回 401）。

## 8. 依赖与风险

- 依赖 M1（日志/优雅停机）与 M4（分布式锁、Redis）。
- 风险：memory 驱动在重启后丢任务 → 文档明确「memory 仅用于可丢失的轻量任务」。
- 风险：定时任务在容器多副本下重复执行 → 默认 `lock: true`；使用进程内守卫时启动期告警，多副本部署须配置 Redis 守卫。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| Kafka 适配何时做？ | 接口预留（`JobDriverName` 保留 `kafka` 字面量，`QueueModule` 工厂对非法值启动即报错），M8 或按项目需求触发 | donttemo | M8 评审时 |
| 是否需要 DAG 工作流编排？ | 首版不做，用「任务链」（一个 Job dispatch 下一个）替代 | donttemo | M7 评审前（结论：不做） |

## 10. 实现记录（2026-10-13）

- 交付物：`packages/queue`（`@fw/queue`，单测 135 / 覆盖率 lines 94.96% / branches 86.57%）、`docs/contracts/queue.ts`（C-08）、example-api `demo-queue` 模块与 `scripts/smoke-queue.mjs`（27/27）、admin-web `/system/queue` 页与 mock `/admin/queue/*`（冒烟 57/57）、CI M7 步骤。
- 配置：11 个 `MQ_*` 键（`@fw/config` env-schema），bullmq 缺 `MQ_URL` 回退 `CACHE_URL`；切换驱动业务代码 diff = 0。
- 自研组件：cron 表达式解析（`Intl` 时区）、memory 驱动（单定时器 pump + 令牌桶）、执行守卫存储端口（幂等标记 + 分布式锁，复用 CacheService）。
