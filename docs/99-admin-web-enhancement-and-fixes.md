# 管理后台前端功能补充与缺陷修复方案

> 版本 v0.3（待发布）｜ 状态：**已实施（前端 + 相关后端小改，含验证证据）** ｜ 关联：[PRD-005 管理后台模板](./prd/prd-005-admin-template.md) ｜ [原型与 UI 规范](./25-ui-prototype.md) ｜ [API 文档](./40-api-spec.md) ｜ [C-06 前端契约](./contracts/api-web.ts) ｜ [C-06 契约定稿记录](../CHANGELOG.md) ｜ 更新：2026-10-14 ｜ 负责人：donttemo
>
> 定位：本轮把管理后台前端从「文档标注已交付」拉到「**真机可用的同源状态**」。所有缺陷均在代码层复核过根因
> （后端权限码常量、菜单种子、`import.meta.glob` 解析规则、mock 与真机差异），并按 PRD-005 的四个交付面
> （页面清单 / 组件规范 / 交互规范 / 兼容要求）给出**修复后预期行为**与验证方式。
>
> 一句话结论：**上一轮 6 项 P0 中，5 项属「前端权限码与后端常量不同源」与「菜单/路由数据源不一致」**——
> 本地 mock 全绿、真机才炸（mock 自建了一套 `dict:create/update/delete`、`routesAdded` 解析规则也只覆盖 mock 的菜单形状）。

## 1. 现状核对：文档承诺 vs 代码实现

依据 [原型 §3 页面清单](./25-ui-prototype.md) 与 [PRD-005 §7 验收标准] 逐页核对（`apps/admin-web/src`）：

| 路由 | 页面 | 核对结论 | 说明 |
|---|---|---|---|
| `/login` `/403` `/404` `/` `/profile` | 登录 / 错误页 / 工作台 / 个人中心 | ⚠️ 基本可用，**个人中心写入不可用** | 见 BUG-05 |
| `/system/users` | 用户管理 | ⚠️ 可用但**越权按钮可点 + 角色字段类型错** | BUG-06 / BUG-07 |
| `/system/roles` | 角色与权限 | ✅ 通过 | 权限树三层、数据范围四档、复制角色均与后端同源 |
| `/system/menus` | 菜单管理 | ⚠️ 按钮无权限门禁 | BUG-06 |
| `/system/dict` | 字典管理 | ❌ **字典项维护按钮全部不渲染** | BUG-02 |
| `/system/audit-logs` | 审计日志 | ❌ **「详情」入口不可达（diff 看不到）** | BUG-01 |
| `/system/queue` | 队列管理 | ❌ **真机不可达**（种子缺菜单） | BUG-04 |
| `/system/tenants` | 租户管理 | ❌ **未实现**（前端页面与后端端点都缺） | N-01 |
| `/order/list`、`/demo-items` | 生成器/演示列表页 | ❌ **生成器页面菜单不可达** | BUG-03 |

## 2. 需要新增或完善的前端功能模块与页面

### 2.1 新增（当前完全缺失）

| 编号 | 模块 / 页面 | 目标行为（交互流程 + 数据展示） | 依赖 | 验收 |
|---|---|---|---|---|
| **N-01** | **租户管理页 `/system/tenants`**（原型 §3 M8 规划项） | 列表展示租户编码/名称/隔离级别（`shared`/`dedicated`）/状态/创建时间；支持新建（选 `isolation`）、改套餐与状态、停用（不物理删除）、`shared ↔ dedicated` 迁移（长任务 → 进度反馈）。隔离级别与状态用 `<StatusTag>` + 字典 `tenant_isolation` / `tenant_status`；停用与迁移必须二次确认 | **后端 `/tenants` 五个端点（api-spec §3.9 已定义，实现为零）+ 权限点 `tenant:read/create/update/delete/manage`** | 列表分页 20 条；无 `tenant:read` 时菜单不出现、直输 URL 落 403 |
| **N-02** | **异步导出任务中心**（原型 §7「导出 / 批量走异步任务」） | 列表页点导出 → 派发任务返回 `jobId` → 页脚常驻任务条（进度百分比 + 轮询退避）→ 完成后下载；失败可重试并展示 `traceId` | **后端 `/audit-logs/export`（api-spec §3.7 标 Backlog）与通用 `/jobs/:id/progress`** | 导出中不阻塞页面；关闭弹窗任务继续；失败不丢任务 |
| **N-03** | **403 无权限整页视图**（CrudTable 四态之一，原型 §5.2） | 列表接口返回 `3002` 时，**整页替换**为无权限插画 + 「申请权限」引导 + 返回工作台，不再渲染表格骨架 | 无（前端自闭环） | 有权限与无权限的页面截图可对比；`3002` 不与其他错误共用同一提示文案 |

### 2.2 完善（已存在但行为不达要求）

| 编号 | 模块 | 现状问题 | 目标行为 |
|---|---|---|---|
| **E-01** | 字典消费（`useDict` / `<DictSelect>` / `<StatusTag>`） | 后端 `GET /dict/:code` 需 `dict:read`，而 `api/dict.ts` 注释与 api-spec 都写「登录后可用」→ 普通角色持续 3002，状态列退化成 `0/1` | 无 `dict:read` 时**短路不发请求**（降级显示原值，不刷错误）；普通用户角色按「字典是 UI 枚举元数据」授予 `dict:read`；`dict:write` 才能维护 |
| **E-02** | 个人中心（资料维护） | 借 `PUT /users/:id` 保存，普通角色必 3002；手机/邮箱回显依赖 `user:read` | 走 `GET/PUT /auth/profile`（`auth:me`）；服务端白名单只收 `nickname/phone/email` |
| **E-03** | 队列管理 | 真机无菜单入口；「暂停/恢复」无按钮级权限 | 种子补菜单；查看类 `system:queue:list`，变更类 `system:queue:manage` |
| **E-04** | 标准 CRUD（`<CrudTable>`） | 操作列条件漏插槽、权限码不可覆盖、数组字段被当单值、查询条件不持久化、批量删除假成功 | 见 §3 BUG-01/02/07/10/13 修复后行为 |
| **E-05** | 工作台统计 | `/roles`、`/permissions` 需 `role:read`/`permission:read`，无权限时数字静默变 `0`，与真实 0 无法区分 | 卡片显式区分「无权限（—）」/「0」/「加载失败（可重试）」，并给数据来源说明 |
| **E-06** | 菜单管理 | 图标、权限码为自由文本，易填错导致菜单被静默跳过 | 图标改为受限选择器（`icon-map.ts` 白名单 + 预览）；权限码改为远程搜索下拉（`/permissions`，无权限时降级为文本） |
| **E-07** | 审计日志 | 模块下拉是硬编码枚举（原型「禁止硬编码枚举」） | 改为字典 `audit_module`，与 `audit_action` 同源 |

## 3. 已知缺陷清单（现象 / 触发条件 / 根因 / 修复后预期行为）

> 状态列：✅ = 本轮已修复并跑过验证；🕐 = 本轮未改（有明确依赖或属产品待决策）。

| 编号 | 严重度 | 现象 | 触发条件 | 根因 | 修复后预期行为 | 状态 |
|---|---|---|---|---|---|---|
| **BUG-01** | **P0** | 审计日志页**没有「操作」列**，看不到字段级 diff | 打开 `/system/audit-logs`（任意角色，含 admin） | `CrudTable` 操作列 `v-if="actions && (formFields?.length \|\| canDelete())"`；审计页无 `formFields`，且 `audit:delete` 权限码**根本不存在** → 条件恒 false，`actions-extra` 插槽整块不渲染 | 操作列在「配置了表单 / 有删除权限 / **页面挂了 `actions-extra` 插槽**」任一成立时渲染；审计「详情」可打开，抽屉展示 before→after 字段级 diff（敏感字段 `***`） | ✅ |
| **BUG-02** | **P0** | 字典管理页**新建/编辑/删除按钮全部不出现**，字典项无法维护 | 打开 `/system/dict`（任意角色，含 admin） | 页面传 `permission="dict"` → 组件推导 `dict:create/update/delete`；后端权限常量只有 `dict:read` / `dict:write`（`packages/auth/src/constants.ts`）→ 权限码永不命中 | `CrudTable` 支持 `permissionActions` 显式覆盖动作码；字典项增删改绑 `dict:write`，分类增删改同样按 `dict:write` 渲染 | ✅ |
| **BUG-03** | **P0** | `fw gen crud` 生成的页面**在侧边栏看不到**，直输 URL 落 404 | `fw gen crud` 落库菜单后重新登录 | 生成器模板写 `component: 'views/<model>/index'`（相对 `web/src`），而 `resolveComponent` 只拼 `/views/<component>/index.vue` 候选 → 解析失败被**静默跳过**（不报错、不记日志） | `component` 解析前归一化（去 `src/` `views/` 前缀、去 `.vue`），两种既有约定都能解析；解析失败仍在控制台 `warn` 出菜单名与 component 值，便于定位 | ✅ |
| **BUG-04** | **P0** | **真机**上队列管理页无法进入（无菜单、直输 URL 403） | 真实部署（非 mock）登录 admin | M7 只补了 `system:queue:list/manage` **权限点**，没补 `/system/queue` **菜单**；前端动态路由完全由 `/auth/menus` 生成 → 无菜单即无路由 | 种子补「队列管理」菜单（`permissionCode: system:queue:list`）；重跑 `db:seed` 并重登后菜单与路由同时出现 | ✅ |
| **BUG-05** | **P0** | 个人中心**保存资料必失败**（普通角色 3002）；手机/邮箱回显为空 | 以 `alice`（仅 `auth:me`+`user:read`）登录 → 个人中心 → 保存 | 前端用 `PUT /users/:id`（需 `user:update`）保存、`GET /users/:id`（需 `user:read`）回显——把「自助」当成了「管理」 | 新增 `GET/PUT /auth/profile`（仅需 `auth:me`）：GET 回显 `nickname/phone/email`，PUT 白名单更新（`username/status/roleIds` 一律拒收，防自助提权；手机/邮箱冲突 409）；前端切换后普通用户可保存，头部昵称即时刷新 | ✅ |
| **BUG-06** | **P1** | 无写权限的角色仍能看到并可点击**越权按钮**，点了才 3002 | 用户页（分配角色/重置密码/启用禁用）、菜单页（增删改）、字典分类（增删改）、队列页（暂停/恢复）、个人中心（下线设备） | 这些按钮未加 `v-permission`，只有页面级可见性（菜单树）在控 | 按服务端真实权限码补齐门禁：`user:assign-role` / `user:reset-password` / `user:update` / `menu:create,update,delete` / `dict:write` / `system:queue:manage` / `auth:revoke-session`；无权限即不渲染（服务端仍是最终防线） | ✅ |
| **BUG-07** | **P1** | 用户编辑弹窗**角色回显为空**；新建带角色提交报 `1001` | `/system/users` 新建 / 编辑用户 | 表单把 `roleIds`（`ID[]`）配成单选下拉：数组值 → 控件空显示；提交把数组变成字符串，而服务端明确要求字符串数组 | 新增 `FormField.multiple`，`roleIds` 改多选；新建初值 `[]`、编辑归一为数组；`number` 字段初值改 `undefined`（不再给空串触发 `el-input-number` 告警） | ✅ |
| **BUG-08** | **P1** | 多标签页切回**仍重新请求**、页面状态丢失 | 任意标签来回切换 | `AppMain` 写 `<keep-alive :include="[]">`——空数组不匹配任何组件名，等于**关闭缓存**（与组件注释「切回不重复请求」矛盾） | 去掉 `include`，改为 `:max="12"`（LRU 上限），缓存以 `fullPath` 为键；标签「刷新」仍走 `/redirect` 强制重建以拉新数据 | ✅ |
| **BUG-09** | **P1** | 配置为「不显示」的菜单**仍出现在侧边栏**，点击落 404 | 菜单管理里把某菜单设为隐藏后重新登录 | 后端 `/auth/menus` 只按权限码过滤、**不过滤 `visible`**（`permission.service.ts`）；前端 `visibleMenus()` 只过滤了顶层，子级被直接渲染 | `visibleMenus()` 改**递归剪枝**（隐藏节点及其子树不进侧边栏），与动态路由生成规则保持一致 | ✅ |
| **BUG-10** | **P1** | 「导出」按钮点了**没有任何反应**（死 UI） | 审计日志页；用户管理页（点了只弹一段 JSON 提示） | 后端 `/audit-logs/export` 未实现（api-spec 已标 Backlog）却已挂 `exportable`；用户页的 `@export` 只做了演示提示 | 后端就绪前**移除**按钮，避免死 UI；`CrudTable` 保留 `export` 事件钩子不变。落地后按 N-02 接异步任务 | ✅ |
| **BUG-11** | **P1** | 普通用户看用户列表，状态列显示 `0/1` 而非「启用/禁用」，控制台刷 3002 | 以无 `dict:read` 角色打开任何消费字典的页面 | `GET /dict/:code` 实际需 `dict:read`，与 `api/dict.ts` 注释、api-spec §3.6「登录后可用」不一致 | ① 前端无 `dict:read` 时短路不发请求（降级显示原值，不刷错误）；② 普通用户角色补 `dict:read`（字典是 UI 枚举元数据，非敏感数据）；③ api-spec 更正权限点标注 | ✅ |
| **BUG-12** | **P1** | 真机点「订单退款」菜单落 404 | 真实部署登录 admin 后点侧边栏 | 种子把菜单指向 `component: 'order/refund'`，但 `views/order/refund` **不存在**；且后端没有 `/api/v1/orders` 端点（订单页只存在于前端 mock） | 移除死链菜单「订单中心」整支（真实部署的业务菜单示范由 `/demo-items` 承担，它有真实端点）；`order:read`/`order:refund` 权限点保留供授权页与前端演示页用 | ✅ |
| **BUG-13** | **P2** | 批量删除**部分失败仍提示「删除成功」**且列表不刷新 | 选中多条，其中一条已被他人删除 | `handleDelete` 循环逐条删 + 单一 `catch`，首条成功即弹成功；失败时不刷新 | 逐条删除但**累计成功/失败数**：全成功 → `success`；部分成功 → `warning`「已删除 N 项，M 项失败：<原因>」；无论成败都刷新列表并清空选择 | ✅ |
| **BUG-14** | **P2** | 接口 `3002` 只在列表区显示通用错误块，未按原型「整页无权限视图」处理 | 菜单可见但接口拒绝（权限刚被回收） | 未实现四态中的 403 态 | 见 N-03（整页替换 + 申请权限引导） | 🕐 待补 |
| **BUG-15** | **P2** | 表格列排序点了不生效 | 配置了 `sortable: true` 的列（当前无页面启用） | 前端发 `sort=createdAt:asc`，而后端所有列表端点**都不读 `sort`**；且 api-spec §1.5 约定的是 `created_at:desc,id:asc`（snake_case） | 统一为 api-spec 约定（`<snake_case 字段>:asc\|desc`，多字段逗号分隔）并在后端列表端点消费；未实现前列表列不开放 `sortable` | 🕐 待补 |

## 4. 交互流程（涉及改动的关键路径）

### 4.1 登录 → 动态路由 → 菜单（BUG-03/04/09）

1. `/login` 提交 → 令牌落内存（access）+ 本地（refresh，按「记住我」选 local/session）。
2. 守卫恢复会话 → `/auth/me`（权限码唯一权威来源）→ `/auth/menus`（已按权限码过滤，**未过滤 `visible`**）。
3. 前端 `visibleMenus()` 递归剪枝隐藏节点 → 侧边栏数据；`generateRoutes()` 再按 `permissionCode` 二次过滤 + `resolveComponent()` 解析视图。
4. **解析规则（本轮归一化）**：接受 `system/users`、`dashboard/index`、`layout/blank`、`views/demo-item/index` 四种写法；解析失败**跳过并告警**（绝不生成死链路由）。
5. 目标路由未注册：属 `KNOWN_SYSTEM_PATHS` → `/403`；否则 `/404`。

### 4.2 按钮级权限（BUG-02/06）

- 「页面可见」由菜单树控制，「按钮可见」由 `v-permission` + `user.hasPermission()` 控制，**两者都不替代服务端校验**。
- `<CrudTable>` 动作码优先级：`permissionActions.<动作>` > `<permission>:<动作>`；后端权限码不是「前缀 + 标准动作」时（字典只有 `dict:write`）**必须**用前者，否则按钮永不渲染。
- 行内自定义按钮（分配角色、重置密码、下线设备…）一律显式写权限码。

### 4.3 表单校验与错误回显（BUG-07）

前端 `rules` 先校验 → 提交禁用防重复 → 服务端 `1001` 且带 `data.details` 时**逐字段回显**（`applyServerErrors`），字段错误定位到对应表单项；非字段级错误走统一 toast（`9001` 附 `traceId`）。

### 4.4 危险操作（NFR：删除 / 禁用 / 重置密码 / 改密）

一律二次确认；确认文案必须含**对象标识**与**后果**（如「禁用后该用户将被强制下线」）；成功后 `toast` + 列表刷新，失败留在原页不关弹窗。

### 4.5 令牌无感刷新

`3001/3003` → 并发请求共用同一刷新 Promise → 重放原请求；刷新失败清令牌跳登录（带 `redirect`）。自助改密成功后令牌被服务端吊销 → 前端主动清态并跳登录。

### 4.6 字典消费与失效（BUG-11）

`useDict(code)` 首屏拉一次并全局缓存 → 无 `dict:read` 直接降级（不发请求）→ 字典管理页维护成功后 `invalidate(code)`，消费方下次渲染取新值。

### 4.7 队列运维（BUG-04/06）

查看总览/积压/死信/cron 用 `system:queue:list`；暂停恢复、清空等待、死信重放/清理、cron 手动触发用 `system:queue:manage`，其中**破坏性操作（清空、清理）必须二次确认**，成功/失败均给明确文案并刷新总览。

## 5. 数据展示要求

| 项 | 规则 |
|---|---|
| 列表与分页 | 默认每页 20 条（可选 10/20/50/100），显示「共 N 条」；查询条件与列设置**按用户 + 路由**本地持久化 |
| 状态 | 统一 `<StatusTag>`：颜色取自字典项 `color`，**同时给文案**（不只靠颜色区分）；字典缺失时退化为原始值并保持可读 |
| 时间 | 一律本地时区展示（`toLocaleString('zh-CN', { hour12: false })`），提交按 UTC ISO 8601；空值显示 `—` |
| ID / 金额 | 主键与外键按 `string` 处理（雪花 ID 防精度丢失）；`decimal` 金额按字符串传输，禁浮点 |
| 审计 diff | 字段级 before → after 对照，敏感字段（password/token/secret/idCard/phone/email…）显示 `***`，变更行标「变更」 |
| 错误定位 | 错误块展示可读原因 + `traceId`（后 6 位足够报障）+ 「重试」按钮 |
| 空态 | 空插画 + 「暂无数据」+ （有创建权限时）「立即新建」引导 |
| 无权限 | 整页替换（N-03），不渲染表格骨架，避免误以为「数据为空」 |
| 统计卡 | 区分「无权限（—）/ 0 / 加载失败」，禁止把 3002 静默当 0（E-05） |

## 6. 兼容性要求

| 维度 | 要求 |
|---|---|
| 浏览器 | Chrome / Edge / Firefox 最新两个大版本（TC-NFR-008）；构建产物为纯静态资源，无 Node 运行时 |
| 断点 | ≥1440 侧边栏展开；1280–1440 次要列可折叠；768–1280 侧边栏自动折叠为图标；<768 抽屉式侧边栏 + 表格转卡片（仅保证可用） |
| 主题 | 浅色 / 暗色 / 紧凑三态经 CSS 变量覆盖 Element Plus 令牌，业务组件禁止写死颜色；主色可切换并持久化 |
| 可访问性 | 表格与表单可键盘操作；图标按钮提供 `aria-label`/tooltip；状态不仅靠颜色表达 |
| 环境变量 | `VITE_API_BASE_URL` 缺失时兜底同源 `/api/v1`（真机 405 缺陷的根治手段之一）；`VITE_AUTH_STORAGE=none` 时本地不落令牌（`AUTH_STRATEGY=session`）；**构建期输入不得只存在于被 gitignore 的 `.env.*`** |
| 体积门禁 | `dist` gzip ≤ 600 kB，`vendor-element-plus` gzip ≤ 360 kB（mock 冒烟脚本内置，当前 311.5 kB / 231.6 kB） |
| mock 与真机一致 | mock 的路由、权限码、响应结构必须与真实后端同源（本轮已修两处漂移：新增 `PUT /auth/profile`、`DELETE /auth/sessions/:id` 补 `auth:revoke-session` 校验） |
| 真机部署 | 2C2G 环境构建需 swap；`prisma generate` 必须在 `.env` 之后；Prisma query engine 平台相关，Linux 产物须在 Linux/CI 构建 |

## 7. 本轮改动清单（文件级）

**前端（`apps/admin-web`）**

- `src/components/CrudTable/index.vue`：操作列条件补插槽探测；新增 `permissionActions`；number/多选字段初始化与提交；查询条件持久化；批量删除容错与刷新。
- `src/components/CrudTable/types.ts`：新增 `permissionActions`、`FormField.multiple`。
- `src/components/FormDialog/index.vue`：下拉支持 `multiple`。
- `src/store/permission.ts`：`component` 归一化解析；`KNOWN_SYSTEM_PATHS` 与真实菜单对齐；`visibleMenus()` 递归剪枝。
- `src/store/dict.ts`：无 `dict:read` 短路降级。
- `src/store/user.ts`、`src/api/auth.ts`、`src/api/types.ts`：新增 `GET/PUT /auth/profile` 与 `ProfileResult`。
- `src/views/system/users|menus|dict|audit-logs|queue/index.vue`、`src/views/profile/index.vue`：权限门禁、多选角色、移除死 UI、导出按钮下线、自助资料切换。
- `src/layout/AppMain.vue`：keep-alive 修复。
- `mock/handlers.ts`：新增 `GET/PUT /auth/profile`；`DELETE /auth/sessions/:id` 补权限校验；`/auth/me` 与 profile 共用视图构造。
- `scripts/smoke-mock.mjs`：新增「个人资料自服务」冒烟段（8 条断言）。

**后端（`apps/example-api`）**

- `src/modules/auth/auth.controller.ts`：新增 `GET /api/v1/auth/profile`、`PUT /api/v1/auth/profile`（`auth:me`，白名单字段，`409` 冲突，写审计）。
- `prisma/seed.ts`：补「队列管理」菜单；移除死链「订单中心」；普通用户角色补 `dict:read`。

**文档**

- 本文件；`docs/40-api-spec.md`（§3.2 新增 profile 端点、§3.6 更正 `/dict/:code` 权限标注）；`docs/contracts/api-web.ts`（`ProfileResult`）；`README.md` 索引；`CHANGELOG.md`。

## 8. 验证与证据

| 验证项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `cd apps/admin-web && ./node_modules/.bin/vue-tsc --noEmit` | ✅ 通过（0 错误） |
| 前端单测 | `./node_modules/.bin/vitest run --no-file-parallelism` | ✅ 4 文件 / **31 通过**（新增 2 条回归：`visibleMenus` 递归剪枝、生成器 `views/<model>/index` 可解析） |
| mock 全链路冒烟 | `node scripts/smoke-mock.mjs` | ✅ **65/65 通过**（含新增 8 条自服务断言 + bundle gzip 门禁 311.5 kB / 231.6 kB） |
| 后端类型检查 | `cd apps/example-api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` | ✅ 通过 |
| 文件头门禁 | `node scripts/check-file-headers.mjs` | ✅ 371 个文件通过 |
| 接口一致性 | `node scripts/check-api-parity.mjs` | ✅ 前端调用面全部有对应后端路由 |
| 真机回归（1Panel / 裸机） | 见 [1Panel 实测手册](./63-1panel-real-deploy-verification.md)：重新发版 + `pnpm db:seed` + 重登 | ⛔ **未执行**（本轮未连真机；改动含种子，需重跑种子后按 §4.1 复验菜单与页面） |

> 复现命令（本机）：
> ```bash
> cd apps/admin-web && ./node_modules/.bin/vue-tsc --noEmit && ./node_modules/.bin/vitest run --no-file-parallelism
> node scripts/smoke-mock.mjs
> cd ../../apps/example-api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
> cd ../.. && node scripts/check-file-headers.mjs && node scripts/check-api-parity.mjs
> ```

## 9. 遗留与后续（按优先级）

1. **必须配套后端**：N-01 租户管理、N-02 异步导出、BUG-15 排序参数消费、N-03 整页 403（纯前端可先做）。
2. **发版注意**：本轮改了菜单与角色种子 → 真机必须**重跑 `db:seed` 并让用户重新登录**（动态路由与权限码均为登录时快照）；权限码新增 `dict:read` 授予普通角色后，已有角色的授权记录不会被自动补齐，需在角色页保存一次或在种子中确认。
3. **产品待决策**：`GET /dict/:code` 是「登录即可读」还是「必须 `dict:read`」——本轮的折中是「授权 + 前端降级」；若后续放宽端点权限，请同步 `docs/40-api-spec.md` §3.6 与 `PERM.DICT_READ` 的说明。
4. **体验债**：E-06 菜单图标/权限码选择器、E-05 工作台统计三态、死信列表无分页（后端 `listDeadLetters` 全量返回，规模大时需加窗口）。
