# 管理后台前端功能补充与缺陷修复方案

> 版本 v0.4.2 ｜ 状态：**已实施 + 已在真机（1Panel / `106.55.32.251`）验证 + 已随 [v0.3.0](./90-release-v0.3.0.md) 发布（2026-10-14）** ｜ 关联：[PRD-005 管理后台模板](./prd/prd-005-admin-template.md) ｜ [原型与 UI 规范](./25-ui-prototype.md) ｜ [API 文档](./40-api-spec.md) ｜ [C-06 前端契约](./contracts/api-web.ts) ｜ [C-06 契约定稿记录](../CHANGELOG.md) ｜ 更新：2026-10-14 ｜ 负责人：donttemo
>
> 定位：本轮把管理后台前端从「文档标注已交付」拉到「**真机可用的同源状态**」。所有缺陷均在代码层复核过根因
> （后端权限码常量、菜单种子、`import.meta.glob` 解析规则、mock 与真机差异、路由注入与登录态生命周期），
> 并按 PRD-005 的四个交付面（页面清单 / 组件规范 / 交互规范 / 兼容要求）给出**修复后预期行为**与验证方式。
>
> 一句话结论：**P0 缺陷集中在「路由与权限的数据源在前后端不同源」**——本地 mock 全绿、真机才炸。
> v0.4 追加 5 项（BUG-16~20），其中 **BUG-16「点进功能页侧边栏消失」与 BUG-19「换号后仍是上一个账号的菜单」**
> 属布局外壳与登录态生命周期，均已带**可失败的反向验证**；v0.4.1 追加 BUG-21（静态路由表重名僵尸记录）与
> BUG-22（工作台对低权限账号刷 403 并把无权指标显示成误导性的 `0`）。
> 真机验证方式见 **§8.1**（真实 Chromium 端到端 26/26、全程 0 条 4xx），数据面复核见 `verify-webfix7.sh` 24/24 与 `verify-c06.sh` 27/27。

## 1. 现状核对：文档承诺 vs 代码实现

依据 [原型 §3 页面清单](./25-ui-prototype.md) 与 [PRD-005 §7 验收标准] 逐页核对（`apps/admin-web/src`）：

| 路由 | 页面 | 核对结论 | 说明 |
|---|---|---|---|
| （全局布局） | 侧边栏 + 顶栏 + 标签页 | ❌ **动态功能页会整块脱离外壳** | BUG-16 |
| （登录态切换） | 登出 / 换号登录 | ❌ **侧边栏与路由表停留在上一个账号** | BUG-19 |
| `/login` `/403` `/404` `/` `/profile` | 登录 / 错误页 / 工作台 / 个人中心 | ⚠️ 基本可用，**个人中心写入不可用** | 见 BUG-05 |
| `/system/users` | 用户管理 | ⚠️ 可用但**越权按钮可点 + 角色字段类型错** | BUG-06 / BUG-07 |
| `/system/roles` | 角色与权限 | ✅ 通过 | 权限树三层、数据范围四档、复制角色均与后端同源 |
| `/system/menus` | 菜单管理 | ⚠️ 按钮无权限门禁 | BUG-06 |
| `/system/dict` | 字典管理 | ❌ **字典项维护按钮全部不渲染** | BUG-02 |
| `/system/audit-logs` | 审计日志 | ❌ **「详情」入口不可达（diff 看不到）** | BUG-01 |
| `/system/queue` | 队列管理 | ❌ **真机不可达**（种子缺菜单） | BUG-04 |
| `/system/tenants` | 租户管理 | ✅ **已实现**（N-01 收口，2026-10-15） | N-01 |
| `/order/list`、`/demo-items` | 生成器/演示列表页 | ❌ **生成器页面菜单不可达** | BUG-03 |

## 2. 需要新增或完善的前端功能模块与页面

### 2.1 新增（当前完全缺失）

| 编号 | 模块 / 页面 | 目标行为（交互流程 + 数据展示） | 依赖 | 验收 |
|---|---|---|---|---|
| **N-01** | **租户管理页 `/system/tenants`**（原型 §3 M8 规划项） | 列表展示租户编码/名称/隔离级别（`shared`/`dedicated`）/状态/创建时间；支持新建（选 `isolation`）、改套餐与状态、停用（不物理删除）、`shared ↔ dedicated` 迁移（长任务 → 进度反馈）。隔离级别与状态用 `<StatusTag>` + 字典 `tenant_isolation` / `tenant_status`；停用与迁移必须二次确认 | **后端 `/tenants` 五个端点（api-spec §3.9 已定义，实现为零）+ 权限点 `tenant:read/create/update/delete/manage`** | ✅ **已完成（2026-10-15）**：后端五端点 + `TenantAdminStore`（Prisma/内存双实现）+ `@IgnoreTenant` 豁免 + legacy 守卫；前端 `views/system/tenants/index.vue`（CrudTable + 停用/迁移二次确认，迁移接入任务条）；mock 同构；`tenant-admin` 单测 20 + `smoke-admin` 22 条断言通过 |
| **N-02** | **异步导出任务中心**（原型 §7「导出 / 批量走异步任务」） | 列表页点导出 → 派发任务返回 `jobId` → 页脚常驻任务条（进度百分比 + 轮询退避）→ 完成后下载；失败可重试并展示 `traceId` | **后端 `/audit-logs/export`（api-spec §3.7 标 Backlog）与通用 `/jobs/:id/progress`** | ✅ **已完成（2026-10-15）**：`JobCenterService`（进程内存登记表 / 归属人隔离 / 产物上限 20MB / 重跑状态机）+ `/jobs/:id/progress|retry|download`；`GET /audit-logs/export` 派发；前端 `useJobCenter` store + `JobBar.vue`（轮询退避 1s×1.5 封顶 10s、连续 3 失败标 stale、sessionStorage 按用户持久化）+ 审计页导出按钮；CSV 与 mock 逐字节同构；单测 10 + 12 + 冒烟通过 |
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
| **BUG-15** | **P2** | 表格列排序点了不生效 | 配置了 `sortable: true` 的列（当前无页面启用） | 前端发 `sort=createdAt:asc`，而后端所有列表端点**都不读 `sort`**；且 api-spec §1.5 约定的是 `created_at:desc,id:asc`（snake_case） | 统一为 api-spec 约定（`<snake_case 字段>:asc\|desc`，多字段逗号分隔）——**前后端均已完成**：`@fw/db` 新增 `parseSortQuery()`（字段白名单映射 + 方向校验；未知字段 / 非法方向 / 超 5 项一律 400，**不静默忽略**），`@fw/auth` 的 `UserQuery` 增 `sort`，Prisma 与内存两个 store 均消费并始终追加主键 tie-breaker；`GET /users` 已接线并通过冒烟（28/28，含 3 条排序断言）。**前端** `CrudTable` 抽出纯函数 `buildSortParam()`（camelCase → snake_case，支持列 `sortField` 覆盖），`users` 页开启 5 列 `sortable`，mock 同步同一白名单语义，冒烟 68/68（含 3 条排序断言）、前端单测 69（含 9 条）。**`GET /audit-logs` 已接入同一解析器**（白名单 `id`/`module`/`action`/`target_type`/`created_at`，两套 store 消费并追加 `id asc` 次级键；审计日志页 4 列开启 `sortable`，`smoke-admin` +3 条、`smoke-mock` 71/71）。**剩余**：roles / dictionary 等小规模枚举型列表接入同一解析器（属增量，非缺陷） | ✅ 已修（后端 users + audit-logs、前端接线均完成） |
| **BUG-16** | **P0** | **点进任何具体功能页后侧边栏（连带顶栏、标签页）整块消失**，只剩一块裸内容区；点「系统管理 → 用户管理」必现 | 登录后点击侧边栏任意业务菜单（`/system/users`、`/system/roles`、`/demo-items`…）；工作台与个人中心正常 | `guard.ts` 用 `router.addRoute(route)` 把动态路由注册成**顶层记录**，匹配链里不含布局路由 → 渲染的是 `views/layout/blank.vue`（内容只有一个 `<router-view/>`），全局布局 `layout/index.vue` 根本没被挂载。目录类菜单的父组件 `blank.vue` 语义是「承载子路由出口」，从来不是「替代外壳」 | 动态路由统一经 `router/inject.ts` 的 `injectDynamicRoutes` **挂到布局路由（`name: 'Layout'`）之下**；匹配链变为 `Layout → /system → /system/users`，外壳常驻，内容区只换内层视图。子路由仍写绝对路径（URL 不变） | ✅ |
| **BUG-17** | **P1** | 无权限时**看不到 403 页**：直输一个「存在但无权限」的路径（如 `/system/users`）落的是 **404**，与「路径不存在」无法区分 | 无 `user:read` 的账号直输 `/system/users`（或权限刚被回收后点旧标签） | 兜底路由已注册的前提下 `router.resolve()` **对任何路径都返回非空 `matched`**（命中 `/:pathMatch(.*)*`），因而 `if (resolved.matched.length > 0) return true` 恒成立；其后的 `KNOWN_SYSTEM_PATHS → 403` 分支是**不可达死代码** | 判定改为「匹配链是否命中兜底记录」（抽出纯函数 `resolveFallback` 便于单测）：命中兜底 + 属已知系统路径 → `/403`；命中兜底 + 路径未知 → `/404`；命中真实路由 → 放行。403 与 404 从此可区分 | ✅ |
| **BUG-18** | **P2** | mock 下永远看不出「隐藏菜单仍进侧边栏」类缺陷 | 在菜单管理里把某菜单设为隐藏，用 mock 跑 | mock 的 `GET /auth/menus` 比真实后端**多做了一层 `visible` 过滤**，而真实后端只按权限码过滤、可见性由前端剪枝 → 前端 `visibleMenus()` 剪枝路径在 dev 下**永不执行**，「mock 全绿、真机炸」的经典温床 | mock 去掉 `visible` 过滤，与后端行为对齐（可见性在前端剪枝）；`订单中心` 菜单标注为 mock-only 演示菜单（生产 seed 已移除该分支） | ✅ |
| **BUG-19** | **P0** | **登出后换另一个账号登录，侧边栏仍显示上一个账号的菜单**，且上一个账号有权限的页面（如用户管理）仍可路由进入（渲染别人的页面，只是接口 3002） | 同一浏览器标签页内：admin 登录 → 退出登录 → 用 alice 登录（不刷新页面） | ① 守卫判据只有 `if (!permission.routesAdded)`，而 `routesAdded` **登出后从未复位**——`permission.reset()` 在生产代码里**没有任何调用点**（只有单测调用）→ 换号后整个「加载菜单 + 注入路由」步骤被跳过；② 动态路由也不会随登出自动出表 | ① 判据改为「**菜单所属用户 id** 是否变化」（`menusOwnerId`）：登出与换号都能自愈，即使多入口登出（顶栏、个人中心、被踢下线）也无需逐一改；② 重建时传入上一轮注入的记录名，先 `removeRoute` 再注入 → 上一个账号的路径彻底出表，直输 URL 落 403（`TC-WEB-001 未授权路径不进路由表`）；③ `reset()` 刻意保留 `injectedRouteNames`（否则换号时无从移除旧记录） | ✅ |
| **BUG-20** | **P2** | 换号后**标签页仍列出上一个账号开过的标签**（点进去落 403） | 与 BUG-19 同场景；标签本地持久化在 `localStorage` | `TagsView` 所有账号共用一个存储键 `fw_admin_tags`，既不隔离也不清理 → 新账号继承旧账号的标签，且两边互相覆盖写入 | 存储键按用户隔离为 `fw_admin_tags:<用户 id>`，并让键随登录用户变化 → 换号即自动切到该账号自己的标签集合（首个账号视为空）；不做旧键迁移（无法判断标签归属，迁移等于把上一个账号的标签泄露给新账号）。另修正装配顺序：`restore()` 必须放在持久化 watcher **之后**，否则初始状态不写回本地（刷新即丢标签） | ✅ |

| **BUG-21** | **P2** | 静态路由表里 **`/redirect` 存在两条同名同路径记录** | 阅读 `src/router/routes.ts`；或调试标签页「刷新」时观察 | 上一轮「`/redirect` 从顶层移入布局内」只做了一半：**新增了布局内记录，却漏删顶层同名记录**。vue-router 在注册时会把同名记录**静默移除**（先者被后者覆盖），因此运行时表现为正常、只留一条永远不可达的僵尸定义，且与文件头注释「从顶层移入布局内」自相矛盾 | 删除顶层 `/redirect`，仅保留布局内那一条；新增断言「静态路由表内不得存在同名或同路径记录」。**注意首版断言写在 `router.getRoutes()` 上是假绿** —— 实测故意加回重名后它仍然通过（vue-router 已静默去重），改为断言静态定义表 `constantRoutes` 本身后，加回重名 → FAIL、去掉 → PASS | ✅ |

| **BUG-22** | **P1** | **低权限账号的工作台**：① 控制台 3 条 `403`（`/permissions`、`/roles`、`/audit-logs`）；② 更严重的是把**无权读取的指标显示成 `0`** —— `0` 与「真实为 0」无法区分，属误导；③「常用入口」列出无权进入的页面，点进去 403 | 以 `alice`（仅 `user:read` + `dict:read`）登录后看工作台 | `views/dashboard/index.vue`（v0.1.0 起未改动）**无条件** `Promise.all` 拉 `/users`、`/roles`、`/permissions`、`/audit-logs`，请求失败一律 `.catch(() => null)` 后回落成 `0`；常用入口是写死的三条、不看权限 | ① 每个指标按其**后端守卫权限码**决定是否请求（`/users`→`user:read`、`/roles`→`role:read`、`/permissions`→`permission:read`、`/audit-logs`→`audit:read`），无权端点**不发请求** → 不再产生 403；② 统计卡三态化（加载中 / 有值 / **取数失败显示「—」**），不再用 `0` 冒充；③ 常用入口按权限过滤；④ 一个指标都不可读时给出明确说明而非渲染空卡片。与 BUG-11（字典短路降级）同一模式 | ✅ |

## 4. 交互流程（涉及改动的关键路径）

### 4.1 登录 → 动态路由 → 菜单（BUG-03/04/09/16/19）

1. `/login` 提交 → 令牌落内存（access）+ 本地（refresh，按「记住我」选 local/session）。
2. 守卫恢复会话 → `/auth/me`（权限码唯一权威来源）→ `/auth/menus`（已按权限码过滤，**未过滤 `visible`**）。
3. 前端 `visibleMenus()` 递归剪枝隐藏节点 → 侧边栏数据；`generateRoutes()` 再按 `permissionCode` 二次过滤 + `resolveComponent()` 解析视图。
4. **解析规则（本轮归一化）**：接受 `system/users`、`dashboard/index`、`layout/blank`、`views/demo-item/index` 四种写法；解析失败**跳过并告警**（绝不生成死链路由）。
5. **注入规则（BUG-16）**：生成的路由**必须**以 `router.addRoute('Layout', record)` 挂到布局路由之下——顶层注册会让功能页脱离侧边栏/顶栏；与静态路由同路径的记录（`/dashboard`）跳过，保留静态记录。
6. 目标路由未注册：属 `KNOWN_SYSTEM_PATHS` → `/403`；否则 `/404`（判定见 BUG-17）。

**侧边栏可见性 = 布局是否在匹配链上**。任何「功能页侧边栏消失」的排查第一步都是看 `router.resolve(path).matched`：完整链应为
`Layout → 目录节点（layout/blank）→ 具体页面`；只剩 `目录节点 → 具体页面` 就说明路由没挂到布局下。

### 4.1.1 登出与换号（BUG-19）

1. 登出：`user.logout()` → 服务端吊销 → 清本地态（**不动** permission store 的 `injectedRouteNames`）→ `router.push('/login')`。
2. 下次进入受保护页面时守卫比对「当前登录用户 id」与 `menusOwnerId`：**不一致即重新加载菜单并重建路由表**（先移除上一轮注入的记录）。
3. 结果：换号后侧边栏与可达页面立即归属新账号；被吊销的路径直输 URL 落 403，而不是渲染上一个账号的页面。
4. 同一账号重复进入是幂等的（不会重复注册、不会误删静态路由）。

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
- `src/store/permission.ts`：`component` 归一化解析；`KNOWN_SYSTEM_PATHS` 与真实菜单对齐；`visibleMenus()` 递归剪枝；新增 `menusOwnerId` / `injectedRouteNames`（换号重建，BUG-19）。
- `src/router/routes.ts`：布局路由具名 `LAYOUT_ROUTE_NAME`；`/redirect` 移入布局内（标签页刷新不再卸载外壳）；导出 `CATCH_ALL_NAME`；**删除顶层重复的 `/redirect` 记录**（BUG-21）。
- `src/router/inject.ts`（**新增**）：`injectDynamicRoutes()` —— 动态路由挂到布局之下 + 同路径去重 + 换号时先移除上一轮记录。
- `src/router/guard.ts`：改用 `injectDynamicRoutes`（BUG-16）；抽出纯函数 `resolveFallback()` 修掉 403 死代码（BUG-17）；按 `menusOwnerId` 判定换号重建（BUG-19）。
- `src/router/__tests__/layout-nesting.test.ts`（**新增**）：16 条护栏 —— 匹配链含 Layout、静态路由去重、`/redirect` 在布局内、公开页无外壳、真实挂载出 `.fw-sidebar`、换号后旧页面落 403、`resolveFallback` 三分支。
- `src/store/dict.ts`：无 `dict:read` 短路降级。
- `src/store/user.ts`、`src/api/auth.ts`、`src/api/types.ts`：新增 `GET/PUT /auth/profile` 与 `ProfileResult`。
- `src/views/system/users|menus|dict|audit-logs|queue/index.vue`、`src/views/profile/index.vue`：权限门禁、多选角色、移除死 UI、导出按钮下线、自助资料切换。
- `src/layout/AppMain.vue`：keep-alive 修复。
- `src/layout/TagsView.vue`：标签存储键按用户隔离 + 修正装配顺序（BUG-20）。
- `src/layout/__tests__/tags-view.test.ts`（**新增**）：2 条护栏 —— 新账号看不到上一个账号的标签、切回原账号恢复、两端存储键互不污染。
- `src/router/__tests__/fixtures/real-menus.json`（**新增**）：真机 `GET /api/v1/auth/menus`（admin）**原样转储**的响应 `data` 段，非手写 mock。
- `src/router/__tests__/real-menus.test.ts`（**新增**）：6 条集成护栏 —— 用**真机菜单数据**跑真实管线（`generateRoutes` → `injectDynamicRoutes`），断言每个菜单页都命中自身记录且匹配链以 `Layout` 开头。专治「mock 形状 ≠ 真机形状」：生成器写法的 `views/<model>/index` 能否解析、目录节点子页是否嵌在布局内。
- `src/views/dashboard/index.vue`：统计指标按**后端守卫权限码**决定是否请求（无权端点不发请求）、卡片三态化（失败显示「—」而非 0）、常用入口按权限过滤、无可读指标时给明确说明（BUG-22）。
- `src/views/dashboard/__tests__/dashboard-permission.test.ts`（**新增**）：5 条护栏 —— 低权限只请求有权的端点、常用入口过滤、无可读指标不渲染空卡、取数失败显示「—」、高权限四卡齐全。
- `mock/handlers.ts`：新增 `GET/PUT /auth/profile`；`DELETE /auth/sessions/:id` 补权限校验；`/auth/me` 与 profile 共用视图构造；`/auth/menus` 去掉 `visible` 过滤与后端对齐（BUG-18）。
- `mock/db.ts`：标注 `订单中心` 为 mock-only 演示菜单。
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
| 前端单测 | `./node_modules/.bin/vitest run --no-file-parallelism` | ✅ 8 文件 / **60 通过**（16 条路由/布局护栏 + 6 条真机菜单数据集成护栏 + 5 条工作台权限护栏 + 1 条标签页隔离护栏 + 静态表重名校验） |
| **护栏反向验证** | 临时回退修复后复跑同组测试 | ✅ **能失败才算数**：回退 BUG-16 → 3 条 FAIL（含 `.fw-sidebar` 挂载断言，对**真机菜单数据**同样 3 条 FAIL）；回退 BUG-19 → 3 条 FAIL；回退 BUG-20 → 1 条 FAIL；回退 BUG-21 → 1 条 FAIL；回退 BUG-22 → 3 条 FAIL |
| mock 全链路冒烟 | `node scripts/smoke-mock.mjs` | ✅ **65/65 通过**（含新增 8 条自服务断言 + bundle gzip 门禁 311.5 kB / 231.6 kB） |
| 后端类型检查 | `cd apps/example-api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit` | ✅ 通过 |
| 文件头门禁 | `node scripts/check-file-headers.mjs` | ✅ 375 个文件通过 |
| 接口一致性 | `node scripts/check-api-parity.mjs` | ✅ 前端调用面全部有对应后端路由 |
| 真机部署 + 本轮验收 | `106.55.32.251`：重建前端产物 → 同步 `/opt/1panel/www/fw-web` → `wb-ssh/verify-webfix7.sh` | ✅ **24/24 通过**（产物为按用户隔离键的新 TagsView、站点 200、后端 `/ready` ok 且未重启、菜单树 8 条路径齐全且无 `/order` 死链、`/auth/profile` 可达） |
| 真机全量回归 | `wb-ssh/verify-c06.sh`（C-06 契约面 27 项） | ✅ **27/27 通过**，无回退 |
| **真机浏览器端到端** | 真实 Chromium 经 SSH 动态转发访问 `https://cs.donttemo.top`（截图见 `wb-ssh/shots/`） | ✅ **26/26 通过**，且**全程 0 条 4xx**（见下方 §8.1） |
| 真机菜单数据 × 真实管线 | `vitest run src/router/__tests__/real-menus.test.ts` | ✅ **6/6 通过**（夹具为真机 `/auth/menus` 原样转储；反向验证：撤掉修复 → 3 条 FAIL） |

**BUG-16 的原始证据（修复前实测）**：以现有注入方式构造路由表后 `router.resolve('/system/users').matched` =
`["/system","/system/users"]` —— 匹配链里没有 `Layout`，即外壳未被挂载。修复后为
`["Layout","/system","/system/users"]`，DOM 断言 `.fw-sidebar` / `.fw-layout` / `.fw-tags` 均存在。

> 已知无害告警：首次进入未注册的动态路由时，vue-router 会打印 `No match found for location with path "…"`。
> 这是「先解析目标、再在守卫里注入路由」这一模式的固有产物（修复前同样存在），随后守卫会注入并重新解析，不影响结果。

> 复现命令（本机）：
> ```bash
> cd apps/admin-web && ./node_modules/.bin/vue-tsc --noEmit && ./node_modules/.bin/vitest run --no-file-parallelism
> node scripts/smoke-mock.mjs
> cd ../../apps/example-api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
> cd ../.. && node scripts/check-file-headers.mjs && node scripts/check-api-parity.mjs
> ```

### 8.1 真机浏览器端到端实测（2026-10-14，`106.55.32.251`）

方法：真实 Chromium（Playwright 内核，`chromium-1223`）访问 `https://cs.donttemo.top`，**网络经 SSH 动态转发从远端出网**
（本机直连 `106.55.32.251:443` 的 TLS 握手被本地网络重置，出网本身正常）。断言全部限定在 `.fw-sidebar` **内部** ——
页面正文里也有「角色权限」「审计日志」等快捷入口卡片标题，用全页文本断言会误判（首版脚本就踩了这个坑）。

| 组 | 断言 | 结果 |
|---|---|---|
| 1 登录 | 未登录访问站点 → 重定向 `/login`；admin 登录落 `/dashboard`；侧边栏与标签页渲染 | ✅ |
| 2 **报障路径** | **点击**「系统管理 → 用户管理」→ URL `/system/users`，且侧边栏 / 顶栏 / 标签页**全部仍在**；侧边栏实测宽度 200px；菜单含 6 个系统管理子项与「队列管理」、无「订单中心」 | ✅ |
| 3 冷启动路径 | 直输 `/system/roles`、`/system/menus`、`/system/dict`、`/system/audit-logs`、`/system/queue`、`/demo-items`：URL 未被改写、侧边栏在、面包屑渲染出该页菜单名 | ✅ 6/6 |
| 4 换号登录 | admin（标签页已积累 7 个标签）→ 退出 → alice 登录：alice 侧边栏文本为 `控制台 / 系统管理 / 用户管理 / 字典管理`，**admin 独有的「角色权限 / 菜单管理 / 审计日志 / 队列管理 / DemoItem管理」全部消失**；标签页只剩「工作台」 | ✅ |
| 5 JS 运行时报错 | 全程无 `pageerror` 与非资源类 `console.error` | ✅ |
| 6 网络 4xx | **全程 0 条 4xx**（修复前后对比：修复前 alice 登录必现上述 3 条 403） | ✅ |

首轮实测（修复 BUG-22 之前）在此处记录到 3 条 `403`（`GET /permissions`、`/roles`、`/audit-logs?pageSize=1`）。
定位为工作台的既有缺陷（**不是本轮回归**，`views/dashboard/index.vue` 自 v0.1.0 起未改动），
已按 BUG-22 一并修复并重新构建部署 —— 复测后 **26/26 通过、4xx 归零**。
截图证据：`wb-ssh/shots/01-system-users.png`（功能页外壳完整）、`page_system_*.png`（6 个功能页）、
`02-alice-after-switch.png`（换号后侧边栏 + 工作台只见「用户数」，不再出现冒充 0 的指标）。

## 9. 遗留与后续（按优先级）

1. **必须配套后端**：~~N-01 租户管理（后端 `/tenants` 五端点**未实现**，前端亦无页面）~~ —— **已完成（2026-10-15）**：`tenant-admin.controller.ts` 五端点（`@IgnoreTenant` + `system:tenant:ignore` 双重要求，legacy 停用/迁移一律 `1004`，DELETE = 停用不写 `deletedAt`）+ `TenantAdminStore`（Prisma 与内存双实现，编码格式/dedicated 必填/唯一性校验/连接串密文）+ 前端 `views/system/tenants/index.vue`；~~N-02 异步导出任务中心（后端无任务表/端点）~~ —— **已完成（2026-10-15）**：`JobCenterService`（进程内存登记表、归属人隔离、产物上限 20MB、重跑状态机）+ `/jobs/:id/progress|retry|download` + `GET /audit-logs/export` 派发 + 前端 `useJobCenter`/`JobBar.vue`（轮询退避、stale 标记、按用户持久化）；api-spec 已同步（§3.7/§3.9/§3.11/§4）。~~N-03 整页 403（纯前端可先做）~~ —— **已实现并随 v0.3.0 交付**：`router/guard.ts` 的 `resolveFallback()` 三分类（公开页 login/403/404 放行 → 已知系统路径命中 `/403` → 其余 `/404`）+ `routes.ts` 的 `/403` 静态记录 + `views/error/403.vue`，随路由重构（提交 `68d9334` / `f351be3`）落地；本条原有待办标注作废（2026-10-14 核查订正）。~~BUG-15 排序参数消费~~ —— **已完成（后端 + 前端）**：`@fw/db` 的 `parseSortQuery()` 白名单解析 + `@fw/auth` `UserQuery.sort` + 双 store 消费 + `GET /users` 接线 + `CrudTable` 前端接线（`buildSortParam()` 转 snake_case，`users` 页 5 列开启 `sortable`），冒烟 28/28（后端）+ 68/68（mock）；**剩余为增量项**：将其余列表端点（roles / dictionary 等小规模枚举型列表）接入同一解析器（2026-10-14 核查订正）。
2. **发版注意（分两段）**：① **BUG-01~15 那一段**改了菜单与角色种子 → 真机必须**重跑 `db:seed` 并让用户重新登录**（动态路由与权限码均为登录时快照）；权限码新增 `dict:read` 授予普通角色后，已有角色的授权记录不会被自动补齐，需在角色页保存一次或在种子中确认。② **BUG-16~21 这一段（含 §8.1 真机实测的交付内容）只改了前端与前端 mock**，不需要重跑种子、不需要重新登录 —— 只需重新构建 `apps/admin-web` 并把 `dist/` 同步到站点目录（本轮做法：从 `git archive` 打包 → `/opt/fw/web-fix/<ts>` 建依赖与构建 → `rsync -a --delete` 到 `/opt/1panel/www/fw-web`；后端进程、`/opt/fw/current` 软链与数据库均未触碰）。
3. **产品待决策**：`GET /dict/:code` 是「登录即可读」还是「必须 `dict:read`」——本轮的折中是「授权 + 前端降级」；若后续放宽端点权限，请同步 `docs/40-api-spec.md` §3.6 与 `PERM.DICT_READ` 的说明。
4. **体验债**：E-06 菜单图标/权限码选择器。~~死信列表无分页（后端 `listDeadLetters` 全量返回，规模大时需加窗口）~~ —— **已完成（2026-10-15）**：`pageDeadLetters()` 窗口切片 + 控制器返回 `page/pageSize`，前端 `views/system/queue/index.vue` 分页消费，`packages/queue` 新增 4 条单测、`smoke-mock` 补分页断言。~~E-05 工作台统计三态~~ —— **本轮已实现**（BUG-22：按权限取数 + 加载/有值/失败三态 + 入口过滤），剩余仅「统计口径本身」（当前一律取 `total` 或全量 `length`，与数据权限 `self` 的口径关系未细化）。
5. **标签页迁移说明（BUG-20 的副作用，可接受）**：标签存储键由 `fw_admin_tags` 改为 `fw_admin_tags:<用户 id>`，**不做旧键迁移**
   —— 升级后各账号的标签集合会从空开始重建一次（旧键数据被弃用）。不迁移是刻意的：无法判断旧键里的标签属于哪个账号，
   迁移等于把上一个账号的标签泄露给新账号。如需保留可加一次性提示，属产品待决策。
