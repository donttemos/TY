# PRD-016 · 开发体验与部署一体化（M16）

> 里程碑：M16 ｜ 状态：开发中（S1 生成 / S2 部署 / S3 验收三条命令均已交付，2026-10-22；待验证：镜像真实构建、CI 黄金链路作业首跑、真机 target=real）｜ 优先级：P1 ｜ 依赖：M6（生成器）、M8（部署档位）、PRD-013 主线 B ｜ 负责人：donttemo ｜ 更新：2026-10-22

## 1. 背景与目标

M6 交付了 `fw gen crud`，但「生成完」不等于「能跑」：`packages/cli/src/gen/gen.ts` 的下一步清单仍要求用户手工跑迁移、编辑 `app.module.ts`、编辑 `prisma/seed.ts`、跑前端 lint。M8 交付了 compose 编排，但仓库没有 Dockerfile。M1–M15 的验收全部靠人工执行几十条命令。

**本 PRD 的唯一衡量标准是「用户要敲几条命令、回答几个问题」**，不是「实现了多少能力」。

目标态：**三条命令，零到一次交互。**

| 任务 | 用户输入 | 框架内部完成 |
|---|---|---|
| A 代码生成 | `fw gen crud Product` | 生成 → 接线 → 迁移 → 种子 → 前后端校验 |
| B 部署 | `fw deploy`（首次答 3 问） | 预检 → 构建 → 备份 → 迁移 → 启动 → 健康 |
| C 验收 | `fw verify` | 初始化 → 生成 → 迁移 → 启动 → 浏览器 CRUD → 部署 → 健康 |

## 2. 范围

**做**：生成器自动接线（模块注册 / 种子聚合 / 权限码）、生成后迁移与双端编译校验、单机 Docker Compose 一条命令部署（含迁移风险检查与备份）、黄金链路自动化验收。

**不做**：业务逻辑生成、脱离框架仓库的独立项目脚手架（需先发布 `@fw/*`）、Helm/K8s 部署渠道重做（保留现状）、多机编排、可视化建模。

## 3. 精简原则（本 PRD 的硬约束）

1. **默认正确，flag 只用于例外**。每条命令的必填参数只有一个（生成器：模型名；部署：无；验收：无）。能用自动探测得出的绝不设成开关。
2. **纵向切片交付**，不按「后端层 / 前端层 / 文档层」横切。每个切片结束时对应用户可独立使用。
3. **交互只出现在「有副作用且无法自动判定」时**，且一次问完，不允许分步追问。
4. **失败输出不超过三行**：哪一步、什么原因、下一条命令。不把底层命令清单丢给用户。
5. **`fw help` 新增命令不超过 3 条**，每条不超过 3 行说明。

## 4. 用户故事

- 作为开发，我加了一张表，敲 `fw gen crud Product` 之后直接 `fw dev` 就能在后台看到菜单并增删改查，不需要改任何框架文件。
- 作为开发，我第一次部署只回答三个问题，之后每次发版只敲 `fw deploy`。
- 作为测试，我不用再手工执行几十条验证命令，`fw verify` 一条命令告诉我链路在哪一环断了。
- 作为架构师，CI 与真机跑的是同一条验收命令，只是 target 不同，结论可比。

## 5. 功能需求（FR）

### A · 代码生成一条命令完成

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-16-01 | 单一入口 | `fw gen crud <Model>` 完成生成、接线、迁移、种子、双端校验，无需第二条命令 |
| FR-16-02 | 自动接线 | 生成 `src/modules/generated/index.ts` 与 `prisma/seed/generated.seed.ts`，并由清单**整块重写** `app.module.ts` / `seed.ts` 中的 `// <fw:gen:…>` 标记块；零人工编辑 |
| FR-16-03 | 清单为事实源 | `fw.gen.json` 记录已生成模型、产物路径、schema 指纹；重跑幂等，`--force` 不产生重复片段；清单与产物不一致时门禁报红 |
| FR-16-04 | 权限码去手写 | 删除 `seed.ts` 中手写的 `GENERATED_PERMISSION_CODES` 字面量，权限码由清单归集 |
| FR-16-05 | 迁移自动化 | 生成迁移文件后按风险分级：非破坏性自动 apply；破坏性（DROP COLUMN/TABLE、类型收窄、ADD NOT NULL 无默认值）需一次确认；**任何情况下不允许自动 reset** |
| FR-16-06 | 双端校验 | 后端 `tsc --noEmit` + 前端 `vue-tsc --noEmit` 并行执行，失败整体回滚并列出被还原文件 |
| FR-16-07 | 存量兼容 | 手写模块保持手写；清单与手写冲突时明确报错，不隐式覆盖 |

### B · 部署一条标准流程

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-16-08 | 可构建镜像 | 新增多阶段 `Dockerfile`（deps → build → runtime + 独立 migrator 目标），非 root 运行、含健康检查；`migrator` 目标保留 `prisma` 与 `tsx`（二者当前在 devDependencies） |
| FR-16-09 | 首次向导 | 首次 `fw deploy` 只问三项：数据库连接串、Redis 连接串、对外域名；写入 `.env.prod`（权限 600、密钥不回显、不进日志），后续零输入 |
| FR-16-10 | 阶段化编排 | preflight → plan → build → backup → migrate → up → health → report 串行执行；`--plan` 只输出计划不执行；中断后可重入 |
| FR-16-11 | 迁移风险检查 | 对齐库与 schema 做 `migrate diff`，按危险级别分类输出；破坏性迁移默认阻断，需 `--allow-destructive` 且备份成功后才继续 |
| FR-16-12 | 备份 | 迁移前 `pg_dump -Fc` 到 `backups/`，用 `pg_restore -l` 校验可读，失败即中止部署；按份数保留 |
| FR-16-13 | 失败恢复 | 健康检查失败自动回退到上一镜像并重启；**数据库不回滚**（写进文档与命令输出），默认要求 expand-contract |
| FR-16-14 | 渠道边界 | `--target=compose`（本轮唯一正式渠道）与 `--target=bare-metal`（薄包装既有 `deploy/scripts/bare-metal-deploy.sh`，不改其内部） |

### C · 黄金链路验收

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-16-15 | 单命令验收 | `fw verify` 串联七个阶段，输出 JSON + 可读摘要；任一阶段失败即停止并标明断裂点 |
| FR-16-16 | 双 target | `--target=ci`（无 Docker、SQLite）与 `--target=real`（compose + 真机健康）共用同一命令与断言集 |
| FR-16-17 | 真实浏览器 | 引入 Playwright（仅 chromium），完成登录 → 列表 → 新建 → 编辑 → 删除一条流程；失败保留 trace |
| FR-16-18 | 真机隔离 | 真机验收使用独立实例与端口，不触碰在用服务；受登录限流约束时按退避重试而非放宽限流 |

## 6. 非功能需求（NFR）

- **耗时**：`fw gen crud` 单模型含双端校验 ≤ 90s；`fw deploy` 首次 ≤ 10min、增量 ≤ 4min；`fw verify --target=ci` ≤ 8min。实测超出则降档为并行或缓存，不静默放宽。
- **幂等**：三条命令均可重复执行，不产生重复文件、重复接线、重复迁移记录。
- **可回滚**：生成失败回滚文件（含被修改文件的原文快照）；部署失败回滚镜像；数据库迁移不自动回滚但必须已备份。
- **可诊断**：所有失败输出含阶段名、原因、下一条命令；不输出密钥。
- **兼容**：`fw gen crud` 既有 flag（`--dry/--force/--only/--all/--app/--web/--schema/--no-verify`）行为不变，新行为只改默认值。

## 7. 关键设计

**接线机制**：`fw.gen.json`（事实源）→ 渲染 `generated/index.ts`、`generated.seed.ts` → 按清单全量重写 `app.module.ts` / `seed.ts` 的标记块。否决运行时动态加载（破坏 Nest DI 静态分析与 tsc 路径解析）与文本增量插入（`--force` 重复插入）。

**回滚语义扩展**：`gen/writer.ts` 现只支持「写新文件 + 整删回滚」，需扩展为「写/改 + 按原文快照还原」。

**部署编排**：`fw deploy` 是编排器不是包装器，自身维护阶段状态与 `deploy.manifest.json`（release id、镜像 tag、迁移清单、备份路径、健康结果），使中断可重入、失败可定位。

**已知不成立项**：`deploy/docker-compose.prod.yml` 中的 `deploy.update_config` / `restart_policy` 属 Swarm 语义，单机 `docker compose up` 不执行，文件中「start-first + failure_action: rollback」不能作为既有能力依赖，本轮由 `fw deploy` 自己实现回退。

## 8. 验收标准（AC）

- [x] **AC-16-01 命令面**：新增命令 3 条、必填参数 ≤ 1 —— `fw gen crud <模型>`（唯一必填：模型名）、`fw deploy`（无必填）、`fw verify`（待 S3）；flag 全部有默认值
- [x] **AC-16-02 一键生成**：新模型从「5 条命令 + 2 处手工编辑」降为「1 条命令 + 0 处手工编辑」——临时项目实测：生成 10 个产物 + 自动重写 `app.module.ts` / `seed.ts` 标记块 + 写入 `fw.gen.json`，全程未手工编辑框架文件
- [x] **AC-16-03 交互次数**：非破坏性迁移 0 次交互；破坏性迁移恰好 1 次确认——`post-gen.test.ts` 断言确认回调被调用 1 次，`--allow-destructive` 时 0 次
- [x] **AC-16-04 部署交互**：首次部署恰好 3 问（域名 / 数据库密码 / Redis 密码，后两项留空自动生成），第二次部署 0 问——`deploy.test.ts` 断言二次部署提问器零调用、`--yes` 与 `--plan` 都不提问
- [x] **AC-16-05 失败诊断**：部署失败输出单行「失败：原因。下一步」并落 `deploy-report.json`（含阶段与 next）；本机无 docker 时实测输出 1 行且不再等待 stdin
- [x] **AC-16-06 幂等**：连续两次 `fw gen crud` 无重复产物、无重复接线——实测第二次输出「接线已是最新」且零写入（`fw deploy` 部分待 S2）
- [ ] **AC-16-07 全新项目链路**：`fw verify --target=ci` 已实现并单测覆盖（15 例：阶段序、失败定位、浏览器缺失降级、收尾清理）；**本机实跑至 migrate 阶段通过**，seed 之后受沙箱限制（Prisma 引擎在此沙箱静默不落库，与既有 `tsc/build` 同类问题），完整链路待 CI 作业首跑确认
- [ ] **AC-16-08 真机链路**：`fw verify --target=real` 已实现（部署 → 健康 → 浏览器 CRUD，同一份用例）；**未验证**：本机无 docker、chromium 二进制下载在本机卡在 0%（CDN 不可达），镜像构建与真实浏览器执行均待测试机/CI 确认
- [x] **AC-16-09 迁移安全**：DROP COLUMN / DROP TABLE / ADD NOT NULL 无默认值默认阻断；`--allow-destructive` 且确认后才执行；`migrate dev` 只用 `--create-only`，永不 reset；`fw deploy` 侧「备份失败即中止迁移」且首次部署显式跳过风险闸门（无历史基线）
- [x] **AC-16-10 门禁**：`check:gen-sync` 覆盖「清单 ↔ 产物 ↔ 接线」三方一致（含反向抽查），已接入 CI 且反向验证会报红

## 9. 交付切片

每个切片独立可验收，不横切分层：

| 切片 | 内容 | 完成标志 |
|---|---|---|
| S1 | A：一键生成（FR-16-01~07） | AC-16-02/03/07 绿 |
| S2 | B：一键部署（FR-16-08~14） | AC-16-04/05/09 绿 |
| S3 | C：一键验收（FR-16-15~18） | 代码与单测完成（AC-16-01 收口）；AC-16-07/08 待 CI 与真机首跑 |

S1 与 S2 可并行（共享 `fw.gen.json` 与 `deploy.manifest.json` 契约），S3 依赖 S1、S2 主体完成。

## 10. 依赖与风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `writer.ts` 回滚语义改造 | 生成器 116 用例回归面 | 先补「修改既有文件 + 原文快照回滚」单测，再改调用方 |
| `vue-tsc` 全量校验耗时 | 单命令超 90s 预算 | 先实测再定默认档，必要时前端校验走增量 |
| compose Swarm 语义残留 | 「失败自动回滚」假象 | `fw deploy` 自行实现回退，文档标注字段无效 |
| 真机并行会话抢资源 | 行数漂移、断言假红 | 真机验收用独立实例；断言用集合不用计数 |
| `templates/admin/server/dist` 已入库 | 旧产物遮蔽源码改动 | 本轮清理，模板不提交 dist |

## 11. 待定问题

1. 前端校验默认档：全量 `vue-tsc` 还是仅校验新增文件相关类型？——实施时以实测耗时决定，负责人 donttemo。
2. `fw verify --target=real` 的触发方式：手动触发还是定时？——建议手动触发，避免与并行会话冲突。

## 12. 变更记录

| 日期 | 变更点 | 影响 |
|---|---|---|
| 2026-10-22 | 立项：三个任务合并为「三条命令」目标，确立 5 条精简原则；A 接线机制定为「清单 + 标记块整块重写」；「全新测试项目」限定为仓库内生成的项目；部署只做单机 Compose | 初版 PRD |
| 2026-10-22 | S1 交付：`fw gen crud` 一条命令到底（自动接线 + 建并应用迁移 + 定向种子 + 双端校验）；接线缺标记时**降级告警不阻断**（存量项目可平滑升级）；新增 `check:gen-sync` 门禁并接入 CI | FR-16-01~07 落地；AC-16-01/02/03/06/09/10 勾选；`docs/50` 新增 TC-GEN-010/011 |
| 2026-10-22 | S2 交付：`fw deploy` 单机 Compose 一条命令（预检/构建/备份/迁移/启动/健康/报告）；新增 `deploy/Dockerfile`（runtime + migrator 双目标）与 `.dockerignore`；编排接入本地构建、副本数可配、迁移改走 migrator、移除 Swarm 专用字段 | FR-16-08~14 落地；AC-16-04/05 勾选；AC-16-08 仍待真机 |
| 2026-10-22 | **实施期修正 FR-16-09 的提问内容**：原写「数据库连接串 / Redis 连接串 / 对外域名」，实际单机 Compose 下连接串由编排内部派生（`DB_URL` 由 `POSTGRES_PASSWORD` 拼出），问用户没有意义——改为「域名 / 数据库密码 / Redis 密码」，密码可留空自动生成，JWT 密钥始终自动生成且永不回显 | 交互次数不变（仍 3 问），但问的是用户真正能决定的东西 |
| 2026-10-22 | 新增 `--seed`（默认不执行）：`prisma/seed.ts` 自带清场语义，自动执行会清数据；首次部署仅在计划输出里提示，绝不擅自 seed | 首装可用性靠显式一次 `fw deploy --seed` 换取数据安全 |
| 2026-10-22 | S3 交付：`fw verify`（ci/real 双 target，阶段 workspace→install→model→migrate(+generate)→seed→generate→build→boot→browser）；新增 Playwright 配置与一条 CRUD 用例、CI `golden-path` 作业；**S3 暴露出 3 个真实缺陷并修复**（见下三行） | FR-16-15/16/17 落地；AC-16-01 收口 |
| 2026-10-22 | 缺陷 1（`fw new`）：工作区成员注册用「项目名」而非「相对仓库根路径」，在 `apps/` 子目录执行时注册出匹配不到目录的 glob，生成项目不会被 pnpm 链接 | 直接阻塞黄金链路；已改为相对路径并补注释 |
| 2026-10-22 | 缺陷 2（`resolveLayout`）：`fw new --template=admin` 产出 `server/` + `admin-web/` 兄弟目录，无 `apps/` 时前端根被当成后端根，前端产物会写进后端目录 | 已识别兄弟 `admin-web`/`web`/`frontend` 目录，补 2 例布局测试 |
| 2026-10-22 | 缺陷 3（Windows 执行）：`execFile('pnpm')` 报 ENOENT/EINVAL（`pnpm.cmd` 需经 shell）；错误信息只有 `Command failed`，无法定位 | 增加 `pnpmBin()` 与「.cmd 才走 shell」策略；失败时改用 stderr 首行 |
| 2026-10-22 | 强化：`fw verify` 在 sqlite 场景预创建库文件（Prisma 引擎在沙箱/网络盘上 `unable to open database file`），并在 seed 前显式 `prisma generate`（否则 `@prisma/client` 只是空壳，报 `does not provide an export named 'PrismaClient'`） | 让黄金链路在 CI 与真机都能跑；本机沙箱仍受引擎静默失败限制 |
