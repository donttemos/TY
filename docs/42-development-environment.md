<!--
@file 开发环境指南（M13 主线 B，OQ-13-4 定案：与 47 并列、42 号落地）
@description 从零搭建本仓开发环境的唯一入口：运行时版本（工具链冻结，见 48）、安装步骤、
  常用命令、端口表、沙箱/已知环境坑。可复现性核对走 97 的验证清单。
@author donttemo
@created 2026-10-19
-->

# 开发环境指南

- 版本基线：**Node 22.22.2 / pnpm 11.6.0**（冻结依据与一致性矩阵见 [48](./48-reproducible-builds.md)）
- 快速核对：`node -v` 应输出 `v22.22.2`（仓库 `.nvmrc` 与 CI 已 pin）；`corepack enable && pnpm -v` 应输出 `11.6.0`

## 1. 安装步骤（干净机器）

```bash
# 1) Node 22.22.2（nvm/fnm/nvs 任选其一，或官网安装包）
nvm install 22.22.2 && nvm use
# 2) pnpm（由根 package.json packageManager 字段钉死，corepack 自动取 11.6.0）
corepack enable
# 3) 依赖（CI 同款：锁定文件校验）
pnpm install --frozen-lockfile
# 4) Prisma Client 生成（两份 schema：@fw/db 测试 schema + example-api 主 schema）
pnpm --filter @fw/db exec prisma generate --schema prisma/test-schema.prisma
DB_URL="file:./dev.db" pnpm --filter example-api exec prisma generate --schema prisma/schema.prisma
# 5) 数据库迁移 + 种子（example-api，sqlite 本地库 prisma/dev.db）
pnpm -C apps/example-api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm -C apps/example-api exec tsx prisma/seed.ts
# 6) M13 存量回填（幂等；为种子租户建 default 套餐订阅）
node apps/example-api/scripts/backfill-saas.mjs
# 7) 全量构建（顺序即依赖序：core → … → saas，见 CI 构建循环）
pnpm -r --filter './packages/*' run build
pnpm --filter example-api run build && pnpm --filter admin-web run build
```

## 2. 常用命令

| 场景 | 命令 |
|---|---|
| 单包测试 | `pnpm -C <pkg> exec vitest run --no-file-parallelism` |
| 覆盖率门禁 | `pnpm -C <pkg> run test:coverage`（阈值 85/85/65/85） |
| example-api 全量测试 | `pnpm -C apps/example-api exec vitest run --no-file-parallelism`（138 例） |
| 端到端冒烟 | `node apps/example-api/scripts/smoke-tenant.mjs` / `smoke-saas-ops.mjs`（自带服务生命周期） |
| 前端 mock 冒烟 | `node apps/admin-web/scripts/smoke-mock.mjs`（140 例） |
| 门禁 | `node scripts/check-triway-consistency.mjs` / `check-api-parity.mjs` / `check-file-headers.mjs` / `check-no-raw-sql.mjs` / `check-no-raw-throw.mjs` / `check-helm-chart.mjs` |
| 本地起后端 | `cd apps/example-api && node dist/main.js`（先 build；默认 3000） |
| 本地起前端 | `pnpm -C apps/admin-web run dev`（mock 面见 §4） |

## 3. 端口占用表（冒烟脚本各用固定端口，起服务前 `netstat` 复核）

| 端口 | 用途 |
|---|---|
| 3000 | example-api 默认 |
| 3100~3300 | 各冒烟脚本专用（3300=smoke-tenant） |
| 3400/3401 | transport 双进程冒烟 |
| 3600/3610/3611/3620/3700 | 其余冒烟 / mock（3620=smoke-saas-ops） |

## 4. 前端两种模式

- **mock 模式**（默认 dev）：`pnpm -C apps/admin-web run dev` 走 `mock/` 内存数据（含 M13 SaaS 运营面预置），无需后端；
- **真实后端**：`.env` 指向 example-api（登录快照含权限码，**后端 seed 变更后必须重登**）。

## 5. 已知环境坑（按平台）

| 环境 | 症状 | 对策 |
|---|---|---|
| Windows 受限沙箱 | `pnpm exec tsc`/`pnpm run build` 静默不落盘 | 直调 `node node_modules/typescript/bin/tsc -p <tsconfig>` |
| Windows 受限沙箱 | `prisma migrate deploy` 静默不执行（exit 0 无副作用，偶发部分应用） | 集成测试用 `src/testing/apply-sqlite-migrations.ts` 兜底；生产走 Linux |
| Windows 沙箱 | 根目录 `turbo` os error 231 | 逐包 `pnpm -C` 执行 |
| 任意平台 | Prisma engine 平台相关 | **Windows 产物不能上 Linux**（二进制不兼容），跨平台部署用源码构建 |
| 清理目录 | EBUSY / 误删 | 清目录前置 `CODEBUDDY_SAFE_DELETE_ENABLED=0` |

## 6. 相关文档

- 可复现构建规范：[48](./48-reproducible-builds.md)
- Dev Container：[49](./49-devcontainer.md) + `/.devcontainer/devcontainer.json`
- 可复现性验证清单：[97](./97-reproducibility-verification.md)
- 工程规范（文件头/门禁）：[70](./70-engineering-standards.md)
- 部署运维：[60](./60-deployment-ops.md)、[61](./61-bare-metal-deploy.md)
