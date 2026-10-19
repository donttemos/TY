<!--
@file ADR-0030 · 硬限额的并发安全扣减方案
@description M13（PRD-013 FR-13-06）硬限额执行定案：DB 事务 + 条件更新为唯一事实源，
  Redis 余量仅作快速预检加速；软限额/仅统计语义；多 key Lua 在 Redis Cluster 下的边界声明。
@author donttemo
@created 2026-10-19
-->

# ADR-0030 · 硬限额的并发安全扣减方案

- 状态：**已采纳**（2026-10-19；M13 P1 契约冻结）
- 关联：PRD-013 FR-13-06/NFR-13-1、ADR-0028（Cluster 键布局约束）、ADR-0029（生效配额解析）、PRD-013 OQ-13-1

## 1. 背景与问题

硬限额要求「并发逼近限额时不超发」。 naive 实现「先读用量 → 判断 → 再写用量」在并发下必然竞态超发。候选方案：

- **A. DB 事务 + 条件更新**：`UPDATE tenant_quota_usage SET used = used + :qty WHERE tenant_id=? AND quota_key=? AND window_start=? AND used + :qty <= limit_value`，affected rows = 0 即超限。
- **B. Redis Lua 原子预扣 + DB 异步落账**：热路径快，但 Redis 与 DB 双事实源，崩溃窗口内账目漂移，需对账补偿。
- **C. 分布式锁串行化**：正确但吞吐差，锁本身是已有故障高发区（见 Cache 缺陷清单历史）。

## 2. 决策

**方案 A 为主，方案 B 的只读预检为辅（可选优化），方案 C 不用于扣减主路径。**

### 2.1 事实源与执行

1. **DB 是唯一事实源**。扣减 = 单条条件 UPDATE，在同一事务内附带 INSERT `usage_events`（幂等键唯一约束去重）。事务成功 = 限额扣减 + 用量留痕原子生效。
2. **affected rows = 0 的语义判定顺序**：先查「窗口行是否存在」——不存在则初始化窗口行（INSERT，唯一约束防并发重复初始化）后重试一次 UPDATE；行存在且 `used + qty > limit` → 返回 `QUOTA_EXCEEDED` 4029。
3. **窗口翻转**：按 `window_start`（天/自然月）切片，跨窗自动开新行，旧窗行只读。无需定时清零任务。

### 2.2 Redis 的角色（仅加速，非事实）

- 余量缓存键 `{prefix}:quota:{tenantId}:{quotaKey}:{windowStart}`，TTL 60s。
- **只做预检**（超限可直接拒绝，节省一次 DB 往返）；预检通过仍必须走 DB 条件更新。缓存漏判（余量虚高）由 DB 兜底，**不会超发**；缓存误判（虚低）最多造成短暂误拒，可接受。
- 写路径（事务提交后）用 `@fw/cache` 标签协议失效该键（复用 setWithTags/invalidateByTag，ADR-0028 的 Cluster 限制随之继承）。

### 2.3 Redis Cluster 边界声明

单键预检不涉及多 key Lua，**预检路径天然 Cluster 兼容**；但标签失效路径受 ADR-0028 限制（跨 slot 多键脚本）。因此：Cluster 环境下限额执行功能可用（DB 兜底），标签失效降级为直删单键或等待 TTL。发布说明按 PRD-013 AC-13-14 口径声明，不以双进程测试冒充 Cluster 验证。

### 2.4 软限额 / 仅统计

| execution | 行为 |
|---|---|
| `hard` | 条件更新失败 → 4029（附 metricKey、当前窗口用量与升级指引 details） |
| `soft` | 正常扣减；`used >= limit` 时发一次告警事件（同窗口内幂等：告警状态记在窗口行 `warned_at`，重复触发不重复告警） |
| `observe` | 仅写 usage_events，不判限额（窗口行可不建） |

### 2.5 窗口行初始化的并发去重

窗口行 `tenant_quota_windows` 以 `unique(tenant_id, quota_key, window_type, window_start)` 防并发重复初始化：插入撞唯一键 → 捕获错误后重读重试一次 UPDATE（三库行为一致，无方言分叉）；并发扣减本身由条件 UPDATE 的行锁保证。

## 3. 验收绑定

- AC-13-04：并发竞态测试入 CI（N 线程并发扣减至限额边界，断言最终 `used == limit` 且成功数恰为限额余量、其余全部 4029）。
- NFR-13-7：预检命中时 P99 增量 ≤ 10%；预检关闭（故障）时功能不劣化（只多 DB 往返）。

## 4. 后果

- 正确性不依赖 Redis 可用性：Redis 宕机 = 性能退化，非正确性事故。
- 代价：每次硬限额请求一次 DB 写事务（含 usage_events insert）。M13 不做事件批量合并（那会引入「扣减先于留痕」窗口），留待 M14 用 outbox 模式优化。
- 4029 需在 error-codes.ts 三副本（core 源 + 生成的 error-codes.json + mock/契约断言）同步登记。
