<!--
@file 可复现性验证清单（M13 主线 B）
@description 「这台机器可信吗」的一次性核对步骤：工具链版本矩阵逐项打勾 + 干净构建五步 + 冒烟抽检。
  Node/pnpm 升级、CI 改动、新包引入后必须全项重跑。
@author donttemo
@created 2026-10-19
-->

# 可复现性验证清单

- 配套：[48](./48-reproducible-builds.md)（规范本体）、[42](./42-development-environment.md)（安装步骤）
- 使用方式：每项打勾留痕（执行人/日期）；任何一项失败先看 48 §5 违规示例与 §4 平台差异

## 1. 工具链版本矩阵（逐项核对）

| # | 核对项 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| 1.1 | `node -v` | `v22.22.2` | | ☐ |
| 1.2 | `cat .nvmrc` | `22.22.2` | | ☐ |
| 1.3 | `pnpm -v` | `11.6.0`（corepack 由 packageManager 取） | | ☐ |
| 1.4 | CI `setup-node.node-version` | `22.22.2` ×2（无浮动 `22`） | | ☐ |
| 1.5 | `.devcontainer` 基镜像/feature | `22.22.2` | | ☐ |
| 1.6 | `server-bootstrap.sh NODE_VERSION` 默认 | `22.22.2` | | ☐ |
| 1.7 | 根 `engines.node` | `>=20.19`（仅兜底） | | ☐ |
| 1.8 | CI 构建/测试循环包含全部框架包 | 对照 `ls packages`（M13 含 `@fw/saas`） | | ☐ |

## 2. 干净构建五步（`git clone` 后的新目录）

| # | 步骤 | 通过判据 | 结果 |
|---|---|---|---|
| 2.1 | `corepack enable && pnpm install --frozen-lockfile` | exit 0，无 lockfile 变更 | ☐ |
| 2.2 | Prisma generate ×2（42 §1 第 4 步） | 无 `Prisma.InputJsonValue` 类报错 | ☐ |
| 2.3 | migrate deploy + seed + backfill | dev.db 有 29 表 + 种子账号 + default 订阅 | ☐ |
| 2.4 | 按依赖序全量构建（42 §1 第 7 步） | 全部 exit 0 | ☐ |
| 2.5 | `node apps/example-api/scripts/smoke-saas-ops.mjs` | 22/22 | ☐ |

## 3. 门禁抽检（至少跑一次全绿）

☐ `check-triway-consistency`（七轴）　☐ `check-api-parity`　☐ `check-file-headers`
☐ `check-no-raw-sql`　☐ `check-no-raw-throw`　☐ `check-helm-chart`

## 4. 行为一致性抽检（防「版本对了但行为漂了」）

| # | 抽检 | 通过判据 | 结果 |
|---|---|---|---|
| 4.1 | 登录 → 统一信封 | `{code:0,data,traceId,requestId?}` 形态 | ☐ |
| 4.2 | `POST /saas/tenants/:id/usage/events` 超限 | 429/4029 + details 三字段 | ☐ |
| 4.3 | frozen 租户业务请求 | 403/4031（冻结租户登录仍可） | ☐ |
| 4.4 | `GET /metrics` | 含 `fw_saas_*` 段（七计数器结构） | ☐ |

## 5. 已知环境差异（不算失败，见 48 §4）

- Windows 沙箱：tsc/turbo/deploy 静默类症状 → 按 42 §5 对策绕过后重验；
- Prisma engine 跨平台产物不可复制；
- CI（Linux）与本清单结果的任何分歧 → 以 CI 为准并回填 48 §4 登记。

## 6. 留痕

| 日期 | 执行人 | 环境 | 结果 |
|---|---|---|---|
| 2026-10-19 | donttemo | Windows 沙箱（§2.1/2.4/2.5 + §3 全绿；§2.2/2.3 按 §5 绕过） | 通过 |
