# 贡献指南

本仓库已发布 **v0.7.0**（M1~M13 全部里程碑：核心骨架 / 数据库抽象 / 鉴权权限 / 缓存 / 前端模板 / 代码生成 / 队列调度 / 多租户规模化 / 配置中心 / M10 增强 / 认证核心 M11 / 可观测 M12 / SaaS 运营基础 M13 + 主线 B 工具链）。参与开发请按下列流程。

> 发布记录见 [`docs/90-release-v0.7.0.md`](docs/90-release-v0.7.0.md)（及 docs/90-release-v0.3.0~v0.6.0 系列）。

## 快速开始

```bash
corepack enable              # pnpm 11.6.0 由根 package.json packageManager 钉死
pnpm install --frozen-lockfile
# Prisma Client 双 generate + 迁移/种子/回填，见 docs/42 §1（安装七步）
pnpm -C <pkg> exec vitest run --no-file-parallelism   # 单包测试
pnpm run check:headers       # 提交前自检（其余六项门禁见 docs/48 / README 开发规范）
```

> 环境基线 **Node 22.22.2 / pnpm 11.6.0**（`.nvmrc` + 冻结矩阵见 [`docs/48`](docs/48-reproducible-builds.md)）；完整安装步骤、端口表与已知环境坑见 [`docs/42`](docs/42-development-environment.md)，容器化走 [`docs/49`](docs/49-devcontainer.md)。

> 署名约定：本仓库文件头 `@author` 统一为 `donttemo`，须与 `git config user.name` 一致（新成员加入时保持二者完全相同）。

## 三步上手

1. **读文档**：先看 [README](./README.md) 了解定位，再看对应 PRD（`docs/prd/`）与 [架构设计](./docs/20-architecture.md)。
2. **认领任务**：从 [项目计划的任务板](./docs/80-project-plan.md) 挑 `Ready` 列任务，留言认领后移到 `In Progress`。
3. **提 PR**：分支 `feat/<prd>-<短名>` → 关联 PRD 与任务 ID → 按 PR 模板填写 → 等评审。

## 硬性规则

- 编码 / Git / PR 规范见 [`docs/70-engineering-standards.md`](./docs/70-engineering-standards.md)，**提交前必须自检**。
- 完成定义见 [`docs/10-acceptance-criteria.md`](./docs/10-acceptance-criteria.md)，缺一项不得合并。
- 需求变更先改对应 PRD 的「变更记录」，再改代码；发布时汇总到 [CHANGELOG](./CHANGELOG.md)。
- 架构决策写 ADR，见 [`docs/adr/`](./docs/adr/README.md)（当前至 0031；**新 ADR 先核对编号占用**——0028 曾在立项后被并行批次占用的教训见 PRD-013 OQ-13-4）。
- **可复现性**（[`docs/48`](docs/48-reproducible-builds.md)）：升级 Node/pnpm 或新增框架包必须同步冻结矩阵全部位置（`.nvmrc` / CI / devcontainer / 真机脚本）并全项重跑 [`docs/97` 验证清单](docs/97-reproducibility-verification.md)；**新增框架包必须同步 CI 构建/测试两处循环，且推送前跑 `test:coverage`（裸 `vitest run` 与 CI 阈值口径不同，曾致 CI 假绿）**。

## 常见入口

| 我想… | 去哪 |
|---|---|
| 从零搭环境 / 查端口与环境坑 | `docs/42-development-environment.md` |
| 确认构建可复现 / 版本冻结 | `docs/48-reproducible-builds.md` |
| 容器化开发 | `docs/49-devcontainer.md`（+ `/.devcontainer/`） |
| 知道某个能力的验收标准 | `docs/prd/prd-00X-*.md` 的 AC 章节 |
| 写测试用例 | `docs/50-test-cases.md` |
| 查接口与错误码 | `docs/40-api-spec.md` |
| 查表结构与字段 | `docs/30-data-dictionary.md` |
| 做页面 / 查 UI 与交互规范 | `docs/25-ui-prototype.md` |
| 部署与排障 | `docs/60-deployment-ops.md`（真机路径见 61/62/63） |
| 确认文档之间是否一致 | `docs/95-doc-audit.md` |
