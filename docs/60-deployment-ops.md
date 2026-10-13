# 通用应用框架 · 部署与运维手册

> 版本 v0.1 ｜ 状态：草案 ｜ 关联：[架构设计](./20-architecture.md) 第 6 节 ｜ [验收标准](./10-acceptance-criteria.md) ｜ 更新：2026-10-09
>
> 适用：基于本框架构建的所有项目。档位选择决定操作复杂度——**小档不要求运维懂 K8s，大档不要求开发改代码**。

## 1. 环境要求

| 组件 | 小档 | 中档 | 大档 |
|---|---|---|---|
| 应用运行时 | Node 20 / 22（NestJS 11 要求 ≥ 20） | 同左 | 同左（容器镜像） |
| 包管理 | pnpm 9+ | 同左 | CI 内构建，运行时不需 |
| 数据库 | SQLite 或 MySQL 8 单实例 | MySQL 8 / PostgreSQL 15（主从） | 主从 + 读写分离 |
| 缓存 | 进程内 memory | Redis 7（哨兵可选） | Redis Cluster |
| 队列 | 进程内 | BullMQ + Redis | Kafka（M8） |
| 编排 | Docker | docker-compose | Helm / K8s |
| 建议资源 | 1C2G × 1 | 2C4G × 2–3 | 按 HPA 弹性 |

## 2. 档位选择

| 判断项 | 小 | 中 | 大 |
|---|---|---|---|
| 日活 | < 1k | 1k–10w | > 10w |
| 可用性要求 | 可接受分钟级中断 | 99.9% | 99.95%+ |
| 实例数 | 1 | 2–3（无状态） | 弹性 |
| 是否多租户 | 否 | 可选 | 是 |
| 运维人力 | 无专职 | 兼职 | 专职 |

原则：**先小档起步**；出现下列信号再升档——单机 CPU 长期 > 60%、需要零停机发布、出现多租户或强合规要求、团队边界清晰需拆服务。

## 3. 配置清单

> 完整 `.env` 由模板提供（`.env.example`），以下为关键项；**缺失必填项时服务启动即失败并打印项名**。

| 分类 | 键 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| 应用 | `APP_ENV` | 是 | — | `dev` / `test` / `prod` |
| | `APP_PORT` | 否 | 3000 | 监听端口 |
| 数据库 | `DB_DRIVER` | 是 | — | `mysql` / `postgres` / `sqlite` |
| | `DB_URL` | 是 | — | 连接串；`sqlite` 时为文件路径 |
| | `DB_POOL_MAX` | 否 | 10 | 连接池上限 |
| | `DB_SLOW_MS` | 否 | 500 | 慢查询阈值 |
| 缓存 | `CACHE_DRIVER` | 是 | — | `memory` / `redis` / `redis-cluster` |
| | `CACHE_URL` | 条件 | — | redis / redis-cluster 驱动必填；cluster 为逗号分隔节点列表 |
| | `CACHE_PREFIX` | 否 | `fw:<APP_ENV>` | key 全局前缀，避免多应用/多环境串数据 |
| | `CACHE_TTL` | 否 | 300 | 默认 TTL（秒） |
| | `CACHE_MAX_ITEMS` | 否 | 10000 | memory 驱动 LRU 容量上限 |
| | `CACHE_FAIL_OPEN` | 否 | true | 依赖故障降级直查；false 时抛 9002 |
| | `CACHE_NULL_TTL` | 否 | 60 | 空值占位 TTL（秒），防穿透 |
| | `CACHE_TTL_JITTER` | 否 | 0.1 | TTL 随机抖动比例，防雪崩 |
| | `CACHE_LOCK_TTL` | 否 | 30 | 分布式锁默认 TTL（秒） |
| | `CACHE_TAG_TTL` | 否 | 86400 | 标签映射 TTL（秒），防「幽灵缓存」 |
| | `CACHE_SLOW_MS` | 否 | 50 | 慢缓存操作告警阈值（毫秒） |
| | `CACHE_MAX_VALUE_BYTES` | 否 | 1048576 | 单 key 值字节上限（大 key 防护） |
| 鉴权 | `AUTH_STRATEGY` | 是 | jwt | `jwt`/`session`/`oauth2`/`apikey` |
| | `AUTH_ACCESS_TTL` | 否 | 2h | access 有效期 |
| | `AUTH_REFRESH_TTL` | 否 | 7d | refresh 有效期 |
| | `JWT_SECRET` | **是** | — | 当前签名密钥，**无默认值**（缺失则启动失败）；≥32 位强随机 |
| | `JWT_SECRET_PREV` | 否 | — | 轮换过渡期旧密钥，须与 `JWT_SECRET` 不同 |
| | `AUTH_MAX_FAILED` | 否 | 5 | 连续失败锁定阈值 |
| | `AUTH_LOCK_MINUTES` | 否 | 15 | 锁定时长 |
| | `AUTH_REFRESH_GRACE_SECONDS` | 否 | 10 | refresh 并发宽限窗口（秒）；超出即判泄漏并撤销整族 |
| | `AUTH_PASSWORD_POLICY` | 否 | medium | 密码强度策略：`low` / `medium` / `high` |
| | `AUTH_ALLOW_REGISTER` | 否 | false | 是否开放自助注册（默认关闭，「默认安全」） |
| | `AUTH_API_KEYS` | 否 | 空 | 开放接口 API Key，格式 `<key>:<主体名>:<权限码,权限码>`；多条用 `|` 分隔。**权限码本身含冒号，按前两段切分** |
| 队列 | `MQ_DRIVER` | 是 | memory | `memory` / `bullmq`（`kafka` 为 M8 预留位） |
| | `MQ_CONCURRENCY` | 否 | 10 | 消费并发 |
| | `MQ_MAX_ATTEMPTS` | 否 | 3 | 最大重试次数（退避 1s/5s/30s） |
| | `MQ_CRON_ENABLED` | 否 | true | 是否启用定时调度 |
| 日志 | `LOG_LEVEL` | 否 | info | 级别 |
| | `LOG_FORMAT` | 否 | json | 容器环境固定 json |
| 追踪 | `OTEL_ENABLED` | 否 | false | M8 起支持 |
| | `OTEL_EXPORTER_URL` | 条件 | — | 启用后必填 |
| 前端（admin-web） | `VITE_API_BASE_URL` | 是 | — | 管理后台 API 基址（如 `https://api.example.com/api/v1`）；**构建期注入**，改值需重新构建 |
| | `VITE_APP_TITLE` | 否 | 通用应用框架 | 站点标题 |
| | `VITE_LOGIN_CAPTCHA` | 否 | false | 登录页验证码开关（true 时需接入验证码服务） |
| | `VITE_USE_MOCK` | 否 | 随 mode | 是否挂载 mock server（`true`/`false`）；**生产构建不引入任何 mock 代码**，切真实后端只改此项与 `VITE_API_BASE_URL` |

**密钥管理**：生产禁止把密钥写进镜像或仓库；用 K8s Secret / 环境变量注入 / 密钥管理服务，定期轮换并保留 `*_PREV` 过渡值。

**管理后台托管**：`apps/admin-web` 生产构建（`pnpm --filter admin-web build`）产出纯静态 `dist/`，无 Node 依赖；Nginx 需配置 SPA history 回退（`try_files $uri $uri/ /index.html`），API 请求经 `VITE_API_BASE_URL` 直连后端或由 Nginx 反代 `/api/`。

## 4. 小档部署（单机 Docker）

```bash
# 1. 准备配置（SQLite + 内存缓存，零外部依赖）
cat > .env <<'EOF'
APP_ENV=prod
DB_DRIVER=sqlite
DB_URL=file:/data/app.db
CACHE_DRIVER=memory
AUTH_STRATEGY=jwt
JWT_SECRET=<生成的强随机串>
MQ_DRIVER=memory
EOF

# 2. 启动
docker run -d --name app -p 3000:3000 \
  -v /opt/app/data:/data --env-file .env \
  --restart unless-stopped registry.example.com/fw-app:1.0.0

# 3. 执行迁移与种子数据
docker exec app pnpm db:migrate
docker exec app pnpm db:seed

# 4. 验证
curl -fsS http://127.0.0.1:3000/health
```

要点：数据目录必须挂载到宿主机；`--restart unless-stopped` 保证重启自愈；**备份 = 备份挂载目录**。

## 5. 中档部署（docker-compose）

```
├─ nginx        # 静态资源 + 反向代理 + TLS 终止 + 限流
├─ app-1 / app-2# 无状态应用实例（同一镜像）
├─ worker       # BullMQ 消费者（可与 app 同镜像不同启动命令）
├─ mysql / pg   # 主从
└─ redis        # 缓存 + 队列 + 分布式锁
```

**操作**

```bash
docker compose --env-file .env.prod up -d        # 启动
docker compose exec app pnpm db:migrate          # 迁移（只在一个实例执行）
docker compose logs -f --tail=200 app            # 看日志
docker compose up -d --scale app=3               # 扩容实例
docker compose down                              # 停止（保留卷）
```

**Nginx 要点**：`/api` 反向代理到 app 上游；`/` 指向前端静态资源；开启 gzip；`client_max_body_size` 与上传限制对齐；TLS 证书与自动续期；对 `/auth/*` 单独限流。

**无状态要求**：会话不落本地内存（走 Redis 或 JWT）、上传文件走对象存储、定时任务靠分布式锁单点执行——否则多实例会出现行为不一致。

## 6. 大档部署（Helm / K8s）

```bash
helm repo add fw https://charts.example.com
helm upgrade --install myapp fw/app \
  -f values-prod.yaml --set image.tag=1.0.0 --wait
```

**关键 values**

| 项 | 建议 |
|---|---|
| `replicaCount` / HPA | 最小 3，CPU 60% 触发扩容，上限按容量评估 |
| `readinessProbe` / `livenessProbe` | 分别指向 `/ready` 与 `/health` |
| `resources` | 必须设置 requests/limits，避免节点资源争抢 |
| `strategy` | RollingUpdate，`maxUnavailable=0`，`maxSurge=1` |
| `podDisruptionBudget` | `minAvailable: 2` |
| `secrets` | 从外部 Secret / CSI 驱动注入，禁止写入 values 文件 |
| `cronJobs` | 与 Deployment 分离，避免定时任务被多副本重复执行 |

## 7. 启动、停止与优雅停机

| 操作 | 命令 / 行为 |
|---|---|
| 启动 | 容器入口执行 `pnpm db:migrate`（由迁移锁保证单实例执行）后启动应用 |
| 停止 | 发 `SIGTERM`；应用停止接收新请求，等待在途请求完成（默认 10s）后退出 |
| 强制退出 | 超时未完成则强制退出，日志告警；未完成任务重新入队 |
| 禁止 | 直接 `kill -9`，会导致在途请求丢失与任务状态不一致 |

## 8. 数据与备份

| 项 | 策略 |
|---|---|
| 迁移 | 发布流程内自动执行；禁止手工改库结构；禁止修改已提交迁移文件 |
| 备份频率 | 每日全量 + binlog/WAL 增量（中/大档）；小档每日拷贝数据目录 |
| 保留期 | 全量 30 天，月度快照保留 12 个月 |
| 加密与异地 | 备份加密，至少一份异地/对象存储 |
| 恢复演练 | **每季度一次**，记录 RTO/RPO 实测值，演练不通过视为 P1 缺陷 |
| 敏感数据 | 备份中含用户信息，按合规要求控制访问与下载权限 |

```bash
# MySQL 备份与恢复示例
mysqldump --single-transaction --routines myapp > backup_$(date +%F).sql
mysql myapp < backup_2026-10-09.sql
```

## 9. 监控与告警

**核心指标**（`/metrics` 暴露）

| 指标 | 告警阈值建议 |
|---|---|
| HTTP 5xx 率 | 5 分钟内 > 1% |
| 接口 P95 | 持续 10 分钟 > 1s |
| 缓存命中率 | 持续 30 分钟 < 80% |
| 队列积压 | > 1000 或持续增长 10 分钟 |
| 慢查询数 | 5 分钟内 > 10 |
| 降级事件计数 | > 0（提示依赖故障） |
| DB 连接池使用率 | > 80% |
| 磁盘 / 内存 / CPU | 分别 > 85% / 85% / 80% |
| 证书到期 | < 15 天 |

**日志排查**：所有日志带 `traceId`，先取响应头 `X-Trace-Id`，再按 traceId 检索全链路：

```bash
# 结构化日志按 traceId 检索（示例：jq）
cat app.log | jq 'select(.traceId=="b3f1c9")'
# 按错误级别与模块统计
cat app.log | jq -r 'select(.level=="error") | .module' | sort | uniq -c | sort -nr
```

## 10. 故障处理 Runbook

| 现象 | 排查 | 处置 | 恢复确认 |
|---|---|---|---|
| 应用起不来 | 看启动日志：配置校验失败 / 端口占用 / DB 不可达 | 修正 `.env` 或依赖；勿改代码绕过校验 | `/health` 返回 200 |
| 5xx 飙升 | 按 module 聚合错误日志；查最近发布与迁移 | 回滚上一版本；必要时摘除故障实例 | 5xx 率 < 0.1% |
| DB 连接耗尽 | 查连接池指标与慢查询 | 限流降级、杀长事务、临时调大连接池并定位慢 SQL | `/ready` 恢复 ok |
| Redis 不可用 | 确认降级是否生效（`CACHE_FAIL_OPEN`） | 恢复 Redis；观察回切无脏数据 | 命中率回升，降级计数归零 |
| 队列积压 | 查 worker 是否存活、失败率、消费速率 | 扩容 worker、暂停非关键队列、修复失败任务后重放 | 积压持续下降 |
| 定时任务没执行 | 查锁、cron 开关、worker 副本数 | 修锁或手动触发；确认未重复执行 | 任务记录出现且仅一条 |
| 磁盘写满 | 查日志与备份占用 | 清理旧日志与备份，扩容磁盘 | 使用率 < 70% |
| 证书过期 | 检查 Nginx/Ingress 证书 | 续期并重载 | HTTPS 握手正常 |
| 数据被误删 | 定位删除操作（审计日志 + traceId） | 软删可恢复；否则用备份按时间点恢复 | 数据一致性校验通过 |

## 11. 扩容与缩容

- **横向**：应用无状态，中档 `--scale`，大档调 HPA；扩容后确认 `/ready` 全部就绪再导流。
- **纵向**：先扩应用，再考虑数据库；数据库优先加只读从库与连接池调优。
- **缩容**：先摘流量（`/ready` 返回非 ok）→ 等待在途请求完成 → 再终止，避免 5xx。

## 12. 升级与回滚

1. 预检：备份数据库、确认镜像 tag、确认迁移脚本可逆性。
2. 灰度：大档先发 1 个副本观察 10 分钟（错误率、P95、日志无新增错误）。
3. 全量：滚动更新，`maxUnavailable=0`。
4. 迁移：破坏性变更按「加字段 → 双写 → 切读 → 删旧字段」分多次发布。
5. 回滚触发条件：5xx > 1%、P95 翻倍、关键功能不可用、数据不一致。
6. 回滚步骤：回滚镜像（含迁移回滚脚本），确认 `/health` 与核心接口，补缺陷用例。

## 13. 安全运维

- 密钥集中管理、定期轮换；代码与镜像中禁止存在明文密钥（CI 扫描门禁）。
- 最小权限：应用数据库账号仅授予必要库的 DML（迁移用单独账号）；容器以非 root 运行。
- 端口最小化：仅暴露 80/443，数据库与 Redis 不对外；内网安全组限制来源。
- 依赖与镜像：定期更新基础镜像与依赖，漏洞扫描无高危才发布。
- 审计：管理操作（改密、授权、租户变更）留痕，审计日志保留 ≥ 180 天。
- 备份加密与访问审计同样适用于运维操作。

## 14. 值班检查清单

| 频次 | 检查项 |
|---|---|
| 每日 | `/health`、`/ready` 正常；5xx 与 P95 无异常；队列无积压；备份任务成功 |
| 每周 | 慢查询 Top10；缓存命中率；磁盘与内存趋势；依赖漏洞扫描结果 |
| 每月 | 证书与密钥到期检查；容量评估；备份恢复演练；Runbook 复盘更新 |
| 每季 | 灾备演练（切换/演进/降级三大演练）；RTO/RPO 复核；权限与审计抽查 |

## 15. 常用命令速查

```bash
fw new <name> --template=admin      # 建项目
fw dev | fw build | fw check        # 开发 / 构建 / 配置自检
fw db:migrate | db:rollback | db:seed
fw gen crud <model> [--dry|--force]

curl -s localhost:3000/health | jq
curl -s localhost:3000/ready  | jq
curl -s localhost:3000/metrics | grep cache_hit

docker compose logs -f --tail=200 app
kubectl rollout status deploy/myapp
kubectl rollout undo deploy/myapp
```
