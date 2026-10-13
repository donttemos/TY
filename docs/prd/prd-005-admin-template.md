# PRD-005 · 管理后台模板

> 里程碑：M5 ｜ 状态：草案 ｜ 优先级：P0 ｜ 依赖：M3 ｜ 负责人：待定 ｜ 更新：2026-10-09

## 1. 背景与目标

框架的价值最终要被「看得见」——一个开箱可用的后台，是团队评估这套框架的第一印象，也是 G1（1 天出骨架）的主要载体。

目标：`--template=admin` 生成的项目自带登录、动态菜单、用户/角色/权限/字典/审计日志等通用能力，并与后端 RBAC 同源。

衡量：新项目 1 天内可交付「能登录、能配权限、能管数据」的后台。

## 2. 范围

**做**：前端工程（Vue3 + Element Plus）、布局与主题、登录/个人中心、动态路由与菜单、用户/角色/权限/字典/审计日志页面、标准 CRUD 组件（查询表单 + 表格 + 弹窗表单）、前后端权限同源、环境变量与构建配置。

**不做**：营销页 / 数据大屏 / 移动端；复杂表单设计器与工作流引擎（列为待规划）。

## 3. 用户故事

- 作为管理员，我登录后只看到被授权的菜单，权限变更重新登录即生效。
- 作为管理员，我在角色页面勾选菜单与按钮权限并保存，无需改代码。
- 作为开发，我写一个新页面时复用 `<CrudTable>` 组件，只配字段与接口即可。
- 作为运维，我通过 `pnpm build` 产出静态资源，用 Nginx 托管，无需 Node 运行时。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 工程脚手架 | Vite + Vue3 + TypeScript + Pinia + Vue Router；ESLint/Prettier 与后端同一套规范；支持 `pnpm dev / build / preview` |
| FR-02 | 布局与主题 | 侧边菜单 + 顶栏 + 面包屑 + 多标签页；主题色/暗色模式/紧凑模式可配；响应式（≥1280 完整，≥768 折叠） |
| FR-03 | 登录与个人中心 | 登录页（账号密码 + 图形验证码钩子）、记住我、登出；个人中心含资料修改、改密、登录设备/会话查看 |
| FR-04 | 动态路由 | 菜单由后端权限树接口下发，前端按 `permission code` 过滤路由与按钮，杜绝「前端隐藏即安全」 |
| FR-05 | 用户管理 | 列表/新增/编辑/启用禁用/重置密码/分配角色；支持按部门（预留）与关键词筛选 |
| FR-06 | 角色与权限 | 角色 CRUD；权限树勾选（菜单 / 按钮 / 接口）；支持复制角色 |
| FR-07 | 字典管理 | 字典分类与项维护，前端 `useDict()` 直接消费，避免枚举硬编码 |
| FR-08 | 审计日志 | 按人/时间/模块查询操作记录，展示变更前后值（脱敏） |
| FR-09 | 标准 CRUD 组件 | `<CrudTable>`：配置 `columns / searchForm / api` 即可；内置分页、排序、批量操作、导入导出钩子、加载/空态 |
| FR-10 | 请求层封装 | 统一请求拦截（token 注入、traceId 透传）、响应拦截（错误码 → 提示）、401 跳转登录、刷新 token 无感重试 |
| FR-11 | 环境变量 | `.env.*` 区分 dev/test/prod，API 基址可配；构建产物为纯静态资源 |

## 5. 非功能需求（NFR）

- 首屏可交互 ≤ 2s（本地/内网），打包体积 gzip 后 ≤ 500KB（按需引入 Element Plus）。
- 所有列表接口带分页，单页默认 20 条；表格支持列设置与本地持久化。
- 前端不存敏感信息（token 放 httpOnly Cookie 或内存，视鉴权策略而定）。
- 关键操作（删除、禁用、改密）必须有二次确认。

## 6. 关键设计

**目录**

```
web/src/{api,views,components,layout,router,store,utils,directives}
web/src/components/CrudTable/     # 标准列表页核心
web/src/directives/permission.ts  # v-permission 按钮级控制
```

**权限同源**：后端返回的菜单树含 `code`；前端路由 meta 标注所需 code；按钮用 `v-permission="'order:refund'"`。

**与后端接口约定**：`/auth/login`、`/auth/refresh`、`/auth/me`、`/auth/menus`、`/users`、`/roles`、`/permissions`、`/dict`、`/audit-logs`（以 [API 文档](../40-api-spec.md) 为准）。

页面线框、设计令牌与交互规范见 [原型与 UI](./../25-ui-prototype.md)。

## 7. 验收标准（AC）

- [x] 模板项目启动后可直接登录，未授权菜单不出现在侧边栏与路由中（直接输 URL 也被拦截）。（登录页 + `/auth/menus` 下发菜单树二次过滤生成路由，静态路由仅登录/403/404/工作台/个人中心；守卫对已知系统路径无权限落 403，未知落 404；权限过滤有单测）
- [x] 角色勾选权限保存后，目标用户重新登录生效；按钮级权限同步隐藏/禁用。（角色页权限树勾选 → `PUT /roles/:id/permissions`；权限码经 `/auth/me` 唯一权威来源，重登生效；`v-permission` + CrudTable 按 `user:create` 等码渲染按钮，冒烟验证 alice 越权 3002）
- [x] 新增一个业务列表页，仅用 `<CrudTable>` + 一段配置即可完成，代码 ≤ 80 行。（演示页 `views/demo/orders/index.vue` 65 行：columns + searchForm + api + permission 四要素）
- [x] token 过期时自动刷新并重试原请求，用户无感。（3001/3003 → 无感刷新，并发共用同一 Promise、刷新成功重放原请求；刷新失败清令牌跳登录；单测覆盖重放/跳登录/防递归/并发合并，TC-WEB-003）
- [x] 审计日志页能按人查出一次操作的前后值。（审计页按用户/时间/模块查询，详情抽屉展示字段级 diff；mock 冒烟验证 `module=user` 可查且含前后值）
- [x] 生产构建产物为静态文件，Nginx 托管后功能完整，无 Node 依赖。（`vite build` 产出纯静态 dist；mock 仅 dev/test 挂载、生产不引入；Nginx SPA 托管配置见部署手册 §3）

## 8. 依赖与风险

- 依赖 M3（RBAC 与菜单树接口）；前端与后端需约定统一错误码表。
- 风险：动态路由与静态路由混合导致权限绕过 → 所有业务路由统一由权限树生成，静态路由仅限 404/登录页。
- 风险：Element Plus 全量引入导致体积膨胀 → 按需引入 + 构建体积门禁。

## 9. 待定问题（均已结论）

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| 前端选 Vue3 还是 React？ | 默认 Vue3 + Element Plus，React 版本作为第二模板后续补 | donttemo | **已定（M5，2026-10-13）：Vue3 + Vite + Element Plus** |
| token 存 localStorage 还是 Cookie？ | 跟随 AUTH_STRATEGY：jwt 用 httpOnly Cookie，apikey 用内存 | donttemo | **已定（M5，2026-10-13）：access token 仅存内存（刷新即失效，由 refresh 无感恢复）、refresh token 按「记住我」存 local/sessionStorage；AUTH_STRATEGY=session 时本地不落令牌** |
