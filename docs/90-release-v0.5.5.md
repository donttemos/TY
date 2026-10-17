# v0.5.5 发布验收报告

- 状态：已发布（2026-10-16）
- 版本：`0.5.5`（全仓 16 个 `package.json` 统一，含根与全部 workspace 成员）
- 发布提交：`4c85f7e`（chore(release): v0.5.5——整合 M10 P2/P3 在途交付 + PRD-011 立项 + 驱动审查修复 26 项）
- 发布 tag：`v0.5.5` → `503b326`（lightweight tag，已推送 origin；指向 release 提交的直接后继——该提交修复 smoke-config 白名单断言 11→12 键的 CI 假红，见 §3.2）
- 本版定位：**M10（PRD-010）P2/P3 在途交付整体成版 + M11（PRD-011）立项 + @fw/auth·cache·queue 驱动审查批量修复**

## 1. 交付范围

### 1.1 M10 P2/P3（E-08 ~ E-17）

| 项 | 内容 | 关键产物 |
|---|---|---|
| E-08 | admin 全栈项目模板 | `templates/admin/`（server + admin-web）+ `fw new --template=admin`（自动注册工作区成员）；依赖解析走「工作区成员 + `workspace:*`」单一 lockfile |
| E-09 | 文件存储端口 `@fw/storage` | `StoragePort` + local/s3 双驱动（S3 optional peer 懒加载，ADR-0016）；`upload_files` 表 + `/api/v1/files` 三端点；codegen 附件字段识别（`*FileId`/`*AttachmentId`）；模板收编为端口消费 |
| E-10 | 审计归档策略 | `AuditArchivePort`（先写归档后删在线，fail-closed 幂等）+ `audit_log_archives` 表（迁移 `20261015210000`）+ `audit.archive` cron（分布式锁）+ 冷数据两端点 + CSV 导出 |
| E-12 | SSE 实时推送 | `@fw/transport` 事件面（publish/subscribe，redis 跨实例广播）+ 60s 一次性票据换流 + 前端「实时优先、轮询兜底」+ `X-Accel-Buffering: no` |
| E-13 | 站内信/通知中心 | 事件订阅派发（任务终态 + 队列告警）+ `notifications` 表（迁移 `20261015233000`，`dedupe_key` 唯一约束多副本幂等）+ 五端点 + 顶栏铃铛（单连接多消费者 store/realtime） |
| E-14 | i18n 骨架 | locale 运行时自研不引 vue-i18n（ADR-0014）；错误码文案前端接管，键集与 `BIZ_CODE` 编译期同构 |
| E-15 | 暗色模式 | 令牌层双列 + 派生档静态预计算（弃 `color-mix()`，ADR-0015）+ 主题三态 `light/dark/auto` 默认跟随系统 + 首帧内联上色 |
| E-16 | 边界上限配置化 | 4 键定价（`WEB_KEEP_ALIVE_MAX` 等），`ENV_KEY_PATHS` 82→87 键，前端 `store/web-limits` 消费 |
| E-17 | 前端错误监控 RUM | 三源采集 + 会话去重/上限 + sendBeacon 上报 + `POST /telemetry/client-errors`（@Public）+ `X-Trace-Id` 链路关联 |

### 1.2 驱动审查批量修复（26 项）

`@fw/auth` / `@fw/cache` / `@fw/queue` 内存与 Redis 驱动：P0 崩溃/泄漏/连接 5 项（nextId 撞号静默覆盖、`void execute` 吞 rejection、令牌桶无界增长、假时钟 close 死循环、集群连接串凭据）+ P1 跨驱动一致性 7 项 + P2 性能/类型/设计 14 项。**公开端口方法签名零破坏**。

### 1.3 文档立项

- **PRD-011 立项（M11，草案）**：九方向 48 项 `S-01~S-48` + 48 条 AC（`docs/prd/prd-011-saas-operations-and-ecosystem.md`），配套 ADR-0017~0019 预留跳号。
- 新 ADR：0014（i18n）、0015（暗色模式令牌）、0016（存储端口）。

## 2. 升级影响

- **配置键 80→97**（`ENV_KEY_PATHS` 护栏同步）：E-09 新增 `STORAGE_*` 10 键、E-10 新增 `AUDIT_ARCHIVE_*` 2 键、E-16 定价 4 键、模板 `.env.example` 补齐 `RATE_LIMIT_*` 6 键等。
- **新增表 4 张**（迁移 + PG 变体同构）：`upload_files`（`20261016000000`）、`audit_log_archives`（`20261015210000`）、`notifications`（`20261015233000`）、`config_snapshots`（`20261015185000`）。
- **新增权限点 2 个**：`file:create`（seed 授 user，无菜单）、`notification:read`（seed 授 admin/user 与 M8 三示范角色）。
- **零破坏性变更**：驱动修复不改公开签名；auth 面无 schema 变更（M11.1 起的 `refresh_tokens` 加列在 tag 之后合入，属 `[Unreleased]`）。

## 3. 验证证据

### 3.1 本机全量（发布前，2026-10-16）

- **15 包 + 2 应用 1205 例全绿**：core 18 / db 83 / logger 17 / config 16 / tenant 34 / telemetry 53 / transport 93 / config-center 54 / auth 145 / cache 91 / queue 156 / storage 45 / cli 120 / example-api 97 / admin-web 183。
- 静态门禁 4 项 + `vue-tsc` 0 错误。

### 3.2 CI（GitHub Actions）

- release 提交 `4c85f7e`：run `38837747747` **failure**——smoke-config 白名单断言 11→12 键未同步（E-16 扩范围遗漏端到端脚本），修复为 `503b326`。
- **tag 提交 `503b326`：run `38838353189` success**（tag 即打在该修复提交上，发布以绿为准）。
- 后续 M11.5 收口 run `38921161345`（`b45abab`）与最新 run（`47b64a0`）均 success。

### 3.3 专项冒烟（按 E-xx 既定纪律不入 CI）

`smoke-template-admin` 7/7、`smoke-mock` 140/140（E-09 后含附件 7 断言）、`smoke-events` 19/19、`smoke-notifications` 29/29、`smoke-audit-archive` 13/13。

## 4. 发布记录

本项目发布记录 = **tag + CHANGELOG 版本条目 + 本报告** 三件套（v0.1.0~v0.5.5 一贯如此，GitHub Releases 功能未启用，仓库为 private）。v0.5.5 的三件套已齐：

| 件 | 状态 |
|---|---|
| tag `v0.5.5`（origin） | ✅ `503b326` |
| CHANGELOG `[0.5.5] - 2026-10-16` 条目 | ✅ |
| 本报告 `docs/90-release-v0.5.5.md` | ✅（本次固化补齐） |

## 5. 遗留与边界（如实登记）

- E-05 真实 K8s 部署（本机无 docker/helm，PRD-010 内记 L-01）、E-11 长压实测：未做，随环境到位推进。
- **M11.1–M11.5（ADR-0020~0024，认证核心强化）在 tag 之后合入 main**，记 CHANGELOG `[Unreleased]`，随下一版本（v0.5.x/v0.6.0）发布；ADR-0020~0024 索引状态均为已采纳。
- 模板冒烟不入 CI 为既定纪律；CI 对 `templates/admin` 无门禁步骤（详见 §6 讨论，另登记）。

## 6. 发布结论

**通过。** v0.5.5 三件套齐备，tag 所指提交 CI 全绿，升级影响（配置键/新表/权限点）已如实登记，认证核心（M11.5 及之前）自本报告起冻结——后续变更走新 ADR，不再改动已验收实现。
