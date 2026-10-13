# PRD-007 · 队列与定时任务

> 里程碑：M7 ｜ 状态：草案 ｜ 优先级：P2 ｜ 依赖：M1、M4 ｜ 负责人：待定 ｜ 更新：2026-10-09

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
| FR-04 | 重试与退避 | 默认 3 次，指数退避（1s/5s/30s，可配）；区分可重试异常与终态失败 |
| FR-05 | 幂等 | 支持 `idempotencyKey`，同一 key 在窗口期内只执行一次；提供 `Idempotent` 装饰器 |
| FR-06 | 延时与计划任务 | `dispatch(job, { delay })` 或指定执行时间，用于预约、超时关闭等场景 |
| FR-07 | 死信与重放 | 耗尽重试进 dead-letter 列表；支持查看失败原因、手动重放、批量清理 |
| FR-08 | 并发与限流 | 每队列可配并发数与速率（如 10/s），防止打垮下游 |
| FR-09 | 可观测与管理 | 队列长度、成功率、平均耗时、积压量暴露到 `/metrics`；后台队列管理页（暂停/恢复/重放/清空） |
| FR-10 | 优雅停机 | 停机时等待在途任务完成（超时策略可配），未完成重新入队 |

## 5. 非功能需求（NFR）

- memory 驱动下任务延迟 ≤ 1s；bullmq 下入队到执行 P95 ≤ 3s（无积压）。
- 任务处理必须可重入：崩溃后重启能续跑或重放，不丢任务（bullmq 持久化）。
- 单个任务执行超时默认 60s，超时按失败处理并记录。
- 任务日志带 `jobId` 与 traceId，可独立检索。

## 6. 关键设计

**配置**

```
MQ_DRIVER=memory        # memory | bullmq
MQ_CONCURRENCY=10       MQ_MAX_ATTEMPTS=3
MQ_CRON_ENABLED=true
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

- [ ] 同一份 Job 代码在 memory 与 bullmq 两种驱动下行为一致（切换仅改配置）。
- [ ] 集群 3 实例下，定时任务只在其中 1 个实例执行（分布式锁生效）。
- [ ] 人为让任务抛异常，观察到 3 次指数退避重试后进 dead-letter，且可手动重放成功。
- [ ] 同一 `idempotencyKey` 重复 dispatch，实际只执行一次。
- [ ] 服务重启后，未完成的任务被重新执行，无丢失。
- [ ] 队列积压时按配置限速，下游不被打垮。
- [ ] 后台队列页可查看积压、暂停队列、重放失败任务。

## 8. 依赖与风险

- 依赖 M1（日志/优雅停机）与 M4（分布式锁、Redis）。
- 风险：memory 驱动在重启后丢任务 → 文档明确「memory 仅用于可丢失的轻量任务」。
- 风险：定时任务在容器多副本下重复执行 → 强制默认 `lock: true`，并在启动时校验锁可用性。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| Kafka 适配何时做？ | 接口预留，M8 或按项目需求触发 | 待定 | M8 评审时 |
| 是否需要 DAG 工作流编排？ | 首版不做，用「任务链」（一个 Job dispatch 下一个）替代 | 待定 | M7 评审前 |
