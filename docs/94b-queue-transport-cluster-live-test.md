# E-06 收口：bullmq / transport 在 Redis Cluster 上的实跑实测（2026-10-15）

> 遗留来源：[L-04 实测报告](./94-redis-cluster-live-test.md) §3 划出的范围边界——`@fw/queue`（bullmq）与
> `@fw/transport`（redis）在 Redis Cluster 上的行为未验证（L-04 只覆盖 `@fw/cache`）。
> 本次在真机（`106.55.32.251`，2C2G）以一次性容器拉起真实 6 节点集群实跑收口，**结论：通过**。

## 1. 代码面改动（实测前置）

| # | 改动 | 说明 |
|---|---|---|
| 1 | `@fw/queue` `createBullConnection`：多节点连接串（逗号分隔）→ `ioredis.Cluster` | bullmq 阻塞连接 `maxRetriesPerRequest=null` 语义在 cluster 下保留；单节点走原路径 |
| 2 | `@fw/transport` `createRedisClient`：同上，且保留 `maxRetriesPerRequest=2` 快速失败语义 | transport 的键操作全部**单键**（LPUSH/BLPOP/BRPOP/DEL/EXPIRE 各自独立），cluster 下无 CROSSSLOT 风险，**无需 hash-tag**（与 bullmq 的差异已文档化） |
| 3 | bullmq 驱动启动告警：cluster URL + `MQ_PREFIX` 无花括号 → 可操作 WARN | BullMQ 键族必须同槽（hash-tag），官方约定 prefix 带 `{...}`（如 `{fw:prod}:`） |
| 4 | `smoke-queue.mjs` 阶段 D/F：cluster URL 时自动包 hash-tag + `CACHE_DRIVER=redis-cluster` | cache 单实例客户端对 cluster 节点会收 MOVED 假错误，必须用 redis-cluster 驱动（L-04 已实测） |
| 5 | 单测 4 条：`parseClusterNodes` 解析面（scheme/凭据/缺省端口）+ 两包 Cluster 分支桩 | 真实集群行为由本实测覆盖 |

## 2. 集群环境（一次性，测后即删）

与 [L-04 §1](./94-redis-cluster-live-test.md) 完全同模式：`redis:8.10.2` 单容器 6 节点
（7000–7002 master / 7003–7005 replica，announce 127.0.0.1），`cluster_state:ok`、16384 槽全覆盖；
容器 `fw-redis-cluster-test` 测后 `docker rm -f`，生产 Redis（6379）全程未触碰。

## 3. 框架级实跑（14/14 通过）

> 被测代码 = E-06 提交 `1fe4f8b` 的真机构建产物（`/opt/fw/test-m10e06`，独立测试目录，非发版 current）。
> `SMOKE_REDIS_URL=127.0.0.1:7000,7001,7002`（cluster 多节点形态）。

### 3.1 `@fw/queue` bullmq 驱动（smoke-queue 31/31，其中 cluster 相关）

| 编号 | 断言 | 结果 |
|---|---|---|
| Q1 | bullmq 以 Cluster 客户端连接成功（`/ready` 探针 `checks.queue=ok`，driver=bullmq） | ✅ |
| Q2 | 入队即执行（echo 任务跨槽路由正常，hasTraceId=true） | ✅ |
| Q3 | 失败重试：同一退避序列，attempt=2 成功 | ✅ |
| Q4 | 终态失败不重试（attemptsMade=1），死信面正常 | ✅ |
| Q5 | 队列指标可见（`/api/v1/demo-queue/stats`，driver=bullmq） | ✅ |
| Q6 | **失速恢复演练（TC-JOB-008）**：在途任务执行中 SIGKILL 强杀 → 任务留 Redis → 新消费进程把失速任务搬回等待区并完成（tag 匹配、无死信） | ✅ |
| Q7 | cache 侧同集群健康：`checks.cache=ok`（redis-cluster 驱动，`CACHE_DRIVER=redis-cluster`） | ✅ |
| Q8 | cron 分布式互斥：`distributed=true`（CacheGuardStore 走 cluster，无进程内降级告警） | ✅ |

### 3.2 `@fw/transport` redis 驱动（smoke-transport 17/17，其中 cluster 相关）

| 编号 | 断言 | 结果 |
|---|---|---|
| T1 | 单进程往返 ×5：请求/应答键异槽（无 hash-tag）下 LPUSH→BLPOP 正常 | ✅ |
| T2 | 双进程跨进程调用：A=caller / B=handler，跨进程序列化协议往返 | ✅ |
| T3 | 超时 fail-fast：无处理方时 1500ms 窗口内明确失败（maxRetriesPerRequest=2 语义保留） | ✅ |

### 3.3 hash-tag 语义实证

- 阶段 D/F 带 `{...}:` hash-tag prefix → BullMQ 全键族同槽，多键 Lua（addJob/stalled check）
  全部正常执行（Q2/Q6 即证据）；
- 反向对照：阶段 F 首轮曾用无 hash-tag prefix → 入队静默失败（CROSSSLOT），与启动告警的提示一致，
  佐证「cluster 部署必须 MQ_PREFIX 带 hash-tag」约定的必要性（已文档化于 60 手册 §3）。

## 4. 边界与说明

- **部署口径**：bullmq + cluster 时必须 `MQ_PREFIX={...}:`（框架启动告警兜底）；transport 无此要求。
- **本机沙箱 CI**：cluster 段仍由 `SMOKE_REDIS_URL` 门控（CI 未设置跳过），单节点路径回归不受影响。
- **测试方法学收获**：裸进程起服务时 Prisma 读不到 `process.env.DB_URL`（Prisma v6 client 不自动加载
  cwd/.env），`/ready` 的 db 探针会静默 fail——生产由 systemd `EnvironmentFile` 注入故无此问题；
  实测脚本环境须显式传 `DB_URL`。

## 5. 结论

E-06 **收口**：「大档部署（Redis Cluster）+ 队列/传输持久化」组合从「未评估」变为「有实测依据」——
bullmq（带 hash-tag 约定）与 transport（无附加要求）在真实 6 节点集群上的入队/消费/重试/失速恢复/
跨进程调用/超时语义全部符合 PRD-007/008 定义。框架「切换只改 .env」承诺扩展到 cluster 形态成立。
