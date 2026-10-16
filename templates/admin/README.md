# @file admin 项目模板说明
# @description fw new --template=admin 生成的全栈管理后台项目使用说明
# @author donttemo
# @created 2026-10-15

# __APP_NAME__

由 `@fw/cli` 生成的**全栈管理后台**项目：服务端（登录 + RBAC + 示例 CRUD + 附件上传）与管理前端（Vue3 + Element Plus，登录 / 动态路由 / 按钮级权限）。

## 目录结构

```
__APP_NAME__/
├── server/       # NestJS 服务端（@fw/auth + @fw/cache + @fw/db + @fw/core）
│   ├── prisma/   # schema + 迁移 + 种子（RBAC 基线：权限点 / 角色 / 菜单 / 字典 / 账号）
│   └── src/      # auth（登录/RBAC/审计）、admin（用户/角色/菜单/字典）、demo-item（示例 CRUD）、upload（附件）
└── admin-web/    # Vue3 管理前端（登录 / 动态路由 / 按钮级权限 / 用户 / 角色 / 字典 / 示例 CRUD）
```

## 快速开始（默认账号 admin / Admin@123456，首次登录后立即改密）

模板按「框架工作区成员」生成（依赖经 `workspace:*` 解析，与 `apps/*` 同构）。
`fw new` 已自动把 `__APP_NAME__/server` 与 `__APP_NAME__/admin-web` 注册进框架仓库的
`pnpm-workspace.yaml`（带标记注释，弃用项目时删除目录并移除这两行即可）。

```bash
# 0) 在框架仓库根安装（fw new 已注册工作区成员）
pnpm i

# 1) 服务端：配置 → 建库 → 种子 → 构建 → 启动
cd __APP_NAME__/server
cp .env.example .env          # 必改 JWT_SECRET（示例占位值仅供本地开发）
pnem prisma:generate          # 生成 Prisma Client（pnpm exec prisma generate）
pnpm db:migrate && pnpm db:seed
pnpm build && pnpm dev        # http://localhost:3000/health

# 2) 前端：另开终端
cd __APP_NAME__/admin-web
pnpm dev                      # http://localhost:5173（VITE_API_BASE_URL 默认同源 /api/v1，
                              #  dev 下经 vite 代理或直接改 .env.development 指向 http://localhost:3000/api/v1）
```

## 内置端点（登录后可用，RBAC 守卫）

- `POST /api/v1/auth/login` / `refresh` / `logout`、`GET /api/v1/auth/me` —— 双 token 认证
- `/api/v1/users`、`/api/v1/roles`、`/api/v1/menus`、`/api/v1/dict/*`、`/api/v1/audit-logs` —— RBAC 管理面
- `/api/v1/demo-items` —— `fw gen crud` 产物形态的示例 CRUD（带权限点与审计）
- `POST /api/v1/files`、`GET /api/v1/files/:id/download` —— 附件上传 / 下载（file:create 权限，白名单扩展名，20MB 上限）

## 数据库切换

模板默认 sqlite。切 postgresql / mysql：改 `server/prisma/schema.prisma` 的 datasource 两行 +
`server/.env` 的 `DB_DRIVER` / `DB_URL`，然后重建迁移（参照 `docs/94` 方法或
`pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` 生成 SQL 放入
`prisma/migrations/<ts>_init/migration.sql`），再 `pnpm db:migrate && pnpm db:seed`。

## 附件存储

默认本地磁盘（`UPLOAD_DIR`，默认 `./uploads`，按月分目录），元数据在 `upload_files` 表。
`@fw/storage` 端口（E-09）落地后可平移为 StoragePort 适配，业务接口不变。

## 常用命令

```bash
pnpm --filter __APP_NAME__-server dev        # 服务端开发
pnpm --filter __APP_NAME__-web dev           # 前端开发
pnpm --filter __APP_NAME__-server db:reset   # 回滚 + 迁移 + 重新种子
fw gen crud order                            # 由数据表生成新 CRUD（六文件 + seed，接入 app.module 即可）
```
