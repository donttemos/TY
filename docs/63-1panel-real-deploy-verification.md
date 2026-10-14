# 通用应用框架 · 1Panel 真机部署验证报告

> 本文是 [1Panel 服务器真机部署手册](./62-1panel-real-deploy.md) 的**实测记录**：所有数据来自一台真实云服务器的完整部署过程，非估算、非设计推演。手册中标注「待真机确认」的 7 项在此逐条结清。
>
> 验证时间：2026-10-14　·　仓库版本：v0.2.0（`9d4e5fc`）

---

## 1. 被测环境（勘察实测）

| 项 | 实测值 |
|---|---|
| 云主机 | 腾讯云 2C2G4M，公网 `106.55.32.251` |
| 操作系统 | Ubuntu 22.04.4 LTS，内核 `5.15.0-113-generic`，`x86_64` |
| CPU | 2 vCPU（AMD EPYC 7K83） |
| 内存 | **1.9 GiB，初始 swap = 0** |
| 磁盘 | 50 GB ext4（部署前可用 38 GB） |
| 登录 | `ubuntu`（`NOPASSWD` sudo），初始**无 Node 环境** |
| 面板 | 1Panel（`1panel-core` / `1panel-agent`，监听 8090）+ Docker |
| 反代 | 1Panel OpenResty（容器 `1Panel-openresty-iaRX`，`openresty/1.31.1.1`） |
| 数据库 | PostgreSQL 18.6-alpine（容器，`0.0.0.0:5432->5432`）· MySQL 8.4.11（3306）· Redis 8.10.2（6379） |
| 时间 | Asia/Shanghai，已同步 |

### 1.1 三条关键约束的实测结论

手册 §1.3 提出这三条，本次**全部实测坐实**：

| # | 约束 | 实测方式 | 结论 |
|---|---|---|---|
| 1 | OpenResty 是否 host 网络 | `docker inspect ... HostConfig.NetworkMode` | **`host`** —— 容器内 `127.0.0.1` 即宿主，反代直接写 `127.0.0.1:3000` 命中 systemd 服务 ✅ |
| 2 | OpenResty 能否看到 `/opt/fw` | 容器内 `ls /opt/fw` | **不能**（`No such file or directory`）—— 前端产物必须同步到容器可见目录 ✅ |
| 3 | 数据库是容器、应用在宿主 | 宿主 `ss -tlnp` + 回环连通性测试 | 端口经 `docker-proxy` 映射到 `0.0.0.0`，宿主 `127.0.0.1:{5432,3306,6379}` 均可达 ✅ |

**挂载点（实测）**：`/opt/1panel/www -> /www`、`/opt/1panel/apps/openresty/openresty/root -> /usr/share/nginx/html`、`/opt/1panel/www/conf.d -> .../conf/conf.d`。因此**前端静态根落在 `/opt/1panel/www/<目录>`，站点配置写在 `/opt/1panel/www/conf.d/`**。

**PostgreSQL 接入（实测）**：`pg_hba.conf` 含 `host all all 127.0.0.1/32 trust`，即**宿主回环连库无需密码**；`listen_addresses=*`、`max_connections=100`、`ssl=off`。手册 §4.1 的「待真机确认」项 **已满足**，无需改动。

**Redis 认证（实测，手册未覆盖）**：1Panel 安装的 Redis 由 `PANEL_REDIS_ROOT_PASSWORD` 启用 `requirepass`。**未带密码时应用会报 `NOAUTH Authentication required.`**：缓存按 `CACHE_FAIL_OPEN` 降级、`/ready` 返回 503。连接串须写成 `redis://:<密码>@127.0.0.1:6379/<db>`。密码在 `/opt/1panel/apps/redis/redis/.env`。

### 1.2 网络出口实测（决定构建可行性）

| 目标 | 实测 |
|---|---|
| `github.com` | **超时不可达** → 服务器上无法 `git clone`，代码必须从本地投送 |
| `registry.npmjs.org` | 0.86 MB/s（单个包元数据耗时 **18 s**） |
| `registry.npmmirror.com` | **18.7 MB/s**（同一请求 0.8 s）——**相差约 20 倍** |
| `binaries.prisma.sh` | 可达（裸路径 404 属正常），Prisma 引擎可正常下载 |

> 结论：大陆服务器上**不换源就等于把构建从分钟级拖成小时级**。这也解释了为什么 `server-bootstrap.sh` 必须写入 npm 镜像配置。

---

## 2. 部署过程与实测数据

按手册 §3→§7 顺序执行，全程在真机完成。

### 2.1 初始化

| 步骤 | 实测结果 |
|---|---|
| 新增 swap | `fallocate -l 2048M /swapfile` → `Swap: 2.0Gi`，已写入 `/etc/fstab` |
| Node | **v22.22.2**（与本地开发运行时同版本），从 npmmirror 下载 30 MB 用时约 2 s |
| npm / pnpm | npm 10.9.7 · **pnpm 11.6.0** |
| 用户与目录 | 系统用户 `fw`（nologin）+ `/opt/fw/{releases,shared/data}` |

> ⚠️ **踩坑**：npmmirror 的 `latest-v22.x` 索引**陈旧**，仍指向 `node-v22.0.0`。直接用它会装到 22.0.0，而 **pnpm 11.6.0 要求 Node ≥ 22.13**，`npm i -g pnpm` 直接报错。必须显式指定版本（该镜像实际已提供到 `v22.23.3`）。

### 2.2 依赖安装与构建

| 阶段 | 实测 |
|---|---|
| `pnpm install --frozen-lockfile` | **415 个包 / 1 分 12 秒**；swap 峰值仅 **197 MB**（2 GB swap 余量充足） |
| `prisma generate`（PG schema） | **150 ms**，产物 `libquery_engine-debian-openssl-3.0.x.so.node` ✅ Linux 原生引擎 |
| 后端构建（拓扑序） | 12 / 14 个 workspace 项目（`tsc`），无编译错误 |
| 前端构建（vite 8 / rolldown） | **1.74 s**，产物 1.2 MB；`vendor-element-plus` 645 KB（gzip 208 KB） |
| 单 release 体积 | **612 MB**（node_modules 占绝大部分） |

> **2C2G 结论**：构建峰值内存未触及物理内存上限，**加 2 GB swap 后全程无 OOM**。手册 §8 的取舍是正确的，但「必然 OOM」的表述偏重——实测是「无 swap 时不可预期，加 swap 后稳定通过」。

### 2.3 数据库

- 建独立角色 `fw` + 库 `fw`（不污染 1Panel 的超级用户 `user`）
- `fw db:migrate --schema=prisma/pg/schema.prisma`：应用迁移 `20261014000000_init`，建 **13 张表**（12 个模型 + `_prisma_migrations`）、29 个索引
- `fw db:seed`：3 条演示条目 / **28 个权限点** / 5 个角色 / 8 条菜单 / 5 个部门 / 11 个账号 / 4 个租户

### 2.4 服务运行

| 指标 | 实测 |
|---|---|
| `/health` | `200` · `{"status":"ok"}` |
| `/ready` | `200` · `{"db":"ok","cache":"ok","queue":"ok","transport":"ok"}` |
| 开机自启 | `systemctl is-enabled` → `enabled` |
| 优雅停机 | `SIGTERM` → 队列停机 → `shutdown complete`，**约 13 ms**，无超时强杀 |
| 重启到就绪 | systemd 命令 0.05 s，新进程 **约 1.3 s** 后打印「服务启动完成」 |
| 应用内存 | RSS **约 130 MB**；cgroup `MemoryCurrent` 72 MB（上限 768 M 软 / 1024 M 硬） |
| 容器内存 | MySQL 274 MB · PostgreSQL 59 MB · OpenResty 22.6 MB · Redis 7.7 MB |
| 整机 | 已用 686 MB，**可用 1.0 GB**，swap 用 270 MB |
| 日志 | error = 0，warn 仅来自已知 4xx 与 Redis 认证窗口 |

### 2.5 反向代理与公网可达

- 站点配置：`/opt/1panel/www/conf.d/fw.conf`（`server_name 106.55.32.251`）
- 静态根：`/opt/1panel/www/fw-web` → 容器内 `/www/fw-web`
- `openresty -t` 语法通过 → `-s reload` 生效
- **公网实测**：`http://106.55.32.251/` → `200`；`/health` `/ready` → `200`；`/users`（SPA 回退）→ `200`
- 安全组：**80 / 443 已放行**；`3000` 从公网不通（正确，仅回环监听）

### 2.6 发版与回滚

| 动作 | 实测 |
|---|---|
| 软链原子切换 | `ln -sfn ... .tmp && mv -Tf .tmp current`，无窗口期 |
| **回滚**（current 指回上一 release + 重启 + 就绪） | **6.07 s** |
| 回滚后数据完整性 | `users=11 perms=28 tenants=4` 保持不变 |

### 2.7 端到端功能冒烟（从本机经公网打真实接口）

| 链路 | 结果 |
|---|---|
| 登录 / 刷新令牌 / 错误口令拒绝 | ✅ |
| 鉴权接口（`/auth/me`、`/auth/menus`）、无 token 401 | ✅ |
| RBAC（`/users` `/roles` `/permissions`）、越权返回 3002 | ✅ |
| 审计日志落库（`/audit-logs`） | ✅ |
| **缓存链路（真实 Redis）**：`put-and-pick` / `stats` / `find-user`；`driver=redis`，命中率统计正常 | ✅ |
| **队列链路（真实 BullMQ + Redis）**：派发任务 → `completed=1`、任务账本 `demo.echo count=1`、cron 已注册 | ✅ |
| 队列管理端点（`/admin/queue/*`）11 个 | ✅（依赖 §3.1 的缺陷修复） |
| **多租户（M8）**：`TENANT_ENABLED=true` 时无租户标识 → **403** fail-closed；带 `x-tenant-id: legacy` → 200；`off` 为停用租户 | ✅ |
| 静态资源、SPA 回退、长缓存 | ✅ |

---

## 3. 真机暴露的缺陷（本报告的主要价值）

以下 5 项**只有走完整真机流程才会暴露**，本地单测与 CI 都是绿的。均已修复（`9d4e5fc`）并在真机复验。

### 3.1 队列管理功能面对任何角色都不可达（功能级）

- **现象**：`admin` 访问 `/api/v1/admin/queue/stats` 返回 `3002 无操作权限`。
- **根因**：M7 的 `QueueAdminController` 全部 11 个端点由 `system:queue:list` / `system:queue:manage` 守卫，但 `example-api` 的种子**从未创建这两个权限点**——数据库里只有 26 个权限码，不含它们。`admin` 角色虽然拿的是「种子里的全部权限」，也拿不到不存在的权限。
- **修复**：随 `FRAMEWORK_PERMISSIONS` 建出这两点（该循环本就会给 admin 全量授权），权限点总数 26 → 28。
- **复验**：不施加任何手工 SQL，5 个 `list` 端点 + cron 手动触发端点全部 `code:0`；`alice` 仍被正确拒绝。

### 3.2 `dedicated` 租户的连接串写死为 SQLite 路径

- **现象**：PostgreSQL 部署下，`tenants.db_url_enc` 仍存着指向 `file:./tenant-dedicated.db` 的密文。
- **根因**：种子常量 `DEDICATED_DB_URL = 'file:./tenant-dedicated.db'` 未随驱动变化。Prisma 的 `provider` 在 `generate` 时已固定为 `postgresql`，该连接串**永远连不上**（且失败会在真正访问该租户时才爆发）。
- **修复**：优先取 `SEED_DEDICATED_DB_URL`；未配置时仅在 `DB_DRIVER` 为 `sqlite`（或未设置）时回退本地文件，其他驱动留 `NULL`。
- **复验**：`dedicated -> NULL`。

### 3.3 `fw` CLI 的 bin 链接缺失，导致迁移与种子不可用

- **现象**：`pnpm run db:migrate` 报 `sh: 1: fw: not found`。
- **根因**：pnpm 在 **install 阶段**创建 workspace 包的 bin 链接，而那一刻 `packages/cli/dist/index.js` 尚未构建 → `.bin/fw` 被静默跳过（只留一条 WARN）。此后 `pnpm install` 与 `pnpm install --force` 都判定 `Already up to date`，**不会补建**。这是个「先有鸡还是先有蛋」的时序问题：构建在安装之后，而链接只在安装时建立。
- **修复**：部署脚本在构建后删掉应用自身的 `node_modules` 再装一次（工作区内该目录只是一组软链，**重建约 1.6 s**），并断言 `.bin/fw` 可执行。
- **复验**：重链后 `.bin/fw` 就位，`db:migrate` / `db:seed` 正常。

### 3.4 `fw db:migrate` 的迁移数量取自错误的目录（误导排障）

- **现象**：命令打印「共 4 个迁移」，而 Prisma 随后显示「1 migration found」。
- **根因**：`listMigrations()` 固定读 `prisma/migrations`（SQLite 目录），忽略 `--schema` 参数。实际部署行为正确（Prisma 用对了目录），但**打印的数量是错的**，排障时极易误判「迁移漏跑」。
- **修复**：由 schema 路径推导迁移目录；`db:rollback` 的目标目录与临时 SQL 路径同步修正。
- **复验**：输出变为「`prisma/pg/migrations` 下共 1 个迁移」。

### 3.5 `server-bootstrap.sh` 未配置依赖镜像

- **现象**：默认走 `registry.npmjs.org`，大陆机器上 `pnpm install` 从分钟级变小时级。
- **修复**：写入 Node 前缀 / `root` / `fw` 三处 `npmrc` 指向 npmmirror，并给 corepack 指定 `COREPACK_NPM_REGISTRY`；同时把「不要依赖镜像 `latest-v22.x` 索引」写进脚本注释。

### 3.6 环境适配项（非缺陷，但手册需补充）

- **`.env` 权限**：systemd 以 root 读 `EnvironmentFile`，故 **`600 root:root` 是正确姿势**；但若要以 `fw` 身份手工执行迁移/种子（如本次排障），需临时放宽为 **`640 root:fw`**，否则 `Permission denied`。
- **`docker exec -i` 会吞掉脚本的标准输入**：以 `ssh ... 'bash -s' < script` 方式远程执行脚本时，脚本里的 `docker exec -i psql ...` 会把**后续脚本文本当成自己的 stdin 读走**，导致脚本中途截断且不报错。加固：所有 `docker exec` 加 `</dev/null`。
- **已存在的 `framework_test` 库**：目标机上本就有一个含 12 张同名表的数据库（结构与本仓库 schema 一致），说明该机此前跑过同类迁移。本次新建独立库 `fw`，未触碰它。
- **1Panel 的 Redis 有 `requirepass`**：密码在 `/opt/1panel/apps/redis/redis/.env`。连接串必须写成 `redis://:<密码>@127.0.0.1:6379/<db>`，否则 `NOAUTH` → 缓存降级 → `/ready` 503。
- **`ssl_reject_handshake` 的静默拒绝**：默认站开启了 `ssl_reject_handshake on`，**不带 SNI（或用 IP 作 SNI）连 443 会被硬拒（`SSL alert 112 unrecognized_name`）且不写访问日志**。排查「访问日志里查不到用户请求」时先想到这一条。

### 3.7 HTTPS 上线后暴露：生产前端构建缺 API 基址，登录返回 405（配置级，最隐蔽的一个）

- **现象**：域名 HTTPS 打开后点「登录」→ `405 Not Allowed`（响应头 `server: openresty`）。
- **定位过程**（关键在于**先看访问日志而不是猜**）：
  - 访问日志显示真实浏览器发的是 `POST /auth/login`，**而不是** `POST /api/v1/auth/login` —— 请求路径本身就不对；
  - 直接复现：`POST /api/v1/auth/login` → `201`，`POST /auth/login` → `405`；
  - 查部署产物：`grep -ro '/api/v1' <站点>/assets/*.js` 返回 **0 次**。
- **根因**：`apps/admin-web/.env.production` 被 `.gitignore` 的 `.env.*` 规则排除（仅放行 `.env.example`），而 release 取自 `git archive`（**只含被跟踪的文件**）→ 服务器构建时 `VITE_API_BASE_URL` **缺失** → `axios.create({ baseURL: undefined })` → 请求退化为同源相对路径 `/auth/login` → 被静态站 `location /` 接管 → nginx 对静态资源**拒绝 POST** 并返回 405。
- **同源的次生缺陷**：`token.ts` 的 `storageEnabled()` 借用「`VITE_API_BASE_URL` 是否已定义」作环境哨兵 —— 同一个变量缺失会**连带关闭令牌本地存储**。即使 405 修好，登录成功也会立刻掉线（「记住我」失效、刷新页面即回登录页）。属**变量语义错配**，一并修掉。
- **修复（三层，缺一层都会复发）**：
  1. `request.ts`：API 基址按同源反代约定兜底 `import.meta.env.VITE_API_BASE_URL ?? '/api/v1'`；
  2. `token.ts`：改用专用开关 `VITE_AUTH_STORAGE`（**默认启用**，置 `none` 关闭），不再借无关变量作哨兵；
  3. `bare-metal-deploy.sh`：前端构建**显式注入** `VITE_API_BASE_URL`（新增 `WEB_API_BASE`，默认 `/api/v1`），并在构建后**断言产物确含该基址**，缺失即中止发布 —— 新增的发布闸门，杜绝「站点能打开但登不进去」的版本上线。
- **复验（实测）**：
  - 移走 `.env.production` 后本地构建，产物含 `var fr=\`/api/v1\``（**修复前为 0 次**）；
  - 发版脚本断言双向验证：含基址 → 通过；查一个不存在的基址 → 正确报缺失（会触发 `die` 中止发布）；
  - 公网验收：站点 `assets/request-*.js` 内出现 `/api/v1`，`POST /api/v1/auth/login` 返回 `code:0`，`/ready` 四项全 ok；
  - `admin-web` 单测 29/29（含「无感刷新」3 例，改动后不再依赖任何 env 变量）。

> **可复用的教训**：任何**构建期输入**都不能只存在于被 `gitignore` 的文件里。`git archive` / CI 干净检出取不到它，本地却永远正常 —— 这类缺陷**本地全绿、只在真机或 CI 上炸**。凡是「构建产物应当包含的常量」，都应同时具备**代码内默认值**与**产物断言**。


---

## 4. 手册「未验证项」的结清（对应 62 文档 §12）

| # | 手册原列未验证项 | 本次结论 |
|---|---|---|
| 1 | OpenResty 实际网络模式 | ✅ 实测 `host` |
| 2 | 1Panel 站点目录真实路径 | ✅ 前端根 `/opt/1panel/www/<目录>`，配置 `/opt/1panel/www/conf.d/` |
| 3 | PG 容器是否接受宿主回环连接 | ✅ `127.0.0.1/32` 为 `trust`，直接可连 |
| 4 | 2C2G 构建峰值与总耗时 | ✅ 安装 1m12s / 峰值 swap 197 MB；构建无 OOM |
| 5 | 1Panel 是否有站点级配置覆写行为 | ⚠️ **仍未验证**：本次为手工写入 `conf.d`，未经面板 UI 重存。若后续在面板里编辑该站点，需回看配置是否被重写 |
| 6 | Node 二进制兼容性 | ✅ v22.22.2 正常启动运行 |
| 7 | 应用内存与 `MemoryMax=1024M` 的匹配度 | ✅ 实测 RSS≈130 MB / cgroup 72 MB，余量充足（业务量上涨仍需持续观察） |

### 后续轮次已消除的未验证项

- **HTTPS 证书签发** —— 已完成：`cs.donttemo.top` 经 certbot（apt 内网源 1.21.0）webroot 签发 Let's Encrypt 证书，
  实测 `CN=cs.donttemo.top`、有效期至 2027-01-12；`certbot.timer` 已激活且 `renew --dry-run` 通过，
  续期后由 `renew_hook`（`/usr/local/bin/fw-cert-deploy.sh`）把证书同步进**容器可见**路径并热加载。
  80 强制跳 443、TLS 1.2/1.3、HTTP/2 协商均正常。上线后暴露的 405 缺陷见 §3.7。

### 仍然未验证（诚实清单）

- **`fw-worker@.service` worker 进程**：本次只跑了 API 主进程（`TRANSPORT_DRIVER=in-process` 单进程模式），**未验证**跨进程 worker 单元。
- **Redis Cluster**：`CACHE_DRIVER=redis-cluster` 仍未在真实集群上验证（与 62 文档 §12 一致）。
- **1Panel 面板 UI 建档**：站点与反代是**手工写配置文件**实现的，未走面板「创建网站」流程；面板侧的「网站」列表里不会出现该站点。
- **`bare-metal-deploy.sh` 的完整自动跑**：本次为「手工执行等价动作序列」，脚本本身只做了 `bash -n` 与逐步骤对齐；**未以 `sudo ./deploy/scripts/bare-metal-deploy.sh` 端到端执行**（该机 `github.com` 不可达，脚本的常驻 clone 取码路径需另配镜像或改为投送 tar 包）。

---

## 5. 复现要点（给别人照着做的清单）

1. 服务器上**先加 swap**（`2G`），再装 Node（**用 npmmirror 并显式指定 v22.22.2**，不要用 `latest-v22.x`）。
2. `npm config set registry https://registry.npmmirror.com`（Node 前缀 / root / fw 三处）。
3. 代码**从本地 `git archive` 打包投送**，不要在服务器上 clone（`github.com` 不可达）。
   ⚠️ `git archive` **只含被跟踪的文件** —— `.env.*` 一律不在包内。凡「构建产物应包含的常量」
   （最典型是前端 API 基址）都必须有**代码内默认值**，并由发版脚本**注入 + 断言产物**，否则会得到
   「站点能打开但登不进去」（登录 405）的构建（见 §3.7）。
4. PostgreSQL 用 **PG 变体 schema**（`prisma/pg/schema.prisma`），`prisma generate` 必须在 **Linux 上**执行。
5. `pnpm install` → `prisma generate` → **构建** → **重链 bin（关键）** → `db:migrate` → `db:seed`。
6. `.env` 权限 `600 root:root`；以 root 执行迁移/种子，或临时 `640 root:fw`。
7. Redis **必须带密码**（`redis://:<密码>@127.0.0.1:6379/<db>`）。
8. 前端产物同步到 `/opt/1panel/www/<目录>`；站点配置写 `/opt/1panel/www/conf.d/`；反代上游 `127.0.0.1:3000`。
9. 验收顺序：`/health` → `/ready` → 登录 → RBAC → 缓存 → 队列 → 多租户 → SPA 回退。

---

## 6. 相关文档

- [1Panel 真机部署手册](./62-1panel-real-deploy.md) —— 步骤手册（本文为其实测记录）
- [云服务器裸机部署手册](./61-bare-metal-deploy.md) —— 宿主 nginx 档位
- [部署与运维手册](./60-deployment-ops.md) —— Docker / 大档部署
- [文档一致性核对报告](./95-doc-audit.md) —— L-05（`LOG_FORMAT` 未实现）
- [v0.2.0 发布报告](./90-release-v0.2.0.md)
