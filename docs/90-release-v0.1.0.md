# v0.1.0 发布验收报告

> 版本：**v0.1.0** ｜ 发布范围：**M1–M4** ｜ 验收日期：2026-10-13 ｜ 验收人：donttemo（L0 编排）
> 依据：[验收标准](./10-acceptance-criteria.md) §2 完成定义、§3 里程碑门禁、§4 非功能与安全基线、§5 可观测基线、§6 三大关键演练、§7 验收流程
> 证据目录：`.workbuddy/release-0.1.0/`（构建、单测、冒烟、依赖扫描原始输出）

## 1. 发布物与范围

**纳入 v0.1.0**（M1–M4 全部交付）：

| 包 / 应用 | 版本 | 内容 |
|---|---|---|
| `@fw/config` | 0.1.0 | 配置校验（zod schema → 强类型视图） |
| `@fw/logger` | 0.1.0 | 结构化日志、traceId、敏感字段脱敏 |
| `@fw/core` | 0.1.0 | 统一响应与错误码、全局异常过滤、健康检查、优雅停机 |
| `@fw/db` | 0.1.0 | `Repository<T>` 契约 + Prisma 适配 + 方言白名单 + 迁移工具 |
| `@fw/auth` | 0.1.0 | 双 token 轮换、RBAC 五表、多策略、审计、登录加固 |
| `@fw/cache` | 0.1.0 | 统一 CacheService、memory/redis/cluster 驱动、三防护、标签失效、分布式锁、降级 |
| `@fw/cli` | 0.1.0 | `fw new / dev / build / check / db:*` |
| `apps/example-api` | 0.1.0 | M1–M4 验收载体（演示端点 + 端到端冒烟） |

**明确排除**：`apps/admin-web`（M5 半成品：有 api/store/router/mock 基础设施，缺入口、页面与测试）。**不纳入 v0.1.0**，不参与本次门禁判定。

## 2. L2 里程碑门禁（M1–M4）

| 里程碑 | 关键门禁 | 结果 | 证据 |
|---|---|---|---|
| M1 核心骨架 | 30 分钟内跑通 `/health`；缺配置启动即报错；traceId 贯通；异常不裸抛 500；`SIGTERM` 优雅停机；敏感字段脱敏 | ✅ 通过 | `scripts/smoke.mjs` 13/13（含 health / ready / 统一响应 / 结构化错误 / 9001 收敛 / log-sensitive / 404 / traceId 贯通） |
| M2 数据库抽象 | 三库集成测试全绿；切换 diff = 0；原生 SQL 未标注即失败；慢查询带 traceId；`db:rollback` 可用 | ⚠️ 条件通过 | SQLite 45 项集成测试通过；方言白名单门禁 195 文件通过；**MySQL/PG 矩阵未在真实 CI 执行**（见 §6 遗留 R-01） |
| M3 鉴权与权限 | 越权 / 重放 / 篡改 / 爆破用例全绿；refresh 轮换且旧令牌即时失效；权限变更即时生效；审计可还原前后值；多策略共存 | ✅ 通过 | `scripts/smoke-auth.mjs` 25/25；单测 89 项 |
| M4 缓存层 | memory 零依赖跑通；切 redis diff = 0；100 并发热点回源 1 次；Redis 宕机降级可用；分布式锁生效 | ✅ 通过 | `scripts/smoke-cache.mjs` 12/12；单测 73 项；覆盖率 96.23% |

## 3. L3 全局发布门禁

### 3.1 完成定义（DoD）

| 条目 | 结果 | 说明 |
|---|---|---|
| 功能与 PRD 行为一致 | ✅ | M1–M4 各 PRD 的 AC 已逐条勾选（PRD-002/003/004 §10 验收记录） |
| 新增单测 / 集成 / 端到端 | ✅ | 单测 **266 项**；端到端冒烟 **50 项**（13 + 25 + 12） |
| `pnpm lint` 与 `pnpm build` 零错误 | ✅ | 7 包 + example-api 构建全绿；lint 逐包通过（**注**：根 `turbo run lint` 在本机 Windows 沙箱因管道范例耗尽报 os error 231，属环境限制，已按包逐一验证，见 §6 R-02） |
| 无 TODO 遗留（或已建 issue） | ✅ | 现存 TODO 均带责任人与日期 |
| 注释中文 + 文件头完整 | ✅ | `check:headers` 187 文件通过 |
| 日志带 traceId、新能力接指标 | ✅ | traceId 贯通断言通过；`/metrics` 暴露缓存命中率 / 降级计数 |
| 无硬编码密钥、输入校验完备 | ✅ | 密钥模式扫描未命中；参数统一走 zod / Prisma 绑定 |
| 文档同步 | ✅ | README / CHANGELOG / PRD / ADR / 运维手册 / 计划快照 / C-04 契约状态已同步 |

### 3.2 非功能基线

| 项 | 目标 | 结果 |
|---|---|---|
| 覆盖率：整体 ≥ 70% | ≥ 70% | ✅ 各包 statements 均 ≥ 92%（cli 44.18% 见下） |
| `auth` / `cache` / `orm(db)` ≥ 85% | ≥ 85% | ✅ auth 95.75% / cache 96.23% / db 97.7% |
| `core` / `config` / `logger` ≥ 80% | ≥ 80% | ✅ core 92.82% / config 98.29% / logger 92.72% |
| `cli`（生成器）≥ 80% | ≥ 80% | ⚠️ **不适用**：该门槛面向生成器（M6），v0.1.0 未交付生成器。cli 现有命令实测 44.18%，已覆盖 args 100% / check 100% / new 94.2%；未覆盖的 `index.ts`（进程入口）与 `db.ts`/`run.ts`（外部命令编排）由端到端冒烟覆盖 |
| 冷启动 / 接口延迟 / 缓存 get 等性能项 | 见 §4.1 | ⚠️ 未做专项压测（见 §6 R-03） |

### 3.3 安全基线（缺一即不予验收）

| 条目 | 结果 | 证据 |
|---|---|---|
| 越权：A 无法读写 B 的数据 | ✅ | 冒烟：alice 访问 `/roles`、`/audit-logs` → 403/3002；`dataScope=self` 仅返回本人 |
| 重放：refresh 复用被识别并踢下线 | ✅ | 冒烟：窗口外复用 → 401/3001，整族撤销 + 强制下线 |
| 篡改：签名篡改一律拒绝 | ✅ | 冒烟：无效令牌 → 401/3001 |
| 爆破：连续失败达阈值锁定并告警 | ✅ | 冒烟：第 5 次失败 → 3004；锁定期内正确口令亦拒绝 |
| 注入：SQL / XSS / 命令注入 | ⚠️ 部分覆盖 | 方言白名单门禁保证无未标注原生 SQL、参数统一走 Prisma 绑定；**专项注入用例未单列**（见 §6 R-04） |
| 脱敏：密码 / 令牌等不可见 | ✅ | 冒烟 `log-sensitive` 通过；日志按字段名脱敏 |
| 密钥：无硬编码、仓库扫描无命中 | ✅ | 扫描 `jwt_secret\|password\|secret\|api_key\|token` 赋值模式未命中；`.env` 已被 `.gitignore` 排除 |
| 传输：生产强制 HTTPS / Cookie 标记 | ⚠️ 不适用 | v0.1.0 无 Cookie 会话（Bearer token），HTTPS 由部署层强制（运维手册 §13） |
| 依赖：漏洞扫描无高危 | ✅ 生产依赖 | **生产依赖 critical 0 / high 0**（16 → 3，剩余 3 项 moderate 受 NestJS 10 约束）；dev 工具链仍有 8 项高危，见 §6 R-05 |

### 3.4 可观测基线

| 项 | 结果 | 证据 |
|---|---|---|
| `/health` `/ready` `/metrics` | ✅ | 冒烟覆盖；`/ready` 逐项报告 db / cache 状态，缓存故障时返回 503 而业务接口不受影响 |
| 结构化日志字段固定 | ✅ | `time / level / traceId / spanId / module / msg / ctx` |
| 敏感字段脱敏、单条日志截断 | ✅ | 脱敏断言通过 |
| 慢查询（>500ms）、缓存慢操作（>50ms）、降级事件告警 | ✅ | 慢查询阈值 `DB_SLOW_MS`；缓存慢操作 `CACHE_SLOW_MS`；降级计数暴露至 `/metrics` |

### 3.5 三大关键演练

| 演练 | 结果 | 说明 |
|---|---|---|
| 数据库切换（MySQL → PostgreSQL） | ❌ **未执行** | 本地无容器运行时；CI 三库矩阵配置已就位但未在真实 Actions 执行（§6 R-01） |
| 规模演进（单体 → 微服务 + Helm） | — 不适用 | 属 M8 交付范围（transport 切换、Helm Chart 在 M8） |
| 依赖故障降级（停 Redis / DB 慢查询 / 队列积压） | ⚠️ 部分执行 | **Redis 不可达降级已实跑**：fail-open 直查、业务 200、`/ready` 503、降级指标可见（冒烟阶段 B）。DB 慢查询与队列积压未演练（队列为 M7） |

## 4. 验证证据清单（全部实跑）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 构建 | 逐包 `pnpm --filter <pkg> run build` + example-api | **8/8 通过** |
| 单测 | 逐包 `pnpm --filter <pkg> run test` | **266 项通过**（config 10 / logger 13 / core 12 / db 45 / auth 89 / cache 73 / cli 24） |
| 覆盖率 | 逐包 `test:coverage` | config 98.29 / logger 92.72 / core 92.82 / db 97.7 / auth 95.75 / cache 96.23 / cli 44.18（statements %） |
| 冒烟 M1+M2 | `node apps/example-api/scripts/smoke.mjs` | **13/13 通过** |
| 冒烟 M3 | `node apps/example-api/scripts/smoke-auth.mjs` | **25/25 通过** |
| 冒烟 M4 | `node apps/example-api/scripts/smoke-cache.mjs` | **12/12 通过** |
| 文件头门禁 | `pnpm run check:headers` | 187 文件通过 |
| 方言白名单门禁 | `node scripts/check-no-raw-sql.mjs` | 195 文件通过 |
| 依赖冻结 | `pnpm install --frozen-lockfile` | 通过（lockfile 与 package.json 一致） |
| 依赖漏洞（生产） | `pnpm audit --prod` | 3 项 moderate；critical 0 / high 0 |
| 依赖漏洞（全量） | `pnpm audit` | 16 项（critical 4 / high 4 / moderate 8），**全部位于 dev 工具链** |
| 密钥扫描 | 正则扫描 `*.ts / *.mjs` | 未命中 |
| 大文件检查 | 待提交文件 > 1MB | 无 |

## 5. 本次验收中发现并修复的缺陷

| 编号 | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| F-01 | `@fw/cli` 无任何测试，`vitest run` 以 `No test files found` 退出码 1 | `pnpm test` 全量必红，DoD 不满足 | 补 `args/new/check` 三组单测共 24 项 + `vitest.config.ts` 覆盖率底线 + `test:coverage` 脚本；分派逻辑抽为可注入的 `args.ts` |
| F-02 | `auth` / `cache` / `db` 三个包缺 `lint` 脚本 | `turbo run lint` 不覆盖这三个包，DoD「lint 零错误」形同虚设 | 统一补 `tsc -p tsconfig.json --noEmit` |
| F-03 | `process.exit(1)` 后未 `return`（`check.ts` 1 处、`db.ts` 4 处） | exit 被拦截或平台行为差异时会继续执行到后续逻辑并重复抛错（`check.ts` 由新增单测暴露） | 5 处补齐 `return` |
| F-04 | 生产依赖 5 条 `multer` DoS 高危（经 `@nestjs/platform-express`） | 安全基线「依赖扫描无高危」不达标 | `pnpm-workspace.yaml` 加 overrides，逐项验证后收敛：`multer<2.4.0→2.4.0`、`qs<6.16.0→6.16.0`、`body-parser<1.20.6→1.20.6`、`deepmerge-ts<8.0.0→8.0.0`；生产依赖高危清零 |
| F-05 | `pnpm-workspace.yaml` 中 `allowBuilds.vue-demi` 值为占位文本 `set this to true or false` | pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，可能影响 CI 首步 | 改为显式 `false` |
| F-06 | `packages/db/prisma/test-client/`（24MB 生成产物，含平台二进制）未被忽略 | 会把 24MB 产物提交进仓库 | 加入 `.gitignore`；同时忽略 `.workbuddy/` 工具数据目录 |

**修复后回归**：构建 8/8、单测 266/266、三套冒烟 50/50 全部复跑通过。

## 6. 遗留问题

| 编号 | 描述 | 等级 | 责任人 | 闭环时间 |
|---|---|---|---|---|
| R-01 | MySQL / PostgreSQL 三库集成矩阵与「数据库切换演练」**未在真实环境执行**（本地无容器；CI 配置已就位但未触发过 Actions） | P1 | donttemo | 首次推送触发 CI 后 3 日内 |
| R-02 | 根 `turbo run lint/test` 在本机 Windows 沙箱因「管道范例耗尽」(os error 231) 失败，属环境限制 | P2 | donttemo | 引入容器化本地环境后 |
| R-03 | 性能基线（冷启动 / 接口 P95 / 缓存 get 延迟）未做专项压测 | P1 | donttemo | M6 前 |
| R-04 | 专项注入用例（SQL 注入 / XSS / 命令注入）未单列到测试用例集 | P1 | donttemo | M6 前 |
| R-05 | dev 工具链 8 项高危：`vitest`(2→3)、`tinypool`(1→2)、`happy-dom`(15→20)、`vite`(5→6)、`braces`（registry 最新即 3.0.3，补丁未发布） | P2 | donttemo | M5 开工时随 admin-web 依赖整理一并升级 |
| R-06 | 生产依赖 3 项 moderate：`@nestjs/core <=11.1.17` 与 `file-type`，均受 NestJS 10 约束，需升级 NestJS 11 | P1 | donttemo | M6（NestJS 11 升级专项） |
| R-07 | 真实 Redis / Redis Cluster 未实跑（`redis-cluster` 由 fake 客户端验证命令序列） | P1 | donttemo | M8 演练时 |
| R-08 | `apps/admin-web` 为 M5 半成品，本机 `node_modules` 未装全（`@vue/language-core` 缺失）导致其 `lint`/`build` 报 `MODULE_NOT_FOUND`；CI 干净环境不受影响 | P2 | donttemo | M5 开工时 |

## 7. 判定

**判定：条件通过（Conditional Pass）**

依据：

1. **无 P0 阻断红线**：未发现越权漏洞、数据丢失/不一致、密钥硬编码、依赖不可用即整体 500（缓存故障已有降级且实跑验证）、AC 未执行却标记通过。
2. **代码层门禁全绿且可复现**：构建 8/8、单测 266/266、端到端冒烟 50/50、文件头与方言门禁通过、`frozen-lockfile` 通过、生产依赖高危清零。
3. **判为「条件通过」的原因**：§3.5 三大演练中「数据库切换」未执行、「依赖故障降级」部分执行，§4.3 三库/Redis 兼容性未实跑。这些**均为环境能力缺失（无容器 / 无 Redis / CI 未触发）而非代码缺陷**，且 R-01 已给出可复现的闭环路径。
4. **P1 遗留项（R-01、R-03、R-04、R-06、R-07）均已登记责任人与闭环时间**，符合验收总纲 §7.5「P1 未通过可留条件通过」。

**发布动作**：打附注标签 `v0.1.0`（与 [CHANGELOG](../CHANGELOG.md) 的 `[0.1.0] - 2026-10-13` 条目一一对应）。首次推送后须立即触发 CI，用真实 Actions 结果闭环 R-01。
