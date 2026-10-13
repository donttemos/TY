## 变更类型

- [ ] `feat` 新功能 ｜ [ ] `fix` 缺陷修复 ｜ [ ] `refactor` 重构 ｜ [ ] `perf` 性能 ｜ [ ] `test` 测试 ｜ [ ] `docs` 文档 ｜ [ ] `chore` 工程

## 关联

- PRD：`PRD-00X`（必填）
- 任务 ID：`T-Mx-xx`（必填，见 `docs/80-project-plan.md`）
- 测试用例：`TC-XXX-xxx`
- 关联 ADR / Issue：

## 变更说明

<!-- 改了什么？为什么改？一句话说清 -->

## 影响面

- [ ] 需要数据库迁移（附迁移脚本与回滚方式）
- [ ] 需要新增/变更配置项（已同步 `.env.example` 与文档）
- [ ] 接口变更（已同步 `docs/40-api-spec.md` 与 OpenAPI）
- [ ] 影响部署或运维（已同步 `docs/60-deployment-ops.md`）
- [ ] 需更新 CHANGELOG

## 验证方式

<!-- 命令、用例编号或操作路径；前端改动请附截图 -->

```bash
pnpm test
```

## 自检（DoD）

- [ ] `pnpm lint && pnpm test && pnpm build` 全绿
- [ ] 无硬编码密钥、无环境分支、无裸异常、无敏感日志
- [ ] 未破坏分层约束与依赖方向；新增接口已标注权限点
- [ ] 测试覆盖边界与异常分支，无用例间顺序依赖
- [ ] 注释为简体中文；新增/修改文件已补文件头（`@author` + `@created`）；`TODO` 带责任人与日期
- [ ] 涉及权限/租户的已补越权用例
- [ ] 文档已同步（PRD / API / 运维 / CHANGELOG 按需）
- [ ] 对应 PRD 的 AC 已逐条勾选并附证据

> 完整规范见 `docs/70-engineering-standards.md`，完成定义见 `docs/10-acceptance-criteria.md`。
