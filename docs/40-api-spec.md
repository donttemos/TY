# 通用应用框架 · API 文档

> 版本 v0.1 ｜ 状态：草案 ｜ 关联：[架构设计](./20-architecture.md) ｜ [数据字典](./30-data-dictionary.md) ｜ [PRD-001](./prd/prd-001-core-skeleton.md) 更新：2026-10-13
>
> 变更记录：2026-10-13 donttemo M7：§3.8 按实现定稿（`/admin/queue/*` + `system:queue:*`，原 `/jobs` + `job:*` 方案废止，理由见 §3.8 说明）。
>
> 变更记录：2026-10-15 donttemo M10 E-12：新增 §3.13 实时事件流 SSE（`POST /events/ticket` 一次性票据 +
> `GET /events/stream` 长连接；`job` / `queue` 两类事件，主题按权限裁剪，任务事件按归属人过滤）。
>
> 变更记录：2026-10-15 donttemo M10 E-13：新增 §3.14 站内信 / 通知中心（`/notifications` 五端点，
> `notification:read` 守卫 + 归属人 404）；§3.13 增 `notification` 事件（站内信实时未读，主题按权限裁剪）。
>
> 变更记录：2026-10-15 donttemo M10 E-01：§3.11 补注任务登记表驱动化（`JOB_CENTER_DRIVER`：memory 进程内默认 / db·bullmq 落库多副本可达）；
> §3.7 导出与 §3.9 迁移的执行体在 db/bullmq 驱动下经注册表按 params 重建（跨实例重跑）。
>
> 变更记录：2026-10-15 donttemo M10 E-02/E-04：§3.12 补注配置中心多实例语义（快照历史下沉 `config_snapshots`，版本基线跨实例对齐，nacos 驱动转正）；
> §3.4 `GET /permissions/tree` 由 Backlog 转为已实现（三层树，前端授权弹窗与权限码选择器换接）。
>
> 变更记录：2026-10-15 donttemo M10 E-10：§3.7 新增 `/audit-archives`（归档查询）与 `/audit-archives/export`
>（归档异步导出）两端点——审计归档策略的冷数据出口，数据范围与排序白名单同源收敛；归档本体为定时任务
> `audit.archive`（@fw/queue cron + 分布式锁，不占 API 面），运行快照见 `GET /auth-maintenance/audit-archive`。
>
> 变更记录：2026-10-15 donttemo M10 E-03：业务 API 框架级限流默认开启（令牌桶按 IP，G5 兑现）——未豁免路由超限返回
> `429/9003`（RATE_LIMITED，既有错误码段）+ `Retry-After` 头；豁免白名单 `RATE_LIMIT_WHITELIST`（默认 health/ready/metrics）；
> 灰度 `RATE_LIMIT_DRY_RUN` 仅计数不拦截；计数进 `/metrics` 的 `fw_rate_limit_*` 段。redis 驱动下桶跨实例共享（Lua 原子）。
>
> 变更记录：2026-10-14 donttemo 管理后台可达性修复：§3.2 新增 `GET` / `PUT /auth/profile`（`auth:me`，本人资料自助；
> 原实现让个人中心借 `PUT /users/:id` 保存，普通角色必 `3002`）；§3.6 更正 `GET /dict/:code` 的权限点标注为 `dict:read`（原标「登录后」，与实现不符）。
>
> 变更记录：2026-10-15 donttemo N-01/N-02 收口：§3.7 `GET /audit-logs/export` 由 Backlog 转为已实现（异步任务，返回 `jobId`）；
> 新增 §3.11 异步任务中心（`/jobs/:id/progress|retry|download`，登录即可 + 归属人隔离）；§3.9 补注跨租户维护面的
> `@IgnoreTenant()` + `system:tenant:ignore` 双重要求与 legacy 守卫语义；§4 导出/批量行的「M7 未实现通用进度端点」标注作废。
>
> 变更记录：2026-10-15 donttemo BUG-15 增量 + E-07：§3.4 `GET /roles`、§3.6 `GET /dict/categories` / `GET /dict/items`
> 接入 `sort` 白名单（未知字段 / 非法方向 / 超上限一律 `400/1001`，白名单只收视图可见字段）；新增 `audit_module`
> 字典（审计日志页模块筛选项数据源，取值与各控制器写入的 `module` 同源：`auth` / `user` / `role` / `tenant`）。
>
> 约定：接口由代码装饰器自动生成 OpenAPI 3.1 文档（`GET /docs`），本文件定义**规范与清单**，实现必须与本文件一致（CI 校验 spec 与路由一致）。

## 1. 通用约定

### 1.1 基础信息

| 项 | 值 |
|---|---|
| Base URL | `https://<host>/api/v1` |
| 协议 | 仅 HTTPS（生产）；本地可 HTTP |
| 编码 | UTF-8，请求与响应 `Content-Type: application/json` |
| 时间格式 | ISO 8601，UTC 存储（如 `2026-10-09T11:20:00.000Z`） |
| 金额 | 字符串传输，保留 2 位（如 `"1299.00"`），服务端用 `decimal(18,2)` |
| 文档地址 | `GET /docs`（Swagger UI）、`GET /docs-json`（OpenAPI） |

### 1.2 认证

| 方式 | 用法 | 适用场景 | 状态（M10 E-07 名实相符） |
|---|---|---|---|
| Bearer JWT | `Authorization: Bearer <access_token>` | 默认，后台与客户端 | 端到端可用（`AUTH_STRATEGY=jwt`） |
| API Key | `X-Api-Key: <key>`；配置 `AUTH_API_KEY_SIGN_SECRET` 后强制 `X-Api-Timestamp` + `X-Api-Sign`（HMAC-SHA256，算法见 [41](./41-auth-strategies.md)） | 开放接口、三方系统（`/api/v1/open/*` 示例路由） | 端到端可用（`@AuthStrategy('apikey')` 路由级声明） |
| OAuth2 授权码 | `GET /auth/oauth2/:provider/authorize` → IdP → `GET /auth/oauth2/:provider/callback`（回调域名白名单 + state 防 CSRF） | 企业 SSO 登录（example-api + admin-web 登录页端到端） | 端到端可用（提供方经 `AUTH_OAUTH2_PROVIDERS` 注册） |
| Session | Cookie（`HttpOnly; Secure; SameSite`，`fw_sid`） | `AUTH_STRATEGY=session` 的内网后台 | 策略可用；SessionStore 端口由业务侧提供（不注入即明确拒绝） |

- access token 有效期 2h，refresh token 7d；令牌刷新用 `POST /auth/refresh`。
- 401 时前端应静默刷新一次并重试，仍失败则跳登录。
- OAuth2 授权码流程与 apikey 签名约定详见 [认证策略端到端指南](./41-auth-strategies.md)。

### 1.3 统一响应

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": { }, "traceId": "b3f1c9..." }

// 失败
{ "code": 3002, "message": "无操作权限", "data": null, "traceId": "b3f1c9..." }

// 分页（data 固定结构）
{ "code": 0, "data": { "items": [], "total": 128, "page": 1, "pageSize": 20 } }
```

- HTTP 状态码与 `code` 一致：`200` 成功、`400` 参数/业务、`401` 未登录、`403` 无权限、`404` 不存在、`409` 冲突、`429` 限流、`500` 系统错误。
- 校验失败时 `data.details` 返回字段级错误：`[{ "field": "username", "message": "长度需为 3-32" }]`。

### 1.4 通用请求头 / 响应头

| 头 | 方向 | 说明 |
|---|---|---|
| `X-Trace-Id` | 请求（可选） | 透传上游链路 ID；缺省由服务端生成 |
| `X-Tenant-Id` | 请求（M8） | 租户标识；也可由子域名或 token claim 解析 |
| `Idempotency-Key` | 请求（写操作可选） | 幂等键，24h 内重复请求返回首次结果 |
| `X-Trace-Id` | 响应 | 与日志一致，便于排障 |
| `X-RateLimit-Remaining` / `Retry-After` | 响应 | 限流剩余与建议重试秒数 |

### 1.5 列表查询约定

所有 `GET /xxx` 列表接口统一支持：

| 参数 | 说明 |
|---|---|
| `page` / `pageSize` | 分页，默认 `1` / `20`，`pageSize` 上限 200 |
| `sort` | 排序，如 `created_at:desc,id:asc` |
| `fields` | 字段投影（逗号分隔） |
| `keyword` | 通用关键字（按模块定义的字段匹配） |
| `*_min` / `*_max` | 数值与时间的区间筛选，如 `created_at_min` |

### 1.6 写操作约定

- `POST` 创建、`PUT` 全量更新、`PATCH` 局部更新、`DELETE` **软删除**（物理删除需 `?hard=true` 且需额外权限）。
- 创建成功返回完整对象与 `201`；更新返回更新后对象。
- 所有写操作写审计日志，响应不变。

## 2. 错误码

| code | HTTP | 含义 | 处理建议 |
|---|---|---|---|
| `0` | 200 | 成功 | — |
| `1001` | 400 | 参数错误 | 展示 `details` 字段级提示 |
| `1002` | 404 | 资源不存在 | 提示已删除或无权访问 |
| `1003` | 409 | 唯一约束冲突 | 提示重复值 |
| `1004` | 400 | 状态不允许 | 刷新后重试 |
| `2001` | 400 | 业务校验失败（预留细分） | 按 message 提示 |
| `3001` | 401 | 未登录或令牌无效 | 跳登录 |
| `3002` | 403 | 无权限 | 隐藏入口并提示 |
| `3003` | 401 | 令牌已过期 | 静默刷新 |
| `3004` | 403 | 账号已锁定 | 提示等待时间 |
| `4001` | 403 | 租户无效或已过期（M8） | 提示联系管理员 |
| `5001` | 400 | 该配置键不可热更新（boot 键或不在白名单，M9） | 该键走环境变量 + 重启 |
| `5002` | 400 | 配置新值非法（M9） | 展示 `details` 中的拒绝原因 |
| `5003` | 404 | 配置键不存在（M9） | 检查键名拼写 |
| `9001` | 500 | 系统内部错误 | 上报 traceId |
| `9002` | 503 | 依赖不可用（已进入降级） | 稍后重试 |
| `9003` | 429 | 触发限流 | 按 `Retry-After` 退避 |

> 分段：`1xxx` 通用、`2xxx` 预留、`3xxx` 鉴权、`4xxx` 租户与业务、`5xxx` 配置中心（M9）、`9xxx` 系统。新增错误码必须同步本表与 PRD-001。
>
> 文案本地化归属（E-14 / ADR-0014）：错误码的用户可读文案由**前端 locale 表承载**（admin-web `src/locales`，zh-CN / en-US 双表键集与错误码全集编译期同构），后端只回码不负责翻译——zh-CN 显示沿用「后端 `message` 优先」，非 zh-CN 由前端表接管。新增错误码除本表与 PRD-001 外，须同步前端两表（漏同步 `vue-tsc` 即红）。

## 3. 接口清单

> 权限点列即 `permissions.code`，与 [PRD-003](./prd/prd-003-auth-rbac.md) RBAC 对齐；`公开` 表示无需登录。

### 3.1 运维与健康（PRD-001）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 存活探针，返回 `{status:"ok", uptime}` |
| GET | `/ready` | 公开 | 就绪探针，返回 DB / Redis / MQ 逐项状态 |
| GET | `/metrics` | 内部 | Prometheus 指标（缓存命中率、队列积压、慢查询数） |

### 3.2 认证（PRD-003）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 | 账号密码登录，返回 access/refresh；失败计数，达阈值锁定 |
| POST | `/auth/register` | 公开（可关） | 注册，受 `AUTH_ALLOW_REGISTER` 控制 |
| POST | `/auth/refresh` | 公开（带 refresh） | 轮换 refresh，旧 refresh 立即失效 |
| POST | `/auth/logout` | `auth:logout` | 登出，令牌进黑名单 |
| GET | `/auth/me` | `auth:me` | 当前用户资料 + 角色 + 权限码列表 |
| GET | `/auth/profile` | `auth:me` | 本人资料（含 `phone` / `email`，个人中心回显；**不要求 `user:read`**） |
| PUT | `/auth/profile` | `auth:me` | 自助更新本人资料：白名单 `nickname` / `phone` / `email`；`username` / `status` / `roleIds` 一律拒收（防自助提权）；手机/邮箱被占用返回 `1003` |
| GET | `/auth/menus` | `auth:me` | 当前用户可见菜单树（后台动态路由数据源；**不按 `visible` 过滤**，由前端渲染时剪枝） |
| POST | `/auth/change-password` | `auth:change-password` | 改密，成功后其它设备下线 |
| GET | `/auth/sessions` | `auth:me` | 当前用户登录设备列表（一个刷新轮换族即一台设备） |
| DELETE | `/auth/sessions/:id` | `auth:revoke-session` | 下线指定设备（仅限本人设备；整族撤销） |
| GET | `/auth/oauth2/providers` | 公开 | 已注册 OAuth2 提供方列表（`AUTH_OAUTH2_PROVIDERS`；空列表 = 未启用，登录页不渲染入口） |
| GET | `/auth/oauth2/:provider/authorize` | 公开 | 发起授权：`redirect_uri` 必须前缀命中 `AUTH_OAUTH2_REDIRECT_WHITELIST`（否则 `400/1001`），302 到 IdP 并携带一次性 `state`（TTL 300s） |
| GET | `/auth/oauth2/:provider/callback` | 公开 | 授权回调：`state` 一次性校验（重放/跨提供方 `401/3001`）→ code 换 token → 拉用户信息 → 按 `email`/`username` 映射本地账号（不自动建号，未绑定 `401/3001`）；`response_mode=json` 返回 TokenPair，缺省 302 回 `redirect_uri` 且令牌放 URL fragment |

> **订正（M10 E-07）**：原 `/auth/oauth/:provider` 两行契约自 M3 起从未实现（悬空契约），已按本次落地的
> `/auth/oauth2/*` 三端点改写；流程与安全约束详见 [41](./41-auth-strategies.md)。

### 3.3 用户（PRD-003 / PRD-005）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/users` | `user:read` | 分页列表，支持 `keyword / status / role_id` |
| GET | `/users/:id` | `user:read` | 详情（含角色与部门） |
| POST | `/users` | `user:create` | 新建，密码走强校验 |
| PUT | `/users/:id` | `user:update` | 更新资料（自助改本人资料请走 `PUT /auth/profile`，无需 `user:update`） |
| DELETE | `/users/:id` | `user:delete` | 软删除（不可删内置管理员） |
| PUT | `/users/:id/roles` | `user:assign-role` | 分配角色（全量覆盖） |
| POST | `/users/:id/reset-password` | `user:reset-password` | 重置密码，返回一次性密码或触发重置流程 |
| PUT | `/users/:id/status` | `user:update` | 启用 / 禁用 |

> **数据权限四档（M8 T-M8-04，PRD-008 FR-04）**：以上列表与详情/写端点按当前用户生效的 `dataScope` 收敛——
> `all` 全部数据；`org_below` 本部门及全部下级成员；`org` 本部门成员；`self` 仅本人。
> 部门集合由服务端按 `user_department` / `departments` 解析注入，**不接受客户端传参**（防越权放宽）；
> 详情/写目标在范围外返回 `3002`（不泄露存在性）。用户无部门归属的 org 档按 `self` 收敛（fail-closed）。
> 同一规则适用于 `GET /audit-logs`（按部门成员展开归属人集合）。

> **角色分派入参校验（2026-10-14，`roleIds` / `permissionIds` 通用）**：分配类入参在写库前校验——
> 空串、非字符串、不存在或已软删的 ID 一律返回 `1001`（消息列出未知 ID），且**整批拒绝**，
> 既有关联原样保留。背景：分派是「先删后建」的全量覆盖，而 `user_role.role_id` 为裸 `String` 且无外键，
> 无效 ID 会被静默写库，把用户角色集替换成无效关联、权限聚合归零（表现为全站 3002 且无从溯源）。

### 3.4 角色与权限（PRD-003）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/roles` | `role:read` | 角色列表（支持 `sort`，白名单 `id` / `code` / `name` / `remark` / `data_scope` / `sort`；未知字段 `400/1001`） |
| POST | `/roles` | `role:create` | 新建角色（含 `dataScope`） |
| PUT | `/roles/:id` | `role:update` | 更新（内置角色不可改 code） |
| DELETE | `/roles/:id` | `role:delete` | 删除（内置角色拒绝） |
| GET | `/roles/:id/permissions` | `role:read` | 该角色已授权权限码 |
| PUT | `/roles/:id/permissions` | `role:grant` | 全量授权，写入 `role_permission` |
| POST | `/roles/:id/copy` | `role:create` | 复制角色（含权限） |
| GET | `/permissions` | `permission:read` | 权限点列表（按 module 分组） |
| GET | `/permissions/tree` | `permission:read` | 权限树（业务域 → 权限点（menu 类在前，button/api 类随后）→ 子资源预留；节点携带 `id` 与含子孙的 `codes`）—— M10 E-04 落地；前端授权弹窗与权限码选择器换接此端点（拍平兼容）。实现注记：权限点与菜单无归属外键，树不伪造「按钮挂在菜单下」层级 |

### 3.5 菜单（PRD-005）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/menus/tree` | `menu:read` | 完整菜单树（后台配置用） |
| POST | `/menus` | `menu:create` | 新建菜单 |
| PUT | `/menus/:id` | `menu:update` | 更新菜单 |
| DELETE | `/menus/:id` | `menu:delete` | 删除（有子菜单时拒绝） |

### 3.6 字典（PRD-005）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/dict/categories` | `dict:read` | 分类列表（支持 `sort`，白名单 `id` / `code` / `name` / `remark`） |
| POST / PUT / DELETE | `/dict/categories[/:id]` | `dict:write` | 分类维护（删除连带其下字典项；软删同时释放编码唯一键） |
| GET | `/dict/items` | `dict:read` | 字典项列表（按 `category_id`；支持 `sort`，白名单 `id` / `label` / `value` / `sort`） |
| POST / PUT / DELETE | `/dict/items[/:id]` | `dict:write` | 字典项维护 |
| GET | `/dict/:code` | `dict:read` | 按分类编码取字典项，供前端 `useDict()` 消费；编码不存在返回空数组而非报错。**前端在无 `dict:read` 时短路不发请求并降级显示原始值**（此前误标「登录后」，与实现不符） |

### 3.7 审计日志（PRD-003）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/audit-logs` | `audit:read` | 分页查询，支持 `user_id / module / action / target / 时间区间` |
| GET | `/audit-logs/:id` | `audit:read` | 详情，含变更前后值（脱敏） |
| GET | `/audit-logs/export` | `audit:export` | 异步导出：派发到任务中心并**立即返回 `jobId`**（不等导出完成），进度 / 下载 / 重跑走 §3.11 的 `/jobs/:id/*`；同样受 `dataScope` 收敛（`self` 范围只导自己的记录）。CSV 产物与 mock 逐字节同构（UTF-8 BOM + CRLF + 引号转义） |
| GET | `/audit-archives` | `audit:read` | 归档审计分页查询（M10 E-10）：参数与 `/audit-logs` 同形（`user_id / module / action / target / 时间区间 / sort` 白名单同源）；数据范围同样收敛——归档不是越权后门 |
| GET | `/audit-archives/export` | `audit:export` | 归档审计异步导出（M10 E-10）：与 `/audit-logs/export` 同机制（任务中心类型 `audit.archive.export`，返回 `jobId`），CSV 产物形态逐字节同构；数据范围在派发时收敛固化进 params |

### 3.8 任务与队列（PRD-007）

> M7 实现定稿（2026-10-13）：路径前缀冻结为 `/api/v1/admin/queue`（C-08 `QUEUE_ADMIN_PATHS`），
> 权限码为 `system:queue:list`（查看）/ `system:queue:manage`（变更），与原规划的 `/jobs` + `job:*` 方案不同——
> 队列运维是系统级能力而非业务资源，与既有系统管理域（`system:*`）对齐。类型契约见 `docs/contracts/queue.ts` 与 `api-web.ts` §3.8。
> 异步业务任务（如审计导出、租户迁移）走 §3.11 的通用任务中心（`/jobs/:id/*`），不入本组端点；
> 派发侧仍由业务权限码把关（`audit:export` / `tenant:manage`），任务面本身只验登录 + 归属人。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/admin/queue/stats` | `system:queue:list` | 队列状态与积压：`driver / paused / consuming / queues[]（waiting/active/completed/deadLetter/backlog/concurrency/rateLimit）/ totals` |
| GET | `/admin/queue/metrics` | `system:queue:list` | 指标快照：入队/成功/失败/死信/幂等跳过/超时/cron 触发与抢锁失败计数 + `successRate / avgDurationMs` |
| GET | `/admin/queue/handlers` | `system:queue:list` | 已注册任务名（排查「任务未注册」） |
| GET | `/admin/queue/crons` | `system:queue:list` | 定时任务快照：`enabled / items[]（expression/lock/nextRunAt/runs/lockedOut/lastResult）` |
| POST | `/admin/queue/crons/:name/tick` | `system:queue:manage` | 手动触发定时任务（仍走分布式锁），返回 `results[{ name, acquired }]` |
| GET | `/admin/queue/dead-letters` | `system:queue:list` | 死信列表（可按 `queue` 过滤），返回 `{ total, items[] }`；分页 `pageSize` 上限经 `MQ_DEAD_LETTER_PAGE_MAX` 配置（默认 200，M10 E-16），超出钳制到上限而非报错 |
| POST | `/admin/queue/dead-letters/:id/requeue` | `system:queue:manage` | 重放单条死信，返回 `{ id, requeued }`（不存在时 `requeued=false` 而非报错） |
| DELETE | `/admin/queue/dead-letters` | `system:queue:manage` | 清理死信（可按 `queue` 过滤），返回 `{ removed }` |
| POST | `/admin/queue/pause` / `/admin/queue/resume` | `system:queue:manage` | 暂停 / 恢复消费 |
| DELETE | `/admin/queue/drain` | `system:queue:manage` | 清空等待中的任务（可按 `queue` 过滤），返回 `{ removed }` |

> 运维侧另有两个免认证只读端点：`GET /metrics/queue`（Prometheus 文本，含积压 gauge，命中 `/metrics` 前缀豁免）与
> `/ready` 的 `queue` 检查项（驱动可用性）。业务侧派发 API 不走 HTTP——业务代码直接注入 `QueueService.dispatch()`（见 PRD-007 §6）。

### 3.9 租户（PRD-008，M8 + N-01 收口）

> **跨租户维护面**：平台管理员视角的五个端点整类标 `@IgnoreTenant()`（否则 `TENANT_ENABLED=true` 时调用方自身先 4001）。
> 框架要求调用方**同时**持有 `system:tenant:ignore`（守卫额外校验并写豁免审计），与各端点自身的 `tenant:*` 权限码是「与」关系。
> **语义守卫**：legacy 存量单租户（id `0`）停用 / 迁移一律 `1004`；`DELETE` 是停用（不写 `deletedAt`，解析路径仍按 code 命中并给 `4001`「租户已停用」）。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/tenants` | `tenant:read` | 租户列表（平台管理员）：分页 + 关键字 / 隔离级别 / 状态过滤，`sort` 白名单同 §1.5（`id` / `code` / `name` / `isolation` / `status` / `created_at` / `updated_at` / `expire_at`） |
| POST | `/tenants` | `tenant:create` | 开租户，指定 `isolation`；`dedicated` 必须带 `dbUrl`（落库前加密） |
| PUT | `/tenants/:id` | `tenant:update` | 更新（名称、套餐、状态、到期时间；隔离级别不走这里，走 migrate） |
| DELETE | `/tenants/:id` | `tenant:delete` | 停用（不物理删），审计记录含 `affectedUsers` |
| POST | `/tenants/:id/migrate` | `tenant:manage` | shared ↔ dedicated 隔离级别迁移：**长任务**，返回 `jobId`，进度走 §3.11。迁移内容 = 控制面切换（isolation 元数据 + 连接串密文 + 缓存失效），**数据物理搬迁由运维按手册执行**，接口与前端文案均已明示 |

### 3.10 业务模块标准 CRUD（PRD-006 生成器产出）

以 `orders` 为例，生成器对每个模型固定产出 5 个接口与 4 个权限点：

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/orders` | `order:read` | 分页列表 + 关键字筛选 |
| GET | `/orders/:id` | `order:read` | 详情 |
| POST | `/orders` | `order:create` | 创建 |
| PUT | `/orders/:id` | `order:update` | 更新 |
| DELETE | `/orders/:id` | `order:delete` | 软删除 |

### 3.11 异步任务中心（N-02；M10 E-01 驱动化）

> 任务面（`/jobs/:id/*`）**只验登录 + 归属人**，不额外要求业务权限码——语义是「我自己的任务」。
> 派发侧（`/audit-logs/export`、`/tenants/:id/migrate`）才由业务权限码把关。
> **不存在的任务 / 非归属人一律 `404`**（不泄露存在性）。产物体积上限经 `JOB_ARTIFACT_MAX_MB` 配置（默认 20MB，M10 E-16），超出即失败终态。
> `download` 返回裸文本流（非统一信封），前端按 Blob 下载。
> **登记表驱动（M10 E-01，`JOB_CENTER_DRIVER`）**：`memory`（默认）= 进程内存（重启即失效，
> `404` 语义一致）；`db` / `bullmq` = `jobs` 表登记（`404` 同语义含已裁剪任务），**多副本下
> 进度 / 下载 / 重跑任意实例可达**（重跑经执行体注册表按类型 + params 重建；未登记类型给
> 可读 `1004` reason）。并发重跑竞态由条件更新消解（只有一个调用方成功，其余 `1004`）。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/jobs/:id/progress` | 登录即可 | 任务快照 `JobView`：`status`（pending/running/succeeded/failed/cancelled）、`progress`（0–100）、`message`、`timeline[]`、`error` + `traceId`、产物元信息 |
| POST | `/jobs/:id/retry` | 登录即可 | 失败任务原地重跑；仅 `failed` 可重跑（其余 `1004`），重新派发同一 runner |
| GET | `/jobs/:id/download` | 登录即可 | 取回产物（如审计导出 CSV）。`Content-Disposition` 走 RFC 5987 `filename*`，中文名不乱码 |

### 3.12 参数配置（M9 / PRD-009）

> 配置中心管理面。**GET 只列热更新白名单键**（12 键：log / cache / mq / otel / tenant / web 六个运行时可调域；
> `web.keepAliveMax` 为 M10 E-16 新增——前端 keep-alive 条数上限经该键热更）；
> boot 键（端口 / 驱动 / 连接串 / 密钥 / 开关）env 独占、不进列表，改动走重启——尝试写入已知 boot 键返回 `5001`。
> 写走单一生效管道：**校验 → 审计（先审计后生效）→ 持久化事实源 → 应用覆盖 → 通知订阅者**；
> 审计落 `module=config`（变更历史在审计日志按该模块过滤）。`CONFIG_CENTER_ENABLED=false` 时 GET 仍可用
>（env 只读视图），PUT 一律 `1004`。
> **多实例语义（M10 E-02）**：快照历史与版本基线下沉持久层（`config_snapshots` 表）——GET 返回前对齐
> 持久层最新版本（A 实例写入的版本 B 实例即时可见），回滚候选跨实例一致；外部事实源变更（file/nacos
> 轮询）对齐不推号（追上远端已登记版本而非另占新号）。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/configs` | `system:config:read` | 白名单键当前生效值列表：`{key, value, source(runtime/env), hot, envKey, updatedAt}` + 运行元信息 `meta`（驱动 / 快照版本号 / 轮询间隔 / 最近生效时间 / 最近错误） |
| PUT | `/configs/:key` | `system:config:write` | 修改白名单键，body `{value}`（JSON 语义）；响应 `{key, oldValue, newValue, snapshotVersion}`。错误：白名单外 `400/5001`、值非法 `400/5002`（`details` 带原因，**信封顶层**）、键不存在 `404/5003`；同值写入视为无变更（不产生审计） |
| POST | `/configs/rollback` | `system:config:write` | 一键回滚（M9 Backlog）：body `{version?}`（缺省 = 上一个快照版本）；响应 `{fromVersion, toVersion, changed:[{key,oldValue,newValue}], snapshotVersion}`。三阶段：全量预审计（任一失败整体不生效）→ 持久化目标覆盖 → 逐键应用并通知；回滚本身计入历史（可再回滚 = 撤销回滚）。错误：版本不存在（保留版本数经 `CONFIG_CENTER_HISTORY_MAX` 配置，默认 20 版，M10 E-16）`404/5003`、无历史可回滚 `400/1004`、审计/持久化失败 `500/9001`；未启用 `400/1004` |

### 3.13 实时事件流 SSE（M10 E-12）

> 统一 SSE 通道：任务进度与队列告警经**一条长连接**下发，前端轮询降级为兜底（`EventSource`
> 建流失败 / 环境不支持 → 自动回落轮询）。事件面承载在 `@fw/transport`（`TRANSPORT_DRIVER=redis`
> 时经 Redis pub/sub 跨实例扇出，SSE 由任意实例可服务）。
>
> **鉴权用一次性票据而非 `?token=`**：`EventSource` 无法自定义请求头，令牌只能进查询串，
> 而查询串会落进网关访问日志——等于把长期凭证写进日志。故先经带 Bearer 的 `POST /events/ticket`
> 换一张 **60s、取后即废** 的票据（票据存 `CACHE_STORE`，redis 驱动下多实例共享）。
> `GET /events/stream` 标 `@Public()` 由控制器内核销票据，票据无效一律 `401/3001`，**不开流**。
>
> **主题按权限裁剪**：`job`（任务事件）人人可用；`notification`（站内信）需 `notification:read`；
> `queue`（队列告警）需 `system:queue:list`。
> **归属人隔离**：任务事件服务端按 `ownerId` 过滤（同一主题下不把别人的任务推给你）。
> 事件名（SSE `event:`）：`ready`（建连确认，data 含可订阅主题）/ `job` / `queue`。
> 心跳为注释帧（`: heartbeat`，15s），响应带 `X-Accel-Buffering: no` 防反代缓冲。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| POST | `/events/ticket` | 登录即可 | 签发一次性票据 `{ticket, expiresIn: 60, topics: ('job'\|'queue')[]}`；`topics` 按调用者权限裁剪（无 `system:queue:list` 只得 `job`） |
| GET | `/events/stream?ticket=…` | 一次性票据 | `text/event-stream` 长连接。`event: job` 的 data = `{kind: created\|progress\|finished, job: JobView, ownerId}`（与 `GET /jobs/:id/progress` 同形，前端零转换消费）；`event: notification` 的 data = `{ownerId, notification: NotificationView}`（M10 E-13 站内信，前端零转换消费，见 §3.14）；`event: queue` 的 data = `{kind: dead-letter\|backlog, at, queue?, jobId?, jobName?, attemptsMade?, reason?, waiting?, threshold?}`。票据无效/已核销 → `401/3001`（响应为普通 JSON 信封，非事件流） |

### 3.14 站内信 / 通知中心（M10 E-13）

> 消息中心的用户面：列表（含未读数）、未读数、标记已读、全部已读、删除。
> **鉴权 `notification:read`**（不落「登录即可」：消息中心是可授予、可回收的能力面；
> 与审计 / 队列同构的「权限点 + seed」流程）。**归属人即边界**：全部端点只操作本人消息，
> 越权与不存在一律 `404`（不泄露存在性，与 §3.11 任务面同语义）。
>
> **消息如何产生**：站内信**不由业务代码直接调用**产生，而是通知派发器订阅 `@fw/transport`
> 事件面后按规则落库（E-12 的接缝）——`job.progress` 的**终态**事件 → 派发人一条
> （`job.finished` / `job.failed`；运行中的进度事件不通知，进度感知属任务条）；
> `queue.alert` → 持 `system:queue:list` 的账号各一条（`queue.dead-letter` / `queue.backlog`）。
> **幂等**：`dedupe_key` 唯一（多副本各收到同一事件时只有一个写入成功；任务重跑因 `updatedAt` 变化
> 会产生新消息）。**实时**：落库后广播 `notification.created`，经 §3.13 的 `notification` 事件推送，
> 铃铛未读无需轮询。**保留窗口**：每人最多 200 条，超出淘汰最旧。
>
> 列表参数按 §1.5 约定钳制（`pageSize` 上限 200）。`POST` 类端点沿用本仓惯例返回 `201`。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/notifications` | `notification:read` | 本人消息分页 `{total, unread, items, page, pageSize}`；`unreadOnly=true` 只回未读；列表项 `{id, kind, level, title, content, refType, refId, traceId, read, readAt, createdAt}`（不含 userId 等内部字段） |
| GET | `/notifications/unread-count` | `notification:read` | `{unread}`（铃铛角标；实时不可用时的按需刷新端点） |
| POST | `/notifications/:id/read` | `notification:read` | 标记单条已读（**幂等**：已读再标仍成功），返回更新后的视图；非归属人 `404` |
| POST | `/notifications/read-all` | `notification:read` | 全部标记已读 `{updated}`（仅本人未读） |
| DELETE | `/notifications/:id` | `notification:read` | 删除本人消息 `{id, removed}`；非归属人 `404` |

### 3.15 前端错误遥测（M10 E-17）

> RUM（admin-web 实时用户监控）的服务端接收面。`POST /telemetry/client-errors` 标 **`@Public`**：
> 登录页与未登录态的异常同样要能上报；前端 `sendBeacon`（不可用时 `fetch keepalive` 兜底）
> **fire-and-forget**，不依赖响应内容——响应体仅为被动观测回带。
> 采集端三重上限防一个 bug 刷爆上报：同签名去重（每签名 ≤5 条 / 会话）、单会话 ≤100 条、
> 单批 ≤10 条（`RUM_MAX_BATCH`，即下表 `reports` 条数上限）。
> 服务端主观测路径是 **error 级结构化日志**（`module=rum`，字段化上下文，与后端异常同一管道
> 可检索，对齐「错误全采」理念）；计数为**进程内视图**（多实例合计需日志侧聚合），随摄取响应
> 回带 `{received, total}`，**不设 stats 查询端点**（不新增权限码）。
> `reports[].traceId` 取上报前最近一次后端响应头 `X-Trace-Id`——前端错误与后端日志同链关联。
> 载荷字段与前端 `ClientErrorReport` 同构；校验失败 `400/1001`，`details` 带 `reports[i].field`
> 字段级定位（多字段错误一次回齐，不逐条试错）。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| POST | `/telemetry/client-errors` | 公开 | 接收一批前端错误。body `{app: string(≤64), reports[1..10]}`；`reports[]` 字段：`source`（`error`/`rejection`/`vue`/`resource`）、`message`（必填非空，≤2000）、`stack`（≤4000 或 null）、`resource`（≤2000 或 null）、`page`（≤500）、`url`（≤2000）、`traceId`（≤64 或 null）、`repeat`（1–1000 整数）、`at`（ISO 8601，≤40）。响应 `{received, total}`：`received` 本批接收条数，`total` 本实例累计条数。体积防御：单字段长度钳制 + Nest 默认 body 上限 |

### 3.16 附件存储（M10 E-09）

> 文件内容经 `@fw/storage` 的 StoragePort 落地（`STORAGE_DRIVER=local` 本地磁盘 / `s3` S3 兼容对象存储，
> 切换只改配置、业务代码零改动）；本表（元数据，数据字典 §3.19）与端点不随驱动变化。
> **默认安全**：类型 / 大小白名单默认收紧（`STORAGE_MAX_MB=20`、扩展名白名单见 §3 配置键），
> 超限 / 越权类型一律 `400/1001` 且文案与 `@fw/storage` 逐字一致（不静默截断）；
> 存储 key 由服务端生成（`<yyyyMM>/<uuid><ext>`，不透传用户输入，天然免疫路径穿越）。
> 前端消费：`fw gen crud` 识别附件字段（`*FileId` / `*AttachmentId` 的 String 字段）生成 upload 控件
> （FileUpload 组件），表单值存文件 id，下载按 id 现取。
> 下载与元数据**登录即可**（语义同任务产物下载——我自己的上传产物）；上传消耗存储面，需 `file:create`。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| POST | `/files` | `file:create` | 上传附件（multipart/form-data，字段名 `file`）。响应 `{id, url, originalName, size, mimeType}`，`url` 为 `/api/v1/files/:id/download` 相对路径。超限 / 白名单外扩展名 / 缺 file 段 → `400/1001` |
| GET | `/files/:id` | 登录 | 元数据 `{id, originalName, size, mimeType, createdAt}`；不存在或已软删 → `404/1002`（不泄露存在性） |
| GET | `/files/:id/download` | 登录 | 文件字节流（非统一信封；`Content-Disposition` 带 RFC 5987 编码原始文件名）。不存在或已软删 → `404/1002` |

## 4. 限流与幂等

| 场景 | 策略 |
|---|---|
| 登录 / 短信 / 改密 | 按 IP + 账号限流，超限返回 `9003` |
| 列表查询 | 默认 120 次/分钟/用户 |
| 写操作 | 支持 `Idempotency-Key`，24h 内重复返回首次结果 |
| 导出 / 批量 | 业务侧派发到异步任务中心（§3.11）并立即返回 `jobId`；派发入口本身仍需 `audit:export` 等业务权限码，进度查询与下载只验归属人 |

## 5. 版本与兼容

- URL 带版本（`/api/v1`）；破坏性变更升版本并并行运行至少一个版本周期。
- 新增字段视为兼容；删除/改名/改语义为破坏性，需发版说明与迁移期。
- 废弃接口在响应头加 `Deprecation: true` 与 `Sunset` 日期，保留 ≥ 90 天。

## 6. 文档生成与校验

- 由装饰器（DTO + 控制器）生成 OpenAPI，`GET /docs-json` 输出 spec。
- CI 校验：spec 与路由清单一致；未标注权限点的接口视为缺陷并阻断合并。
- **接口对撞门禁（`pnpm run check:api-parity`）**：本仓库是「契约先行 + mock 顶上」的并行架构，
  C-06 契约（[docs/contracts/api-web.ts](./contracts/api-web.ts)）与前端 mock 齐全，而后端按里程碑分批落地。
  两侧各自的门禁都是绿的，导致「契约声明、mock 有、后端未注册」的端点只在接真实 API 后才 404。
  该脚本把**前端调用面**（`apps/admin-web/src` 下所有 `request.<method>('<path>')`）与**后端路由面**
  （全仓 `*.controller.ts` 的 `@Controller` + 方法装饰器）逐一对撞，前端调了而后端没有即失败；
  后端有而前端未调用（演示 / 运维端点）仅提示。已在 CI 的 base 作业阻断合并。
- 变更流程：改接口 → 更新本文档与 spec → 评审 → 合并。
