<!--
@file TC-JOB-008 失速恢复演练记录（真实 Redis）
@description 记录 PRD-007 验收遗留项 TC-JOB-008 的演练设计、排障过程与最终证据；随附演练暴露的
  两个 @fw/queue 框架缺陷修复说明。演练已固化进 scripts/smoke-queue.mjs 阶段 F，可随时复跑。
@author donttemo
@created 2026-10-13
-->

# TC-JOB-008 · BullMQ 失速恢复演练记录

> 日期：2026-10-13 ｜ 结论：**通过** ｜ 环境：远程共享 Redis 8（`docs/archive/database/92-test-databases.md`）+ bullmq 6.3.14 + example-api

## 1. 演练设计

1. 以 `MQ_DRIVER=bullmq + MQ_URL=<真实 Redis> + MQ_PREFIX=<每次运行唯一>` 启动消费进程 A；
2. 派发在途任务 `demo.slow`（handler sleep 8s），等待任务进入执行；
3. 对 A 执行 **SIGKILL**（任务留在 BullMQ active 集合，任务锁随进程死亡，约 30s 后过期）；
4. 以同一 `MQ_PREFIX` 启动消费进程 B，等待失速检测把任务搬回等待区并由 B 完成执行；
5. 断言：任务完成（台账 count=1、tag 匹配）、无死信、任务不丢失。

**恢复窗口实测 ≈ 34s**：任务锁 TTL（lockDuration 默认 30s）+ 失速检测间隔（`MQ_STALLED_MS=1000`）。

## 2. 排障记录（演练暴露的框架缺陷）

初次演练失败：任务滞留 active 集合超过 90s 无人恢复。逐层定位（原生 bullmq Worker 复现对照、
Redis 键 TTL 采样、worker 选项 debug 输出）后确认两个缺陷，均已修复：

| # | 缺陷 | 修复 |
|---|------|------|
| 1 | `QueueService.register()` 未把队列名告知驱动，新消费进程在**首次 dispatch 前**不建消费器、失速检查器不存在——被强杀进程遗留的在途任务永远无人恢复 | `register()` 即调用 `driver.ensureQueue(DEFAULT_QUEUE_NAME)`（默认队列 `default`），B 进程启动期即具备消费器与失速检查器 |
| 2 | `getQueue()` 内回调 `ensureWorker()`，与 `createWorker → getQueue` 形成自递归：`ensureWorker` await 自己未完成的 Promise → **启动期死锁**；且 `ensureWorker` 检查与登记之间存在异步间隙，并发调用会**同队列重复建 3 个消费器** | `getQueue` 去掉 `ensureWorker` 回调（消费器创建统一由 `ensureQueue` / `start()` 负责）；`ensureWorker` 改为「创建中登记 Promise」的并发安全写法 |

## 3. 配套新增

- 新配置键 `MQ_STALLED_MS`（毫秒，默认 30000，0 = 用 bullmq 默认值）：失速检测间隔，演练与运维可调。
  已同步 `env-schema`、`60-deployment-ops.md`、PRD-007、两份 `.env.example`。
- bullmq Worker 增加 `stalled` 事件日志：`检测到失速任务，已搬回等待区重试`（warn，含队列名与 jobId）。
- 演练固化为 `scripts/smoke-queue.mjs` **阶段 F**（`SMOKE_REDIS_URL` 门控，未设置自动跳过），可随时复跑。

## 4. 最终证据

- `apps/example-api/scripts/smoke-queue.mjs` **31/31 通过**（2026-10-13，`SMOKE_REDIS_URL` 指向真实 Redis）：
  - `PASS TC-JOB-008 在途任务执行中被 SIGKILL 强杀（任务留在 Redis，锁随进程死亡）`
  - `PASS TC-JOB-008 失速任务不丢失：搬回等待区后由新进程完成（count=1 tag=stall-0 dead=0）`
- `@fw/queue` 单测 135/135（含 `MQ_STALLED_MS` 解析断言）；`@fw/config` 单测 10/10。
- memory 驱动行为不变：`close()` 返回在途数并放回进程内队列，退出后不持久化（PRD-007 已声明不承诺）。
