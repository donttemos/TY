# ADR-0004 · 缓存抽象基于 cache-manager + ioredis

- 状态：**已部分取代**（存储抽象部分被 [ADR-0012](./0012-cache-own-port-over-cache-manager.md) 取代：改为自研 `CacheStore` 端口；「业务层不暴露底层类型 + 防护内聚在 `CacheService`」两条约束仍然有效）
- 日期：2026-10-09
- 关联：PRD-004、[ADR-0007](./0007-database-switchability.md)、[ADR-0012](./0012-cache-own-port-over-cache-manager.md)

## 背景

1. 小系统不能被迫装 Redis（C1 零依赖起步），大系统需要 Redis Cluster 与哨兵。
2. 业务代码必须只依赖统一接口，切换缓存实现时 diff = 0。
3. 需要标签失效、单飞、降级等能力，但不希望自研整套存储层。

## 决策

缓存能力以 **cache-manager（统一 store 接口）+ ioredis（Redis 客户端）** 为基础，封装为 `CacheService` 与 `@Cacheable` 装饰器，对外只暴露框架自有接口；`memory` 与 `redis` 两种 store 由 `CACHE_DRIVER` 决定注入。

框架**不直接暴露** cache-manager 或 ioredis 类型给业务层，防护能力（空值占位、单飞、TTL 抖动、降级）在 `CacheService` 内实现。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| 直接用 ioredis | 功能最强、性能最好 | 小系统被迫依赖 Redis，切换成本转嫁业务层 | 违背 C1 |
| 自研统一缓存库 | 完全可控 | 重复造轮子，维护成本高 | 不在能力清单 |
| cache-manager + ioredis | 统一 store 抽象、多实现、生态成熟 | 需在其上补齐标签失效与防护能力 | — |
| 仅用 NestJS 内置 CacheModule | 零配置 | 能力不足（无标签失效、无降级策略） | 覆盖不了 PRD-004 |

## 后果

**正面**：memory 与 redis 行为一致，切换仅改配置；统一接口便于埋点（命中率、降级次数）；Redis 能力（哨兵、集群）由 ioredis 兜底。

**负面 / 代价**：cache-manager 不提供标签失效与单飞，需自行实现（约 200 行核心逻辑）；多一层抽象带来轻微开销（基线要求 memory ≤ 1ms）。

**缓解措施**：标签映射 key 设较长 TTL 并定期重建，避免「幽灵缓存」；`CACHE_FAIL_OPEN=true` 时 Redis 故障降级直查；基准用例 TC-NFR-004 守性能。
