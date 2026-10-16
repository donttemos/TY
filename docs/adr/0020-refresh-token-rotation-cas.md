# ADR-0020 · Refresh Token Rotation CAS：单 replacement 不变量 + 加密 grace 恢复 + replay 族撤销

- 状态：已采纳
- 日期：2026-10-16
- 关联：M11.0a baseline（`packages/auth/src/__tests__/refresh-token.m11-0a-baseline.test.ts`，5 failed / 5 passed 实测证据）、《M11.1 最终修改方案》（M11(PRD1-10善后).txt）、PRD-003 FR-02 / TC-AUTH-006/007/008、ADR-0005（认证）、ADR-0007（数据库可切换）

## 背景

M11.0a baseline 在不修改生产代码的前提下冻结了 `RefreshTokenService` 的并发/宽限行为，实测 **5 failed / 5 passed**。失败集中在三个「M11 目标不变量」上：

1. **一个旧 token A 并发 rotation 产生多个 replacement**（A→B、A→C、A→D...），而目标不变量是 N 并发(A) ⇒ 恰好一个 B；
2. **grace 内重复使用旧 A 每次都签发新 token**，而目标语义是「重试拿回同一个已签发的 B」；
3. 由此衍生的安全问题：攻击者与合法用户各自 refresh 得到 B、C **长期静默共存**。

根因：当前实现的「先查后改」（SELECT A → 判断 → UPDATE + INSERT）无原子性，grace 分支重新 `issueInFamily` 而非返回已签发的 replacement。

## 决策（8 条锁死规则）

1. **Rule 1（CAS 准入）**：rotation 权必须由条件更新（CAS）建立——`UPDATE refresh_tokens SET revoked_at=?, replaced_by_id=?, replacement_cipher=?, replacement_key_id=?, replacement_expires_at=? WHERE id=? AND revoked_at IS NULL AND deleted_at IS NULL AND expires_at > ?`，`affectedRows === 1` 即赢家；禁止「先 SELECT 判断再 UPDATE」。
2. **Rule 2（CAS 谓词完整性）**：CAS 谓词必须同时包含**未撤销、未软删、未过期**三个条件（`expires_at > now` 进数据库谓词，消除 check-then-act 的 TOCTOU 窗口）。
3. **Rule 3（原子提交）**：A 的更新与 B 的插入必须在同一事务内提交（Prisma interactive transaction）；事务内只允许这两条持久化操作，生成 B / JWT 签名 / SHA-256 / AES-GCM 一律在事务外完成（事务内禁 HTTP/Redis/RPC）。
4. **Rule 4（CAS 失败后必须离开原事务）**：CAS `affectedRows = 0` 后，当前事务**必须** rollback/结束；任何用于区分 `already_rotated` 与 `replay_detected` 的状态读取**必须**在事务外（新事务/新查询）执行。**禁止在原 CAS 事务内做判断性 SELECT**（MySQL REPEATABLE READ 快照会读到旧数据，实现者无例外）。
5. **Rule 5（唯一 replacement）**：一次成功 rotation 恰好创建一个 replacement B；B 自身只存 `tokenHash`（SHA-256），明文不落库（既有 hash-only 不变量保持）。
6. **Rule 6（grace 语义重定义）**：grace 不是「旧 token A 在窗口内仍然有效」，而是「rotation 完成后，同一客户端在窗口内重试时**返回已持久化的同一个 B**（解密 `replacementCipher`），绝不生成新 token」。grace 窗口默认 10s、上限 30s（配置约束 `0 < grace ≤ 30`）。
7. **Rule 7（存储最小暴露）**：A 行暂存 `replacementCipher`（AES-256-GCM 密文）仅供 grace 恢复，除此之外任何明文/可逆形式不得持久化；`AuthStore` 不感知 JWT/SHA-256/AES——服务层传入即用的不透明串。
8. **Rule 8（副作用编排 / 组件归属）**：replay 副作用（revoke family + revoke 用户全部 refresh + 审计/告警日志）由 **`RefreshTokenService`（`handleReplay()`）** 编排；**`TokenService` 不参与编排**，仅负责 JWT 签发/验签与 replacement 加解密；`AuthStore` 保持纯持久化抽象（persistence + CAS + 事实返回），不在存储层内部触发业务副作用。
   （原表述「由 TokenService（RefreshTokenService）编排」把编排者误记为 `TokenService`，2026-10-16 按实现澄清——见下方「组件职责边界」。）

### 组件职责边界（Rule 8 精确化）

Rule 8 的编排者**只有一个**：`RefreshTokenService`。三组件单一分层，为 M11.4 Key Ring 预留清晰切口：

```text
TokenService（packages/auth/src/token.service.ts）—— 纯计算：无状态、不落库、不编排
├── JWT 签发/验签（HS256；JWT_SECRET + JWT_SECRET_PREV 双密钥过渡期回退）
├── replacement 加解密（AES-256-GCM，encryptReplacement / decryptReplacement）
└── 密钥派生（HKDF-SHA256 域分离出独立 replacement 密钥域）

RefreshTokenService（packages/auth/src/refresh-token.service.ts）—— 唯一的编排者与策略持有者
├── rotation orchestration（rotate / rotateWithCas：事务外生成 B，再交存储层裁决）
├── grace policy（now <= replacement.recoverableUntil + 族存活前置校验）
├── family policy（revokeFamily / revokeAllForUser / cleanup）
├── replay handling（handleReplay：族撤销 + 用户全部 refresh 作废 + 告警日志）
├── error mapping（BizError 3001 未授权 / 3003 过期）
└── 令牌哈希（hashToken：SHA-256，明文 → 落库哈希的唯一入口）

AuthStore（packages/auth/src/auth-store.ts；Prisma / Memory 双实现）—— 纯持久化，零业务策略
├── persistence（create / find / purge / revoke 等 CRUD）
├── CAS（rotateRefreshToken 的原子裁决，affectedRows 语义，Rule 1/2）
└── state facts（只返回 rotated / already_rotated / replay_detected 事实，不返回策略）
```

- **SHA-256 的归属澄清**：令牌哈希（`hashToken`，SHA-256）在 `RefreshTokenService`，**不在** `TokenService`——`TokenService` 内出现的 SHA 仅为 HKDF 密钥派生。存储层收到的永远是已哈希的不透明 `tokenHash` 串（Rule 7）；
- **切口理由**：编排/策略耦合在服务层，密钥材料全部封在 `TokenService` ⇒ M11.4 Key Ring 只需替换 `TokenService` 的密钥来源（多 `keyId` + JWT TTL 级 / replacement grace 级双生命周期），`RefreshTokenService` 与 `AuthStore` 的编排、持久化契约**零改动**（`keyId` 已是 `already_rotated` 结果字段的一部分，见「接口契约」）。

### 状态机

```
              ┌──────────────────────────┐
              │ A: active                │
              │ revokedAt = null         │
              └────────────┬─────────────┘
                           │ CAS success（唯一赢家）
                           ▼
              ┌──────────────────────────┐
              │ A: rotated               │
              │ revokedAt = now          │
              │ replacedById = B.id      │
              │ replacementCipher = enc(B)│
              │ replacementExpiresAt     │
              │   = now + grace（窗口终点）│
              └────────────┬─────────────┘
                           │
              ┌────────────┴─────────────┐
              │                          │
        grace 内（窗口未过且族存活）    grace 外 / 族已死 / B 已失效
              │                          │
              ▼                          ▼
       already_rotated             replay_detected
              │                          │
        decrypt → 恢复原 B        revoke family + revoke sessions
              │                          │
           return B                 audit/alert + 抛 3001/3003

A 不存在 / A 已过期 ──────────────────▶ replay_detected
```

**关键澄清**：`already_rotated` **绝不是重新执行 rotation**——它只能解密恢复已持久化的原 B，任何从 A 生成第二个 replacement 的路径都被禁止（见下方 Security Invariant）。

### 时间基准（单次 rotation 单一 `now`）

同一次 rotation 内，`revokedAt`（写入 A）与 `replacementExpiresAt`（grace 窗口终点）**必须来自同一个应用时间基准**：

```ts
const now = new Date();
const replacementRecoverableUntil = new Date(now.getTime() + graceSeconds * 1000);
// 注意两个时间是不同的东西：
//   B 自身过期时间 = now + refreshTtl（B.expireAt，写在 B 行）
//   密文可恢复期终点 = now + grace（A.replacementExpiresAt 列，仅 grace 恢复语义）
```

禁止在 Rotation 过程中多次取 `Date.now()` 拼接判断——毫秒级漂移会让边界测试与 grace 判定出现不稳定结果。grace 评估因此收敛为一次列比较：`now <= A.replacementExpiresAt`（窗口终点在 CAS 时一次算好落库，grace 语义 = 「密文可恢复期」）。

### 安全不变量（Security Invariant）

> **SECURITY INVARIANT**：
>
> Once A has been successfully rotated, **no execution path may generate another replacement from A**.
>
> If A's persisted replacement cannot be recovered (decrypt failure / unknown keyId / B no longer active), the request **MUST fail closed** and the refresh-token family **MUST be revoked**.
>
> Generating C from A after replacement recovery failure is **forbidden**（否则重新打开 `A → B/C/D` race，对应故障注入 Case C）。

### 接口契约（Commit 2 定稿为必选，Commit 1 以可选方法 + 服务侧特性检测过渡）

`AuthStore.rotateRefreshToken(input)` 返回三态（结果只携带**事实**，不携带业务策略）：

```ts
type RefreshRotationResult =
  | { outcome: 'rotated'; replacementId: ID }
  | {
      outcome: 'already_rotated';
      oldToken: { revokedAt: Date; familyId: string };
      replacement: { cipher: string; keyId: string; recoverableUntil: Date };
    }
  | { outcome: 'replay_detected'; reason: 'not_found' | 'expired' | 'no_replacement' };
```

- `rotated` —— CAS 赢家，B 已由存储层原子写入；
- `already_rotated` —— A 已被并发请求轮换；`userId` **不进结果**（服务层已从旧记录获得，结果不重复承担业务语义）；grace 窗口与族存活评估由服务层完成；
- `replay_detected` —— `not_found / expired / no_replacement` 三种**存储层可判定**的事实；`grace_expired` 由服务层基于 `already_rotated.oldToken.revokedAt` / `replacement.expiresAt` 与族存活状态判定后走同一 replay 副作用路径（存储层不持 grace 策略，故该 reason 不在存储层契约内）。`RefreshTokenService` 统一执行副作用后抛 3001/3003（Rule 8）。

### 加密方案（Commit 1 即生效）

- AES-256-GCM，密文格式 `v1:{keyId}:{iv}:{ciphertext}:{tag}`（Base64URL 段），version 段为 M11.4 Key Ring 平滑升级预留；
- M11.1 单密钥：`keyId = replacement-v1`，密钥经 **HKDF-SHA256(jwtSecret, salt="fw/auth/replacement/v1")** 域分离派生（2026-10-16 勘误：本文原写作 `fw/replacement/v1`，实现 `token.service.ts` 的 `REPLACEMENT_HKDF_SALT = 'fw/auth/replacement/v1'`，以实现为准）——与 JWT 签名密钥同一来源但独立密钥域。**偏离方案原文**（原文要求独立 `REPLACEMENT_ENCRYPTION_KEY` 配置）：避免引入新配置键造成既有部署/测试破坏；HKDF 域分离在密码学上等效于独立密钥，显式独立密钥与环境变量登记留到 M11.4 Key Ring 一并落地；
- **轮换窗口已知限制（2026-10-16 评审登记 → M11.4 prerequisite，M11.1 不返工）**：replacement 密钥只从**当前** `jwtSecret` 派生，`decryptReplacement` 只持这一把派生密钥（`keyId` 恒为 `replacement-v1`，不标识密钥代际；JWT 验签侧的 `JWT_SECRET_PREV` 双密钥回退**不覆盖** replacement 解密）。`JWT_SECRET` 轮换部署（`JWT_SECRET=NEW` + `JWT_SECRET_PREV=OLD`）后：旧实例在轮换前写入的密文由 `HKDF(OLD)` 派生密钥加密，新实例验签旧 A 可经 PREV 回退放行，但解密只试 `HKDF(NEW)` → GCM 认证失败 → 按 Security Invariant fail closed 触发族撤销 → **误杀一个合法的并发 retry**（A→B 跨部署代际 + 客户端 grace 重试重叠的极端窗口）。**不为此推翻 HKDF 方案**——解决方案由 M11.4 Key Ring 承担，本条登记为其 prerequisite，要求与验收判据见下方「已知留白」。
- 解密失败（密文损坏 / keyId 未知）**必须报错并触发族撤销，绝不能生成新 token C**（否则重新打开 rotation race，对应故障注入 Case C）。

## 对方案原文的四点修正（评审结论，已并入本 ADR）

1. **grace 单位统一为秒**：方案原文提出 `REFRESH_ROTATION_GRACE_MS`（毫秒），但既有配置链路（`AUTH_REFRESH_GRACE_SECONDS` / `AuthOptions.refreshGraceSeconds` / test-helpers）全为秒——维持秒，不新增毫秒键，杜绝一套代码两套单位。
2. **B.tokenHash 唯一索引入 schema**（Commit 2）：主表 `token_hash @unique` 已存在，migration 同步给 `replaced_by_id` 建索引（family 撤销与 grace 恢复的查询路径）；幂等防线优先数据库唯一约束（本仓既定经验），CAS 之外加一层兜底。
3. **迁移与发布兼容**：新列（`replaced_by_id / replacement_cipher / replacement_key_id / replacement_expires_at`）全部 **nullable**，旧代码（未升级的 PrismaAuthStore 走 legacy 路径）与新 schema 互相兼容；发布顺序 = 先 migration 后发版；回滚 = 旧版本代码可直接跑在新 schema 上（新列被忽略），无需数据回填。三库矩阵（main + pg 变体 + matrix mysql/postgresql + test sqlite）与模板 schema 同步加列，migration SQL 三方言各一份且语义一致。
4. **Rule 8 组件归属澄清**：方案原文 `M11(PRD1-10善后).txt` 的 Rule 8 写作 "Replay side effects are orchestrated by **TokenService**, not AuthStore"——组件名不准确：编排者是 `RefreshTokenService.handleReplay()`，`TokenService` 仅做 JWT 签发/验签与 replacement 加解密。结论实质不变（副作用**绝不**进 `AuthStore`），此处仅登记命名澄清，防止 M11.4 做 Key Ring 时沿用「TokenService 负责编排」的错误前提去拆改造面。

## 测试分层（完成标准）

| 层 | 内容 | 载体 |
|---|---|---|
| L1 Baseline | M11.0a 10 条**原样保留、禁止改断言迁就**；M11.1 完成后 5 failed → 10 passed | `refresh-token.m11-0a-baseline.test.ts` |
| L2 内存并发 | 2/10/100 并发 rotation ⇒ unique replacement = 1 | Commit 3 新增 |
| L3 Prisma 集成 | SQLite 真库 + 事务回滚 + CAS；跨实例（双进程打同一真库）100 并发 ⇒ 1 replacement | Commit 3；跨实例跑测试机 106（测试环境）与 GH Actions service DB |
| L4 故障注入 | Case A CAS 成功 INSERT B 失败→回滚 A 仍活；Case B CAS 失败 grace 内→already_rotated；Case C 密文损坏→报错+族撤销绝不签发 C；Case D grace 过期→replay；Case E B 已用后 A replay→族撤销；Case F A 过期→拒绝 | Commit 3 新增 |

CI 门禁最低线（合并前必须全绿）：baseline = PASS、100 并发 = PASS、rollback = PASS、双实例 = PASS。

## 后果

**正面**：
- 「一个 A 只有一个 B」成为数据库级保证，并发/重试/故障三类路径全部收敛到同一不变量；
- 攻击者共存模型从「长期静默共存」变为「下一次竞争性 refresh 必触发 replay 检测 → 整族撤销」；
- grace 重试从「每次新签发」变为「解密恢复」，消除并发刷新的 token 膨胀。

**负面 / 代价 / 已知留白**：
- 不做 fingerprint（M11.3）：持有 A 的任意方（含攻击者）在 grace 内都能拿回 B——这是 M11.1 的显式取舍，baseline-009 冻结该现状，M11.3 引入客户端指纹后翻转为拒绝；
- 族存活检查与 grace 判定在服务层、CAS 在存储层，两层之间存在毫秒级 TOCTOU 窗口（登出瞬间恰好 grace 重试可能拿到已撤销前的 B）——窗口远小于网络往返，接受并记录；
- known-keyId 单密钥：密钥泄露需全量轮换，M11.4 Key Ring（JWT TTL 级 / Replacement grace 级双生命周期）解决；
- **JWT Secret 轮换窗口（2026-10-16 评审登记 → M11.4 prerequisite，M11.1 不返工）**：轮换过渡期（`JWT_SECRET=NEW` + `JWT_SECRET_PREV=OLD`）内，旧实例写入的 replacement 密文（`HKDF(OLD)` 派生密钥加密）在新实例解密必失败——解密无 PREV 回退路径，`keyId` 又不标识代际（详见「加密方案」末条）→ fail closed 族撤销 → 误杀合法并发 retry。M11.4 Key Ring 因此增加一条 **prerequisite**：① replacement 密文必须能在 `JWT_SECRET` / `JWT_SECRET_PREV` 双来源间回退解密（密文 version / keyId 段携带派生代际标识）；② replacement key 退役条件覆盖 `max(grace, 轮换重叠期)`，不得早于旧密文可恢复期终点；③ **验收判据**：双 secret 部署下旧密文在 grace 内可恢复原 B 且不触发族撤销（反向验证：回退缺失时 fail closed 族撤销仍然成立——Security Invariant 不因轮换兼容而松动）。
- 时钟策略：grace 比较用应用时间，多实例依赖 NTP 同步（部署环境 SHOULD NTP）；不为 10s 窗口引入 DB 时钟接口。

## Definition of Done（M11.1 封板清单，全部勾选才可合并）

```text
[x] ADR-0020 adopted
[x] baseline 10/10 PASS（M11.0a 原样，未改断言）
[x] Memory 100 concurrency PASS（unique replacement === 1，exactly 而非 <=）
[x] Prisma transaction rollback PASS（Case A，token_hash 唯一约束注入 INSERT B 失败）
[x] Prisma CAS PASS
[x] SQLite integration PASS（独立临时库 + migrate deploy；注：SQLite 单写者 + 连接器超时，
    本地并发容量实测稳定上限 10——store 已放宽事务超时 15s；下方三库与容量线以 CI 为准）
[x] PostgreSQL integration PASS（run 38866505347，service DB 独立库 fw_rotation）
[x] MySQL integration PASS（run 38866505347；RR 快照陷阱由 Rule 4「事务外重读」结构性消除并经真库回归）
[x] dual-instance 100 concurrency PASS（CI run 38866505347：2 独立进程 × 50 并发打同一 MySQL/PG，
    进程间唯一共享状态 = 数据库；脚本 scripts/dual-instance-rotation.mjs）
[x] Case A–F PASS（A/C 在 L3 集成，B/D/E/F 在 L4 注入，L2 并发补充 Case B）
[x] DB 无明文 replacement token；token_hash 保持 hash-only
[x] 不存在任何「从已轮换的 A 再生成 replacement」的路径（Security Invariant，Case C/E 证明）
[x] CAS 失败后绝不从原事务快照读状态（Rule 4，事务外重读路径已测）
[x] replay 副作用留在 `RefreshTokenService`（Rule 8；AuthStore 零业务副作用，TokenService 零编排）
[x] CI green（run 38862407905：4/4 job 全绿——构建/单测(SQLite)/静态 + 集成 mysql/postgres/sqlite）
```

> **CI 收口注记（2026-10-16 终态）**：rotation spec 与双实例脚本已挂进 CI 集成矩阵 MySQL/PG 腿
> （独立库 fw_rotation 与 packages/db 矩阵库隔离；run 38866505347 全绿）。**MySQL 踩坑记录**：
> `String` 默认 VARCHAR(191) 装不下真实密文（JWT≈460B → base64url≈620C），mysql 变体
> replacement_cipher 须标 @db.Text（SQLite/PG 的 String 本为无限文本，故仅 mysql 变体有此差异）。
> M11.1 至此 DoD 全项达成。另修独立小缺陷：issue() 返回 jti 与 JWT 载荷内 jti 背离（bf2055d）。
