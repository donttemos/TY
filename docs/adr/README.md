# 架构决策记录（ADR）

记录本项目**具有长期影响的技术决策**：为什么选、放弃什么、代价是什么。

## 规则

- 一个决策一个文件，编号不复用；**决策只增不改**——要推翻旧决策就写新 ADR 并把旧的标记为 `已取代`。
- 状态：`提案` → `已采纳` → (`已取代` / `已废弃`)。重大决策需在架构评审会上过一遍。
- 触发写 ADR 的场景：选型、引入或移除依赖、跨模块契约变更、影响可切换性/安全/性能的决策。

## 清单

| 编号 | 决策 | 状态 | 影响范围 |
|---|---|---|---|
| [0001](./0001-backend-framework-nestjs.md) | 后端框架采用 NestJS | 已采纳 | 全局 |
| [0002](./0002-orm-selection.md) | ORM 选型：Prisma 或 TypeORM | 提案（M2 前定稿） | 数据访问 |
| [0003](./0003-monorepo-pnpm-turborepo.md) | monorepo + pnpm workspace + Turborepo | 已采纳 | 工程 |
| [0004](./0004-cache-abstraction.md) | 缓存抽象基于 cache-manager + ioredis | 已部分取代（存储抽象被 0012 取代） | 缓存 |
| [0005](./0005-auth-passport-rbac.md) | 鉴权用 Passport 策略 + 自研 RBAC，不引 Casbin | 已采纳 | 鉴权 |
| [0006](./0006-frontend-vue3-element-plus.md) | 后台前端采用 Vue3 + Element Plus | 已采纳 | 前端 |
| [0007](./0007-database-switchability.md) | 数据库可切换靠方言白名单 + 三库 CI 矩阵 | 已采纳 | 数据访问 |
| [0008](./0008-testing-strategy.md) | 测试：SQLite 单测 + 双库集成矩阵 | 已采纳 | 质量 |
| [0009](./0009-code-generation-over-lowcode.md) | 快速开发靠代码生成，不做低代码引擎 | 已采纳 | 研发效率 |
| [0010](./0010-observability-otel.md) | 可观测：先统一 traceId，M8 再引入 OpenTelemetry | 已采纳 | 可观测 |
| [0011](./0011-auth-strategy-registry.md) | 鉴权策略自实现注册表，不引入 passport 包 | 已采纳 | 鉴权 |
| [0012](./0012-cache-own-port-over-cache-manager.md) | 缓存存储抽象自研 `CacheStore` 端口，不引入 cache-manager | 已采纳 | 缓存 |

## 模板

```
# ADR-00XX · <决策标题>

- 状态：提案 / 已采纳 / 已取代（被 ADR-00XX 取代）/ 已废弃
- 日期：YYYY-MM-DD
- 关联：PRD-00X、相关 ADR

## 背景
要解决的问题与约束（不超过 5 条）

## 决策
我们决定……（一句话，可执行）

## 备选方案
| 方案 | 优点 | 缺点 | 未选原因 |

## 后果
**正面**：
**负面 / 代价**：
**缓解措施**：
```
