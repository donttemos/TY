<!--
@file ADR-0028 · 缓存标签索引的 Redis Cluster 兼容策略
@description 标签原子协议（setWithTags / invalidateByTag 的多键 Lua）在 Redis Cluster 下的 slot
  约束分析、hash tag 方案评估与标签索引协议重设计选项；当前版本限制登记与后续演进定案。
@author donttemo
@created 2026-10-17
-->

# ADR-0028 · 缓存标签索引的 Redis Cluster 兼容策略

- 状态：**已采纳**（2026-10-17；限制登记 + 策略定案，键格式改造列入后续版本）
- 关联：Cache 缺陷清单 C-01/C-03/A-04（标签原子协议）、`store.port.ts` 限制登记、`redis-integration.test.ts`（单实例验证）、`docs/90-release-v0.6.0.md` §6 验证矩阵

## 1. 背景与问题

C-01/C-03/A-04 修复后，`@fw/cache` 的标签能力由两个**多键 Lua 脚本**承载（`SET_TAGS_LUA` / `INVALIDATE_TAG_LUA`），
换取「写值+登记」「读成员+删成员+删索引」的单次原子性。Redis Cluster 按 key 的 slot 分片，
**跨 slot 的多键脚本被服务端直接拒绝（CROSSSLOT））**——标签能力在 Cluster 下不可用。

## 2. 约束分析：哪些键必须同 slot

先厘清每次原子操作实际涉及的键集合（这是所有方案的地基）：

| 原子操作 | 涉及键 | slot 约束 |
|---|---|---|
| `setWithTags` | 1 个值键 + N 个标签索引键（单脚本内 SET + SADD×N + PEXPIRE×N） | 全部 N+1 个键同 slot |
| `invalidateByTag` | 1 个标签索引键 + 其全部成员值键（单脚本内 SMEMBERS + DEL×(M+1)） | 全部 M+1 个键同 slot |
| 锁（`compareAndDelete`/`compareAndExpire`/`setNx`） | 单键 | 无 |
| 令牌桶（`tokenBucketTake`） | 单键 | 无 |
| 普通 `get/set/del/mget/exists/expire` | 单键 | 无 |

**关键结构性事实：值键 ↔ 标签索引键是 N:M 关系**——一个值可属多个标签，一个标签聚合多个值。
因此「同 slot」无法只靠给标签键加 hash tag 满足（那只能保证标签键之间同 slot，值键仍散列）；
**值键与其全部标签索引键必须落在同一 slot**，这是任何可行方案的硬约束。

当前键布局（`withPrefix`）：`{prefix}:{logical}` 与 `{prefix}:__tag__:{tagId}`——不含 hash tag，
Cluster 下按完整键散列，必然跨 slot。

## 3. 方案评估

### 方案 A：单全局 hash tag（`fw:cache:{g}:...`）

- 全部缓存键固定一个 slot：原子性 ✓；Cluster 退化为「单节点存储 + 多副本 HA」，**分片能力归零**。
- 实现最简（改一处键格式化），风险最低。
- 适用：缓存总量可控、要 Cluster 的 HA 而非吞吐的场景。

### 方案 B：prefix 作用域 hash tag（推荐）

- 键格式改为 `fw:cache:{prefix}:{logical}` / `fw:cache:{prefix}:__tag__:{tagId}`：同 prefix 的
  全部键同 slot → 原子性 ✓；**按 prefix（≈ 应用/命名空间）分片保留**。
- `prefix` 已是 CacheService 的既有命名空间参数（多应用共用一套 Redis 时本来就分前缀），
  把它提升为 slot 作用域不引入新概念；同 prefix 内无分片（可接受：prefix 通常就是租户/应用边界）。
- 代价：键格式变更 → 需要键格式版本化（v2 前缀）+ 迁移期双读（旧键 TTL 自然过期）。

### 方案 C：tenant 作用域 hash tag

- 分片粒度最细（按租户），但当前缓存键**不含 tenant**（`resolveKey` 无租户上下文），
  需要改键格式 + 缓存隔离语义（跨租户共享前缀的场景会变），改动面最大。备选，不采纳。

### 方案 D：重新设计标签索引协议（放弃多键原子）

- 形态：每值 sidecar（`{logical}` 同 slot 存值 + 自身标签列表）+ 失效改按 tag 扫描值键。
- 问题：scan 不可原子、代价随缓存总量增长；或保留 tag→成员索引但接受**最终一致**
  （写值原子、登记补偿/异步）——正是 C-01/C-03 修复要消灭的「孤儿键/幽灵索引」回归。
- 结论：不采纳。C-01/C-03 的核心收益就是强不变式，为此宁愿接受 slot 约束。

## 4. 定案

1. **当前版本（v0.6.0）不改键格式**，限制四路登记：`store.port.ts` 注释、`docs/contracts/cache.ts`、
   `redis.driver.ts` 构造期 cluster 客户端告警（`isCluster` 检测）、本文档。
2. **后续版本采用方案 B**（prefix 作用域 hash tag）：键格式版本化 + 双读迁移，作为独立变更落地
   （涉及全部缓存使用方，需迁移窗口与回滚预案）。
3. 真实验证边界：单实例已由 CI redis:7 service 容器验证（见 §5）；**Cluster 未验证**
   （无集群环境）——方案 B 落地前需补真实集群 CI（GitHub Actions 多节点 cluster 或外部集群），
   验证 CROSSSLOT 消失 + 原子性在集群形态下仍然成立。

## 5. 已验证 / 未验证矩阵

| 能力 | Fake 驱动测试 | 单实例真实 Redis | Redis Cluster |
|---|---|---|---|
| 标签原子协议（setWithTags/invalidateByTag） | ✓（调用映射） | ✓（CI service，含并发不变式） | ✗（CROSSSLOT，未验证） |
| 锁 CAS / SET NX | ✓ | ✓ | 未验证（单键，理论可用） |
| 真服务器端 TTL | ✗（Fake 惰性） | ✓ | 未验证 |
| 故障路径（WRONGTYPE/断连/关停） | 部分 | ✓ | 未验证 |
| 令牌桶 | ✓ | 未覆盖（单键） | 未覆盖 |
