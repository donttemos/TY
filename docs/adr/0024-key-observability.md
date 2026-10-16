# ADR-0024 · M11.5 Key Ring 可观测性：稳定 kid + 密钥运维端点 + 安全事件审计口径

- 状态：已采纳（2026-10-16 评审通过，6 条意见全落实：kid 16 hex + collision 启动失败 / unknown kid 禁 fallback / retirable 基于可恢复密文计数 / @Public 边界 + no-store / source 枚举化 / kid 与 keyId 语义分离 + 目标语义与状态机补全）
- 日期：2026-10-16
- 关联：ADR-0023（双 Key Ring；其决策 4 冻结的「稳定 kid 留 M11.5」与本 ADR 交付）、ADR-0021（grace 级清理 = 退役判据的计算基础）、M3 TC-AUTH-014、M10 E-10（audit-archive 先例）、M11.3（audit security 事件）

## 背景

M11.1–11.4 已闭环 rotation **并发正确性**、grace 恢复、replacement 密钥代际回退及密钥退役**基础判据**（密钥全生命周期中的 retire/destroy 运维闭环由 M11.5 起步），但遗留三个 M11.5 范畴项：

1. **kid 语义漂移（ADR-0023 决策 4 冻结项）**：`jwt-current` / `jwt-prev` 是角色路由标识——轮换部署后旧代际 token 上仍写 `jwt-current`（签发方视角），kid 的核心价值（跨部署稳定定位密钥代际）未兑现；
2. **Key Ring 零可观测**：Ring 的 keyId 清单、current 代际、replacement 各 keyId 名下的活跃 cipher 行数（**退役判据**，ADR-0023 已定义但只能查库）都没有运维视图——「这个 key 能不能退役」要手写 SQL；
3. **安全事件有落库无口径**：M11.3 起 replay / 指纹不匹配落 `audit action='security'`，但「怎么查、看什么」没有文档化口径。

## 目标语义（冻结）

**JWT 域**：sign 全量携带稳定 kid（`'jwt-' + sha256(secret)[0:16]`）；verify 四分支路由
（absent / legacy 角色标识 → dual-try 兼容；known stable kid → 精确单 key；unknown → reject）。
**Replacement 域**：decrypt 严格按 keyId 路由（ADR-0023 Rule 6 延续）；运维面暴露
每个 keyId 的「仍存在可恢复密文」计数 → retirable 判据。**rotation 核心 / grace 状态机零改动**。

## 状态机（冻结）

```
JWT sign
    │
    ├─ current key → kid = 'jwt-' + sha256(secret)[0:16]（稳定指纹）
    │
    └── JWT issued
             │
             ▼
          verify
             │
       ┌─────┴────────────────────┐
       │                          │
  kid absent / legacy kid    known stable kid        unknown kid
  (jwt-current / jwt-prev)        │                       │
       │                          │                       │
  legacy dual-try            keyFor(kid)              直接拒绝（invalid）
  (current → prev)           只验证该 key              禁止尝试任何 Ring key
       │                          │
  失败 → invalid             失败 → invalid（不 fallback）

Replacement cipher
        │
        ▼
  replacement_key_id
        │
        ▼
  ReplacementRing.keyFor()
        │
   ┌────┴────┐
 known      unknown
   │           │
 decrypt     fail closed
（ADR-0023 Rule 6 延续）
```

## 决策（提议稿）

1. **稳定 kid（兑现 ADR-0023 决策 4 的冻结项）**：JWT kid 从角色标识升级为**基于 secret 指纹的派生标识**——`kid = 'jwt-' + sha256(secret).slice(0, 16)`（**64 bit**；current/previous 各自派生；同 secret 跨部署、跨实例、跨重启**稳定不变**，语义漂移问题消除）。
   - **kid 的定位（冻结）**：kid 是**不可逆的密钥指纹标识**，不是密钥材料指纹对外承诺密码学唯一性——同 Ring 内 kid collision **启动即失败**（`JwtKeyRing` 构造时检测：不同 secret 派生出相同 kid → throw），杜绝 `keyFor(kid)` 路由歧义；
   - `JwtKeyRing` 构造时派生 `currentKid / previousKid`，`keyFor(kid)` 按派生 kid 精确路由；
   - **兼容回退（钉死，四分支见决策 2）**：仅 kid 缺失（存量 token）与 legacy 角色标识（`jwt-current`/`jwt-prev`，ADR-0023 过渡期 token）回退双试——**未知 kid 一律拒绝，不 fallback**；
   - kid 只暴露 16 hex 派生前缀，不可逆、不泄露 secret。
2. **JWT verify 的 kid 路由四分支（P0，钉死）**：

   ```
   kid absent                       → legacy dual-try（current→prev，存量 token 兼容）
   kid = jwt-current / jwt-prev     → legacy dual-try（ADR-0023 过渡期 token 兼容）
   kid = known stable kid           → keyFor(kid) 只验证该 key，失败即失败（不 fallback）
   kid = unknown                    → 直接拒绝（invalid），**禁止尝试 current/previous**——
                                      否则多代 Ring 扩展后重新形成「带 kid 不认识 → 全 Ring 尝试」
                                      的 brute-force 面（kid 路由失去意义）
   ```

   测试必须锁死：**unknown kid 不得尝试 current/previous**（用 current 密钥签发但 kid=unknown 的 token → verify 必须 reject，即使 token 本身可被 current 验通）。
3. **Key Ring 运维端点（管理面交付）**：`GET /api/v1/auth-maintenance/key-ring`（沿 maintenance 自检先例 `@Public()`，**零敏感材料**——只有 keyId/kid/来源/行数统计，无任何 secret/密文）：
   ```json
   {
     "jwt":     { "currentKid": "jwt-a1b2c3d4", "previousKid": "jwt-9f8e7d6c|null", "source": "env(JWT_SECRET/PREV)" },
     "replacement": {
       "mode": "explicit|legacy-hkdf",
       "currentKeyId": "replacement-v2",
       "keyIds": [{ "keyId": "replacement-v1", "activeCiphers": 0, "retirable": true },
                  { "keyId": "replacement-v2", "activeCiphers": 3, "retirable": false }]
     }
   }
   ```
   - **retirable 判据基于「仍存在可恢复密文」**（与 ADR-0021 cipher 清理语义一致）：
     `activeReplacementCipherCount(keyId) = COUNT(replacement_cipher IS NOT NULL AND replacement_key_id = keyId AND replacement_expires_at > now)`——cipher 已清空的历史行**不计入**（否则会把已脱敏的历史行误判为不可退役）；
   - 端点挂在既有 `MaintenanceController`（框架自检面）；**安全边界（冻结）**：响应不得包含 secret、secret hash、cipher、token、原始配置值——仅非敏感运维元数据；响应头加 `Cache-Control: no-store`；沿 @Public 先例的理由 = 暴露内容为无敏感运维元数据（如实登记攻击面评估）；
   - **source 字段枚举化（冻结）**：`type KeySource = 'explicit' | 'legacy-hkdf' | 'jwt-secret' | 'jwt-secret-prev'`——API 契约不允许自由字符串（防 'env'/'HKDF' 之类的漂移实现）；
   - **JWT kid 与 replacement keyId 是两种语义，响应结构分离**：JWT kid 是 token header 中的公开标识；replacement keyId 是数据库 cipher 的内部路由标签——生命周期、来源、暴露面完全不同，不得混用同一字段命名；
   - 支撑查询新增 `AuthStore.countReplacementCiphersByKeyId(now): Promise<Record<string, number>>`（Memory + Prisma ×2 三实现，与 `clearExpiredReplacementCiphers` 同模式）。
4. **安全事件审计口径（文档化，不新建页面）**：replay / 指纹不匹配 / 族撤销统一落 `audit_logs action='security'`（M11.3 已实现）；查询口径 = 既有 admin 审计面 `action=security` 过滤（审计查询 API 与权限码均现成）；ADR 登记排查手册条目：看到 security 事件 → 确认 family 撤销 → 检查 `/auth-maintenance/key-ring` 的退役状态与 AUTH_FINGERPRINT/KEYS 配置。
5. **不做**：rotation 核心/grace 状态机零改动（红线延续）；不做 admin 前端新页面（审计过滤能力已存在）；不做密钥轮换自动化（运维显式）；不做 KMS（PRD-011 S-40 独立交付）。

## 备选方案

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **secret 指纹派生 kid（本提议）** | 零配置获得跨部署稳定身份；轮换部署新 kid 天然区分代际 | kid 前缀 8 hex 有理论碰撞面（2^-32，登记） | 接受 |
| 显式配置 JWT keyId（`JWT_KEY_IDS`） | 人工可控命名 | 新配置键 + 轮换时两处同步（secret+keyId），运维负担 | 留 M11.5 之后按需 |
| 可观测端点挂 admin 权限码 | 收紧访问面 | 暴露内容为无敏感元数据，加权限码需 seed+前端菜单 | 沿 @Public 自检先例 |

## 后果

**正面**：kid 语义漂移消除（轮换部署新签发 token 的 kid 天然区分代际）；「key 能不能退役」从手写 SQL 变成一个 GET；安全事件排查有固定口径；全部交付不触碰 rotation 核心与 grace 状态机（红线延续）。
**负面 / 代价 / 已知留白**：旧 kid token 在过渡期后仍需双试回退（登记为长期兼容行为，不设废弃期限）；`@Public()` 端点暴露 keyId 前缀与行数统计（无 secret/密文，攻击面评估为可接受，如实登记）；M11.3 审计口径依赖既有 admin 审计页（无专门可视化，M11.5 之后按需）。

## Definition of Done（M11.5 封板清单）

**M11.5-01 Stable JWT kid**
- [x] 新 JWT 全部携带 stable kid（`'jwt-' + sha256(secret)[0:16]`）
- [x] 同 secret → 跨实例/重启 kid 相同
- [x] 不同 secret → kid 通常不同
- [x] Ring 内 kid collision → startup fail
- [x] legacy jwt-current / jwt-prev 可验证（dual-try 兼容）
- [x] 无 kid token 可验证

**M11.5-02 kid routing**
- [x] known kid 只使用对应 key
- [x] unknown kid 不 fallback（用 current 密钥签发但 kid=unknown 的 token → verify 必须 reject）
- [x] unknown kid 不遍历 Ring
- [x] known kid verification failure 不 fallback 到其它 key

**M11.5-03 Key Ring endpoint**
- [x] endpoint 可访问（@Public 自检先例 + Cache-Control: no-store）
- [x] 不返回 secret / secret hash / cipher / token / 原始配置值
- [x] replacement key 的 activeReplacementCipherCount 正确（判据含 cipher IS NOT NULL）
- [x] retirable 与 ADR-0023 判据一致
- [x] source 枚举化（KeySource 四值）
- [x] Memory / Prisma SQLite / PostgreSQL / MySQL 行为一致

**M11.5-04 Audit**
- [x] replay → action=security（M11.3 已实现，回归锁定）
- [x] fingerprint mismatch → action=security（同上）
- [x] family revoke 可关联（targetType=refresh_family + targetId）
- [x] admin audit 查询可以过滤 security

**M11.5-05 Regression**
- [x] M11.0a baseline PASS
- [x] M11.1 CAS PASS
- [x] M11.2 lifecycle PASS
- [x] M11.3 fingerprint PASS
- [x] M11.4 key ring PASS
- [x] M11.5 kid PASS
- [x] 三件套回归 + CI 全绿（rotation 核心红线验证）
