# ADR-0003 · monorepo + pnpm workspace + Turborepo

- 状态：已采纳
- 日期：2026-10-09
- 关联：PRD-001、PRD-006

## 背景

1. 框架由多个独立包（core/config/logger/orm/cache/auth/queue/cli）与多个项目模板组成，需要统一版本与协同发布。
2. 模板与示例应用要能直接引用框架包源码（未发布状态）以便联调。
3. 构建与测试需要增量执行，否则随包数量增长 CI 会越来越慢。

## 决策

采用 **pnpm workspace + Turborepo** 的 monorepo：`packages/*` 放框架包，`apps/*` 放示例应用，`templates/*` 放项目模板；任务编排与缓存由 turbo 负责；包间依赖用 `workspace:*`。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| 多仓库（每包一库） | 边界清晰、独立发布 | 联调需发包、版本地狱 | 与「模板联调」需求冲突 |
| npm / yarn workspace | 生态熟悉 | 依赖提升与幽灵依赖问题，安装较慢 | pnpm 更严格且快 |
| Nx | 功能更强（含依赖图可视化、生成器） | 配置复杂度更高 | 初期收益 < 成本，后续可迁移 |
| pnpm + turbo | 安装快、严格依赖、增量构建开箱即用 | 依赖图可视化弱于 Nx | — |

## 后果

**正面**：模板可直接引用框架源码联调；`turbo` 增量构建与远程缓存显著缩短 CI；统一 lint/test/build 脚本。

**负面 / 代价**：pnpm 的严格依赖会暴露幽灵依赖（初期需整改）；单体仓库权限粒度粗（靠 CODEOWNERS 补）。

**缓解措施**：启用 `.npmrc` 的 `strict-peer-dependencies`；CI 校验无跨包直接引用内部实现；用 CODEOWNERS 给各包指定评审人。
