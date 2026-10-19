<!--
@file docs/46 · 运维端点安全边界矩阵
@description M12 W3（PRD-012 OBS-15/16/17，ADR-0027）：全仓 @Public 与路径级公开项逐条登记
  必要性 / 暴露面 / 敏感度 / 环境约束。原则：**默认受保护，公开需显式白名单 + 书面理由 + 契约测试**。
@author donttemo
@created 2026-10-17
-->

# docs/46 · 运维端点安全边界矩阵（M12 / PRD-012）

> 状态：**正式**（2026-10-17）｜ 关联：ADR-0027（运维端点安全边界）、`docs/45` §6、`docs/40` §3、`docs/60` §Nginx
>
> 分层模型：**Public 自检**（探针/抓取需免鉴权，零敏感）/ **Protected maintenance**（权限码守卫）/
> **业务公开面**（登录/回调/上报等本身要求公开的能力）。

## 1. Public 自检层（路径白名单，零敏感材料）

| 端点 | 必要性 | 暴露面 | 敏感度 | 环境约束 |
|---|---|---|---|---|
| `GET /health` | liveness 探针（进程存活）；K8s/监控抓取 | 全网可读 | 无（固定 ok 体） | 三层部署均公开；Nginx/K8s 白名单覆盖（OBS-19） |
| `GET /ready` | readiness 探针（逐依赖探针，失败 503） | 全网可读 | 低（仅依赖健康态） | 同上；探针集可配 |
| `GET /metrics` | Prometheus 抓取 | 建议内网（部署侧 allow 白名单） | 低（计数器；label 仅低基数枚举，无身份值——OBS-12 基数护栏） | Nginx 三份配置内网 allow 段覆盖；K8s NetworkPolicy 收敛 |
| `GET /metrics/queue` | 队列深度抓取 | 同上 | 低 | 同上 |

语义说明（OBS-17）：`/health` = liveness（进程存活即 200，不探依赖）；`/ready` = readiness（逐探针判定，
任一失败 503）。路径**不重命名**（K8s 探针映射已登记 `docs/60`，改名即破坏部署契约）；如需具名别名
（`/liveness`、`/readiness`）须以同 handler 多路由实现（本版未做——无消费方）。

## 2. Protected maintenance 层（M12 W3 OBS-15 收敛）

| 端点 | 此前 | 现状 | 敏感度 | 锁定证据 |
|---|---|---|---|---|
| `GET /api/v1/auth-maintenance/refresh-cleanup` | 类级 `@Public` 裸奔 | `ops:read` 权限守卫 + `no-store` | 低（任务元数据/计数） | `auth-maintenance.contract.spec.ts` 元数据断言 |
| `GET /api/v1/auth-maintenance/audit-archive` | 同上 | 同上 | 低（归档计数/行数） | 同上 |
| `GET /api/v1/auth-maintenance/key-ring` | 类级 `@Public` + 仅 key-ring 有 no-store | `ops:read` 守卫 + `no-store` | 低（kid/来源/计数，ADR-0024 零敏感契约） | 同上 + 零敏感 grep 断言 |

- 鉴权形态（OQ-4 定案）：**权限码 `ops:read`**（进 `PERM` 权威表 + seed 声明 + admin 全量授权）；未登录
  `3001`、无权限 `3002`。`OPS_TOKEN`（运维 token 逃生门）登记为备选**未启用**（ADR-0027 §2）。
- 部署侧（OBS-19）：Nginx 三份配置**均不含 auth-maintenance 白名单**——maintenance 走普通 `/api/` 反代，
  由应用层权限码保护（部署侧不放大暴露面）。

## 3. 业务公开面（本就要求公开，登记理由）

| 端点 | 理由 | 敏感度 | 环境约束 |
|---|---|---|---|
| `POST /api/v1/auth/login` / `register` | 未登录方可访问是登录/注册的定义 | 登录限流 + 锁定策略（Nginx limit_req + 应用层） | 全环境公开；限流白名单不含 |
| `POST /api/v1/auth/refresh` | 静默续期（双 token 语义） | 旋转族策略（ADR-0020/0022） | 全环境公开 |
| `POST /api/v1/auth/logout` / `me` 等鉴权后端点 | — | — | 不在本矩阵（非公开面） |
| `GET /api/v1/auth/oauth2/providers` + OAuth2 回调 | 授权码流程起点与 IdP 回调 | 回调白名单 `AUTH_OAUTH2_REDIRECT_WHITELIST` | 启用 OAuth2 时公开 |
| `POST /api/v1/telemetry/client-errors` | RUM 前端错误上报（浏览器无 token 场景） | 无（仅堆栈文本，落库限长） | 全环境公开；写入限速靠 DB 上限 |
| `GET /api/v1/events/stream`（SSE） | 实时推送；票据鉴权 | 一次性票据（60s + 原子核销），不信任内建重连 | 全环境公开（票据保护） |

## 4. 演示自检面（M12 W3 OBS-16 收敛：非 dev 默认 404）

`DEMO_ENDPOINTS_ENABLED`（未设置按 `APP_ENV=dev`/`NODE_ENV=development` 判定；显式 true/false 优先）：

| 控制器 | 路径前缀 | 关闭时 | 登记理由 |
|---|---|---|---|
| `DemoController` | `/api/v1/demo*` | 404 | 框架自检演示（未知异常收敛等），演示对象本身即异常注入 |
| `DemoQueueController` | `/api/v1/demo-queue` | 404 | 队列重试/死信演示（故意失败任务） |
| `DemoTransportController` | `/api/v1/demo-transport` | 404 | 跨进程 RPC 错误传播演示 |
| `CacheDemoController` | `/api/v1/demo-cache` | 404 | 缓存命中率演示；`GET /stats` 额外返回实例实际 `CACHE_PREFIX`（2026-10-18 起，供双节点冒烟在清场前核对两节点前缀一致——仅自检面可见，关闭时 404） |

保留公开/受保护的相邻面（非「自检」范畴）：`demo-item`（生成器业务示例页数据源，走 RBAC）、
`demo-tenant-items`（租户演示，走 RBAC + tenant 解析）、`open.controller`（OAuth2 回调演示，启用才可达）。
反向验证：`demo-endpoints.guard.spec.ts`（显式开关优先 / dev 默认开 / 其余关 / 关闭 404 不暴露存在性 /
**四控制器 guard 挂载元数据断言**）。

> **2026-10-17 真机实测修正**：`DemoController` 此前只在源码里 `import` 了 `DemoEndpointsGuard` 却**未加
> `@UseGuards`**——`APP_ENV=prod` 下 `/api/v1/demo/*` 实测仍 200，与本表第 1 行漂移。已补装饰器
> （commit `0944864`）并以「四控制器 guard 挂载」元数据断言锁定；重发后真机四端点与公网入口均 404。
> 实测记录见 [docs/63](./63-1panel-real-deploy-verification.md) §6。

## 5. 门禁与登记

- 本矩阵的「默认受保护」由 `auth-maintenance.contract.spec.ts`（元数据断言：无 `@Public` + `ops:read` +
  全端点 `no-store`）与 `demo-endpoints.guard.spec.ts`（demo 404）锁定；新增公开端点必须先在本文件登记
  理由，否则属漂移。
- 部署侧一致性由 `check:helm` 的 Nginx 三份一致性轴断言（OBS-19）。
