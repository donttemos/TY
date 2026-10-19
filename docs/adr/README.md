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
| [0013](./0013-async-job-center-in-memory-registry.md) | 异步任务中心用进程内存登记表，任务面只验归属人 | 已采纳 | 任务/导出 |
| [0014](./0014-i18n-frontend-locale.md) | i18n 骨架：错误码文案前端接管，locale 运行时自研不引 vue-i18n | 已采纳 | 前端 |
| [0015](./0015-dark-mode-tokens.md) | 暗色模式：令牌层双列落地 + 派生档静态预计算（弃 color-mix）+ 主题三态默认跟随系统 | 已采纳 | 前端 |
| [0016](./0016-storage-port-fw-storage.md) | 文件存储端口 @fw/storage：端口 + local/s3 双驱动，S3 走 optional peer 结构化最小接口；附件字段约定 `*FileId` 由 codegen 识别 | 已采纳 | 后端 |
| [0020](./0020-refresh-token-rotation-cas.md) | Refresh Token Rotation CAS：单 replacement 不变量 + AES-GCM 加密 grace 恢复 + replay 族撤销（编号 0017–0019 已由 PRD-011 预留，跳号） | 已采纳 | 后端 |
| [0021](./0021-refresh-token-lifecycle.md) | Refresh Token 生命周期完整性：replacement 密文 grace 级清空（cipher 三列置 NULL）+ 两级清理接线 + L5 全链生命周期回归 | 已采纳 | 后端 |
| [0022](./0022-client-fingerprint.md) | M11.3 Client Fingerprint：grace 恢复绑定轮换发起方（UA 指纹起步，provider 接口预留 deviceId/clientId），异端重试升级为 replay | 已采纳 | 后端 |
| [0023](./0023-key-ring.md) | M11.4 双 Key Ring：Replacement 密钥代际回退（HKDF legacy 回退链，解 JWT_SECRET 轮换误杀）+ JWT kid 路由 + 退役窗口规则 | 已采纳 | 后端 |
| [0024](./0024-key-observability.md) | M11.5 Key Ring 可观测性：稳定 kid（secret 指纹派生，兼容回退）+ 密钥运维端点（retirable 判据）+ 安全事件审计口径 | 已采纳（2026-10-16） | 后端 |
| [0025](./0025-unified-error-audit-contract.md) | M12 W1 统一错误与审计事件契约：错误三类治理（①继承 BizError / ②内部信号禁上浮 / ③fail-fast）+ 判别符≠错误码 + `audit_logs` 软增列六列（category/event/result/family_id/jti/request_id）+ replay 安全事件九要素 | 已采纳（2026-10-17） | 后端 / 前端契约 |
| [0026](./0026-observability-id-layering.md) | M12 W2 可观测 ID 分层与贯穿：requestId(单请求) vs traceId(跨服务) 分层 / ALS 扩展（familyId/jti）+ logger 自动身份 / fw_auth_*·fw_security_* 指标段与基数护栏 / 审计检索键扩展 | 已采纳（2026-10-17） | 后端 / 前端契约 |
| [0027](./0027-ops-endpoints-boundary.md) | M12 W3 运维端点安全边界：三层模型（Public 自检 / Protected maintenance / 业务公开面）+ 默认受保护原则 + OQ-4 定案权限码 ops:read（OPS_TOKEN 备选未启用）+ demo 自检面非 dev 404 + Nginx 三份一致性轴 | 已采纳（2026-10-17） | 后端 / 部署 |
| [0028](./0028-cache-tag-index-cluster-compatibility.md) | 缓存标签索引的 Redis Cluster 兼容策略：多键 Lua 的 slot 约束分析（值键 ↔ 标签键 N:M，必须全部同 slot）+ hash tag 四方案评估（A 全局 / B prefix 作用域【推荐】/ C tenant / D 重设计放弃原子性）+ 当前版本限制登记与方案 B 键格式版本化演进 + 单实例/Cluster 验证矩阵 | 已采纳（2026-10-17） | 后端 / 缓存 |
| [0029](./0029-plan-subscription-quota-model.md) | M13 套餐/订阅/生效配额三层模型：plans→plan_versions 版本化发布、订阅绑定版本 + 一租户一生效订阅、生效值 = 租户覆盖 ?? 套餐默认；tenants.plan/status/expireAt 转派生只读列（写权收口领域服务）+ 幂等回填 + M14 退役里程碑 | 已采纳（2026-10-19） | 后端 / 数据 |
| [0030](./0030-hard-quota-concurrency.md) | M13 硬限额并发扣减：DB 事务 + 条件 UPDATE 为唯一事实源（扣减与 usage_events 留痕同事务），Redis 余量仅预检加速（漏判 DB 兜底不超发）；软限额同窗幂等告警；窗口翻转按 window_start 切片；Cluster 边界按 ADR-0028 声明 | 已采纳（2026-10-19） | 后端 / 数据 / 缓存 |
| [0031](./0031-tenant-lifecycle-state-machine.md) | M13 租户五态生命周期：pending/active/grace/frozen/terminated 合法迁移表唯一权威 + 迁移写权唯一归属 TenantLifecycleService + 条件更新幂等（正确性不依赖分布式锁）+ 冻结 4031 作用于业务入口（白名单走 @LifecycleExempt 元数据）+ terminated 数据保留策略（审计永不删除） | 已采纳（2026-10-19） | 后端 / 数据 |

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
