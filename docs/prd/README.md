# PRD 索引

本目录按**功能 / 迭代**组织，一份 PRD 对应一个可独立验收的交付单元。

## 迭代清单

| PRD | 里程碑 | 名称 | 依赖 | 优先级 | 状态 |
|---|---|---|---|---|---|
| [PRD-001](./prd-001-core-skeleton.md) | M1 | 核心骨架：配置 / 日志 / 错误 / 健康检查 | 无 | P0 | 已发布 v0.1.0 |
| [PRD-002](./prd-002-database-abstraction.md) | M2 | 数据库抽象层与多库切换 | M1 | P0 | 已验收 |
| [PRD-003](./prd-003-auth-rbac.md) | M3 | 鉴权与权限（RBAC） | M1, M2 | P0 | 已实现 |
| [PRD-004](./prd-004-cache-layer.md) | M4 | 缓存层 | M1 | P1 | 已实现 |
| [PRD-005](./prd-005-admin-template.md) | M5 | 管理后台模板 | M3 | P0 | 已发布 v0.2.0 |
| [PRD-006](./prd-006-code-generator.md) | M6 | CRUD 代码生成器 | M2, M5 | P1 | 已发布 v0.2.0 |
| [PRD-007](./prd-007-queue-scheduler.md) | M7 | 队列与定时任务 | M1, M4 | P2 | 已发布 v0.2.0 |
| [PRD-008](./prd-008-multitenancy-scale.md) | M8 | 多租户与规模化演进 | M2–M4、M7 | P2 | 已发布 v0.2.0（条件通过） |
| [PRD-009](./prd-009-config-center.md) | M9 | 配置中心与热更新（L-02 / FR-08 收口） | M1、M3、M5 | P2 | 已发布 v0.4.0（2026-10-15） |
| [PRD-010](./prd-010-next-stage-enhancements.md) | M10 | 下一阶段增强：多实例一致性收口与模板生态 | M7、M4、M9 | P1 | 已发布 v0.5.0（P0/P1 已交付，P2 过半，P3 全部落地） |
| [PRD-011](./prd-011-saas-operations-and-ecosystem.md) | M11 | SaaS 运营能力与生态扩展（多租户运营 / 插件市场 / 更多适配器 / 通知渠道 / 生成器增强 / 微服务拆分 / 可观测告警 / 安全合规 / 开发者体验） | M1–M10（重点 M8、M9、M10） | P1 | 草案（2026-10-17） |
| [PRD-012](./prd-012-observability-error-contract.md) | M12 | 统一可观测契约与运维暴露（W1 统一 Error/Audit Contract → W2 Observability 贯穿 → W3 Maintenance/Health 暴露） | M1–M11（重点 M1、M3、M8、M10、M11.3/11.5） | P1 | 草案（2026-10-17） |
| [PRD-013](./prd-013-saas-operations-foundation.md) | M13 | SaaS 运营基础落地与可复现开发环境（主线 A 套餐/订阅/配额/用量/生命周期/运营端/账单，细化 PRD-011 S-01~S-07；主线 B 工具链冻结与开发环境文档四件套） | M1–M12（重点 M8、M12） | P0 | 已发布 v0.7.0（2026-10-19） |
| [PRD-014](./prd-014-admin-web-productization.md) | M14 | Admin Web 产品化与 SaaS 运营体验升级（B1 正确性修复 → B2 运营 API 闭环 → B3 页面产品化 → B4 看板与运营首页） | M13（重点 M12 契约、M13 领域服务与运营 API） | P1 | 草案（2026-10-19） |

## 待规划 PRD（尚未排期）

> 原列表中的「文件存储抽象」「消息通知」「国际化」已由 [PRD-010](./prd-010-next-stage-enhancements.md) 收编为 E-09 / E-12~E-13 / E-14，随该 PRD 分阶段排期。
>
> **「开放平台网关（API Key + 签名 + 配额）」已由 [PRD-011](./prd-011-saas-operations-and-ecosystem.md) 收编**：API Key 轮换为 S-39、租户配额与用量为 S-01~S-03。**「内容 / 门户模板（CMS）」仍待规划**（NG5 边界内，尚未有立项）。

## PRD 模板约定

每份 PRD 统一包含以下章节，便于横向评审：

1. **背景与目标** —— 为什么要做，做完衡量什么
2. **范围** —— 做 / 不做，明确划界
3. **用户故事 / 场景** —— 谁在什么场景下用它
4. **功能需求（FR）** —— 编号 `FR-xx`，可独立验收
5. **非功能需求（NFR）** —— 性能、安全、兼容、可观测
6. **关键设计** —— 数据模型 / 接口 / 配置项
7. **验收标准（AC）** —— 逐条勾选，全部通过才算完成
8. **依赖与风险**
9. **待定问题（Open Questions）** —— 带负责人与结论时间

## 编号与状态规则

- 编号：`PRD-00X`，文件名 `prd-00X-英文短名.md`，一个交付单元不跨文件。
- 状态流转：草案 → 评审中 → 已确认 → 开发中 → 已验收 → 已归档。
- 需求变更：在 PRD 内追加「变更记录」（日期 + 变更点 + 影响），不直接改写历史需求条目。
