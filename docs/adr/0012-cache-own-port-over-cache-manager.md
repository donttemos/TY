# ADR-0012 · 缓存存储抽象自研端口，不引入 cache-manager

- 状态：已采纳
- 日期：2026-10-13
- 关联：PRD-004、[ADR-0004](./0004-cache-abstraction.md)（部分取代）、[ADR-0008](./0008-testing-strategy.md)

## 背景

1. ADR-0004 决定「以 cache-manager 统一 store 接口 + ioredis 为底座」。M4 落地时复核发现：cache-manager v5+ 已改版为 ESM-first 的 `createCache({ stores })` 形态，`del` 不再支持通配、没有 `sadd`/`smembers`（标签映射需要集合语义）、没有 `setNx`（分布式锁需要原子性），且 v4→v5 的 API 搬迁尚未稳定。
2. 本框架需要在 store 层直接使用**集合**（标签→key 映射）与**原子 set-if-not-exists**（锁），这两项 cache-manager 均不提供，仍需绕到原生客户端，抽象层收益被抵消。
3. PRD-004 NFR 要求 memory 驱动单次 get ≤ 1ms（零依赖起步，C1），引入 cache-manager 会把「统一 store 接口」这层成本加到最小的内存路径上。
4. ADR-0004 中「不暴露底层类型给业务层、`CacheService` 内聚防护能力」这两条约束仍然成立，本次只调整**抽象承载方式**。

## 决策

框架自研 **`CacheStore` 端口**（`get / set / del / has / mget / mset / expire / sadd / srem / smembers / setNx / delBySet / ping / close`），由 **memory 驱动**（零依赖，LRU + TTL 惰性淘汰）与 **redis 驱动**（ioredis 懒加载，`CACHE_DRIVER=redis|redis-cluster`）分别实现；防护能力（空值占位、单飞、TTL 抖动、标签失效、降级、指标）全部收敛在 `CacheService` 内。**不引入 cache-manager**。

业务层仍只依赖 `CacheService` / `@Cacheable`，不接触 ioredis 或驱动类型——ADR-0004 的对外契约不变。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| cache-manager v5 + ioredis | 生态成熟、多 store | v5 API 未稳定、缺集合与 setNx 语义，仍需下沉原生客户端 | 抽象被穿透，收益为负 |
| cache-manager v4 + ioredis | API 稳定 | 已停止维护、esm/cjs 混用、`del` 通配语义与 Redis 不一致 | 维护风险高 |
| 直接用 ioredis | 功能最全 | 小系统被迫依赖 Redis，违背 C1 零依赖 | 不可接受 |
| **自研 `CacheStore` 端口 + 双驱动** | 内存路径零依赖、集合与锁语义一等公民、测试可注入 Fake | 需自维护一套端口（约 400 行） | — |

## 后果

**正面**：
- memory 驱动零外部依赖，小系统不装 Redis 也能跑通全量功能（AC-001）。
- 集合语义（标签映射）与 `setNx`（分布式锁）成为端口一等能力，无需绕行。
- 单测可注入 `FakeRedisClient`，同一套用例跑 memory 与 redis 两驱动，验证行为一致性（TC-CACHE-001）。
- ioredis 降为**可选 peerDependency**，只有 `CACHE_DRIVER=redis*` 时才解析，安装体积与攻击面可控。

**负面 / 代价**：
- 自研端口需自行维护（含 LRU 淘汰、TTL 抖动、锁续期、Lua 脚本），M4 核心逻辑约 400 行 + 8 个测试文件。
- 放弃 cache-manager 的第三方 store 生态（如 memcached、多级 store 组合）。

**缓解措施**：
- 端口签名对齐 Redis 原生语义（`sadd`/`setNx`/`expire` 同名同义），降低认知负担与未来接入第三方 store 的迁移成本。
- 单测覆盖率门禁 85%/65%，Fake 客户端与 memory 驱动共用同一批用例，防止两驱动行为漂移。
- 若未来 PRD-004「待定问题」确认引入 L1+L2 多级缓存，可在 `CacheStore` 之上叠加组合驱动，不需改动 `CacheService`。
