<!--
@file Dev Container 指南（M13 主线 B）
@description 用 .devcontainer 一键获得与 CI/真机同版本的开发环境；覆盖前置条件、启动流程、
  容器内常用命令与常见问题。容器定义见 /.devcontainer/devcontainer.json。
@author donttemo
@created 2026-10-19
-->

# Dev Container 指南

- 基镜像：`node:22.22.2-bookworm`（与 `.nvmrc` / CI / 真机 bootstrap 同版本，冻结矩阵见 [48](./48-reproducible-builds.md)）
- 定义文件：`/.devcontainer/devcontainer.json`

## 1. 前置条件

- VS Code + 「Dev Containers」扩展（或 GitHub Codespaces / `devcontainer cli`）；
- Docker（本地 Desktop 或远端 context）。

## 2. 启动流程

1. VS Code 打开仓库根目录 → 左下角 `Reopen in Container`；
2. `postCreateCommand` 自动执行：corepack 激活 pnpm@11.6.0 → `pnpm install --frozen-lockfile` → 两份 Prisma Client 生成（`@fw/db` test-schema + example-api 主 schema）；
3. 首次建库（二选一）：
   ```bash
   pnpm -C apps/example-api exec prisma migrate deploy --schema prisma/schema.prisma
   pnpm -C apps/example-api exec tsx prisma/seed.ts
   node apps/example-api/scripts/backfill-saas.mjs
   ```
4. 验证：`node -v` → `v22.22.2`；`pnpm -v` → `11.6.0`；`pnpm -C packages/core exec vitest run` 全绿。

## 3. 容器内常用命令（与本地完全一致）

| 场景 | 命令 |
|---|---|
| 起后端 | `pnpm --filter example-api run build && cd apps/example-api && node dist/main.js` |
| 起前端（mock） | `pnpm --filter admin-web run dev`（3600 端口已在 forwardPorts） |
| 冒烟 | `node scripts/smoke-saas-ops.mjs`（3620）等，见 [42](./42-development-environment.md) §2 |
| 门禁 | 同 [42](./42-development-environment.md) §2 门禁行 |

## 4. 端口转发

3000（example-api）/ 3300 / 3400（冒烟）/ 3600（admin-web dev）/ 3700（mock server）已在 `devcontainer.json` 声明并命名。

## 5. 常见问题

- **corepack 下载提示阻塞**：容器已注入 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`，离线环境可预 `corepack prepare pnpm@11.6.0 --activate`；
- **Prisma engine 平台**：容器是 linux-x64，与 Windows 本地产物不通用——**不要把 Windows 的 dist/node_modules 挂载进容器**，始终容器内重建；
- **sqlite 文件权限**：`prisma/dev.db` 由容器内用户创建，宿主机以 root 打开可能只读——统一在容器内操作数据库。
