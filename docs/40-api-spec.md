# 通用应用框架 · API 文档

> 版本 v0.1 ｜ 状态：草案 ｜ 关联：[架构设计](./20-architecture.md) ｜ [数据字典](./30-data-dictionary.md) ｜ [PRD-001](./prd/prd-001-core-skeleton.md) 更新：2026-10-13
>
> 变更记录：2026-10-13 donttemo M7：§3.8 按实现定稿（`/admin/queue/*` + `system:queue:*`，原 `/jobs` + `job:*` 方案废止，理由见 §3.8 说明）。
>
> 变更记录：2026-10-14 donttemo 管理后台可达性修复：§3.2 新增 `GET` / `PUT /auth/profile`（`auth:me`，本人资料自助；
> 原实现让个人中心借 `PUT /users/:id` 保存，普通角色必 `3002`）；§3.6 更正 `GET /dict/:code` 的权限点标注为 `dict:read`（原标「登录后」，与实现不符）。
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

| 方式 | 用法 | 适用场景 |
|---|---|---|
| Bearer JWT | `Authorization: Bearer <access_token>` | 默认，后台与客户端 |
| API Key | `X-Api-Key: <key>` + `X-Api-Sign` + `X-Api-Timestamp` | 开放接口、三方系统 |
| Session | Cookie（`HttpOnly; Secure; SameSite`） | `AUTH_STRATEGY=session` 的内网后台 |

- access token 有效期 2h，refresh token 7d；令牌刷新用 `POST /auth/refresh`。
- 401 时前端应静默刷新一次并重试，仍失败则跳登录。

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
| `9001` | 500 | 系统内部错误 | 上报 traceId |
| `9002` | 503 | 依赖不可用（已进入降级） | 稍后重试 |
| `9003` | 429 | 触发限流 | 按 `Retry-After` 退避 |

> 分段：`1xxx` 通用、`2xxx` 预留、`3xxx` 鉴权、`4xxx` 租户与业务、`9xxx` 系统。新增错误码必须同步本表与 PRD-001。

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
| GET | `/auth/oauth/:provider` | 公开 | OAuth2 跳转（微信 / 企业微信 / GitHub） |
| GET | `/auth/oauth/:provider/callback` | 公开 | OAuth2 回调，绑定或创建用户 |

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
| GET | `/roles` | `role:read` | 角色列表 |
| POST | `/roles` | `role:create` | 新建角色（含 `dataScope`） |
| PUT | `/roles/:id` | `role:update` | 更新（内置角色不可改 code） |
| DELETE | `/roles/:id` | `role:delete` | 删除（内置角色拒绝） |
| GET | `/roles/:id/permissions` | `role:read` | 该角色已授权权限码 |
| PUT | `/roles/:id/permissions` | `role:grant` | 全量授权，写入 `role_permission` |
| POST | `/roles/:id/copy` | `role:create` | 复制角色（含权限） |
| GET | `/permissions` | `permission:read` | 权限点列表（按 module 分组） |
| GET | `/permissions/tree` | `permission:read` | 权限树（菜单 / 按钮 / 接口三层）—— **未实现（Backlog）**，前端未消费，`scripts/check-api-parity.mjs` 仅提示不阻断 |

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
| GET | `/dict/categories` | `dict:read` | 分类列表 |
| POST / PUT / DELETE | `/dict/categories[/:id]` | `dict:write` | 分类维护（删除连带其下字典项；软删同时释放编码唯一键） |
| GET | `/dict/items` | `dict:read` | 字典项列表（按 `category_id`） |
| POST / PUT / DELETE | `/dict/items[/:id]` | `dict:write` | 字典项维护 |
| GET | `/dict/:code` | `dict:read` | 按分类编码取字典项，供前端 `useDict()` 消费；编码不存在返回空数组而非报错。**前端在无 `dict:read` 时短路不发请求并降级显示原始值**（此前误标「登录后」，与实现不符） |

### 3.7 审计日志（PRD-003）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/audit-logs` | `audit:read` | 分页查询，支持 `user_id / module / action / target / 时间区间` |
| GET | `/audit-logs/:id` | `audit:read` | 详情，含变更前后值（脱敏） |
| GET | `/audit-logs/export` | `audit:export` | 导出（异步任务，返回 `jobId`）—— **未实现（Backlog）**，前端未消费 |

### 3.8 任务与队列（PRD-007）

> M7 实现定稿（2026-10-13）：路径前缀冻结为 `/api/v1/admin/queue`（C-08 `QUEUE_ADMIN_PATHS`），
> 权限码为 `system:queue:list`（查看）/ `system:queue:manage`（变更），与原规划的 `/jobs` + `job:*` 方案不同——
> 队列运维是系统级能力而非业务资源，与既有系统管理域（`system:*`）对齐。类型契约见 `docs/contracts/queue.ts` 与 `api-web.ts` §3.8。
> 异步业务进度（如审计导出）沿用「业务表存 jobId + 自查进度」模式，不入本组端点。

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/admin/queue/stats` | `system:queue:list` | 队列状态与积压：`driver / paused / consuming / queues[]（waiting/active/completed/deadLetter/backlog/concurrency/rateLimit）/ totals` |
| GET | `/admin/queue/metrics` | `system:queue:list` | 指标快照：入队/成功/失败/死信/幂等跳过/超时/cron 触发与抢锁失败计数 + `successRate / avgDurationMs` |
| GET | `/admin/queue/handlers` | `system:queue:list` | 已注册任务名（排查「任务未注册」） |
| GET | `/admin/queue/crons` | `system:queue:list` | 定时任务快照：`enabled / items[]（expression/lock/nextRunAt/runs/lockedOut/lastResult）` |
| POST | `/admin/queue/crons/:name/tick` | `system:queue:manage` | 手动触发定时任务（仍走分布式锁），返回 `results[{ name, acquired }]` |
| GET | `/admin/queue/dead-letters` | `system:queue:list` | 死信列表（可按 `queue` 过滤），返回 `{ total, items[] }` |
| POST | `/admin/queue/dead-letters/:id/requeue` | `system:queue:manage` | 重放单条死信，返回 `{ id, requeued }`（不存在时 `requeued=false` 而非报错） |
| DELETE | `/admin/queue/dead-letters` | `system:queue:manage` | 清理死信（可按 `queue` 过滤），返回 `{ removed }` |
| POST | `/admin/queue/pause` / `/admin/queue/resume` | `system:queue:manage` | 暂停 / 恢复消费 |
| DELETE | `/admin/queue/drain` | `system:queue:manage` | 清空等待中的任务（可按 `queue` 过滤），返回 `{ removed }` |

> 运维侧另有两个免认证只读端点：`GET /metrics/queue`（Prometheus 文本，含积压 gauge，命中 `/metrics` 前缀豁免）与
> `/ready` 的 `queue` 检查项（驱动可用性）。业务侧派发 API 不走 HTTP——业务代码直接注入 `QueueService.dispatch()`（见 PRD-007 §6）。

### 3.9 租户（PRD-008，M8）

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/tenants` | `tenant:read` | 租户列表（平台管理员） |
| POST | `/tenants` | `tenant:create` | 开租户，指定 `isolation` |
| PUT | `/tenants/:id` | `tenant:update` | 更新（套餐、状态） |
| DELETE | `/tenants/:id` | `tenant:delete` | 停用（不物理删） |
| POST | `/tenants/:id/migrate` | `tenant:manage` | shared ↔ dedicated 隔离级别迁移 |

### 3.10 业务模块标准 CRUD（PRD-006 生成器产出）

以 `orders` 为例，生成器对每个模型固定产出 5 个接口与 4 个权限点：

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/orders` | `order:read` | 分页列表 + 关键字筛选 |
| GET | `/orders/:id` | `order:read` | 详情 |
| POST | `/orders` | `order:create` | 创建 |
| PUT | `/orders/:id` | `order:update` | 更新 |
| DELETE | `/orders/:id` | `order:delete` | 软删除 |

## 4. 限流与幂等

| 场景 | 策略 |
|---|---|
| 登录 / 短信 / 改密 | 按 IP + 账号限流，超限返回 `9003` |
| 列表查询 | 默认 120 次/分钟/用户 |
| 写操作 | 支持 `Idempotency-Key`，24h 内重复返回首次结果 |
| 导出 / 批量 | 可通过 `QueueService.dispatch()` 派发异步任务；业务侧自行持久化 `jobId` 并提供进度查询接口，M7 未实现通用 `/jobs/:id/progress` |

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
