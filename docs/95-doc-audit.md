# 文档一致性核对报告

> 核对日期：2026-10-09 ｜ 范围：本仓库全部 **35 份文档** ｜ 结论：**13 处冲突已修复，1 项缺失已补齐，5 项遗留待定**
>
> 方法：按 6 个一致性维度逐项比对——① 交付物完整性 ② 术语与编号 ③ 数据模型 ④ 接口契约 ⑤ 配置键 ⑥ 计划与验收闭环。

## 1. 核对范围

| 类别 | 文档 |
|---|---|
| 根级 | `README.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`.github/PULL_REQUEST_TEMPLATE.md` |
| 规划 | `docs/00-vision-scope.md`、`docs/10-acceptance-criteria.md`、`docs/80-project-plan.md` |
| 设计 | `docs/20-architecture.md`、`docs/25-ui-prototype.md`、`docs/30-data-dictionary.md`、`docs/40-api-spec.md` |
| 质量与运维 | `docs/50-test-cases.md`、`docs/60-deployment-ops.md`、`docs/70-engineering-standards.md` |
| 决策与需求 | `docs/adr/README.md` + ADR-0001~0010、`docs/prd/README.md` + PRD-001~008 |
| 本报告 | `docs/95-doc-audit.md` |

## 2. 一致性矩阵（结论）

| 维度 | 检查项 | 结果 |
|---|---|---|
| 交付物完整性 | 12 类交付物是否齐备 | ⚠️ 原缺「原型/UI」，已补齐 `25-ui-prototype.md` |
| 术语与编号 | 包名、ADR 编号、任务 ID、用例 ID | ❌→✅ ADR 编号错位已修（详见 D-01） |
| 数据模型 | 命名规范、字段类型、权限档位、枚举取值 | ❌→✅ 3 处冲突已修（D-03/04/05/06） |
| 接口契约 | 路径、错误码、权限点、分页结构 | ❌→✅ 2 处冲突已修（D-07/08） |
| 配置键 | 文档间配置清单是否同源 | ❌→✅ 部署手册补 6 个键（D-09） |
| 计划与验收 | 里程碑/目标/覆盖率/关键路径是否自洽 | ❌→✅ 3 处冲突已修（D-10/11/12） |

## 3. 缺陷与处置清单

| 编号 | 严重度 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| **D-00** | P1（缺失） | 交付清单 | 「原型/UI」文档缺失，M5/M6 页面无视觉与交互基线 | ✅ 新建 `docs/25-ui-prototype.md`（设计令牌、路由表、布局线框、7 个关键页、组件与交互规范、与 PRD-005 AC 映射） |
| **D-01** | P0 | `20-architecture.md` §8 vs `docs/adr/` | 架构用 `ADR-01~08` 编号，实际文件为 `0001~0010`，且 03/04/05/06/07/08 含义整体错位（架构 ADR-03=缓存，实际 0003=monorepo），并漏掉 monorepo 与可切换性两条 | ✅ 架构 §8 改为链接到真实文件 0001–0010，状态与 ADR 目录一致 |
| **D-02** | P2 | `CHANGELOG.md` | 记为「8 条 ADR」，实际 10 条；且未记录 ADR / 规范 / 计划 / 原型 | ✅ 改为 10 条并补齐 Unreleased 条目 |
| **D-03** | P1 | `30-data-dictionary.md` §1.1 | 命名约定「表名带模块前缀 `auth_users`/`sys_dict_items`」与实际表名 `users`/`dict_items` 矛盾；「关联表按字母序 `role_user`」与同表自注「沿用 `user_role`」自相矛盾；「`<单体>_id`」为错字 | ✅ 改为框架表不带前缀、关联表按语义顺序、修正错字为 `<单表>_id` |
| **D-04** | P1 | `30-data-dictionary.md` §1.3 vs §1.2 | `int/bigint → number` 与 `<xx>_id → string` 冲突；雪花 ID 用 `number` 会丢精度 | ✅ 明确：主键 `id` 与外键 `*_id` 一律 `string`；仅非 ID 的 `int` 用 `number` |
| **D-05** | P1 | `prd-006` vs `30-data-dictionary` | 生成器类型映射 `int/bigint/decimal → number`，与「金额禁浮点、decimal→string」冲突 | ✅ 生成器映射表改为与数据字典同源，并注明未命中类型报错 |
| **D-06** | P1 | `prd-003` FR-10 vs 架构 §5.4 / 数据字典 / `prd-008` | 数据权限三档（全部/本部门/仅本人）vs 四档（`all`/`org_below`/`org`/`self`） | ✅ PRD-003 改为四档并给出编码，与 `roles.data_scope` 对齐 |
| **D-07** | P1 | `prd-005` §6 vs `40-api-spec.md` §3.2 | 接口约定写 `/me/menus`，API 文档为 `/auth/me` + `/auth/menus` | ✅ 统一为 `/auth/me`、`/auth/menus`，并注明以 API 文档为准 |
| **D-08** | P2 | `prd-001` FR-06 vs `40-api-spec.md` §2 | 错误码分段不一致（`2xxx 参数`、`4xxx 业务` vs `2xxx 预留`、`4xxx 租户与业务`） | ✅ 统一为：`1xxx` 通用与参数、`2xxx` 业务、`3xxx` 鉴权、`4xxx` 租户与配额、`9xxx` 系统 |
| **D-09** | P1 | `60-deployment-ops.md` §3 | PRD 中已定义的 `AUTH_MAX_FAILED`、`AUTH_LOCK_MINUTES`、`AUTH_PASSWORD_POLICY`、`CACHE_PREFIX`、`CACHE_MAX_ITEMS`、`MQ_MAX_ATTEMPTS` 未进配置清单 | ✅ 全部补入并标注默认值与含义 |
| **D-10** | P1 | `00-vision-scope.md` vs `README.md` / `prd-001` | 愿景「一周内」vs README「1 天内」vs PRD-001「半天内」，成功指标「≤3 天」 | ✅ 统一：骨架 30 分钟（M1）→ 含登录权限的骨架 ≤1 天 → 可交付 CRUD ≤3 天 |
| **D-11** | P2 | `prd-001` FR-03 vs 验收 §5 / 架构 §5.6 | 日志字段缺 `spanId`（其余文档均含） | ✅ 补齐并说明 OTel 启用前为空串 |
| **D-12** | P2 | `80-project-plan.md` §1 | 关键路径写 M1→M2→M3→M5→M6，与甘特图（M7→M8 串行）不符 | ✅ 改为 M1→M2→M3→M5→M6→M7→M8 |
| **D-13** | P2 | `20-architecture.md` §3 / §10 | 模块表缺 `@fw/config`、`@fw/logger`；映射表「5.x 生成器约定」指向不存在的小节 | ✅ 补齐两个包；新增 §5.7 生成器约定并修正映射 |

## 4. 复核通过项（无需修改）

| 项 | 核对结论 |
|---|---|
| 里程碑与 PRD 映射 | M1–M8 ↔ PRD-001~008 一一对应，README / 愿景 / 计划 / CHANGELOG 四处一致 |
| 令牌策略 | access 2h + refresh 7d，轮换 + 10s 并发宽限，API / 架构 / PRD-003 / 用例 TC-AUTH-006~008 一致 |
| 缓存三防与降级 | 空值占位、单飞、TTL ±10%、`CACHE_FAIL_OPEN`，架构 / PRD-004 / 部署 Runbook / 用例一致 |
| 三库矩阵 | 单测 SQLite、集成 MySQL 8 + PG 15 并行，ADR-0008 / PRD-002 / 测试 §2 一致 |
| 性能基线 | 冷启动 ≤1.5s、登录 P95 ≤300ms、百万行分页 ≤200ms、生成 ≤3s，验收 §4.1 / TC-NFR / PRD NFR 一致 |
| 覆盖率 | 整体 ≥70%，auth/cache/orm ≥85%（已在验收 §4.3 补 core/config/logger ≥80%、cli ≥80%，与 PRD-001/006 对齐） |
| 权限点命名 | `资源:操作`（如 `order:refund`），API / PRD-003 / 数据字典 / 生成器一致 |
| 计划时程 | 15 周甘特（2026-10-12 → 2027-01-22）与 75 工作日关键路径吻合 |
| Git / PR 规范 | README、CONTRIBUTING、70 规范、PR 模板四处分支与提交约定一致 |

## 5. 遗留待定项（需开工前决策）

| 编号 | 问题 | 影响 | 责任里程碑 |
|---|---|---|---|
| O-1 | ORM 选 Prisma 还是 TypeORM（ADR-0002 仍为提案） | 阻塞 M2 全部任务 | M2 开工前（已设 3 人日 spike） |
| O-2 | 密码算法 Argon2id / bcrypt 最终确认 | PRD-003 | M3 开工前 |
| O-3 | token 存 localStorage 还是 httpOnly Cookie | PRD-005 + 原型 §7 | M5 评审前 |
| O-4 | 前端是否需要暗色模式首发 | 原型 §2.1 | M5 评审前 |
| O-5 | Kafka 驱动是否 M8 落地 | PRD-007 / 部署大档 | M8 评审时 |

## 6. 后续保持一致的硬规则

1. **新增/修改任一文档** → 同步 `README.md` 文档索引 + `CHANGELOG.md`（`Unreleased`）。
2. **新增配置项** → 同步 PRD 关键设计 + `docs/60-deployment-ops.md` §3 + `.env.example`（实现阶段）。
3. **新增错误码** → 同步 `40-api-spec.md` §2 + PRD-001 分段约定。
4. **新增表/字段** → 同步 `30-data-dictionary.md` + 生成器类型映射。
5. **决策变更** → 写新 ADR（不改写旧 ADR），并同步 `20-architecture.md` §8 摘要。
6. **每次里程碑验收前** → 重跑本报告第 2 节矩阵，未通过项记入验收记录「遗留问题」。
