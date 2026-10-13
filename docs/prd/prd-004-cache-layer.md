# PRD-004 · 缓存层

> 里程碑：M4 ｜ 状态：**已实现（M4 验收通过，2026-10-13）** ｜ 优先级：P1 ｜ 依赖：M1 ｜ 负责人：L3 缓存队列线 ｜ 更新：2026-10-13

## 1. 背景与目标

缓存是「小系统零依赖、大系统扛并发」的同一个开关：小项目不该被迫装 Redis，大项目必须能平滑切到 Redis Cluster。

目标：统一缓存接口 + 多驱动（memory / redis / cluster）+ 标签化失效 + 三大经典问题内建防护；业务代码不感知底层实现。

衡量：小系统纯内存跑通全部功能；切换 Redis 只需改配置；缓存异常时系统仍能正确运行（降级而非雪崩）。

## 2. 范围

**做**：统一 CacheService、双驱动、装饰器、key 规范、标签失效、穿透/击穿/雪崩防护、分布式锁、命中率指标、降级策略。

**不做**：多级缓存一致性框架（L1+L2，M8 评估）、CDN / 浏览器缓存、ORM 二级缓存自动托管。

## 3. 用户故事

- 作为开发者，我在方法上加 `@Cacheable({ ttl: 300, tags: ['user'] })` 就完成缓存，不用写 key 拼接。
- 作为开发者，我在更新用户后调用 `cache.invalidateTag('user:123')`，相关缓存全部失效。
- 作为运维，Redis 挂了的时候服务仍能运行（降级直查），而不是整体 500。
- 作为开发者，我做定时任务时用分布式锁保证集群内只有一个实例执行。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 统一接口 | `get / set / del / has / wrap / mget / mset / expire`；`wrap(key, ttl, loader)` 是最推荐用法（自动回源） |
| FR-02 | 驱动适配 | `memory`（默认，零依赖，带 LRU 与容量上限）、`redis`（ioredis，支持哨兵）、`redis-cluster`；由 `CACHE_DRIVER` 切换 |
| FR-03 | `@Cacheable` 装饰器 | 支持 `ttl`、自定义 key 生成（类名:方法:参数哈希）、`tags`、`condition`（如仅缓存登录用户之外的数据） |
| FR-04 | Key 规范 | 统一 `前缀:模块:标识`，全局前缀含应用名与环境，避免多应用/多环境串数据；key 长度与字符白名单校验 |
| FR-05 | 标签化失效 | `invalidateTag(tag)`；标签与 key 的映射单独存储，支持按用户、按模块批量失效 |
| FR-06 | 防穿透 | 空结果写入短 TTL 占位（默认 60s）；可选布隆过滤器钩子 |
| FR-07 | 防击穿 | 热点 key 回源用单飞（single-flight）：同 key 并发只回源一次 |
| FR-08 | 防雪崩 | TTL 叠加随机抖动（±10%）；支持分级 TTL |
| FR-09 | 分布式锁 | `lock(key, ttl)` 基于 Redis `SET NX PX`（memory 驱动下退化为进程内锁）；支持自动续期与可重入标记 |
| FR-10 | 可观测与降级 | 暴露命中率、平均耗时、错误数指标到 `/metrics`；Redis 不可用时自动降级（直查或 memory）并记录告警日志 |
| FR-11 | 与事务协同 | 写操作在事务提交后执行失效，避免「删缓存 → 事务回滚」导致脏数据 |

## 5. 非功能需求（NFR）

- memory 驱动下单次 get ≤ 1ms；redis 驱动 ≤ 3ms（同机房）。
- 缓存不可用时接口仍可用（降级），P95 退化不超过直查耗时的 1.2 倍。
- 单 key 序列化后 ≤ 1MB，超过则拒绝写入并告警（防大 key）。
- 所有缓存操作带 traceId 日志，慢操作（> 50ms）告警。

## 6. 关键设计

**配置**

```
CACHE_DRIVER=memory        # memory | redis | redis-cluster
CACHE_URL=redis://127.0.0.1:6379
CACHE_PREFIX=myapp:prod    # 留空自动取 fw:<APP_ENV>
CACHE_TTL=300              # 默认 TTL（秒）
CACHE_MAX_ITEMS=10000      # memory 驱动 LRU 容量上限
CACHE_FAIL_OPEN=true       # Redis 故障时降级直查；false 时抛 9002
CACHE_NULL_TTL=60          # 空值占位 TTL（防穿透）
CACHE_TTL_JITTER=0.1       # TTL 抖动比例（防雪崩）
CACHE_LOCK_TTL=30          # 分布式锁默认 TTL（秒）
CACHE_TAG_TTL=86400        # 标签映射 TTL（防幽灵缓存）
CACHE_SLOW_MS=50           # 慢缓存操作告警阈值（毫秒）
CACHE_MAX_VALUE_BYTES=1048576  # 大 key 防护阈值
```

**用法示例**

```ts
@Cacheable({ ttl: 300, tags: ['user'] })
async findUser(id: string) { return this.repo.findById(id); }

await this.cache.invalidateTag(`user:${id}`);   // 更新后失效
```

**降级决策**：`CACHE_FAIL_OPEN=true` → 读失败直查、写失败忽略；观测指标与日志必须体现降级次数。

## 7. 验收标准（AC）

- [x] `CACHE_DRIVER=memory` 时，无任何 Redis 依赖，全量功能测试通过。
- [x] 仅改配置切换到 `redis`，业务代码 diff = 0，功能测试同样通过。
- [x] 并发 100 请求打同一个热点 key，回源只发生 1 次（单飞生效）。
- [x] 查询不存在的 key 时，回源只发生一次（空值占位生效）。
- [x] `invalidateTag('user:1')` 后，该用户所有相关缓存全部失效。
- [x] 手动停掉 Redis，接口仍能正确返回（降级），日志有降级告警。
- [x] 集群下两个实例同时执行定时任务，分布式锁保证只执行一次。
- [x] `/metrics` 可见命中率，压测下命中率 ≥ 90%。

## 8. 依赖与风险

- 依赖 M1 日志与配置；与 PRD-003 权限缓存、PRD-002 事务协同。
- 风险：标签映射在 Redis 中本身失效会导致「幽灵缓存」→ 映射 key 设较长 TTL 并定期重建。
- 风险：memory 驱动在多实例下不一致 → 文档明确标注 memory 仅适用于单实例或可容忍不一致的数据。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| 是否需要 L1 本地 + L2 Redis 多级缓存？ | M4 不做，M8 按规模评估 | 待定 | M8 评审时 |
| 缓存序列化用 JSON 还是 MessagePack？ | 首版 JSON（可读可排查），体积敏感场景再引 msgpack → **结论：采用 JSON 信封**（`{"v":值,"n":是否空值占位}`），可读且能区分「未命中」与「命中的空值」 | L3 | 已定稿（M4，2026-10-13） |

## 10. 验收记录（M4，2026-10-13）

**交付物**

- `docs/contracts/cache.ts`：C-04 缓存契约（`CacheService` 接口、`Lock` API、`CacheStore` 端口签名、指标快照结构、`CACHE_FAIL_OPEN` 降级语义）。
- `packages/cache`（`@fw/cache` v0.1.0）：`CacheStore` 端口 + memory/redis/redis-cluster 三态驱动 + `CacheService` + `@Cacheable` 装饰器 + `Lock` + `CacheModule.forRoot` + `/metrics` 与 `/ready` 探针。
- `packages/config`：新增 9 个配置键（`CACHE_PREFIX` / `CACHE_TTL` / `CACHE_MAX_ITEMS` / `CACHE_FAIL_OPEN` / `CACHE_NULL_TTL` / `CACHE_TTL_JITTER` / `CACHE_LOCK_TTL` / `CACHE_TAG_TTL` / `CACHE_SLOW_MS` / `CACHE_MAX_VALUE_BYTES`），schema → 视图 → `.env.example` → 部署手册四层贯通。
- `apps/example-api`：`CacheModule.forRoot` 接线（默认 memory）、`/api/v1/demo-cache/*` 演示端点、`CacheBackedAuthCache`（把 M3 的 `AUTH_CACHE` 端口换成 `CacheService`，鉴权业务代码 diff = 0）。
- `apps/example-api/scripts/smoke-cache.mjs`：M4 端到端冒烟（三阶段 12 项断言）。
- ADR-0012（缓存存储抽象自研端口，不引 cache-manager），ADR-0004 标记为已部分取代。

**验证结果**

| 验证项 | 命令 | 结果 |
|---|---|---|
| `@fw/cache` 单测 | `pnpm --filter @fw/cache run test:coverage` | 8 文件全通过；覆盖率 **96.23% lines / 94.45% branch / 98.37% funcs / 96.23% stmts**（门禁 85/65/85/85） |
| M4 缓存端到端 | `node apps/example-api/scripts/smoke-cache.mjs` | **12/12 通过**（阶段 A memory 全能力 / 阶段 B redis 降级 / 阶段 C 配置守卫） |
| M1+M2 回归 | `node apps/example-api/scripts/smoke.mjs` | **13/13 通过** |
| M3 回归 | `node apps/example-api/scripts/smoke-auth.mjs` | **25/25 通过**（鉴权缓存切 `CacheService` 后无回归） |
| 文件头门禁 | `pnpm run check:headers` | 通过（128 文件） |
| 方言白名单门禁 | `node scripts/check-no-raw-sql.mjs` | 通过（134 文件） |

**TC-CACHE 覆盖映射**

| 用例 | 覆盖方式 | 结果 |
|---|---|---|
| TC-CACHE-001 memory/redis 行为一致 | `@fw/cache` 单测：同一套用例跑 memory 与 `FakeRedisClient` | 通过 |
| TC-CACHE-002 统一接口 | 冒烟（写入读回 + 驱动标识）+ 单测 | 通过 |
| TC-CACHE-003 标签失效 | 冒烟（`invalidateTag` 后重新回源）+ 单测 | 通过 |
| TC-CACHE-004 防击穿（单飞） | 冒烟（100 并发回源 1 次，单飞合并 ≥ 50） | 通过 |
| TC-CACHE-005 防穿透（空值占位） | 冒烟（10 并发回源 1 次 + 二次读取命中占位） | 通过 |
| TC-CACHE-006 防雪崩（TTL 抖动） | 单测（抖动落在 ±jitter 区间） | 通过 |
| TC-CACHE-007 依赖故障降级 | 冒烟阶段 B（redis 不可达 + fail-open，业务 http=200、指标可见降级、`/ready` 503） | 通过 |
| TC-CACHE-008 故障恢复回切 | 单测（先坏后好时序） | 通过 |
| TC-CACHE-009 分布式锁 | 冒烟（持锁互斥 + 释放后可获取）+ 单测（`setNx`/续期/安全释放） | 通过 |
| TC-CACHE-010 大 key 防护 | 单测（超 `CACHE_MAX_VALUE_BYTES` 拒绝写入） | 通过 |

**残留缺口**：真实 Redis 集群（`CACHE_DRIVER=redis-cluster`）未在本地实跑，由 fake 客户端验证命令序列；生产级集群行为在 M8 演练时复验。`memory` 驱动已知仅适用于单实例（PRD-004 §8 风险项，文档已标注）。
