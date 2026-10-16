# ADR-0022 · M11.3 Client Fingerprint：grace 恢复绑定轮换发起方，异端重试升级为 replay

- 状态：已采纳（2026-10-16 评审通过，4 条意见全落实：CAS 同事务写指纹 / NULL 收窄 / normalize 冻结+向量 / 状态机+安全事件全链）
- 日期：2026-10-16
- 关联：ADR-0020（rotation CAS 与 grace 语义）、ADR-0021（生命周期与 cipher 清理）、baseline-009（异客户端 grace 观测，本 ADR 翻转）、424c221（RFC 9700 定位登记）、路线 M11.3 → M11.4（Key Ring）

## 背景

1. M11.1/11.2 之后仍留一个已知攻击面（ADR-0020 明示留白）：**任何持有 A 的一方在 grace 窗口内都能拿回 B**——攻击者与用户同时持有 A 时，双方都能在窗口内拿到 B（baseline-009 冻结了该现状：不同 UA 的 rotate 返回同一 B 且 `withinGrace=true`）；
2. RFC 9700 定位（已在 ADR-0020 收口注记登记）：rotation 本身就是官方 replay detection 机制，fingerprint 是**降误报增强**而非检测前提——本 ADR 沿用该定位，不推翻 M11.1 语义；
3. `rotate()` 现有入参只有 `ip + userAgent`，无 deviceId / clientId 契约。

## 目标语义

```
A(grace 内重试) + 指纹匹配赢家  → already_rotated → 返回同一个 B
A(grace 内重试) + 指纹不匹配    → replay_detected → revoke family + 3001
A + 指纹缺失/旧数据（NULL）     → 维持现行为放行（向后兼容，见决策 5）
```

## 决策（提议稿）

1. **指纹 = SHA-256(规范化的客户端标识串)**，由 `rotate()` 的现有入参派生（本 ADR 阶段：`userAgent`；`ip` 明确**不进**指纹——移动网络切换/代理出口导致合法用户 IP 漂移，会误杀）；
2. **绑定与校验（原子性硬规则）**：赢家指纹由 **CAS 的同一条 UPDATE 一并写入** A 行新列 `rotated_fingerprint`（与 revokedAt / replacement 三列同事务、同语句提交，ADR-0020 Rule 3）——**禁止任何二次 UPDATE 补写**：指纹写入失败 = 整个 rotation 回滚，不存在「A 已 revoked + B 已创建但 fingerprint 缺失」的中间态（否则 grace 会退化为 NULL 放行）。grace 重试时比较重试方指纹与 A 行指纹——匹配走 `already_rotated`，不匹配返回 `replay_detected`（服务层统一走既有族撤销路径，Rule 8 不变）；
3. **NULL 放行的收窄边界**：`rotated_fingerprint IS NULL` 的放行**仅适用于 M11.1 历史存量行**（该列诞生前的 rotation）；新代码的 rotation 在开关开启时**必须产生非 NULL 指纹**（UA 为 null/空也按 `normalizeUserAgent(null) = ""` 固定派生，见决策 3a）——**新 rotation 产生 NULL 即缺陷**，由 Store contract test 锁死；显式关闭指纹（`AUTH_FINGERPRINT=off`）是唯一合法的 NULL 来源。合规判定：NULL 放行是存量迁移兼容，不是常态旁路；
4. **schema**：单列 nullable `String`，无索引；三方言 + 模板 migration 同 M11.1 模式（sqlite / pg / mysql 变体 / 模板）；
3a. **normalizeUserAgent 规则冻结（DR-0022-03）**：第一版规则刻意最保守——`normalizeUserAgent(ua) = ua.trim()`（仅去首尾空白，**不做去版本号/大小写归一/品牌归并**等任何模糊规则，杜绝行为漂移）；`normalizeUserAgent(null) = ""`。指纹 = `SHA-256(normalizeUserAgent(ua))` 十六进制串。固定测试向量（实现与测试必须逐条对齐，浏览器小版本升级只改变指纹值、不改变映射确定性）：

   | 输入 | 规范化输出 | 指纹 |
   |---|---|---|
   | `null` | `""` | SHA-256("") 常量 |
   | `""` | `""` | 同上（与 null 同指纹——空 UA 视为同一类客户端，如实登记） |
   | `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"` | 原样（trim 后） | 确定性 hex |
   | `"  Mozilla/5.0 Chrome/119  "` | `"Mozilla/5.0 Chrome/119"` | 与无空格版本同指纹 |

5. **指纹来源分两步走（本 ADR 的关键取舍，待评审确认）**：
   - **M11.3 本体（方案 A，推荐）**：UA 指纹，零客户端改动、零 API 变更，`AuthOptions` 加开关（默认开）；如实登记安全边界——UA 可被蓄意伪造，方案 A 防的是「token 被复制到其它设备/浏览器后的意外共用」，不防蓄意攻击者；
   - **方案 B（完整契约，后续版本）**：客户端持久化 `X-Device-Id` + `X-Client-Id` 请求头，指纹 = SHA-256(clientId:deviceId)，需 API 契约变更 + 前端/admin 模板适配 + 无头客户端兼容策略（缺失回退 UA 指纹）；本 ADR 只在 Store/Service 层预留指纹**提供者接口**（fingerprint 由调用方算好传入，框架不感知来源），B 落地时零核心改动；
6. **baseline-009 翻转**：异客户端 grace 重试从 observation 改为断言拒绝（ADR-0020 预告项兑现）；同步检查 `same-UA` 攻击者场景仍是留白并写入 M11.4 评审输入。
7. **fingerprint mismatch 是安全事件，不是普通认证失败**：与 token replay 完全同构，必须走 ADR-0020 Rule 8 的同一编排——`replay_detected → revoke family → revoke user's refresh sessions → audit 安全事件（writeAuditLog 落审计）→ 3001`。禁止只返回 401 就结束；
8. **状态机（钉死）**：

```
              refresh A
                  │
        ┌─────────┴──────────┐
        │                    │
   CAS winner            CAS loser
        │                    │
        ▼                    ▼
  A→B + fingerprint    ┌─────┴─────────────────────┐
  （同一 UPDATE 提交，  │                           │
   禁止二次补写）  grace expired          grace active
        │                    │                           │
        │                    ▼                           ▼
        │              replay_detected      fingerprint == A.rotatedFingerprint ?
        │              revoke family              │                    │
        │              revoke sessions         匹配（含 NULL 存量）   不匹配
        │              audit security event       │                    │
        │              → 3001                     ▼                    ▼
        │                                   already_rotated      replay_detected
        │                                   解密返回同一个 B      （决策 7 安全事件全链）
        │
        └──► 指纹来源：normalizeUserAgent（决策 3a），IP 不参与（漂移误杀）
```

## 备选方案

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **A：UA 指纹（本提议 M11.3 本体）** | 零客户端/API 变更，立即收窄攻击面 | UA 可伪造；同一 UA 的多标签页共享（合法）不受影响 | 接受——RFC 9700 定位下的增强项 |
| B：deviceId/clientId 完整契约 | 真正的设备绑定 | API + 前端 + admin 模板三处契约与灰度兼容，工作量数倍 | 拆到后续版本，本 ADR 预留 provider 接口 |
| IP 入指纹 | 额外信号 | 移动网络/代理漂移误杀合法用户 | 否决（明确不进指纹） |

## 后果

**正面**：grace 窗口的跨设备滥用从「默认放行」变为「默认拒绝」；存量数据零迁移成本（NULL 放行）；M11.4 双 Ring 的设备维度有了挂靠点。
**负面 / 代价**：同 UA 蓄意攻击者不受影响（如实登记）；`rotated_fingerprint` 引入一次三方言 migration；UA 规范化策略（截断/去版本号）需在测试中固定，避免浏览器小版本升级误杀。

## Definition of Done（M11.3 封板清单）

```text
[ ] ADR-0022 adopted
[ ] rotated_fingerprint 三方言 + 模板 migration
[ ] 指纹派生与比对实现（Memory + Prisma 双侧）
[ ] L6 指纹测试层：同客户端 → B / 异客户端 → replay + 族撤销 / NULL 兼容 / IP 变化无关
[ ] baseline-009 翻转
[ ] 三件套回归全绿 + CI 全绿
[ ] CHANGELOG 登记
```
