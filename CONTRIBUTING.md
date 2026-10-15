# 贡献指南

本仓库已发布 **v0.1.0**（M1 核心骨架 / M2 数据库抽象层 / M3 鉴权与权限 / M4 缓存层，代码与测试均已就绪）。参与开发请按下列流程。

> 发布验收记录见 [`docs/archive/release/90-release-v0.1.0.md`](docs/archive/release/90-release-v0.1.0.md)。

## 快速开始（M1 起）

```bash
pnpm install                 # 安装依赖
pnpm dev                     # 启动示例应用
pnpm test                    # 运行测试（SQLite 单测）
pnpm lint && pnpm build      # 提交前自检
pnpm run check:headers       # 校验文件头注释（中文 + 作者 + 日期）
```

> 署名约定：本仓库文件头 `@author` 统一为 `donttemo`，须与 `git config user.name` 一致（新成员加入时保持二者完全相同）。

## 三步上手

1. **读文档**：先看 [README](./README.md) 了解定位，再看对应 PRD（`docs/prd/`）与 [架构设计](./docs/20-architecture.md)。
2. **认领任务**：从 [项目计划的任务板](./docs/80-project-plan.md) 挑 `Ready` 列任务，留言认领后移到 `In Progress`。
3. **提 PR**：分支 `feat/<prd>-<短名>` → 关联 PRD 与任务 ID → 按 PR 模板填写 → 等评审。

## 硬性规则

- 编码 / Git / PR 规范见 [`docs/70-engineering-standards.md`](./docs/70-engineering-standards.md)，**提交前必须自检**。
- 完成定义见 [`docs/10-acceptance-criteria.md`](./docs/10-acceptance-criteria.md)，缺一项不得合并。
- 需求变更先改对应 PRD 的「变更记录」，再改代码；发布时汇总到 [CHANGELOG](./CHANGELOG.md)。
- 架构决策写 ADR，见 [`docs/adr/`](./docs/adr/README.md)。

## 常见入口

| 我想… | 去哪 |
|---|---|
| 知道某个能力的验收标准 | `docs/prd/prd-00X-*.md` 的 AC 章节 |
| 写测试用例 | `docs/50-test-cases.md` |
| 查接口与错误码 | `docs/40-api-spec.md` |
| 查表结构与字段 | `docs/30-data-dictionary.md` |
| 做页面 / 查 UI 与交互规范 | `docs/25-ui-prototype.md` |
| 部署与排障 | `docs/60-deployment-ops.md` |
| 确认文档之间是否一致 | `docs/95-doc-audit.md` |
