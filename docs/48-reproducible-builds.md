<!--
@file 可复现构建规范（M13 主线 B）
@description 让「任何一台干净机器 clone 后构建出的产物行为一致」的规则集：单一权威来源、
  四处一致性矩阵、安装/构建纪律、已知平台差异登记。核对步骤见 97 验证清单。
@author donttemo
@created 2026-10-19
-->

# 可复现构建规范

- 状态：已采纳（M13 主线 B）；配套验证清单 [97](./97-reproducibility-verification.md)
- 关联：OQ-13-4、`docs/42`（开发环境指南）、CI workflow、`deploy/scripts/server-bootstrap.sh`

## 1. 单一权威来源（Single Source of Truth）

| 事实 | 权威位置 | 其余引用方式 |
|---|---|---|
| pnpm 版本（11.6.0） | 根 `package.json` 的 `packageManager` | CI `pnpm/action-setup@v4` **不带 version 输入**（以此字段为准，双写会 ERR_PNPM_BAD_PM_VERSION）；本地 corepack 自动取 |
| Node 版本（22.22.2） | 仓库 `.nvmrc` | CI `setup-node` `node-version: 22.22.2`（两 job）；devcontainer image/features；真机 `server-bootstrap.sh NODE_VERSION` 默认值 |
| 依赖树 | `pnpm-lock.yaml` | 安装纪律见 §3 |
| 运行时兼容下限 | 根 `package.json` `engines.node >= 20.19` | 仅兜底；构建基线按 Node 22.22.2 |

## 2. 一致性矩阵（四处冻结点）

| 位置 | 值 | 说明 |
|---|---|---|
| `.nvmrc` | `22.22.2` | 本地 nvm/fnm 自动切换 |
| CI `setup-node.node-version` | `22.22.2`（两处） | **禁止退回浮动 `22`**——minor 漂移曾致 engine 行为差异 |
| `.devcontainer/devcontainer.json` | `node:22.22.2-bookworm` + feature 22.22.2 | 容器内与本地同版本 |
| `deploy/scripts/server-bootstrap.sh` | `NODE_VERSION=22.22.2` | 真机不依赖镜像 latest-v22.x |
| 根 `packageManager` | `pnpm@11.6.0` | CI/本地唯一 pnpm 来源 |
| `engines.node` | `>=20.19` | 兜底下限，不是构建基线 |

**变更纪律**：升级 Node/pnpm 必须一次改齐上述全部位置 + 重跑 97 清单全项；`package.json#prisma` 配置段已弃用告警（Prisma 6），迁 `prisma.config.ts` 时同规则一次改齐。

## 3. 安装与构建纪律

1. **CI 与验证环境一律 `--frozen-lockfile`**；本地常规安装允许无参 `pnpm install`（会更新 lockfile），**提交前必须确认 lockfile 变更与本批依赖声明一致**（新包入 workspace 时 lockfile 随包提交）。
2. **构建产物（dist/coverage）不入库**（.gitignore 已覆盖）；CI 每次从源码构建，禁止把 dist 当交付物。
3. **构建顺序即依赖序**（干净环境无预热 dist）：`@fw/config → @fw/logger → @fw/core → @fw/config-center → @fw/db → @fw/auth → @fw/cache → @fw/cli → @fw/queue → @fw/saas → @fw/tenant → @fw/transport → @fw/telemetry → @fw/storage`（与 CI build 循环同序，新包按依赖插入）。
4. **Prisma generate 两份**：`@fw/db` test-schema（自定义 output）+ example-api 主 schema（默认 client）——缺一则 example-api 的 tsc 报 `Pr.InputJsonValue` 不存在。
5. **不引入 postinstall 隐式网络下载**（allowBuilds 白名单管理构建脚本）；依赖只能走「workspace 成员 + `workspace:*`」。

## 4. 已知平台差异（登记，不视为违反可复现性）

| 差异 | 影响 | 对策 |
|---|---|---|
| Prisma engine 二进制平台相关 | Windows 构建产物不能复制到 Linux 运行 | 产物分发一律「目标平台源码构建」；镜像/真机流程已按此设计 |
| Prisma CLI 在部分受限环境 `migrate deploy` 静默不落盘 | 本地集成测试建库失败 | 测试用 `src/testing/apply-sqlite-migrations.ts` DDL 兜底；**CI（Linux）与真机正常** |
| Windows 受限沙箱 tsc/turbo 静默 | 本地构建命令失效 | 直调 `node node_modules/typescript/bin/tsc`（见 42 §5） |

## 5. 违规示例（历史教训，引以为戒）

- CI `pnpm/action-setup` 双写 version 与 packageManager → 多版本冲突直接失败（v0.2.0 首跑修复）。
- 新增框架包漏加 CI 构建/测试循环 → 干净环境取不到 dist 构建失败（v0.2.0 发布前修复，`@fw/tenant` 先例；M13 `@fw/saas` 已随建随加）。
- mock/example-api 的「范围固定断言」扩键不同步三处 → 已提交代码 CI 假绿（Cache 缺陷清单教训）。
