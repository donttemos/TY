# ADR-0023 · M11.4 双 Key Ring：Replacement 密钥代际回退 + JWT kid 路由 + 退役窗口规则

- 状态：已采纳（2026-10-16 评审通过，5 条意见全落实：legacy 路由严格优先级 / kid 角色标识定位 / 解析规则冻结含 bytes 计量 / 显式 Ring 后 legacy 行为写死 / Rule 6 禁 brute-force）
- 日期：2026-10-16
- 关联：ADR-0020（rotation CAS；其「加密方案」与「已知留白」登记了本 ADR 的 **prerequisite 三条 + 验收判据**）、ADR-0021（grace 级 cipher 清理 = 密钥退役窗口的计算基础）、ADR-0022（AUTH_FINGERPRINT 先例：配置键四处登记模式）、M3 TC-AUTH-014（JWT_SECRET_PREV 双密钥验签现状）

## 背景（M11.4 的两条 prerequisite，均已在 ADR-0020 登记）

1. **Replacement 密钥代际陷阱**：M11.1 起 replacement 密钥 = `HKDF(JWT_SECRET)` 单代派生（`keyId` 恒为 `replacement-v1`，不标识代际；`JWT_SECRET_PREV` 双密钥回退只覆盖 JWT 验签、**不覆盖 replacement 解密**）。`JWT_SECRET` 轮换部署（`JWT_SECRET=NEW` + `JWT_SECRET_PREV=OLD`）后：旧实例写入的密文由 `HKDF(OLD)` 加密，新实例只试 `HKDF(NEW)` → GCM 认证失败 → fail closed 族撤销 → **误杀合法并发 retry**（极端窗口：A→B 跨部署代际 + grace 重试重叠）。
2. **JWT 验签无 kid**：`setProtectedHeader` 只有 alg；verify 靠 current→prev 顺序双试。正确性已覆盖，但无代际可观测性，且 key 管理散在两个字符串字段，无 Ring 结构。

切口已在 ADR-0020 预留：密钥材料全部封在 `TokenService` ⇒ Key Ring 只替换其密钥来源，`RefreshTokenService` / `AuthStore` / rotation 核心算法**零改动**（本轮红线）。**红线边界（硬规则）**：Ring 逻辑只允许存在于 `TokenService`（JWT Ring：sign/verify；Replacement Ring：encrypt/decrypt）——**严禁渗入** `RefreshTokenService` / `AuthStore` / `PrismaAuthStore` / `MemoryAuthStore` / CAS / grace 状态机，否则会重新打开 M11.1/M11.3 已封死的边界。

## 决策（提议稿）

1. **统一 Key Ring 抽象（新 `key-ring.ts`）**：`{ currentKeyId, keyFor(keyId): Buffer | null }`——两个域各自实例化：
   - **Replacement Ring**：显式配置 `AUTH_REPLACEMENT_KEYS`（`<keyId>:<secret>` 列表，`|` 分隔）→ `currentKeyId` = 列表末位（最新）；**未配置时回退现状**：`currentKeyId = replacement-v1`，密钥 = `HKDF(JWT_SECRET)`（M11.1–11.3 部署零配置零破坏）。
     **解析规则（冻结，启动即校验）**：① keyId 禁含 `:` 与 `|`；② secret 禁含 `|`（避免分割歧义）；③ 空 entry（连续 `|` / 空段）**启动即失败**；④ 重复 keyId **启动即失败**；⑤ secret 长度 **≥ 32 UTF-8 bytes**（非 JS 字符数——多字节字符按字节计）。
   - **JWT Ring**：由现有 `JWT_SECRET`（current）/ `JWT_SECRET_PREV`（previous）构造，**不引入新配置键**——行为与现状等价，仅形式化结构（见决策 3 的 kid 路由增量）。
2. **代际回退解密（prerequisite ①，本 ADR 核心交付）+ Rule 6：Key ID 路由优先级（硬规则）**——`decryptReplacement` 必须严格按以下顺序，**禁止「遍历所有 Replacement keys 直到某个能解密」的 brute-force 默认行为**（否则 keyId 失去路由边界、扩大错误密钥尝试面）：
   - **① 显式命中**：密文 keyId 存在于显式 Replacement Ring → **仅使用该 key 解密；失败即 fail closed，禁止继续尝试其它 key**；
   - **② legacy 回退链**：keyId == `replacement-v1` 且显式 Ring 不包含该 ID → 依次 `HKDF(current)` → `HKDF(prev)`（若配置）→ 全失败才 fail closed（Security Invariant 不松动）；
   - **③ 未知 keyId / 格式非法** → 直接 fail closed。
   顺带修复 M11.3 审计发现（ADR-0022 决策 3 注记）：`keyId` 未知与格式非法同走 fail closed，不产生新密文。
3. **退役窗口规则（prerequisite ②，规则进 ADR + 运维文档）**：replacement key 从 Ring 移除（retire）**不得早于** `max(grace, cleanup 调度周期) + 轮换重叠期`；硬安全条件 = 该 keyId 名下所有 cipher 已被 ADR-0021 的 `clearExpiredReplacementCiphers` 回收（判据：库中 `replacement_key_id = 该 keyId 且 replacement_expires_at IS NOT NULL` 的行数为 0）。retired key **保留在配置注释/运维台账中**（不进运行时 Ring），解密需要时临时加回。
4. **JWT kid 路由（决策 3 增量）+ kid 语义定位（DR-0023-02）**：sign 时 header 写 `kid`（current → `jwt-current`、previous → `jwt-prev`）；verify：带 kid 且可识别 → 优先对应密钥，失败回退双试（兜底，正确性不依赖 kid）；**无 kid（存量 token）→ 维持现双试行为**。**语义定位（冻结）**：`jwt-current` / `jwt-prev` 是**角色路由标识**而非跨部署稳定的密钥身份——一次轮换后旧代际的 token 上仍写着 `jwt-current`（签发方视角），kid 的核心价值（稳定定位密钥代际）在本版**不承诺**；真正稳定的 kid（基于 secret 指纹或显式 keyId 配置）留给 M11.5。
5. **显式 Ring 配置后的 legacy 数据行为（M11.4 最关键兼容性验收，写死）**：

   ```
   存量（M11.1–11.3）：keyId = replacement-v1，密文 = AES-GCM(HKDF(JWT_SECRET_OLD))
   新部署：AUTH_REPLACEMENT_KEYS = replacement-v2:NEW_REPLACEMENT_SECRET
           JWT_SECRET = NEW，JWT_SECRET_PREV = OLD
   ```
   此时 `replacement-v1` 密文的路由：显式 Ring **不含** replacement-v1 → legacy 回退链 → `HKDF(NEW)` **失败** → `HKDF(OLD)` **成功** → 恢复原 B，**不触发族撤销**。这条跨代际恢复就是 M11.4 的核心兼容性验收（对应 L7 用例 + 双实例轮换部署集成测试）。
6. **不做**：rotation 核心算法零改动（红线）；不自动轮换/不自动退役（运维显式操作）；不引入 KMS/外部密钥服务；JWT Ring 不加新配置键。

## 备选方案

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **显式 Ring + legacy HKDF 回退链（本提议）** | prerequisite ①② 全满足；存量零迁移；零破坏 | 两种密钥来源并存（显式 + HKDF）需测试覆盖 | 接受——回退链只在 legacy keyId 上激活 |
| 立即强制显式 Ring（废弃 HKDF） | 单一来源 | M11.1–11.3 存量密文全量失效 → 违反 Security Invariant | 否决 |
| JWT 全面 kid 化 + 多代配置 | 彻底 | 配置膨胀 + 跨实例 kid 语义问题 | 拆 M11.5 |
| DB 存密钥（SecretPort，PRD-011 S-40） | 集中管理 | 依赖面扩大 | S-40 独立交付，本 ADR 只留环境变量面 |

## 测试计划（L7 Key Ring 层）

- 代际回退：`HKDF(OLD)` 加密的密文在 `JWT_SECRET=NEW + PREV=OLD` 部署下解密恢复 B，**不触发族撤销**（prerequisite ③ 验收判据正向）；
- 反向：回退链全失败（两个 secret 都解不开）→ fail closed 族撤销（Security Invariant 不松动）；
- 显式 Ring：current 签发/keyId 路由/未知 keyId fail closed/`AUTH_REPLACEMENT_KEYS` 解析（含非法格式启动即失败）；
- JWT kid：sign 带 kid / verify kid 路由 / 无 kid 存量兼容 / kid+双试兜底；
- 双实例脚本扩展：轮换部署形态（parent 用 OLD 派生写、child 用 NEW+PREV 解）——可选集成项；
- 退役窗口：规则文档化 + 判据查询方法（M11.5 可视化挂靠点）。

## 实施顺序（Commit 1–5）

```text
Commit 1  key-ring.ts + 配置解析 + Replacement Ring + JWT Ring + 单元测试（解析规则/构造校验）
Commit 2  encrypt/decrypt 路由 + legacy HKDF current→prev 回退 + unknown key fail-closed + 故障注入
Commit 3  JWT kid（sign 带 kid / verify 路由 / 无 kid 存量兼容）
Commit 4  双实例 OLD → NEW+PREV 轮换部署集成测试 + M11.2 cipher cleanup 后 key retirement 判据测试
Commit 5  ADR-0023 DoD 收口 + CI 全绿 → 进入 M11.5
```

## Definition of Done（M11.4 封板清单）

```text
[ ] ADR-0023 adopted
[x] KeyRing 抽象 + Replacement Ring（显式 AUTH_REPLACEMENT_KEYS + legacy HKDF 回退链）
[x] 代际回退解密：轮换部署下旧密文 grace 内恢复原 B 不触发族撤销（prerequisite ③ 正向；含显式 replacement-v2 + legacy replacement-v1 跨代场景，本地 SQLite + CI mysql/pg）
[x] Rule 6 路由优先级：显式命中失败不试其它 key（即使另一 key 能解）/ legacy 回退链 / 未知 keyId fail closed / 禁全 Ring brute-force
[ ] 反向：回退全失败 → fail closed 族撤销（Security Invariant 不松动）
[x] JWT kid 路由（sign 带 kid / verify 路由 / 无 kid 兼容 / 双试兜底；kid=角色路由标识，稳定 kid 留 M11.5）
[x] 退役窗口规则文档化（docs/60 + 运维判据：keyId 名下未过期 cipher 行数为 0）
[x] L7 测试层全绿 + 三件套回归全绿（auth 199/199 含 L7 17 条、example 108/108、config 16/16；rotation 核心：baseline/L5/L6/集成 spec 零改动全绿——红线验证 ✓）
[x] 配置键四处登记（env-schema + ENV_KEY_PATHS + .env.example + docs/60）
[ ] CI 全绿（含 rotation spec 三方言腿 + 双实例）
[ ] CHANGELOG 登记
```
