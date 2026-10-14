<!--
@file 规模化上线自检清单（PRD-008 FR-10）
@description 上线前逐项自检：连接池、缓存击穿、队列积压、慢 SQL、N+1、日志采样率、容量与降级。
  每项给出「检查点 / 框架对应配置或端点 / 达标口径」，可直接作为发布前门禁清单使用。
@author donttemo
@created 2026-10-14
-->

# 规模化上线自检清单（CheckList）

> 适用：基于本框架构建的项目，从「能跑」升到「扛得住」时的上线前自检。
> 配套：[部署与运维手册](./60-deployment-ops.md) ｜ [压测基线](./97-bench-baseline.md) ｜ [验收标准](./10-acceptance-criteria.md)

## 1. 数据库与连接池

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 1.1 | 连接池上限与实例数匹配 | `DB_POOL_MAX`（默认 10） | `DB_POOL_MAX × 实例数 < 数据库 max_connections`，留 20% 余量 |
| 1.2 | 慢查询阈值设置合理 | `DB_SLOW_MS`（默认 500，最小 10） | 生产 200–500；低于 100 会产生噪声告警 |
| 1.3 | 依赖就绪探针接入编排 | `GET /ready` 的 `checks.db` | 编排 readinessProbe 指向 `/ready`；DB 不可用时 503 摘流量 |
| 1.4 | 分页查询走索引 | Repository `pageItems` | 目标：单表 100 万行 P95 ≤ 200ms（见压测基线 §3） |
| 1.5 | 无 N+1 查询 | Repository 契约（无裸 SQL，走 `@fw/db`） | 列表接口的 SQL 条数与返回行数无关（一次 `findMany` + 一次 `count`） |
| 1.6 | 迁移单点执行 | `pnpm db:migrate` + 迁移锁 | 迁移只在一个实例执行；禁止手工改库结构 |
| 1.7 | 生产禁用 SQLite | `DB_DRIVER` | 生产用 `mysql` / `postgres`；SQLite 仅本地与测试 |

## 2. 缓存

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 2.1 | 缓存驱动为外部实例 | `CACHE_DRIVER=redis`（多实例必须） | memory 驱动只在单实例下可用，多副本会数据不一致 |
| 2.2 | 降级策略明确 | `CACHE_FAIL_OPEN`（默认 true） | true：依赖故障直查（可用性优先）；false：抛 9002（一致性优先） |
| 2.3 | 缓存穿透防护 | 空值占位 `CACHE_NULL_TTL`（默认 60s） | 不存在的 key 命中占位，不打穿 DB |
| 2.4 | 缓存击穿防护 | 单飞 `wrap` | 并发打同一热点 key，回源次数 = 1 |
| 2.5 | 缓存雪崩防护 | `CACHE_TTL_JITTER`（默认 0.1） | 大批 key 不同时过期 |
| 2.6 | 大 key 防护 | `CACHE_MAX_VALUE_BYTES`（默认 1MB） | 超限拒绝写入并告警 |
| 2.7 | 命中率可观测 | `GET /metrics` 的 `fw_cache_*` | 持续 30 分钟命中率 < 80% 需排查 |
| 2.8 | 多环境键空间隔离 | `CACHE_PREFIX`（默认 `fw:<APP_ENV>`） | 不同环境 / 不同应用前缀必须不同 |
| 2.9 | 分布式锁可用 | `CACHE_LOCK_TTL`；多实例 cron 依赖 | 定时任务在多副本下只跑一次 |

## 3. 队列与定时任务

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 3.1 | 驱动选型与持久性匹配 | `MQ_DRIVER`（memory / bullmq） | 需重启恢复的任务必须 `bullmq` + Redis 持久化；memory 不承诺跨进程 |
| 3.2 | 并发与限速按容量设置 | `MQ_CONCURRENCY` / `MQ_RATE_LIMIT` | 单实例并发 × 实例数 ≤ 下游承载上限 |
| 3.3 | 重试与死信可观测 | `MQ_MAX_ATTEMPTS` / `MQ_BACKOFF` / `MQ_DEAD_LETTER_MAX` | 死信可查询、可重放；死信持续增长需告警 |
| 3.4 | 积压指标接入告警 | `GET /metrics/queue` 的 `fw_queue_backlog` | 积压 > 1000 或持续增长 10 分钟即告警 |
| 3.5 | 定时任务单点执行 | `MQ_CRON_ENABLED` + Redis 分布式锁 | 副本扩容后 cron 不重复执行 |
| 3.6 | 任务幂等 | `@Idempotent` + `idempotencyKey` | 重复投递不产生重复副作用 |
| 3.7 | 优雅停机 | `MQ_SHUTDOWN_TIMEOUT`（默认 30s） | 停机时在途任务不丢（bullmq 交失速检测恢复） |
| 3.8 | 失速检测间隔合理 | `MQ_STALLED_MS`（默认 30000） | 消费进程被强杀后的恢复窗口 ≈ lockDuration + 该值 |

## 4. 多租户

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 4.1 | 租户开关与解析顺序 | `TENANT_ENABLED` / `TENANT_ORDER` | 单租户场景保持 false（零开销短路） |
| 4.2 | fail-closed 生效 | Repository 强制租户条件 | 缺失上下文时拒绝查询，绝不返回全量 |
| 4.3 | 跨租户越权用例通过 | `smoke-tenant.mjs` 阶段 A/D | 越权请求 403/4001 或 3002 |
| 4.4 | dedicated 独立库密钥 | `TENANT_DB_KEY` | 生产必须显式配置；轮换需重写 `db_url_enc` |
| 4.5 | 租户元数据缓存延迟可接受 | `TENANT_CACHE_TTL`（默认 60s） | 停用/换库生效延迟 ≤ 一个 TTL |

## 5. 传输与链路追踪

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 5.1 | 传输驱动与拓扑匹配 | `TRANSPORT_DRIVER` / `TRANSPORT_ROLE` | 单体 `in-process`；拆分后 `redis` 并按进程裁剪角色 |
| 5.2 | 连接串启动期可达 | `TRANSPORT_URL`（缺省回退 `CACHE_URL`） | 不可达则启动失败（fail-fast），不带病上线 |
| 5.3 | 调用超时设置合理 | `TRANSPORT_TIMEOUT_MS` | 小于上游网关超时，避免级联等待 |
| 5.4 | 追踪开关与采样率 | `OTEL_ENABLED` / `OTEL_SAMPLE_RATIO`（默认 0.1） | 高 QPS 下调低采样率或下沉到 Collector；错误链路全采（`OTEL_SAMPLE_ERRORS`） |
| 5.5 | 采集端可达性 | `OTEL_EXPORTER_URL` | 采集端不可达只丢 span，业务不受影响；但需监控导出失败率 |
| 5.6 | traceId 全链路贯通 | `X-Trace-Id` 响应头 + 日志字段 | HTTP / DB / 缓存 / 队列 / 传输均带同一 traceId |

## 6. 日志与可观测

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 6.1 | 结构化日志格式 | `LOG_FORMAT=json`（容器环境固定） | 字段固定：`time/level/traceId/spanId/module/msg/ctx` |
| 6.2 | 日志级别与采样 | `LOG_LEVEL` | 生产 `info`；高频路径避免 `debug` |
| 6.3 | 敏感字段脱敏 | `@fw/logger` 内置脱敏 | 密码 / 令牌 / 身份证在日志与响应中不可见 |
| 6.4 | 单条日志大小限制 | 框架自动截断（≤ 8KB） | 防大对象打爆日志通道 |
| 6.5 | 健康检查与指标 | `/health` `/ready` `/metrics` `/metrics/queue` | 编排与监控均已接入 |
| 6.6 | 告警规则就位 | 见部署手册 §9 指标表 | 5xx 率、P95、命中率、队列积压、慢查询、降级计数、磁盘/内存/CPU、证书到期 |

## 7. 部署与容量

| # | 检查点 | 框架对应 | 达标口径 |
|---|---|---|---|
| 7.1 | 应用无状态 | 会话走 JWT/Redis，上传走对象存储 | 多副本行为一致；本机不落状态 |
| 7.2 | 滚动更新零中断 | Helm `maxUnavailable=0` / `maxSurge=1` + PDB | 发布期间可用副本不低于 minAvailable |
| 7.3 | 资源 requests/limits 已设 | Helm `resources` | 避免节点资源争抢与 OOM 驱逐 |
| 7.4 | 副本数与 HPA 匹配 | Helm `replicaCount` / `autoscaling` | 最小 3；HPA 上限按容量评估 |
| 7.5 | 优雅停机宽限期 | Helm `app.terminationGracePeriodSeconds` ≥ 队列/传输停机超时 | 默认 45s，需 > `MQ_SHUTDOWN_TIMEOUT` |
| 7.6 | 密钥外部注入 | Helm `secrets.existingSecret` | 禁止写入 values 文件或镜像 |
| 7.7 | 备份与恢复演练 | 部署手册 §8 | 每日全量 + 增量；每季度恢复演练并记录 RTO/RPO |
| 7.8 | 压测基线已建立 | `apps/example-api/scripts/bench.mjs` | 登录 / 列表 / 写入三类场景均有 QPS 与 P95 记录 |

## 8. 上线前最终门禁

- [ ] `pnpm lint` + `pnpm build` + 全量单测通过
- [ ] 三库集成矩阵通过（MySQL / PostgreSQL / SQLite）
- [ ] `node scripts/drill-m8.mjs` 三大演练通过（关键路径）
- [ ] `node scripts/check-helm-chart.mjs` Chart 清单校验通过
- [ ] 安全基线全绿（越权 / 重放 / 篡改 / 爆破 / 注入 / 脱敏 / 密钥 / 传输 / 依赖）
- [ ] `pnpm audit --prod` 无高危
- [ ] 性能基线数值已记录并与上一版对比无退化
- [ ] 部署手册 Runbook 与值班清单已同步
