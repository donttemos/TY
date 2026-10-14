# 通用应用框架 · 云服务器裸机部署手册

> 面向「不用容器」的云服务器（ECS/CVM/Lighthouse 等单机或少量实例）部署：Node 进程由 **systemd** 守护，
> nginx 负责静态托管与反向代理，数据库按档位选 **SQLite 单机** 或 **云 RDS**。
> 与本文档并列的其它档位见 [部署与运维手册](./60-deployment-ops.md)：§4 单机 Docker、§5 docker-compose、§6 Helm/K8s。
>
> 适用仓库版本：v0.2.0（Node ≥ 20.19，pnpm 11.6.0，NestJS 11 + Prisma 6）。

---

## 1. 为什么可以不用容器

框架的运行时形态本就适合裸机：应用打包为普通 `dist/`（ESM，`node dist/main.js` 即可运行）、
配置全部经环境变量注入、健康与优雅停机由框架自身实现（`/health`、`/ready`、SIGTERM 排空在途请求）。
容器在这里提供的是「依赖隔离 + 一致运行环境」，而这两点用 **systemd 单元 + 固定 Node 版本 + release 目录** 同样能拿到，
且少了一层网络与文件系统抽象，排障时 `journalctl -u fw-api` 就能看到全部日志。

代价是：你需要自己管 Node 版本、进程守护、发版与回滚、静态资源目录权限——本手册把这四件事都固定成了可复制的步骤。

---

## 2. 目标架构

```
云服务器（Ubuntu 22.04 / Debian 12 为例）
│
├─ nginx                      :80/:443  静态托管 admin-web 产物 + /api 反代到 127.0.0.1:3000
│                                        ⤷ 配置见 deploy/nginx/fw-host.conf
├─ systemd
│   ├─ fw-api.service         :3000     node dist/main.js（HTTP 主进程）
│   └─ fw-worker@01.service   :3001     node dist/main.js（TRANSPORT_ROLE=handler，队列消费者）
│
├─ /opt/fw/
│   ├─ releases/20261014130500-a4e2e60/  每次发版一份完整产物（含 node_modules 与 dist）
│   ├─ current -> releases/<最新>         软链，systemd 的 WorkingDirectory 与 nginx 的 root 都指向它
│   └─ shared/
│       ├─ .env                          全部配置（600，属主 fw，不进版本库）
│       ├─ data/                         SQLite 数据库与上传文件（systemd ReadWritePaths 唯一可写目录）
│       ├─ repo/                         常驻 git 克隆，供发版脚本取代码
│       └─ deploy.log                    发版脚本日志（与应用日志分开，便于追溯「谁在何时发的哪一版」）
│
└─ 外部依赖（可选，按档位）
    ├─ 云 RDS PostgreSQL/MySQL            生产推荐：多实例共享 + 自动备份
    └─ 云 Redis                           多实例缓存 / bullmq 队列 / 分布式锁
```

**单实例起步**：只跑 `fw-api` + SQLite + `CACHE_DRIVER=memory`，零外部依赖即可上线。
**需要水平扩容或定时任务单点执行时**：数据库换云 RDS、缓存与队列换 Redis、再起多个 `fw-api`/`fw-worker`。

---

## 3. 云服务器准备

| 项 | 建议 |
|---|---|
| 规格 | 起步 2C2G（构建时峰值内存主要来自 `tsc` 与 vite；1C2G 建议加 2G swap 或改为「本地/CI 构建后上传」） |
| 系统 | Ubuntu 22.04/24.04、Debian 12（本文命令以 apt 为例） |
| 磁盘 | 系统盘 ≥ 40G（每份 release 含 node_modules，约 400–700M，脚本默认保留 5 份） |
| 安全组/防火墙 | **只放行 22、80、443**；3000/3001 等应用端口一律不对公网开放（见 §15） |
| swap | 2G（`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`） |
| 时区 | `timedatectl set-timezone Asia/Shanghai`（日志与迁移时间戳可读） |

---

## 4. 安装运行时与依赖

```bash
# 1) Node 22 LTS（NodeSource 仓库；用系统包管理器便于 systemd 直接调用 /usr/bin/node）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git curl nginx ca-certificates

# 2) pnpm：仓库通过 packageManager 字段锁定版本，corepack 直接激活（勿用 npm i -g pnpm 绕过版本锁定）
sudo corepack enable
sudo corepack prepare pnpm@11.6.0 --activate

# 3) 校验
node -v      # 期望 v22.x
pnpm -v      # 期望 11.6.0
```

> **务必用 `/usr/bin/node`**：systemd 单元的 `ExecStart` 写的是绝对路径。若用 nvm 装在用户目录下，
> 需要把 `ExecStart` 改成实际路径（如 `/home/fw/.nvm/versions/node/v22.x/bin/node`），
> 否则 systemd 会因为找不到可执行文件而反复重启（`status=203/EXEC`）。

**安装 nginx**（已含在上面的 apt 中；确认版本与发行版仓库一致即可，无需额外源）：

```bash
nginx -v
sudo systemctl enable --now nginx
```

---

## 5. 创建运行用户与目录

```bash
# 专用非 root 用户：systemd 单元以它运行，缩小被攻破后的影响面
sudo useradd --system --create-home --shell /usr/sbin/nologin fw

# 目录布局（与 §2 一致）
sudo mkdir -p /opt/fw/{releases,shared/data}
sudo chown -R fw:fw /opt/fw
sudo chmod 750 /opt/fw /opt/fw/shared

# nginx 需要读取 release 内的前端产物：把 www-data 加入 fw 组（推荐，比放开 o+r 更收敛）
sudo usermod -aG fw www-data
# 组成员变更后必须重启 nginx（不是 reload）才生效
sudo systemctl restart nginx
```

---

## 6. 配置环境变量

```bash
sudo cp /opt/fw/current/deploy/systemd/fw.env.example /opt/fw/shared/.env   # 首次可从仓库目录复制
sudo chown fw:fw /opt/fw/shared/.env && sudo chmod 600 /opt/fw/shared/.env
sudo -u fw vi /opt/fw/shared/.env
```

**先改这几项**（其余按档位默认即可）：

```ini
APP_ENV=prod
JWT_SECRET=<openssl rand -base64 48 的输出>
AUTH_ALLOW_REGISTER=false
TENANT_DB_KEY=<openssl rand -hex 32 的输出>      # 多租户启用时必填
```

### 6.1 关于 `EnvironmentFile` 的两个坑

1. **语法比 `.env` 更严格**：不支持 `export` 前缀、不支持变量插值，值里出现 `$` 会被 systemd 当变量展开。
   含特殊字符的密钥请用单引号包裹整值。
2. **它只是注入进程环境变量**，与仓库里 `@fw/config` 读取的 `cwd/.env` 是两条独立通路。
   本方案只用前者（配置集中一处、权限 600、不落进 release），因此 `apps/example-api/.env` 不存在也不会报错。

### 6.2 ★ 数据库 provider 约束（最容易踩的一步）

Prisma 的 provider 在 **生成 client 时**确定，且 `migrations/*.sql` 是 **按方言生成** 的。
仓库当前 `apps/example-api/prisma/schema.prisma` 是 `provider = "sqlite"`，
其迁移 DDL 也是 SQLite 方言（`DATETIME` 等）——**不能直接应用到 PostgreSQL/MySQL**。因此二选一：

- **A) 起步档：保持 SQLite**（`DB_DRIVER=sqlite`、`DB_URL=file:/opt/fw/shared/data/app.db`）。
  单实例可用，零外部依赖，开箱即与现有 schema/迁移一致。
- **B) 生产档：改用云 RDS**。切换步骤（业务代码零改动，仅配置与迁移）：
  1. 把 schema 的 `datasource.provider` 改为 `postgresql`（或 `mysql`）、`url` 保持 `env("DB_URL")`；
  2. **重建迁移**：Prisma 无跨方言转换，需按目标方言重新生成建表 SQL——
     做法见 [PRD-002](./prd/prd-002-database-abstraction.md) §7「切换演练」与 ADR-0002；
     可直接复用 `packages/db/scripts/matrix-db-setup.mjs` 的 `migrate diff --from-empty --to-schema-datamodel --script` 手法；
  3. 重新 `prisma generate`（**本机与服务器都要**，否则运行期报 datasource provider 不匹配）；
  4. 再执行迁移：`fw db:migrate`。
  5. 切换后建议同时把 `CACHE_DRIVER`/`MQ_DRIVER` 换成 `redis`（多实例下 memory 驱动无法跨进程共享状态）。

---

## 7. 在哪里构建：三种方式

| 方式 | 命令 | 适用 / 注意 |
|---|---|---|
| **服务器上构建**（默认，脚本已内置） | `sudo ./deploy/scripts/bare-metal-deploy.sh` | 最简、无额外工具；需 ≥2G 内存（或 swap） |
| **CI（GitHub Actions）构建后上传** | `rsync -az --delete release/ fw@host:/opt/fw/releases/<名字>/` | 生产推荐：服务器只跑不构建，发版更快 |
| **本地 Windows 构建后上传** | ✗ **不可用** | Prisma 的 query engine 是**平台相关二进制**（`query_engine-windows.dll.node` vs `libquery_engine-*.so.node`），
Windows 产物在 Linux 上无法运行；前端静态产物跨平台可用，但后端不行 |

**结论**：Linux 后端产物必须在 **Linux 上构建**——要么在云服务器上构建（脚本默认），要么在 CI 的 ubuntu runner 上构建后上传。
上一轮 CI 排障中，`prisma generate` 与 `.env` 的时序问题都发生在这一步，务必让 `prisma generate` 与运行环境保持一致。

---

## 8. 首次部署

```bash
# 从仓库目录执行（脚本自身也随代码进 release，首次可先用 git clone 拿到仓库）
sudo mkdir -p /opt/fw && sudo chown fw:fw /opt/fw   # 若 §5 已做则跳过

# 方式一：脚本自动完成「克隆 → 装依赖 → generate → 构建 → 迁移 → 切链 → 重启 → 健康检查」
sudo REPO_URL=git@github.com:donttemos/TY.git \
     SERVICE_WORKER=fw-worker@01 \
     /opt/fw/shared/repo/deploy/scripts/bare-metal-deploy.sh
```

私有仓库取码两种方式（脚本用 `git clone`，因此二选一即可）：

```bash
# A) 部署密钥（推荐）：在服务器上生成，公钥加到 GitHub 仓库 Deploy keys（只读即可）
sudo -u fw ssh-keygen -t ed25519 -N '' -f /home/fw/.ssh/id_ed25519
sudo -u fw cat /home/fw/.ssh/id_ed25519.pub      # 复制到仓库 Settings → Deploy keys
sudo -u fw ssh -T git@github.com                 # 验证

# B) HTTPS + PAT（细粒度令牌，仅 contents:read）
REPO_URL=https://<用户名>:<PAT>@github.com/donttemos/TY.git
# 注意：令牌会出现在 /proc/<pid>/cmdline 与 git 的 config 中——用完后清理：
#   sudo -u fw git -C /opt/fw/shared/repo remote set-url origin git@github.com:donttemos/TY.git
```

脚本等价的手工步骤（便于理解与排障）：

```bash
cd /opt/fw/releases/<新建目录>
pnpm install --frozen-lockfile
cd apps/example-api && pnpm exec prisma generate --schema prisma/schema.prisma
cd /opt/fw/releases/<新建目录> && pnpm --filter "example-api..." run build
pnpm --filter admin-web run build
cd apps/example-api && pnpm run db:migrate          # = fw db:migrate（幂等）
cd /opt/fw && ln -sfn releases/<新建目录> current.tmp && mv -Tf current.tmp current
sudo systemctl restart fw-api
curl -fsS http://127.0.0.1:3000/health
```

> `pnpm --filter "example-api..."` 会自动带上全部 workspace 依赖并按拓扑序构建（`@fw/config → core → db …`），
> 新增包无需维护手写列表——这正是 CI 里踩过「漏包」后采用的写法。

**首次还需要**：数据初始化（可选，示例数据）

```bash
cd /opt/fw/current/apps/example-api && pnpm run db:seed
```

（`db:seed` 走 `tsx`，属 devDependencies；若服务器只装生产依赖需另行处理，见 §16 排障。）

---

## 9. systemd 托管

```bash
sudo cp /opt/fw/current/deploy/systemd/fw-api.service /etc/systemd/system/
sudo cp /opt/fw/current/deploy/systemd/fw-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fw-api
# worker 按需启用（实例名必须两位数字，它同时是端口尾号：@01 → 3001）
sudo systemctl enable --now fw-worker@01
```

常用运维命令：

```bash
systemctl status fw-api              # 运行状态与最近日志
journalctl -u fw-api -f              # 实时日志
journalctl -u fw-api -n 200 --no-pager
journalctl -u fw-api --since '10 min ago' -p err    # 只看错误
systemctl restart fw-api
systemctl stop fw-api                # 触发 SIGTERM → 优雅停机（等在途请求）
systemctl list-units 'fw-*'          # 所有框架服务
```

单元内置的运维语义（见单元文件注释）：

- `Restart=always` + `RestartSec=3`：进程崩溃 3 秒后自愈；
- `KillSignal=SIGTERM` + `TimeoutStopSec=30`：与应用 `SHUTDOWN_TIMEOUT`（默认 10s）对接，先排空在途请求再退出；
- `SuccessExitStatus=0 143`：SIGTERM 退出（143 = 128+15）视为计划内停机，不写进失败计数；
- `ProtectSystem=strict` + `ReadWritePaths=/opt/fw/shared/data`：整个文件系统只读，**唯一可写目录**就是数据目录
  —— 这是刻意设计，避免应用意外改写自身代码；若你新增了写文件逻辑（如本地上传），必须同步加进 `ReadWritePaths`。

---

## 10. nginx 与 HTTPS

```bash
sudo cp /opt/fw/current/deploy/nginx/fw-host.conf /etc/nginx/conf.d/fw.conf
sudo nginx -t && sudo systemctl reload nginx
curl -I http://127.0.0.1/                       # 期望 200（返回 index.html）
curl -s http://127.0.0.1/api/v1/demo/ok         # 期望 {"hello":"fw","framework":"v0.2.0"}
```

配置要点（`deploy/nginx/fw-host.conf` 已内置）：`/api` 反代到 `127.0.0.1:3000`、SPA history 回退、
`/assets/` 长缓存 + `index.html` 不缓存（保证发版即时生效）、登录接口独立限流、`traceparent` 透传、
`/health`、`/ready`、`/metrics` 限内网白名单。

**静态目录权限**：nginx 运行用户（`www-data`）必须能穿越 `/opt/fw/current/...`。
§5 已把 `www-data` 加入 `fw` 组；若你改了目录权限策略，确认下面能通过：

```bash
sudo -u www-data test -r /opt/fw/current/apps/admin-web/dist/index.html && echo "nginx 可读"
```

**HTTPS（推荐 certbot）**：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d admin.example.com -d api.example.com   # 自动改写 443 站点并注入证书
sudo certbot renew --dry-run                                   # 验证自动续期
```

---

## 11. 发布与回滚

**发版**（脚本会：取代码 → 装依赖 → generate → 构建 → 迁移 → 原子切链 → 重启 → 健康检查 → 失败自动回滚）：

```bash
sudo SERVICE_WORKER=fw-worker@01 /opt/fw/shared/repo/deploy/scripts/bare-metal-deploy.sh
sudo ... --ref v0.2.0          # 发指定标签/提交
sudo ... --skip-migrate        # 结构未变时跳过迁移
```

**回滚**（只切软链 + 重启，不动代码与数据库）：

```bash
sudo /opt/fw/shared/repo/deploy/scripts/bare-metal-deploy.sh --rollback
```

> ⚠️ **迁移不会随软链回滚自动撤销**。若本次迁移不向后兼容（删列/改类型），回滚后旧代码可能读不到数据。
> 因此约定：**发版前先确认迁移可向后兼容**；不兼容的迁移需配套 `fw db:rollback` 手工执行 + 数据备份。
> 每次发布前建议先备份（§12）。

**为什么用「release 目录 + 软链」**：切换是 `mv -Tf` 的原子 rename，不会出现「文件正在被覆盖时进程读到半个包」；
回滚是秒级的软链切换；历史版本目录天然成为可审计的发布记录。

---

## 12. 备份与恢复

| 数据 | 方式 |
|---|---|
| **SQLite**（起步档） | `sqlite3 /opt/fw/shared/data/app.db ".backup '/opt/fw/shared/backups/app-$(date +%F).db'"`（热备，勿直接 cp 正在写的库），或发版前停服 `cp` |
| **云 RDS**（生产档） | 用云厂商自动备份 + 每日 `pg_dump`/`mysqldump` 落到对象存储 |
| **上传文件** | 目录 `/opt/fw/shared/data`（建议改为对象存储，避免与数据目录耦合） |
| **配置** | `/opt/fw/shared/.env`（含密钥，单独加密备份，不要进 git） |

```bash
# 定时备份（示例：每天 03:10 备份 SQLite 并保留 14 天）
sudo -u fw crontab -e
10 3 * * * sqlite3 /opt/fw/shared/data/app.db ".backup '/opt/fw/shared/backups/app-$(date +\%F).db'" && find /opt/fw/shared/backups -name 'app-*.db' -mtime +14 -delete
```

**恢复**：停服 → 用备份文件覆盖 `app.db`（或 RDS 侧恢复）→ 起服 → `curl -fsS /health` 与关键接口验证。

---

## 13. 监控与告警

| 层 | 手段 |
|---|---|
| 存活 | systemd 自带 `Restart=always`；`systemctl is-active fw-api` |
| 应用健康 | `curl -fsS http://127.0.0.1:3000/health`（进程存活 + 配置可用）、`/ready`（依赖就绪：DB/缓存探针） |
| 指标 | `/metrics`（含队列等框架指标）；生产建议接 Prometheus + node_exporter，或先用云监控的自定义脚本探测 |
| 日志 | `journalctl -u fw-api`（应用输出结构化 JSON，含 `traceId` 可直接检索） |
| 链路追踪 | `OTEL_ENABLED=true` + `OTEL_EXPORTER_URL` 指向 OTLP 采集端（如自建 otel-collector 或云厂商 APM 的 OTLP 入口） |
| 磁盘 | release 保留 5 份 + 日志由 journald 自己轮转（`journalctl --disk-usage`），建议对 `/` 设 80% 告警 |

```bash
# 按 traceId 检索一次请求的全链路日志（JSON 日志配合 jq）
journalctl -u fw-api -o cat --since '10 min ago' | jq -c 'select(.ctx.traceId=="<traceId>")'
```

---

## 14. 升级 Node / pnpm / nginx

- **Node**：`apt upgrade nodejs` 后 `systemctl restart fw-api`（务必先在 release 目录用新 Node 跑一次构建，避免 ABI 不匹配）。
- **pnpm**：仓库由 `packageManager` 字段锁版本，`corepack prepare pnpm@<新版本> --activate` 升，并同步改 `package.json`。
- **nginx**：`apt upgrade nginx` 前先 `nginx -t` 校验配置；reload 不会中断连接。
- **框架版本**：正常走 §11 发版流程；标签与 release 目录名中的 commit 短哈希即可对照 CHANGELOG。

---

## 15. 安全加固清单

- [ ] 安全组/防火墙只放行 **22/80/443**；应用端口 3000/3001 仅监听本机可达（`ss -lntp | grep 3000` 复核，公网 `curl` 应超时/拒绝）。
- [ ] SSH 仅密钥登录（`PasswordAuthentication no`）、禁用 root 直登、可选改端口。
- [ ] `/opt/fw/shared/.env` 权限 600、属主 `fw`；密钥不进镜像、不进 git、不写在单元文件里。
- [ ] 应用以非 root 用户 `fw` 运行；systemd 已内置 `NoNewPrivileges`、`ProtectSystem=strict` 等加固项。
- [ ] `AUTH_ALLOW_REGISTER=false`；`JWT_SECRET`/`TENANT_DB_KEY` 用随机强串并定期轮换（用 `*_PREV` 过渡）。
- [ ] nginx 已放安全响应头；上线 HTTPS 并开启 HSTS（certbot 后可加 `add_header Strict-Transport-Security ...`）。
- [ ] 开启 `unattended-upgrades` 自动打安全补丁（`sudo apt install unattended-upgrades`）。
- [ ] 定期 `pnpm audit`（仓库 CI 已含依赖审计门禁）与云厂商漏洞扫描。

---

## 16. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `status=203/EXEC`，服务起不来 | `ExecStart` 的 node 路径不对（如用 nvm 装在家目录） | `which node` 后改单元里 `ExecStart` 为绝对路径，`daemon-reload` + `restart` |
| 启动即退出且无日志 | 配置校验失败（缺必填项） | 手动前台跑一次看输出：`cd /opt/fw/current/apps/example-api && sudo -u fw node dist/main.js` |
| 日志 `Environment variable not found: DB_URL` | `EnvironmentFile` 没生效或键名拼错；或 `prisma generate` 时未带 env | 检查单元 `EnvironmentFile=` 指向；重新 `prisma generate`（§8） |
| 日志 `datasource provider 不匹配` | schema 是 sqlite 但 `DB_DRIVER` 指向 PG/MySQL，或换库后没重新 generate | 按 §6.2 切换 provider 与迁移并重新 generate |
| 迁移报语法错（如 `DATETIME` 非法） | 把 SQLite 方言迁移应用到了 PG/MySQL | 按 §6.2 步骤 2 重建方言迁移 |
| nginx 403 / 404 静态资源 | `www-data` 读不到 release 目录 | `sudo -u www-data test -r <index.html>`；按 §5 加组并 `systemctl restart nginx` |
| 发版后页面仍旧版 | 浏览器缓存了 `index.html` | 确认配置里 `location /` 带 `Cache-Control: no-cache`；清缓存复核 |
| 服务被 systemd 强杀（`SIGKILL`） | `TimeoutStopSec` 小于应用排空耗时 | 提高 `TimeoutStopSec`（worker 需 > `MQ_SHUTDOWN_TIMEOUT`，默认 30s） |
| `db:seed` 报缺 `tsx` | 只装了生产依赖（`--prod`），而 seed 走 devDependency | 在该 release 内 `pnpm install --frozen-lockfile`（全量）或单独装 `tsx` |
| `OTEL_ENABLED=true` 启动失败 | 未安装 optional peer 的两个 OTel 包 | `pnpm add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http`（或把它们移入应用 `dependencies`） |
| 内存不足 / 构建被 OOM Killer 杀掉 | 1C2G 跑 `tsc` + vite | 加 swap，或改为 CI 构建后上传（§7） |

---

## 17. 与其它档位的关系

| 档位 | 入口 | 何时选 |
|---|---|---|
| 单机 Docker | [60](./60-deployment-ops.md) §4 | 想用镜像固化环境、机器只跑一个应用 |
| docker-compose | [60](./60-deployment-ops.md) §5 + `deploy/docker-compose.prod.yml` | 单机多组件（app + worker + PG + Redis + nginx） |
| **裸机 + systemd（本文档）** | `deploy/systemd/` + `deploy/scripts/bare-metal-deploy.sh` + `deploy/nginx/fw-host.conf` | 云服务器单机/少量实例，希望日志与排障路径最短 |
| Helm / K8s | [60](./60-deployment-ops.md) §6 + `deploy/helm/fw-app/` | 多节点、需要滚动发布与弹性伸缩 |

> 注意：`deploy/docker-compose.prod.yml` 中示例库配置为 `DB_DRIVER=postgres`，而仓库示例应用的 schema 与迁移是
> **SQLite 方言**。直接照该编排部署会因 provider 与迁移方言不一致而失败——请按 §6.2 完成切换，或改用本文档的 SQLite 起步档。
