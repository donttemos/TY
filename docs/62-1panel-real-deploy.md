# 通用应用框架 · 1Panel 服务器真机部署手册

> 本手册面向**已有 1Panel 面板的云服务器**，把 example-api 以「不用容器跑应用、复用面板托管的数据库与反向代理」的方式真实部署上线的完整步骤。
> 与 [云服务器裸机部署手册](./61-bare-metal-deploy.md) 的关系：**61 是宿主 nginx 场景的通用手册，本手册是 1Panel 场景的落地版**——两者共享 systemd 单元与发版脚本，差异集中在反向代理与静态托管（见 §1.3）。
>
> 本文所述步骤按顺序执行即可从零到可访问；**已在真机验证的步骤与"仅设计验证、待真机确认"的步骤分别标注**，未验证项集中列在 §12。

---

## 1. 场景、目标与关键约束

### 1.1 目标环境

| 项 | 值 |
|---|---|
| 服务器 | 2 核 2G 内存 / 4M 带宽 |
| 面板 | 1Panel（自带 OpenResty 反向代理） |
| 已装组件 | MySQL、Redis、PostgreSQL、OpenResty（均以 1Panel 应用商店容器形式安装） |
| 运行时 | Node.js 22 LTS + pnpm 11.6.0（由本手册的脚本安装） |
| 应用 | `apps/example-api`（NestJS 11 单体）+ `apps/admin-web`（Vue3 管理后台静态产物） |
| 数据库 | PostgreSQL（本次选定） |
| 入口 | 域名 + HTTPS，由 1Panel 的 Acme 申请证书 |

### 1.2 目标架构

```
                         公网用户
                             │
                   [云安全组放行 80 / 443]
                             │
        ┌────────────────────▼─────────────────────┐
        │  1Panel OpenResty 容器（host 网络）       │
        │  :80 → :443 重定向 ； :443 终止 TLS       │
        └───────┬───────────────────────┬──────────┘
                │                       │
      /  /assets/（静态）           /api/  /health（反代）
                │                       │
                │                       ▼
                │        ┌──────────────────────────────┐
                │        │  fw-api  (systemd 托管)       │
                │        │  Node 22 + NestJS 11          │
                │        │  监听 127.0.0.1:3000          │
                │        └───┬───────────────┬──────────┘
                │            │               │
                │     127.0.0.1:<PG端口>  127.0.0.1:<Redis端口>
                │            ▼               ▼
                │   ┌────────────────┐ ┌──────────────┐
                │   │ PostgreSQL 容器 │ │  Redis 容器   │
                │   └────────────────┘ └──────────────┘
                │
                └── /opt/1panel/www/sites/<域名>/index（前端产物，deploy 时 rsync 同步）

  宿主文件系统：/opt/fw/{releases,current,shared}  ← 应用代码与运行数据（容器不可见）
```

### 1.3 ★ 三条决定成败的网络/文件系统约束

这三条是本手册与 61 手册的全部差异来源，也是这套组合最容易踩坑的地方：

| # | 事实 | 后果与做法 |
|---|---|---|
| **①** | 1Panel 的 OpenResty 是**容器**，但采用 **host 网络模式**，容器内 `127.0.0.1` **就是宿主机** | 反向代理地址直接填 `http://127.0.0.1:3000` 即可命中宿主上的 systemd 服务。**反向不成立**：若 OpenResty 不是 host 网络（改过配置），必须改用宿主机内网 IP，见 §2.3 的自动判定 |
| **②** | OpenResty 容器**文件系统是隔离的**，容器内看不到 `/opt/fw` | 前端产物**不能**像 61 手册那样 `root /opt/fw/current/apps/admin-web/dist`。必须落到 1Panel 站点目录（`/opt/1panel/www/sites/<域名>/index`），由发版脚本的 `WEB_SYNC_DIR` 同步 |
| **③** | MySQL / PostgreSQL / Redis 都是**容器**，端口映射到宿主 | 应用跑在**宿主机**上，因此连接串 host 必须写 `127.0.0.1`，端口取 1Panel 的**宿主映射端口**（常被改为 15432/13306 等）。写容器名（如 `1Panel-postgresql-xxxx`）会 `ECONNREFUSED`——容器名只在容器之间可解析 |

> 口诀：**应用在宿主 → 用 127.0.0.1；应用在容器 → 用容器名。** 本手册的应用由 systemd 托管在宿主上，所以全程 `127.0.0.1`。

### 1.4 为什么数据库必须重建迁移

Prisma 的 `datasource.provider` 是**编译期字面量**（不能用 `env()` 切换），且 `migrations/*.sql` 是**按方言生成**的 DDL。仓库默认的 `apps/example-api/prisma/schema.prisma` 是 `sqlite`，其四个迁移文件全是 SQLite 方言（`DATETIME` 等），**直接灌进 PostgreSQL 必然失败**。

因此仓库已为本次部署新增独立的一套：

| 用途 | schema 路径 | migrations 目录 | provider |
|---|---|---|---|
| 本地开发 / CI（默认） | `apps/example-api/prisma/schema.prisma` | `prisma/migrations/` | sqlite |
| **生产部署（本手册）** | `apps/example-api/prisma/pg/schema.prisma` | `prisma/pg/migrations/` | postgresql |

两份 schema 的**模型段逐字节一致**，漂移校验命令见 §4.2。部署时用 `PRISMA_SCHEMA` 环境变量切换，同时必须保证 `prisma generate`、`prisma migrate`、运行期三者用的是同一套。

---

## 2. 第 1 步：环境勘察（先摸清事实，再动手）

不要凭猜配置。先在服务器上跑一次勘察脚本，它会回答「OpenResty 是不是 host 网络」「数据库映射到哪个宿主端口」「内存够不够构建」三个问题。

```bash
# 把仓库取到服务器（任一方式）
sudo dnf install -y git || sudo apt-get install -y git
git clone <你的仓库地址> /tmp/fw-src

# 只读勘察，不做任何修改；输出可直接回贴排障（不含密码）
sudo bash /tmp/fw-src/deploy/scripts/probe-env.sh
```

脚本输出 7 节：系统与资源 / 1Panel / 容器与网络拓扑 / 反向代理与端口占用 / 数据库可达性 / 运行时与部署前置 / 外网可达性。

**必须从输出里确认的三件事**：

1. **OpenResty 网络模式**——脚本会直接判定并给出结论：
   - `[OK] OpenResty 容器 [xxx] 使用 host 网络 → 反代地址可直接写 http://127.0.0.1:3000`
   - 若是 `[NOTE] 网络模式为 [bridge]`，则反代地址须改为宿主机内网 IP（脚本会一并打印 `ip -4 addr` 的结果），且下方所有 `127.0.0.1:3000` 都要替换。
2. **PostgreSQL 的宿主映射端口**——在「容器与网络拓扑」节里看 `1Panel-postgresql-*` 那一行的 `0.0.0.0:xxxxx->5432/tcp`，取左侧端口号。
3. **构建可行性**——「系统与资源」节末尾会给出判定：
   - `[OK] 内存+swap ≥ 3000MB` → 可在服务器上全量构建
   - `[NO] ... 偏低` → 先跑 §3 的初始化脚本补 swap，或改用「CI 构建后上传」（见 61 手册 §7）

---

## 3. 第 2 步：初始化服务器

```bash
sudo bash /tmp/fw-src/deploy/scripts/server-bootstrap.sh
# 可选覆盖：sudo NODE_VERSION=22.22.2 SWAP_SIZE=2G bash ...
# 云厂商已自带 swap 时： sudo SKIP_SWAP=1 bash ...
```

脚本幂等，做四件事：

1. **安装 Node 22 LTS**：从 npmmirror 取官方二进制包直解到 `/usr/local/node-v22.22.2-linux-x64`，再软链到 `/usr/local/bin/{node,npm,npx,corepack}`。不走 NodeSource 仓库（国内 4M 带宽下最稳），也不装 build-essential/python3（Prisma 引擎与 esbuild 均为预编译二进制，本项目无需本地编译）。
2. **启用 pnpm**：`corepack enable --install-directory /usr/local/bin` + `corepack prepare pnpm@11.6.0`，与仓库 `packageManager` 字段锁定版本一致。缓存统一落在 `/usr/local/corepack` 并写入 `/etc/profile.d/node-corepack.sh`。
3. **创建运行用户与目录**：系统用户 `fw`（home=`/opt/fw`），目录骨架 `/opt/fw/{releases,shared/{data,logs}}`。
4. **配置 swap 与内核参数**：默认创建 2G swap 并写入 `/etc/fstab`；`/etc/sysctl.d/99-fw.conf` 设 `vm.swappiness=10`、`vm.overcommit_memory=1`、`net.core.somaxconn=1024`。

> **为什么必须开 swap**：2C2G 上 `pnpm install` + `tsc` 全量构建的峰值内存约 1.2~1.6G，叠加 1Panel/OpenResty/数据库容器的常驻占用必然触顶。有 swap 只是**兜底构建**，日常运行不应依赖它——§8 用 systemd 的 `MemoryMax` 保证应用不会去挤占数据库。

初始化完成后，脚本会打印 Node / pnpm / 内存 / swap / 磁盘 / 用户 / 部署根目录的确认表。

---

## 4. 第 3 步：准备 PostgreSQL 与 schema 切换

### 4.1 建库建用户（1Panel 面板操作）

1. 1Panel → **数据库** → PostgreSQL → **创建数据库**
   - 名称：`fw`
   - 用户名：`fw`
   - 密码：点随机生成后**记录下来**（下面配 `DB_URL` 要用）
   - 权限：该库全部权限
2. 回到数据库列表，点该库的**连接信息**，记下：
   - **宿主端口**（1Panel 安装时设定的端口映射；与 §2 勘察结果应一致）
   - 连接地址在面板里可能显示为内网 IP，**这里一律改用 `127.0.0.1`**

若 1Panel 安装 PostgreSQL 时未放行宿主回环访问（应用连接被拒），需在 1Panel 的 PostgreSQL 配置中确认 `postgresql.conf` 的 `listen_addresses = '*'` 且 `pg_hba.conf` 含 `host all all all md5`。**此项已于 2026-10-14 在真机上确认：默认安装即含 `host all all 127.0.0.1/32 trust`，宿主回环连库无需密码，无需改动**（见 [验证报告](./63-1panel-real-deploy-verification.md) §1.1）。

### 4.2 schema 一致性校验（每次改模型后都该跑）

```bash
cd <仓库目录>/apps/example-api/prisma
# 两份 schema 的模型段必须逐字节一致，md5 应相同
sed -n '/^model /,$p' schema.prisma    | md5sum
sed -n '/^model /,$p' pg/schema.prisma | md5sum
```

当前两份的 md5 均为 `27df38cd744bc20926f3bfcf0097452d`（12 个模型）。若不同，说明有人只改了一份，**必须先对齐再部署**，否则本地与生产结构漂移。

### 4.3 迁移方言校验（不需要连库，可选）

```bash
cd <仓库目录>/apps/example-api
./node_modules/.bin/prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/pg/schema.prisma --script | head -20
```

应看到 `CREATE SCHEMA IF NOT EXISTS "public"`、`TIMESTAMP(3)`、`JSONB`、`BIGINT`。生成的迁移已提交在 `prisma/pg/migrations/20261014000000_init/`：12 张表、29 个索引，零 SQLite 残留。

> 迁移**不需要手工执行**——§5 的发版脚本会在切换软链之前自动跑 `prisma migrate deploy`（幂等）。迁移失败会中止发布且不动线上代码。

---

## 5. 第 4 步：配置环境变量

```bash
sudo cp /tmp/fw-src/deploy/systemd/fw.env.example /opt/fw/shared/.env
sudo chown fw:fw /opt/fw/shared/.env
sudo chmod 600 /opt/fw/shared/.env
sudo vi /opt/fw/shared/.env
```

**格式硬约束**：这是 systemd 的 `EnvironmentFile`，**不是** shell 脚本。不支持 `export`、不支持变量插值、不支持 `${}` 引用；值里出现 `$` 会被 systemd 当变量展开——含特殊字符的密钥请**用单引号包裹整值**。

**本次部署必须改的键**：

```ini
# ---- 数据库：接本机 1Panel 容器 PostgreSQL ----
DB_DRIVER=postgres
DB_URL=postgresql://fw:'<上一步的密码>'@127.0.0.1:<宿主端口>/fw?schema=public&connection_limit=10
# ★ 密码含 @ : / ? # 等字符时必须用单引号包起来，否则连接串会被截断

# ---- 密钥：生产必须换掉样例值 ----
JWT_SECRET='<openssl rand -base64 48 的输出>'

# ---- 生产语义 ----
APP_ENV=prod
LOG_LEVEL=info
AUTH_ALLOW_REGISTER=false          # 关闭自助注册，由后台建号
```

**缓存与队列（可选，2C2G 建议先不开）**：机器上已有 Redis 容器，可以启用：

```ini
CACHE_DRIVER=redis
CACHE_URL=redis://:'<redis密码>'@127.0.0.1:<宿主端口>/0
MQ_DRIVER=bullmq
MQ_URL=redis://:'<redis密码>'@127.0.0.1:<宿主端口>/1
MQ_CRON_ENABLED=true
```

> **建议**：第一次真机跑通时先保持 `CACHE_DRIVER=memory` / `MQ_DRIVER=memory`，把「应用能否起来、反代能否通、HTTPS 能否上」三件事验证掉，再切 Redis。**memory 驱动仅单进程可用**，一旦起 `fw-worker@NN` 就必须切 bullmq，否则多个进程各持一份队列状态。

配置自检：

```bash
sudo -u fw bash -c 'set -a; . /opt/fw/shared/.env; set +a; cd /opt/fw/current/apps/example-api 2>/dev/null && node dist/main.js --help 2>&1 | head -5'
# 更直接的做法：部署后看 journalctl 是否报「缺少配置项」
```

---

## 6. 第 5 步：首次部署

### 6.1 先准备代码来源

发版脚本用常驻 clone + `git archive` 取代码，需要一个 git 地址。两种方式：

```bash
# A) 部署密钥（推荐）：在服务器上生成，公钥加到仓库 Deploy keys（只读即可）
sudo -u fw ssh-keygen -t ed25519 -C "fw@$(hostname)" -f /opt/fw/.ssh/id_ed25519 -N ''
sudo -u fw cat /opt/fw/.ssh/id_ed25519.pub   # 贴到 GitHub → Settings → Deploy keys

# B) HTTPS + 细粒度 PAT（仅 contents:read）
#   地址形如 https://<user>:<PAT>@github.com/<owner>/<repo>.git
```

> 若服务器访问 GitHub 不稳定，可改用 Gitee 镜像或先把仓库打包上传。`probe-env.sh` 第 7 节已探测过可达性。

### 6.2 安装 systemd 单元

```bash
sudo cp /tmp/fw-src/deploy/systemd/fw-api.service /etc/systemd/system/
sudo systemctl daemon-reload
# 先不要 start——此时 /opt/fw/current 尚不存在，start 必然失败
```

### 6.3 执行首次部署

```bash
cd /tmp/fw-src
sudo PRISMA_SCHEMA=prisma/pg/schema.prisma \
     WEB_SYNC_DIR=/opt/1panel/www/sites/<你的域名>/index \
     REPO_URL=<git地址> \
     bash deploy/scripts/bare-metal-deploy.sh
```

> `WEB_SYNC_DIR` 需要目录**已存在**（先在 1Panel 创建静态站点，见 §7.1）。若暂时不需要前端，去掉该变量即可。

脚本按序执行并在每步打印日志：

```
取代码（常驻 clone + git archive 导出被跟踪文件）
  → pnpm install --frozen-lockfile（含 devDeps：构建与迁移需要 tsc / prisma CLI / tsx）
  → prisma generate --schema prisma/pg/schema.prisma
  → 拓扑序构建：pnpm --filter "example-api..." run build
  → 前端构建：pnpm --filter admin-web run build  → rsync 到 WEB_SYNC_DIR
  → ★ 迁移先行：fw db:migrate --schema=prisma/pg/schema.prisma
  → mv -Tf 原子切换 /opt/fw/current 软链
  → systemctl restart fw-api
  → 健康检查轮询 http://127.0.0.1:3000/health（最多 30 次 × 2s）
     ├─ 成功 → 打印 release 名与 commit，清理超过 5 份的历史版本
     └─ 失败 → 自动切回上一 release 并重启，随后报错退出
```

完成后立即自测：

```bash
sudo systemctl status fw-api --no-pager
curl -s http://127.0.0.1:3000/health; echo
journalctl -u fw-api -n 50 --no-pager
```

### 6.4 逐项验收清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 服务在跑 | `systemctl is-active fw-api` | `active` |
| 健康检查 | `curl -s 127.0.0.1:3000/health` | 200 + JSON 状态 |
| 就绪检查 | `curl -s 127.0.0.1:3000/ready` | 200（含依赖项状态） |
| 监听端口 | `ss -ltnp \| grep 3000` | `127.0.0.1:3000`，**不应是 `0.0.0.0`** |
| 数据库连通 | `curl -s 127.0.0.1:3000/ready` 中 db 项 | `up` |
| 迁移已应用 | 在 1Panel 的 PG 里查 `_prisma_migrations` | 1 条 `20261014000000_init`，`finished_at` 非空 |
| 表已建 | `\dt` 或面板里看 | 12 张表 + `_prisma_migrations` |
| 内存占用 | `systemctl show fw-api -p MemoryCurrent` | 常规 150~250MB，远低于 `MemoryMax` |
| 开机自启 | `systemctl is-enabled fw-api` | `enabled`（首次部署后执行 `systemctl enable fw-api`） |

> 若 `ss` 显示监听在 `0.0.0.0:3000`，说明应用配置成了对外监听——应确认 `APP_PORT` 与框架的绑定地址设置，**不要**把 3000 暴露到公网安全组。

---

## 7. 第 6 步：1Panel 站点与 HTTPS

### 7.1 创建站点

**方案 A（推荐，单域名）**：一个域名同时托管前端静态页与反代 API。

1. 1Panel → **网站** → **创建网站** → 类型选 **静态网站**
   - 主域名：`fw.example.com`
   - 其他域名：留空（或填 `www.fw.example.com`）
   - 记住面板自动创建的站点根目录（通常为 `/opt/1panel/www/sites/fw.example.com/index`）——这就是 §6.3 里 `WEB_SYNC_DIR` 要填的值
2. 进入该站点 → **配置文件**，把 `deploy/nginx/fw-1panel-locations.conf` 中 **§A 段**的 `location` 块**粘贴进已有的 `server { }` 内**（不要整份覆盖，1Panel 管着 `server_name`/`listen`/证书指令，覆盖会被面板改回）
3. 到 **网站 → 全局设置 → 配置修改**，把该文件顶部的 http 层级片段加进去（`limit_req_zone`、`client_max_body_size 16m`、反代超时）

**方案 B（双域名）**：`api.example.com` 用「反向代理」网站、代理地址填 `http://127.0.0.1:3000`；`admin.example.com` 用「静态网站」。**代价是跨域**（预检请求、Cookie `SameSite`），除非确有必要，选方案 A。

### 7.2 申请 HTTPS

不要手写 443 `server` 块（会与 1Panel 抢同一个 `server_name`）。

1. 确认域名 **A 记录**已解析到本机公网 IP，云**安全组放行 80 与 443**（Let's Encrypt 的 HTTP-01 校验必须 80 可达）
2. 1Panel → 该站点 → **HTTPS** → 选择 **Acme 账户** → 申请 Let's Encrypt 证书
3. 申请成功后打开 **强制 HTTPS**

### 7.3 前端 API 地址

前端构建时的 `VITE_API_BASE_URL` 决定它请求哪里：

- **方案 A（单域名）**：留空或设为 `/api`（同源，无 CORS）
- **方案 B（双域名）**：必须设为 `https://api.example.com`，且后端要放行该 Origin

> 前端构建发生在发版脚本里（`pnpm --filter admin-web run build`），环境变量在**构建时**注入。要改 API 地址需重跑发版。

---

## 8. 2C2G 资源调优（本手册的关键取舍）

一台 2C2G 上同时常驻 1Panel + OpenResty + MySQL + PostgreSQL + Redis，留给应用的余量很小。仓库已针对该场景做了三处约束：

| 手段 | 位置 | 作用 |
|---|---|---|
| `NODE_OPTIONS=--max-old-space-size=640` | `fw-api.service` | 限制 V8 堆。默认上限按整机内存推导，会试图吃掉全部可用内存 |
| `MemoryHigh=768M` / `MemoryMax=1024M` | `fw-api.service` | **关键**：超限时由 cgroup OOM killer **只杀本进程**，systemd 随即拉起；避免整机 OOM 时内核按 score 误杀 PostgreSQL/MySQL，把数据库一起带走 |
| `MemoryHigh=384M` / `MemoryMax=512M` | `fw-worker@.service` | worker 与 API 同机时总额度控制在 1200M 内 |

**强烈建议的实际取舍**：本次用途是**框架部署验证**，不需要同时挂着 MySQL 和 PostgreSQL 两套库。留一个即可：

```bash
# 在 1Panel 里把用不到的那个数据库「停止」（保留数据，随时可再启）
# 省下约 200~300MB 常驻内存
```

**数据库侧调参**（可选，内存紧张时收益明显）：

- PostgreSQL 容器：`shared_buffers=128MB`、`work_mem=4MB`、`max_connections=50`
- MySQL 容器：`innodb_buffer_pool_size=128M`、`max_connections=50`

**实测数据**：本文的 2C2G 适配参数（内存上限、V8 堆、swap 大小）基于构建峰值 1.2~1.6G 的估算与 framework 既有压测基线（`docs/97-bench-baseline.md`）推导，**真机实测值待补充**（见 §12）。

---

## 9. 发版与回滚

### 9.1 日常发版

```bash
cd /tmp/fw-src && git pull
sudo PRISMA_SCHEMA=prisma/pg/schema.prisma \
     WEB_SYNC_DIR=/opt/1panel/www/sites/<域名>/index \
     bash deploy/scripts/bare-metal-deploy.sh --ref v0.2.1
```

`--ref` 支持分支 / 标签 / 提交。脚本保留最近 5 个 release，切换软链是 `rename(2)` 原子操作，前端产物随 `rsync --delete` 同步。

### 9.2 回滚

```bash
sudo PRISMA_SCHEMA=prisma/pg/schema.prisma bash deploy/scripts/bare-metal-deploy.sh --rollback
```

把 `current` 切回上一个 release 并重启服务，**不动代码也不动迁移**。

> ⚠️ **迁移不会自动回退**。若本次发版包含不向后兼容的迁移，回滚代码后数据库结构仍是新的，需要手工执行 `fw db:rollback`（或用 1Panel 的数据库备份恢复）。这是「迁移先行」策略的固有代价：它保证了迁移失败时线上代码不被污染，但代价是回滚语义只覆盖代码。

---

## 10. 备份

在 1Panel 里配置（无需自己写 cron）：

1. **数据库备份**：1Panel → 数据库 → PostgreSQL → 备份 → 创建计划任务，每天一次，保留 14 天
2. **站点文件备份**：1Panel → 网站 → 备份（覆盖前端产物）
3. **应用配置备份**：`/opt/fw/shared/.env` 不进版本库，**必须单独备份**——丢了就得重新生成 `JWT_SECRET`（会导致所有已签发 token 失效）

```bash
# 手工备份配置（建议配成 1Panel 计划任务里的一条 shell 任务）
sudo tar czf /opt/1panel/backups/fw-env-$(date +%F).tar.gz -C /opt/fw/shared .env
```

---

## 11. 排障速查

| 现象 | 最可能的原因 | 处置 |
|---|---|---|
| 部署脚本报 `prisma migrate deploy` 失败 | `PRISMA_SCHEMA` 没设（用了 sqlite 迁移）或 `DB_URL` 连不上 | 确认 `PRISMA_SCHEMA=prisma/pg/schema.prisma`；`nc -vz 127.0.0.1 <PG端口>` |
| 应用启动报 `datasource provider 不匹配` | `prisma generate` 用的 schema 与 `DB_DRIVER` 不一致 | 重跑发版（脚本会重新 generate）；确认服务器上没混用两套 schema |
| 应用报 `ECONNREFUSED 127.0.0.1:<port>` | PG/Redis 的宿主映射端口填错，或容器没起 | 用 §2 勘察的第 3 节结果核对端口；`docker ps` 看容器状态 |
| 应用报 `Connection refused` 连的是容器名 | 把容器名写进了 `DB_URL` | 改成 `127.0.0.1`（应用在宿主机上） |
| 浏览器 502 | OpenResty 连不到上游 | 确认 OpenResty 是 host 网络；`curl 127.0.0.1:3000/health` 本机是否通；反代地址是否写成了容器内不可达的地址 |
| 浏览器 404 但 API 正常 | 前端产物没同步或 SPA 回退没配 | 检查 `WEB_SYNC_DIR` 是否有 `index.html`；确认 §A 的 `location /` 片段已粘入 |
| 后台刷新页面 404 | 缺 `try_files ... /index.html` | 补上 §A 的 SPA 回退片段 |
| 上传文件 413 | `client_max_body_size` 没加 | 在 http 层加 `client_max_body_size 16m` |
| 服务被反复重启 | 触发了 `MemoryMax` 的 cgroup OOM | `journalctl -u fw-api \| grep -i oom`；按 §8 停掉多余数据库或放宽 `MemoryMax` |
| 构建阶段卡死/被 kill | 服务器内存不足 | `free -h` 确认 swap 已启用；或改 CI 构建后上传 |
| 发版后页面还是旧的 | `index.html` 被缓存 | 确认 §A 的 `no-cache` 头生效；强制刷新 |
| HTTPS 申请失败 | 80 端口不通或域名未解析 | 检查安全组与 A 记录；`curl -I http://<域名>/.well-known/acme-challenge/test` |

**结构化日志检索**（应用输出为 JSON，含 `traceId` / `spanId` / `module`）：

```bash
# 某个 traceId 的全链路
journalctl -u fw-api -o cat --since '10 min ago' | jq -c 'select(.traceId=="<traceId>")'
# 只看错误
journalctl -u fw-api -o cat --since today | jq -c 'select(.level=="error")'
```

---

## 12. 未验证项与已知限制

> **2026-10-14 更新**：本手册已在腾讯云 2C2G4M（Ubuntu 22.04 + 1Panel + PostgreSQL 18.6 + Redis 8.10）上**完整跑通**，原列 7 项已结清 6 项，并额外修掉 5 个只有真机才会暴露的缺陷。逐条实测数据见 [1Panel 真机部署验证报告](./63-1panel-real-deploy-verification.md)。下表保留原格式，新增「实测结论」列。

| # | 未验证项 | 风险 | 实测结论 |
|---|---|---|---|
| 1 | 1Panel 的 OpenResty 实际网络模式 | 若非 host 网络，所有 `127.0.0.1:3000` 需改为宿主机内网 IP | ✅ **实测为 `host`**，`127.0.0.1:3000` 直接可用 |
| 2 | 1Panel 站点目录的真实路径 | `WEB_SYNC_DIR` 填错会导致前端 404 | ✅ 前端根 `/opt/1panel/www/<目录>`（容器内 `/www/<目录>`）；站点配置 `/opt/1panel/www/conf.d/` |
| 3 | PG 容器是否接受宿主回环连接 | `pg_hba.conf` 未放行则应用连不上 | ✅ `host all all 127.0.0.1/32 trust`，**无需改配置** |
| 4 | 2C2G 上的构建峰值与总耗时 | 可能仍需 swap 且耗时较长 | ✅ `pnpm install` 415 包 / 1m12s，swap 峰值 197 MB；加 2G swap 后构建全程无 OOM |
| 5 | 1Panel 是否有站点级配置覆写行为 | 面板升级/重存配置可能覆盖手工粘贴的 location | ⚠️ **仍未验证**（本次为手工写 `conf.d`，未经面板 UI 重存） |
| 6 | Node 二进制在目标发行版上的兼容性 | glibc 版本过低可能无法启动 | ✅ v22.22.2 正常启动运行 |
| 7 | 应用实际内存占用与 `MemoryMax=1024M` 的匹配度 | 若业务量上涨可能触顶被杀 | ✅ RSS≈130 MB / cgroup 72 MB，余量充足（业务量上涨仍需观测） |

**手册未覆盖、真机踩到的三处环境适配**（详见验证报告 §3.6）：

- **1Panel 的 Redis 设了 `requirepass`**：连接串必须带密码（`redis://:<密码>@127.0.0.1:6379/<db>`，密码在 `/opt/1panel/apps/redis/redis/.env`），否则 `NOAUTH` → 缓存降级、`/ready` 503。
- **`.env` 以 `fw` 身份读取会被拒**：systemd 以 root 读 `EnvironmentFile`，`600 root:root` 是正确姿势；只有手工以 `fw` 跑迁移/种子时才需临时 `640 root:fw`。
- **`docker exec -i` 会吞掉远程脚本的 stdin**：以 `ssh ... 'bash -s' < script` 执行时，脚本内 `docker exec -i` 会读走后续脚本文本导致静默截断；一律加 `</dev/null`。

**仍然未验证**：HTTPS 证书签发（需已解析的域名）、`fw-worker@.service` 跨进程 worker（本次为单进程 in-process 模式）、Redis Cluster、1Panel 面板 UI 建档流程（本站点为手工写配置）、`bare-metal-deploy.sh` 的端到端自动执行（该机 `github.com` 不可达）。

另外两条**已知的仓库级遗留**（与本次部署无关，但会影响判断）：

- **`LOG_FORMAT` 是「文档声明但未实现」的配置键**：`deploy/docker-compose.prod.yml`、Helm values 与本仓库 env 样例中都出现它，但 `@fw/config` 的 schema 未声明、logger 也未读取——设置它不会报错，也不会改变输出格式（输出固定为结构化 JSON）。已登记在 [文档一致性核对报告](./95-doc-audit.md) L-05。
- **Redis Cluster 未实测**：`CACHE_DRIVER=redis-cluster` 的路径仅有单测覆盖，没有真实集群验证（M8 遗留）。

---

## 13. 与其它部署档位的关系

| 档位 | 入口文档 | 适用 |
|---|---|---|
| 单机 Docker | `deploy/docker-compose.prod.yml` + [部署与运维手册](./60-deployment-ops.md) | 有 Docker、想一键起全套 |
| **1Panel 真机（本文）** | `docs/62-1panel-real-deploy.md` | **已有 1Panel 面板、复用面板托管的数据库与反代** |
| 裸机（宿主 nginx） | `docs/61-bare-metal-deploy.md` | 无面板、自己装 nginx 的纯净服务器 |
| K8s / Helm | `deploy/helm/fw-app` | 集群环境 |

三个裸机档位**共享同一套 systemd 单元与发版脚本**，差异只有反向代理与静态托管方式：

| 差异点 | 61（宿主 nginx） | 本文（1Panel OpenResty） |
|---|---|---|
| 反代上游 | `127.0.0.1:3000` | `127.0.0.1:3000`（靠 host 网络，成因不同） |
| 前端 root | `/opt/fw/current/apps/admin-web/dist`（随软链原子切换） | `/www/sites/<域名>/index`（需 `WEB_SYNC_DIR` 同步，**不与 release 原子切换**） |
| 证书 | certbot | 1Panel Acme |
| nginx 读 release 权限 | 需把 `www-data` 加入 `fw` 组 | 不需要（容器读站点目录） |

> ⚠️ 上表第 2 行是 1Panel 方案的一个**真实代价**：前端产物与后端 release 不再原子同步。回滚后如果需要一并回滚前端，必须重新发版一次（`--rollback` 只切后端软链，不会回滚已 rsync 的前端）。若要消除该代价，可给 OpenResty 容器加挂载 `/opt/fw:/opt/fw:ro`，但会引入「面板重装容器时挂载丢失」的新风险。
