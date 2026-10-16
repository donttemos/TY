# ADR-0021 · Refresh Token 生命周期完整性：replacement 密文 grace 级清空 + 全链生命周期回归

- 状态：已采纳（2026-10-16 评审通过，9 条评审意见全部落实：判据单一化 / 三列一致性不变量 / 滞留期措辞 / L5-06·07 补测 / 状态机补全 / 不新增状态 / 门面架构）
- 日期：2026-10-16
- 关联：ADR-0020（rotation CAS，本 ADR 的直接前置）、M11.0a baseline、数据字典 §3.9、M3 遗留项④（auth.refresh-cleanup 定时任务）、路线 M11.2 → M11.3（fingerprint）→ M11.4（Key Ring）

## 背景

M11.1（ADR-0020）落地后，rotation 的并发正确性已闭环（N × A ⇒ exactly 1 × B，三方言 + 双实例验证）。但生命周期维度残留一个**密文滞留问题**：

1. A 轮换后，A 行的 `replacement_cipher`（可解出 B 的 AES-GCM 密文）没有独立回收路径——它只随**整行删除**消失；
2. 整行删除由 `auth.refresh-cleanup`（每日 cron）执行，条件是「A 自身 `expire_at` 早于 30 天前」——即 A 的密文在库里**可恢复期最长约 37 天**（7 天 token 有效期 + 30 天保留期），而它的合法用途（grace 恢复）只有 10 秒；
3. 现有测试覆盖 rotation 正确性，但 **A→B→C→D 全生命周期组合**（链式轮换中途 logout / logout-all / 改密撤销 / 孤儿 replacement / 密文清空后行为）没有专项回归层。

## 决策

1. **密文 grace 级清空（本 ADR 核心）**：`AuthStore` 新增 `clearExpiredReplacementCiphers(now: Date): Promise<number>`——
   `UPDATE refresh_tokens SET replacement_cipher = NULL, replacement_key_id = NULL, replacement_expires_at = NULL
    WHERE replacement_expires_at < :now`，返回受影响条数。
   - **`replacement_expires_at` 是唯一 cleanup 判据**：部分写入/历史脏数据（如 cipher/keyId 已 NULL 而 expiresAt 残留）同样被回收，清后三列必然全 NULL（满足决策 2 不变量）；
   - **幂等性由置 NULL 本身保证**：清空后 `expires_at` 为 NULL，不再满足 `expires_at < :now`，重复执行 count = 0——无需额外排除条件；
   - 清理窗口直接复用 `replacement_expires_at`（ADR-0020「时间基准」：CAS 时一次算好的 grace 终点）——**清理永不早于 grace 过期**，无窗口冲突，无需新配置键；
   - 只清三列，**保留 `revoked_at` / `replaced_by_id`**（轮换历史链与排障依据不丢——cleanup 是「敏感材料回收」，不是「rotation history cleanup」）；
   - 无 schema 变更、无迁移。
2. **Replacement metadata invariant（三列一致性）**：`(replacement_cipher, replacement_key_id, replacement_expires_at)` 必须**全 NULL 或全 NON-NULL**——未轮换与已清理态为全 NULL，grace 有效期为全 NON-NULL；禁止任何部分填充形态。不加 CHECK constraint（三方言 DDL 一致性成本 > 收益），由 Store contract test 锁死（任意操作序列后扫描内存存储 + 集成断言），作为 M11.4 Replacement Key Ring 的数据基础。
4. **两级清理接线**：现有 `auth.refresh-cleanup` cron 扩展为先 `clearExpiredReplacementCiphers`（**每次运行都执行**，回收密文）再 `purgeExpiredRefreshTokens`（30 天线，删行）；运行快照与 `/auth-maintenance/refresh-cleanup` 端点同步增加 `ciphersCleared` 与 `durationMs` 字段。`RefreshTokenService.cleanupReplacements()` 为**编排门面**（执行顺序 / 日志 / 快照），清库动作全部在 Store——延续 ADR-0020 Rule 8「Store 保持纯持久化抽象」。
5. **清空后的复用语义（钉死）**：cipher 清空后 A 再被使用 → store 走 `no_replacement` → 服务层按 ADR-0020 判 **replay（泄漏）→ 族撤销 + 3001**。此语义正确：清理点 = grace 终点，之后持有 A 还来换发只可能是泄漏；fail closed 行为与 M11.1 完全一致，不引入新分支。
6. **L5 生命周期测试层（新增）**：专项回归 A→B→C→D 全链——
   - 链式轮换中途 logout（单设备）：当前设备族死、其它族不受影响；
   - logout-all / 改密撤销：该用户全部族死，任何旧 token 复用 → 泄漏判定；
   - 孤儿 replacement：A 行被 purge 删除后，B 的 rotate / 撤销 / 过期清理行为不变（族语义只依赖 `familyId`，不依赖父行存在）；
   - cipher 清空：grace 过期清空后 A 复用 → 泄漏判定；
   - **清理只动 A 的 replacement，不碰 B**：cleanup 后 B 仍可正常 B→C（防未来重构误把 parent/replacement 链处理错）；
   - **cleanup 幂等**：第二次执行 ciphersCleared = 0，且 A.revokedAt / A.replacedById / B.tokenHash / B.revokedAt 全部不变；
   - 已有单测 TC-AUTH-006/007/008/010 保留为子集。
7. **不做 + 不新增状态（延续 ADR-0020 边界）**：
   - device fingerprint（M11.3）；JWT/Replacement Key Ring（M11.4，`version:keyId` 密文格式已留接口）；admin `/auth/keys` 可观测（M11.5）；refresh_tokens 软删业务路径（`deleted_at` 仅作 CAS 谓词防御，无业务调用方——如实登记，不实做）；
   - **不因 cleanup 新增任何状态/枚举**（`replacementExpired` / `rotationGraceEnded` 之类）：`replacement_expires_at > now` 已充分表达 grace 状态、`replacement_cipher IS NULL` 已充分表达「恢复材料不存在」——Active / Rotated+Grace / Rotated+Grace-Expired 全部是**派生状态**，不是数据库状态，认证模型保持干净。

### 状态机（含 cleanup 与 A→B→C→D 链）

```
                 refresh A
                     │
                     ▼
            ┌─────────────────┐
            │ A: active       │
            │ revokedAt=null  │
            └────────┬────────┘
                     │ CAS success（ADR-0020）
                     ▼
            ┌─────────────────┐
            │ A: rotated      │  B 已插入（B 可继续 rotate → C → D，同族）
            │ cipher=enc(B)   │  A→B→C→D 全链共享 familyId
            │ recoverableUntil│
            └────────┬────────┘
                     │
           ┌─────────┴──────────────┐
           │                        │
     grace > now               grace <= now
     （窗口内 retry）          （窗口已过）
           │                        │
           ▼                        ▼
     already_rotated          cleanup eligible（每日 cron）
     解密返回同一个 B               │
           │                        ▼
           │                 cipher/keyId/expiresAt = NULL
           │                 （revokedAt/replacedById 保留）
           │                        │
           │                        ▼
           │                    A retry
           │                        │
           │                        ▼
           │                 no_replacement
           │                        │
           │                        ▼
           │                 replay_detected
           │                        │
           │                        ▼
           │                 revoke family
           │
           └──► B 自身生命周期与 A 的 cipher 无关：
                cleanup 后 B 仍可正常 rotate → C（L5-07 锁定）
```

**派生状态说明**：Active / Rotated+Grace / Rotated+Grace-Expired 均由
`revokedAt` / `replacementExpiresAt > now` / `replacementCipher IS NULL` 派生，
不落地为数据库状态、不引入枚举（决策 7）。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| **行内三列置 NULL（本决策）** | 零 schema 变更；窗口复用 `replacement_expires_at` 单一基准；历史链保留 | 清理依赖 cron 执行频率（窗口外密文最多滞留一个调度周期） | — |
| 密文只存内存/Redis，库里不落 | 库内零密文 | 引入新基础设施，违背 ADR-0020「免 Redis」决策；多副本一致性复杂化 | 已被 ADR-0020 否决的方向不回退 |
| 清理逻辑并入 purgeExpiredRefreshTokens | 少一个方法 | 语义耦合：purge 是「删行」（30 天线），cipher 清空是「保值删敏感列」（grace 线），两条时间线、两类断言 | 独立方法可测可观测，cron 顺序编排 |

## 后果

**正面**：
- 可恢复密文的存在期从「最长 ≈37 天」收缩到：**cleanup cron 按计划正常执行时 ≤ grace 窗口 + 一个调度周期**（默认 10s + ≤24h）；cron 故障期间允许继续滞留，恢复后由下一次 cleanup 补偿回收——数据库长期不积累可解密材料；
- 泄漏取证保留完整（revokedAt / replacedById 不清），且密文消失本身就是「grace 已过」的可判事实；
- 生命周期组合行为首次有专项回归层，M11.3（fingerprint）与 M11.4（Key Ring 退役策略依赖 grace 级清理）的地基就绪。

**负面 / 代价 / 已知留白**：
- cron 失败期间密文滞留时间顺延（与现状等价，不劣化；快照暴露 lastError 供探查）；
- `clearExpiredReplacementCiphers` 是全表条件 UPDATE（`replacement_expires_at` 无索引）——数据量大后可考虑加索引，当前量级（单用户 <10 行）不值得，如实登记；
- L5 测试层与既有 TC-AUTH 系列存在部分重叠（logout/revoke 已有单测）——L5 以**组合链**为断言单位，重叠部分不删除。

## Definition of Done（M11.2 封板清单）

```text
[ ] ADR-0021 adopted
[ ] AuthStore.clearExpiredReplacementCiphers 三实现（Memory + example-api/模板 Prisma）
[ ] cron 两级清理 + 快照/端点 ciphersCleared 字段
[ ] L5 生命周期测试层全绿（全链 / 组合撤销 / 孤儿 / 清空后语义）
[ ] 本地三件套（auth / example-api / db）回归全绿 + tsc 0
[ ] CI 全绿（含 rotation spec 三方言腿）
[ ] CHANGELOG 登记
```
