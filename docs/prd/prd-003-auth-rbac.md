# PRD-003 · 鉴权与权限（RBAC）

> 里程碑：M3 ｜ 状态：**已实现（代码就绪，待发版 v0.1.0）** ｜ 优先级：P0 ｜ 依赖：M1、M2 ｜ 负责人：donttemo ｜ 更新：2026-10-13
>
> 实现载体：`packages/auth`（`@fw/auth`）+ `apps/example-api/src/modules/auth`。验收记录见 §10。

## 1. 背景与目标

登录与权限是每个系统都要做、又最容易做漏的部分（越权、令牌泄漏、无审计）。

目标：提供**默认安全**的鉴权能力——双 token、RBAC 到按钮/接口粒度、策略可插拔、操作留痕；业务方零配置即可用，也可按需替换策略。

衡量：模板项目开箱具备登录/角色/权限/审计；安全用例（越权、重放、爆破）全部被拦截。

## 2. 范围

**做**：注册/登录/登出/刷新、双 token 与轮换、RBAC 五表模型、可插拔认证策略（JWT / Session / OAuth2 / API Key）、权限守卫与装饰器、登录安全加固、审计日志。

**不做**：单点登录（SSO）/ LDAP 深度集成（M8 评估）、多租户级权限（PRD-008）、前端页面（PRD-005）。

## 3. 用户故事

- 作为管理员，我给角色勾选菜单与按钮权限，用户重新登录后立即生效。
- 作为开发者，我在接口上加一个 `@Permissions('order:refund')` 即可完成鉴权，不用手写判断。
- 作为运营，我能查到「谁在什么时间改了哪条订单的哪个字段」。
- 作为开放平台接入方，我用 API Key + 签名调用开放接口，无需走登录流程。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 账号体系 | 注册（可开关）、登录（用户名 / 手机号 / 邮箱）、登出、修改密码、重置密码；密码用 Argon2id（退化 bcrypt）存储，永不明文 |
| FR-02 | 双 token | access token 2h；refresh token 7d 且**每次刷新轮换**，旧 refresh 作废；检测到旧 refresh 复用即判定泄漏并踢下线 |
| FR-03 | 令牌失效 | 登出/改密/禁用账号进黑名单（Redis，小系统可用内存），黑名单 TTL = token 剩余有效期 |
| FR-04 | RBAC 模型 | 五表：`users / roles / permissions / user_role / role_permission`；权限点覆盖菜单、按钮、接口三类，粒度 `资源:操作` |
| FR-05 | 权限守卫 | `@Permissions()` 装饰器 + 全局守卫；未登录 → `3001`，无权限 → `3002`；支持 `@Public()` 放行 |
| FR-06 | 策略可插拔 | Passport 策略：`jwt`（默认）、`session`（内网后台可选）、`oauth2`（微信 / 企业微信 / GitHub）、`apikey`（开放接口），由 `AUTH_STRATEGY` 与路由元数据选择 |
| FR-07 | 登录安全 | 同 IP + 账号失败 5 次锁定 15 分钟；登录接口限流；密码强度策略可配；支持预留验证码/滑块钩子 |
| FR-08 | 审计日志 | 记录操作人、时间、IP、模块、动作、变更前后值（敏感字段脱敏）；写入独立表，支持按人/对象查询，保留期可配 |
| FR-09 | 菜单与路由 | 权限树接口返回用户可见菜单，供前端动态渲染（前后端权限同源） |
| FR-10 | 数据权限（预留） | 预留 `dataScope` **四档**：`all` 全部 / `org_below` 本组织及下级 / `org` 本组织 / `self` 仅本人（与数据字典 `roles.data_scope` 同源）；M3 仅实现「仅本人」，其余三档 M8 随组织架构扩展 |

## 5. 非功能需求（NFR）

- 登录接口 P95 ≤ 300ms（含密码校验）；鉴权守卫单次开销 ≤ 5ms（权限缓存后）。
- 令牌密钥支持轮换（`JWT_SECRET` 与 `JWT_SECRET_PREV` 双密钥过渡）。
- 审计日志写入失败不得阻塞主流程（异步落盘 + 本地兜底）。
- 所有鉴权相关操作（登录失败、越权、刷新）必须可观测，接入 PRD-001 日志与 PRD-004 指标。

## 6. 关键设计

**权限模型**

```
User ──< user_role >── Role ──< role_permission >── Permission
Permission: { code: 'order:refund', type: 'api'|'menu'|'button', name }
```

**配置项（`@fw/config` 校验，全部有默认值；仅 `JWT_SECRET` 无默认值）**

```
AUTH_STRATEGY=jwt                                  # jwt | session | oauth2 | apikey
AUTH_ACCESS_TTL=2h        AUTH_REFRESH_TTL=7d
AUTH_MAX_FAILED=5         AUTH_LOCK_MINUTES=15
AUTH_REFRESH_GRACE_SECONDS=10                      # refresh 并发宽限窗口
AUTH_PASSWORD_POLICY=medium                        # low | medium | high
AUTH_ALLOW_REGISTER=false                          # 注册开关，默认关闭（true 才开放；关闭时注册接口 1004）
JWT_SECRET=<≥32 位强随机>                           # 必填，无默认值（防弱密钥入生产）
JWT_SECRET_PREV=                                   # 轮换过渡期上一版密钥，须与 JWT_SECRET 不同
AUTH_API_KEYS=<key>:<主体名>:<权限码,权限码>          # 多条用 | 分隔；权限码本身含冒号，按前两段切分
```

**鉴权链路**：请求 → 策略解析身份 → 加载权限（缓存，PRD-004）→ 守卫比对 → 通过则写入请求上下文（供审计与数据权限使用）。

## 7. 验收标准（AC）

- [x] 未登录访问受保护接口返回 `3001`，无权限返回 `3002`，且不泄漏资源是否存在。
  验证：冒烟「未登录/无效令牌 → 401/3001」「alice 访问 /roles、/audit-logs → 403/3002」；权限判定在处理器之前，不区分「资源不存在」与「无权限」。
- [x] access token 过期后用 refresh 换新，旧 refresh 立即失效；复用旧 refresh 触发告警并踢下线。
  验证：`TC-AUTH-006/007/008`；冒烟「轮换返回新令牌」「窗口外复用 → 401/3001 + 整族撤销」。
- [x] 修改角色权限后，用户重新登录即可见新菜单；接口权限变更即时生效（缓存被清除）。
  验证：`TC-AUTH-009`；`PermissionService` 按 `user:<id>` 标签失效，`AuthService.grantRolePermissions` 覆盖该角色下全部用户。
- [x] 连续 5 次密码错误后账号锁定 15 分钟，且有日志记录。
  验证：冒烟「连续失败触发锁定 3004（第 5 次）」「锁定期内正确口令亦被拒」；日志 `auth.login 登录失败计数 +1`。
- [x] 审计日志能完整还原一次「改单」操作的操作人、时间、字段前后值。
  验证：冒烟「审计日志记录账号禁用（含前后值）」断言 `before={"status":1}` / `after={"status":0,...}`；业务层显式传 `before`（拦截器只补 `after`）。
- [x] OAuth2 与 API Key 策略可在同一服务共存，分别作用于不同路由。
  验证：`StrategyRegistry` 同时注册 jwt/apikey/session/oauth2，按 `AUTH_STRATEGY` 或 `@AuthStrategy()` 路由元数据选择；单测覆盖 API Key 定长时间比较、非法条目跳过、OAuth2 未注册 provider 明确报错。
  *限制：M3 的 example-api 未挂 apikey 路由，端到端仅覆盖 jwt 策略（见 §10 遗留）。*
- [x] 安全用例清单（越权访问他人数据、CSRF、重放、令牌篡改）全部通过。
  验证：越权 → `TC-AUTH-004` + 冒烟 3002 断言；重放 → `TC-AUTH-006/007/008`；令牌篡改/过期 → `TC-AUTH-003/014`（双密钥轮换）；数据越权 → `TC-AUTH-013`（`dataScope=self` 仅返回本人）。
  *CSRF：M3 采用 Bearer 头鉴权，天然免 CSRF；session 策略（Cookie）落地时需补 SameSite + 双提交校验，已登记为 M5 待办。*

## 8. 依赖与风险

- 依赖 M1（错误码、日志上下文）与 M2（持久化）；依赖 PRD-004 缓存做权限缓存。**M3 落地方式**：缓存以端口 `AuthCachePort` 前置，M3 用 `MemoryAuthCache`（进程内、多实例不共享），M4 换 Redis 只改 DI 注册，控制器与服务零改动（不满足 PRD-004 前的降级即「直查」语义）。
- 风险：refresh 轮换在并发请求下可能误判重放 → 引入短窗口（如 10s）宽限同一 refresh 的并发使用。
  **已落地**：`AUTH_REFRESH_GRACE_SECONDS`（默认 10）+ 族存活校验。注意：宽限通道仅在「族内仍有有效令牌」时生效，否则整族撤销（泄漏处置 / 登出 / 强制下线）后旧令牌会借窗口继续换发——该缺陷在 M3 端到端验证中发现并修复（见 §10）。
- 风险：权限缓存与角色变更的一致性问题 → 变更时按 `user:*` 标签主动失效（依赖 PRD-004 标签失效）。
  **已落地**：`AuthCachePort.invalidateTag`，内存实现即已支持标签失效，不阻塞到 M4。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 | 结论 |
|---|---|---|---|---|
| 是否需要组织架构（部门/岗位）？ | M3 只做扁平角色，组织模型放 M8 | donttemo | M3 完成 | 采纳：M3 仅实现 `self`，`org` / `org_below` 在 `resolveDataScope` 收敛为 `self` 并进入 `pendingScopes`，M8 扩展该分支 |
| 密码存储选 Argon2 还是 bcrypt？ | 默认 Argon2id，提供 bcrypt 兼容迁移 | donttemo | M3 完成 | 采纳：`@node-rs/argon2` Argon2id（19MiB / 2 轮 / 单并行）为主，`bcryptjs` 校验历史哈希并 `needsRehash` 时静默升级 |

## 10. 验收记录（2026-10-13）

**实现范围**

- `packages/auth`（`@fw/auth`）：`AuthModule.forRoot({ store, cache?, env?, overrides?, sessionStore?, oauth2Handlers? })`；`AuthStore`（持久化端口）与 `AuthCachePort`（缓存端口）双向解耦，框架包不感知项目 schema 与 Redis。
- `packages/config`：新增 11 个 `AUTH_*` / `JWT_*` 配置键与校验（含 `boolString` 预处理，避免 `z.coerce.boolean('false') === true` 陷阱）。
- `apps/example-api`：`prisma/schema.prisma` 8 张表 + 迁移 `20261012165848_add_auth_rbac`；`PrismaAuthStore` 适配器；4 个控制器（`/api/v1/auth` `/users` `/roles` `/permissions` `/audit-logs`）；seed 写入 22 权限点 / 2 角色 / 7 菜单 / 2 账号。
- `docs/contracts/auth.ts`：C-05 权限契约冻结（供 L4 前端 / L5 生成器消费）。

**验证证据**

| 项 | 命令 | 结果 |
|---|---|---|
| 单测 | `pnpm --filter @fw/auth run test` | **89 passed / 11 files** |
| 覆盖率 | `pnpm --filter @fw/auth run test:coverage` | 96.86% lines / 91.13% branch / 96.05% funcs / 96.86% stmts（阈值 85/65/85/85） |
| M3 端到端 | `node apps/example-api/scripts/smoke-auth.mjs` | **25/25 通过**（TC-AUTH-001~014 覆盖） |
| M1/M2 回归 | `node apps/example-api/scripts/smoke.mjs` | **13/13 通过**（全局守卫生效后自检路由未受影响） |
| 门禁 | `pnpm run check:headers` | 通过（98 文件） |

**验证中发现并修复的缺陷**

1. **泄漏处置可被绕过（安全）**：宽限通道仅按 `revokedAt` 时间判定，整族撤销（泄漏 / 登出 / 强制下线）后旧 refresh 在 10s 内仍能换发新令牌 → 增加「族内是否仍有有效令牌」前置校验（`AuthStore.hasActiveRefreshTokenInFamily`），并补单测。
2. **启动失败静默退出（可用性）**：`NestFactory.create` 默认 `abortOnError: true`，配合 `logger: false` 使装配失败无任何输出并直接退出 → `@fw/core` 的 `bootstrap` 显式传 `abortOnError: false`，由 `main.ts` 的 catch 打印。
3. **DI 元数据退化**：`RbacGuard` / `AuditInterceptor` 以**类型导入**声明依赖，`emitDecoratorMetadata` 只能发出 `Function` / `Object`，Nest 无法解析 → 改值导入 + `@Inject(AUTH_STORE / AUTH_STRATEGY_REGISTRY)`。
4. **CLI 同步 spawn**：`fw db:migrate|rollback|seed` 用 `execFileSync`，在受限宿主（沙箱/部分 CI）返回 `EBUSY` 且阻塞事件循环 → 改异步 `execFile`（与 pnpm 自身调用路径一致），并补充 stderr 透出。

**遗留与后续**

- `apikey` / `session` / `oauth2` 策略仅有单测证据，example-api 未挂对应路由；端到端仅覆盖 `jwt`（M5 接入后台模板时一并补）。
- `dataScope` 的 `org` / `org_below` 待 M8；`roles.data_scope` 字段与解析分支已就位。
- 权限缓存为进程内实现，多实例部署前需接 M4 Redis（否则角色变更后在其它实例上有最多 60s 延迟）。
- refresh 过期记录清理（`purgeExpiredRefreshTokens`）已有实现但未接定时任务，待 M7。

## 11. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-09 | 初稿 | 需求与 AC 定义 |
| 2026-10-13 | 实现完成 | 状态转「已实现」；补配置项清单、待定问题结论、§10 验收记录；AC 全量勾选并附验证方式 |

