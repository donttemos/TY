<!--
@file v0.8.0 发版记录（M16 开发体验与部署一体化 + M17 TY Studio S1~S4 + M15 运营审计收口）
@description 三批内容的发版事实：M15 运营审计 P1/P2 修复、M16 三条命令与黄金链路 CI 首绿、
  M17 本地可视化工作台。零迁移、零新错误码、零新增服务端配置键；升级影响、验证矩阵、
  黄金链路五处真实断裂的修复过程与遗留清单见 §2~§6。
@author donttemo
@created 2026-10-28
-->

# v0.8.0 发版记录（M16 开发体验与部署一体化 + M17 TY Studio + M15 审计收口）

- 关联：PRD-016（M16，[docs/prd/prd-016-dev-experience-and-deploy.md](./prd/prd-016-dev-experience-and-deploy.md)）、PRD-017（M17，[docs/prd/prd-017-ty-studio.md](./prd/prd-017-ty-studio.md)）、PRD-015（M15 遗留修复）、PRD-014 B4（随本版归档）
- 特性：**零迁移 / 零新错误码 / 零新增服务端配置键**；版本升版 17 个 `package.json`（0.7.5 → 0.8.0）+ 新增 `@fw/studio-web` 0.8.0
- 提交：`8dd18be`（M16/M17 主体 + CI 作业）→ `89ce372`→ `5d46b46` → `2cea782` → `ab0c61e` → `5b64754` → `02bebb2` → `a2b5318`（golden-path 首绿）
- CI：**黄金链路作业首绿** run [40684860336](https://github.com/donttemos/TY/actions/runs/40684860336)（job 122804488117，commit `a2b5318`）：九阶段全过、`result=success`、`browser=ok`、跳过 0 阶段；同 run 的构建/单测/静态检查与三库集成矩阵见 §4

## 1. 本版变化清单（相对 v0.7.5）

| 批次 | 类别 | 内容 |
|---|---|---|
| M15 | 行为修正 | 运营面审计显式落目标租户（SaaS 与 `/tenants` 两处，平台审计按租户可查）；终止态租户开通订阅补 denied 审计；平台审计导出与列表同口径（`buildSearchParams` 共用）；订阅创建边界校验（空白 tenantId/planCode → 1001，租户不存在 → 1002）；TenantPicker 搜索竞态保护；seed 清场补 7 张租户级表 |
| M15 | 前端 | 平台审计「在线 / 归档」双来源切换 + 租户筛选受控查询（新增 `/audit-logs/platform/tenant-options`，`@IgnoreTenant` + `audit:read` 最小投影）；「系统管理 → 平台审计」菜单 |
| M16 | 新命令 | `fw deploy`（预检 → 构建 → 备份 → 迁移 → 启动 → 健康；首次 3 问、二次 0 问；`--plan` / `--seed` / `--rollback`） |
| M16 | 新命令 | `fw verify`（ci / real 双 target，九阶段一条命令；失败给「原因 + 下一步」，报告落 `verify-report.json`） |
| M16 | 生成器 | `fw gen crud` 一条命令到底：自动接线（标记块）+ 建并应用迁移 + 定向种子 + 双端校验；`fw.gen.json` 清单与产物指纹；漂移检测；破坏性迁移默认阻断 |
| M16 | 生成器 | **新增模型约定前置校验**：缺 `id` / `deletedAt` / 审计四件套的模型直接报错，不再生成「编译通过、接口 500」的代码 |
| M16 | 部署面 | 新增 `deploy/Dockerfile`（runtime + migrator 双目标）与 `.dockerignore`；`deploy/docker-compose.prod.yml` 按部署档位重新对齐（移除 Swarm 专用语义） |
| M16 | CI | 新增 `golden-path` 作业（干净检出 → 生成 → 迁移/种子 → 构建 → 起服务 → 浏览器 CRUD）；新增「断言浏览器阶段真实执行」步骤防假绿 |
| M17 | 新工具 | `fw studio` 本地工作台：项目只读体检、schema 分期读取、一次性令牌 + Host/Origin 校验、令牌按项目持久化 |
| M17 | 设计器 | 数据模型设计器：schema 安全写回（风险分级 + 一次性令牌 + `prisma validate` + 备份 + 原子写）、关系配置、JSON 导入、中文标注（`///` 写回 + 命名推断）、AI 补标注 |
| M17 | AI | 模型路由在页面配置（`~/.fw/studio-ai.json`，响应永不含密钥、重启不丢）；AI 建模草案（结构 + 语义校验、增量 revise、草案缓存）；AI 检查（分片 / 按模型分组 / 逐文件，结论去重汇总） |
| M17 | 前端 | 新增 `packages/studio-web`（Vue 3 + Vite，114KB JS / 26KB CSS），独立于 admin-web；五条铁律由 `check:studio-separation` 门禁守 |
| 工程 | 门禁 | 新增 `check-gen-sync`（清单 ↔ 产物 ↔ 接线三方一致）与 `check-studio-separation`（Studio 与后台平台互不依赖、不进 `deploy/**`），均接入 CI |
| 工程 | 测试 | admin-web 引入 Playwright（仅 chromium）与黄金链路 CRUD 用例；CI 构建面纳入 `@fw/studio-web` |

## 2. 升级影响（存量环境）

- **数据库**：零迁移。`apps/example-api/prisma/schema.prisma` 与 admin 模板 schema 只补了 `///` 中文标注（M17 标注能力的实测落盘），**无结构变更**；`migrate deploy` 无待应用项。
- **错误码**：零新增（沿 1001/1002/1003/4029~4031 既有码）。
- **服务端配置键**：零新增。M16/M17 的 `FW_AI_*` / `FW_STUDIO_*` 是 **CLI 侧**环境变量（开发者本机），不进服务端 `envSchema`，也不影响部署实例。
- **seed 语义变化（仅新项目 / 重新 seed 时生效）**：`fw gen crud` 的定向种子现在会把新模块的 4 个权限点**授给 admin 角色**；全量 seed 的 `GENERATED_PERMISSION_CODES` 循环改为幂等 upsert。存量项目若此前手工在「角色管理」里勾过权限，行为不变。
- **workspace 成员**：新增 `packages/studio-web`（`pnpm install` 后多一个包；不参与后端构建）。
- **前端**：admin-web 增加「平台审计」入口与双模式；产物 hash 变化，部署后建议强刷。

## 3. 部署步骤（裸机 release 目录范式，沿 docs/61/63）

1. 服务器 `cd /opt/fw/shared/repo && git fetch --tags origin`（取到 `v0.8.0` 标签）。
2. `sudo PRISMA_SCHEMA=prisma/pg/schema.prisma WEB_SYNC_DIR=/opt/1panel/www/<站点> bash deploy/scripts/bare-metal-deploy.sh --ref v0.8.0`（脚本内：构建框架包 → prisma generate → 迁移 → 切 `current` 软链 → 重启 `fw-api` → 健康检查，失败自动回切）。
3. **无需** seed / backfill（种子语义变化只影响新项目与显式 reseed）。
4. 前端产物由脚本 rsync 到 1Panel 站点目录；用户强刷或等 `index.html` no-cache 生效。

**回滚**：`bash deploy/scripts/bare-metal-deploy.sh --rollback`（切回上一 release 目录，数据库无变更可安全回滚）。

## 4. 验证矩阵（本机 + CI）

| 项 | 结果 |
|---|---|
| `@fw/cli` 全量 | **616/616**（43 文件；含 verify 20 / gen 26 / render 21） |
| `example-api` 全量 | **273/273**（`--hookTimeout 60000`；默认 10s 钩子下 2 个 Prisma 集成 spec 超时，属既有 Windows 沙箱限制，非回归） |
| `admin-web` 全量 + vue-tsc | **291/291** + 构建通过 |
| `@fw/studio-web` 构建 | 通过（114.04 KB JS / 26.01 KB CSS） |
| 静态门禁（8 道） | headers 805 文件 / no-raw-throw 326 文件 / helm 65 / api-parity / triway 八轴 / audit-events / gen-sync / studio-separation 全绿 |
| CI `构建 / 单测(SQLite) / 静态检查` | success（见发版提交的 run） |
| CI 三库集成矩阵（sqlite / postgres / mysql） | 三腿 success |
| **CI `golden-path`** | **success**：run [40684860336](https://github.com/donttemos/TY/actions/runs/40684860336)，九阶段 `workspace → install → model → migrate → seed → generate → build → boot → browser` 全 `ok`，`browser=ok 浏览器用例通过`，跳过 0 阶段，耗时约 2 分钟 |
| 真机（cs.donttemo.top / 106.55.32.251） | 部署与健康校验见 §6（本版发布时执行） |

## 5. 黄金链路首绿：五处真实断裂（本版最有价值的记录）

「从干净检出真能跑通」这句话此前从未被验证过。CI 作业上线后连续五轮失败，每一轮都是**产品缺陷**而不是环境噪音，这也是这条作业存在的意义：

| # | 现象（断裂阶段） | 真因 | 修复 |
|---|---|---|---|
| 1 | `generate` 阶段 TS2307 找不到 `@fw/storage` | 作业用清单枚举只构建了 8 个框架包，漏 `storage/queue/saas/tenant/transport/telemetry`；生成项目后端类型校验要解析每一个 `@fw/*` | 改为 `pnpm -r --filter "./packages/*" run build`，靠拓扑序，新增包自动覆盖 |
| 2 | `browser` 阶段 `/products` 是 404 页 | 定向种子建了权限点与菜单，但**没授给任何角色**；`/auth/menus` 按权限码过滤菜单，admin 拿不到 `product:read` → 菜单被滤掉 → 动态路由不注册 | 生成模板种子新增 `grantToAdminRole()`（幂等 upsert），admin 模板副本同步 |
| 3 | `seed` 阶段 P2002 唯一键冲突 | 上一条让定向种子授权后，全量 seed 的 `GENERATED_PERMISSION_CODES` 循环又对同一 `(roleId, permissionId)` 执行 `create` | 该循环改 upsert（本来就该幂等，此前只有 truncate 先行才侥幸成立） |
| 4 | `browser` 阶段登录接口全 200，页面仍停在 `/login` | **Vite dev server 依赖预构建竞态**：首屏 `/_vite/deps/*` 返 504 Outdated Optimize Dep → 动态导入失败 → 路由起不来。预热模块治不了（504 会换到下一条新发现的依赖） | `fw verify` 改为「前端构建 + preview」：验的是用户真正会部署的产物，顺带把生成物前端的 vue-tsc 纳入链路 |
| 5 | `browser` 阶段新建弹窗不关闭，`/products` 500 | `@fw/db` 仓储默认追加 `deletedAt IS NULL`、写入填 `createdBy/updatedBy`，而验收模型只有 `name/qty` 两列 → `PrismaClientValidationError: Unknown argument deletedAt` | 验收模型补齐 `id`/`deletedAt`/审计四件套；`fw gen crud` 增加**写盘前**约定校验，避免用户也踩 |

**副产品（可诊断性）**：第 4/5 轮曾因「失败即清场」把 `9001` 的堆栈一起删掉，只能靠猜。现已改为**失败保留生成项目**并把服务端日志尾部写进错误信息与报告，随 CI artifact 上传。

## 6. 真机验收（2026-10-28，106.55.32.251 / 1Panel）

- 部署前基线：`current → releases/20261021204922-94fb703`，`fw-api` active，`/health` 200（**注：并非任务描述里的 2f30084——真机已先行部署到 94fb703**）。
- 部署：`PRISMA_SCHEMA=prisma/pg/schema.prisma WEB_SYNC_DIR=/opt/1panel/www/fw-web bare-metal-deploy.sh --ref v0.8.0`（release 目录 + 软链原子切换 + 健康检查兜底），日志 `/tmp/deploy-v080.log`。
- **结论：成功**。`current → releases/20261028201335-b8641fe`，`fw-api` active；release 目录内 `package.json` 版本 0.8.0、`docs/90-release-v0.8.0.md` 就位；迁移阶段输出 `11 migrations found / No pending migrations to apply`（与「零迁移」一致）；前端产物于 20:14 同步到站点目录（asset `index-DXT_mLMj.js`）。
- 健康：`/health` → `{"status":"ok"}`；`/ready` → `{"db":"ok","cache":"ok","queue":"ok","transport":"ok"}` 四项全绿。
- 公网冒烟（`https://cs.donttemo.top`，服务器侧 curl）：首页 200；`POST /api/v1/auth/login`（`account` + `password`）201 取到 token；**`GET /api/v1/audit-logs/platform/tenant-options` → 200**（M15 P2 新增端点在线）；`GET /api/v1/auth/menus` → 200。
- **release 目录名的哈希是注解标签对象**（`b8641fe`），不是代码 commit（`cf89e76`）：脚本 `rev-parse --short <ref>` 未解引用标签。已修 `deploy/scripts/bare-metal-deploy.sh`（`^{commit}`），下次发版起目录名与 commit 一致；本次 release 的代码仍是 `cf89e76`（目录内版本与文档已核对）。

## 7. 遗留与后续

- **AC-16-08（`target=real` 真机链路）未关闭**：需要 docker/compose 环境与 Chromium 二进制，本轮真机为非容器部署，留待有 compose 的实例。
- **镜像真实构建未验证**：`deploy/Dockerfile` 已随本版发布，但本机无 docker、CI 未跑镜像构建；建议后续在 CI 增一个 `docker build --target runtime` 的作业。
- **PRD-017 剩余切片**：S5 部署中心、S6 轻量编辑器未做；`fw studio` 目前是本机工具（不随应用部署）。
- **PRD-011 剩余方向**：插件与模板市场、更多适配器、通知渠道扩展、微服务拆分演示、可观测告警等仍未排期（SaaS 运营主线已由 PRD-013 在 v0.7.0 落地）。
- **标签补齐**：仓库 tag 只到 `v0.6.0`，v0.7.0 / v0.7.5 未打；本版补打 `v0.8.0`，历史标签如需补齐可按 `docs/90-release-v0.7.0.md` / `v0.7.5` 里的提交号回打。
