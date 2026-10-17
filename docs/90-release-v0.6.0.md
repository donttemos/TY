# v0.6.0 发布验收报告

- 状态：已发布（2026-10-17）
- 版本：`0.6.0`（全仓 16 个 `package.json` 统一，含根与全部 workspace 成员；admin 模板保持生成项目起始版本 `0.1.0` 独立演进）
- 发布提交：`457b719`（chore(release): v0.6.0）
- 发布 tag：`v0.6.0` → release 提交后的 **CI 收口终提交**（`7c3d1ff`：smoke-queue refresh-cleanup 等待窗放宽 + 诊断增强 + maintenance 端点 ops:read 守卫化后的冒烟持令牌修复，对应 CI run base + 集成矩阵全绿；与 v0.5.5「tag 指向 release 后继」惯例一致）
- 本版定位：**M11（PRD-011）认证核心强化全五阶段成版 + M12（PRD-012）可观测与运维边界 W1~W3 全部交付 + @fw/cache 缺陷清单 13 项修复与跨驱动契约测试基建**

## 1. 交付范围

### 1.1 M11 认证核心强化（ADR-0020 ~ 0024，五阶段全交付）

| 阶段 | 内容 | 关键产物 |
|---|---|---|
| M11.1 | Refresh Token Rotation CAS | 存储层 CAS 三态裁决（`rotated / already_rotated / replay_detected`）、replacement AES-256-GCM 密文 + HKDF 域分离、grace 重试返回同一 B、族撤销 fail closed；Prisma 交互式事务 + 事务外判定性重读；双实例 CAS 脚本与 CI 真库矩阵（exactly 1 replacement） |
| M11.2 | 生命周期完整性 | `clearExpiredReplacementCiphers`（密文回收 + 30 天删行两级清理）、cron 扩展、Replacement metadata invariant 契约锁定 |
| M11.3 | Client Fingerprint | 指纹 = SHA-256(normalizeUserAgent)，IP 不参与；CAS 原子写入 `rotated_fingerprint` 列；异客户端 grace 重试 → replay 安全事件（baseline-009 翻转） |
| M11.4 | 双 Key Ring（ADR-0023） | ReplacementKeyRing + JwtKeyRing 密钥轮换；`AUTH_REPLACEMENT_KEYS` 多代 Ring；代际回退验收 fail closed |
| M11.5 | Key Ring 可观测性（ADR-0024） | 稳定 kid（sha256 前 16 位）、verify kid 四分支路由、`GET /auth-maintenance/key-ring` retirable 判据 |

### 1.2 M12 可观测与运维边界（PRD-012，W1~W3 全交付，ADR-0025 ~ 0027）

| 波次 | 内容 | 关键产物 |
|---|---|---|
| W1 | 统一审计事件契约 + replay 链路修复（OBS-04~07） | `AuditLogRecord/AuditEntry` 增 6 契约字段；`audit_logs` + 归档表软增列（migration `20261017110000` 三方言同构）；handleReplay 九要素 + 5 调用点补 ip/ua；`LogRecord.code` 一等字段；`docs/40` §1.3 details 口径修正 |
| W1 收口 | 错误族收敛 + 禁裸抛 + 码表单一来源（OBS-01/02/03/08） | telemetry/Transport/ConfigValidation 错误族并入 BizError 判类；`check-no-raw-throw` 门禁（存量 ~60 处迁移）；`error-codes.json` 工件 + triway 轴 G 三副本断言；core 16 码信封契约测试 |
| W2 | Observability 贯穿（OBS-09~14） | requestId（ULID + `X-Request-Id`，信封 additive）与 traceId 分层（ADR-0026）；ALS 增 familyId/jti；logger 自动身份（`LOG_IDENTITY_FIELDS`）；`fw_auth_*`/`fw_security_*` 指标段 + 基数护栏；observability-chain 集成用例；审计过滤 +5 键（白名单外 400，CSV/mock 同构） |
| W3 | 运维端点安全边界（OBS-15~19，ADR-0027） | maintenance 三端点 `@Public`→`ops:read` 守卫 + no-store；`docs/46-ops-endpoints.md` 普查矩阵；`DEMO_ENDPOINTS_ENABLED`（非 dev 默认 404）+ DemoEndpointsGuard ×4；快照公共字段集冻结；`check:helm` 扩 Nginx 三份一致性轴（65/65） |

### 1.3 @fw/cache 缺陷清单修复（13 项 + 契约测试基建）

独立复核《Cache缺陷清单》13 项（11 项属实、C-03 条件修正、A-05 代码属实）后两批修复：

| 项 | 内容 |
|---|---|
| C-01/C-03/A-04 | `CacheStorePort` 新增 `setWithTags` / `invalidateByTag` 原子方法（memory 同步原子 / redis 双 Lua）——写值+标签登记、读成员+删成员+删索引单次原子完成；fail-open 失效不再误删索引；已登记 redis-cluster 跨 slot 限制 |
| C-02 | 锁 `release` 改由共享持有记录深度决定 + 幂等（修复普通句柄先释放连重入方一起放锁） |
| C-04 | 看门狗周期 `max(50ms, TTL/3)`（短 TTL 先于过期续期）+ `onLost` 失锁感知回调 |
| C-05 | redis `close()` 超时真正强制 `disconnect()` + 防 unhandled rejection |
| C-06 | 参数哈希升级 SHA-256 + 类型可区分规范化编码（消除 `[undefined]≡[null]` 等确定性碰撞；函数按源码区分；Set/Map/Date 专属编码） |
| A-01 | memory 驱动 WRONGTYPE 语义对齐（类型冲突显式失败）+ `store-contract.test.ts` 双驱动共享契约测试（11 组） |
| A-02/A-06 | 限流：`TokenBucketTakeResult` 运行时形状校验、中间件兜底遵循 failOpen、构造期校验 fail-fast |
| A-03 | `updateRuntimeOptions` 与调用级 TTL 校验；`mset` 非事务契约显式化（CacheService + docs/contracts/cache.ts 双登记） |

### 1.4 工程门禁与文档

- 新增门禁：`check-no-raw-throw`（裸抛治理）、`check-triway-consistency`（框架包 ↔ example-api ↔ admin 模板七轴对撞）；`check-api-parity` 重构共用 `scripts/lib/api-parity-core.mjs`。
- 新文档：`docs/45-observability-contract.md`、`docs/46-ops-endpoints.md`、ADR-0020 ~ 0027、PRD-012 交付中文档。
- 契约同步：`docs/contracts/cache.ts`（release 语义冻结 / `LockOptions.onLost` / invalidateTag 原子语义 / mset 非事务）。

## 2. 回归证据（发布前本地全绿）

| 范围 | 结果 |
|---|---|
| 13 包单测（core 29 / logger 25 / config 16 / config-center 54 / auth 224 / cache 149 / queue 156 / storage 45 / telemetry 53 / tenant 34 / transport 93 / db 83+12skip / cli 120） | 全绿 |
| example-api | 120/120（含 observability-chain 集成用例） |
| admin-web | 单测 186/186 + mock 冒烟 0 失败 |
| 静态门禁 | `check:headers` / `check:no-raw-throw` / `check:api-parity` / `check:triway-consistency`（七轴）/ `check:helm`（65/65）全绿 |
| CI | base + 集成矩阵 sqlite / postgres / mysql 四腿 success（release 提交 run） |

## 3. 升级影响（v0.5.5 → v0.6.0）

1. **数据库迁移**：`prisma migrate deploy`（`20261016140000_add_refresh_replacement`、`20261016193000` 指纹列、`20261017110000_add_audit_event_contract` 三方言）。
2. **存量环境需 reseed 或手工补权限点**：`ops:read`（maintenance 三端点由 `@Public` 收敛为权限守卫；此前直接调用 maintenance 的脚本/探针需改持有该权限的账号）。
3. **新配置键**（`ENV_KEY_PATHS` 97 → 120）：`AUTH_REPLACEMENT_KEYS`、`AUTH_FINGERPRINT`、`REQUEST_ID_ENABLED/HEADER`、`METRICS_AUTH_SECTION_ENABLED`、`LOG_IDENTITY_FIELDS`、`DEMO_ENDPOINTS_ENABLED` 等；均含默认值，不设置可启动。
4. **行为变更（消费方注意）**：
   - 审计导出 CSV 扩列至 15 列（`...traceId,requestId,familyId,category,event,before,after`），CSV 解析方按表头取列；
   - `@Cacheable` 默认键升级 SHA-256，旧缓存条目一次性自然失效（等 TTL 过期，无脏读）；
   - maintenance 三端点鉴权收紧（见第 2 条）；demo 自检控制器非 dev 环境默认 404（`DEMO_ENDPOINTS_ENABLED` 显式开启）；
   - 审计过滤参数白名单收紧（未知参数 400/1001，新增 `simulate` 透传）。
5. **redis-cluster 已知限制**：`setWithTags` / `invalidateByTag` 多键 Lua 跨 slot 不可用（CROSSSLOT），标签失效能力在 cluster 下需 hash-tag 同 slot（`store.port` 与驱动已登记）。

## 4. 发布产物

- 发布提交 / tag：见文首（tag `v0.6.0`）。
- CI：release 提交与其后继（tag 所指）对应 run base + 集成矩阵 sqlite/postgres/mysql 全绿。

## 5. 遗留问题（登记，不阻塞发布）

- ~~AC-OBS-07 的 `request_id` 已于 W2 落地；**真机 1Panel maintenance 边界实测 + AC-OBS-13 排障样例实测**待部署窗口（需用户配合）。~~ **已于 2026-10-17 部署窗口完成**，见 §6。
- K8s NetworkPolicy 评估（E-05）、storage S3 端口实测（E-09）、长压实测（E-11）维持暂缓登记。
- 真 Redis 单实例集成与双进程分布式锁验证（回归测试设计 §9.4）待 CI 挂服务后接入。
- 线上 Nginx 实例与仓库模板漂移（`/metrics` 未建 location，落 SPA 回退）——部署侧对齐跟进（OBS-19，见 §6.2）。

## 6. 发布后真机实测与补丁（2026-10-17，v0.6.0 之后）

发布 tag 之后按计划打了**部署窗口**，把 v0.6.0 部署到 1Panel 真机（`106.55.32.251` / `APP_ENV=prod`）并执行 M12 真机验收。完整数据见 [docs/63 §6](./63-1panel-real-deploy-verification.md)。

### 6.1 实测结论

- **发版路径**：`git archive` 投送 → 服务器构建（100 s）→ 6 条迁移（audit_archives / notifications / upload_files / refresh_replacement / refresh_fingerprint / audit_event_contract）→ reseed（**43 权限点，含 `ops:read`**）→ 前端 rsync → 软链原子切换 → 2 s 内 `/health` 200、`/ready` 四依赖 ok。旧 release 保留可秒级回滚，本次迁移全 additive。
- **W3 边界（OBS-15/16/19）**：maintenance 三端点 `401/3001`（无 token）、`403/3002`（alice）、`200 + no-store`（admin）逐项符合；公网入口同判据；demo 自检面 404；`/health`/`/ready` 200；`/metrics` 含 `fw_auth_*`/`fw_security_*`。
- **OBS-13 链路**：真实 replay 一次，`X-Request-Id`/`X-Trace-Id` ↔ 信封 ↔ `audit_logs` 九要素（含 `category=security`）↔ journald 日志（`auth.refresh` ctx 身份 + `exception-filter` `code=3001`）↔ `fw_security_replay_detected_total{reason="fingerprint_mismatch"} 1`，四处一致；审计检索 `request_id`/`category`/`event` 过滤与白名单外 400 均实测。汇总断言 **40/40 通过**。
- **升级影响第 2 条（reseed 补 `ops:read`）**：真机走通（admin 持有 / alice 不持有）。

### 6.2 实测抓出的缺陷与补丁

| # | 缺陷 | 处置 |
|---|---|---|
| 1 | **`DemoController` 漏挂 `DemoEndpointsGuard`**：W3 只给 demo-queue / demo-transport / cache-demo 加了守卫，`APP_ENV=prod` 下 `/api/v1/demo/*`（含 `/demo/ok`、`/demo/items` CRUD）**公网 200**，与 `docs/46` §4 漂移 | 补 `@UseGuards`（commit **`0944864`**）+ `demo-endpoints.guard.spec.ts` 增四控制器 guard 挂载元数据断言；重建重发后四端点与公网均 404 |
| 2 | `docs/45` 排障样例：1Panel 档日志在 journald（`docker logs` 不可跑）；公共 refresh 路由 ALS 无 userId（顶层只有 requestId，userId 在 `ctx`） | 文档修正（补 journalctl 变体 + 口径说明），契约不变 |
| 3 | 线上 Nginx 实例仍是 v0.2.0 手写 `fw-locations.inc`（仅 `/health`、`/ready`；`/metrics` 落 SPA 回退返回 index.html），与仓库 `deploy/nginx` 模板的内网 allow/deny 漂移 | **未在窗口内改线上配置**（影响探针/排障面），登记为 OBS-19 部署侧对齐项 |

> 补丁 `0944864` 未进入 `v0.6.0` tag，属「发布后真机验证补丁」；tag 语义与发布产物不变，升级到 `main`（或 cherry-pick 该提交）即获得修复。
