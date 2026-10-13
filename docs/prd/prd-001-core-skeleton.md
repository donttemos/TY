# PRD-001 · 核心骨架：配置 / 日志 / 错误 / 健康检查

> 里程碑：M1 ｜ 状态：草案 ｜ 优先级：P0 ｜ 依赖：无 ｜ 负责人：待定 ｜ 更新：2026-10-09

## 1. 背景与目标

所有后续能力的地基。没有统一的配置、日志、错误处理，后面的 `orm` / `cache` / `auth` 各自为政，切换配置无从谈起。

目标：让任何新项目在**30 分钟内**获得一套「开箱即用且规范统一」的运行骨架（配置、日志、错误码、健康检查；登录与权限分别由 M3 / M5 补齐，整体满足愿景 G1「1 天出骨架」）。

衡量：新建项目从空目录到 `/health` 返回 200 且日志结构化输出 ≤ 30 分钟。

## 2. 范围

**做**：monorepo 结构、配置模块、日志模块、统一响应与错误码、健康检查与优雅停机、CLI 入口、TypeScript 严格模式基线。

**不做**：具体业务模块、鉴权、数据库访问、前端（分别由 PRD-002 / 003 / 005 覆盖）。

## 3. 用户故事

- 作为开发者，我执行一条命令即可创建带标准目录结构的新服务，不用手抄配置。
- 作为开发者，配置项缺失时框架在**启动时**明确报错（而不是运行到一半 NPE）。
- 作为运维，我能通过 `/health` 与 `/ready` 判断实例是否可摘流量。
- 作为排障者，我能用一个 traceId 串起一次请求的所有日志。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | monorepo 骨架 | pnpm workspace：`packages/*`（框架包）+ `apps/*`（应用）+ `templates/*`（项目模板）；turbo 编排构建与测试 |
| FR-02 | 配置模块 `@fw/config` | 基于 zod 的 `.env` schema 校验；缺失/类型错误时启动即失败并打印明确提示；支持 `default / dev / test / prod` 多环境；提供 `ConfigService.get('db.driver')` 类型安全读取 |
| FR-03 | 日志模块 `@fw/logger` | 结构化 JSON 日志；字段与全局约定一致为 `time / level / traceId / spanId / module / msg / ctx`（M8 接入 OTel 前 `spanId` 为空串）；支持按 module 设置级别；敏感字段（`password / token / idcard`）自动脱敏 |
| FR-04 | 链路 ID | 中间件生成 `traceId`（或透传上游 `X-Trace-Id`），贯穿日志、响应头、错误对象 |
| FR-05 | 统一响应格式 | 成功 `{ code: 0, data, traceId }`；失败 `{ code, message, traceId, details? }`；提供 `ResponseInterceptor` 自动包装 |
| FR-06 | 错误码体系 | 业务错误码分段约定（`1xxx` 通用与参数、`2xxx` 业务、`3xxx` 鉴权、`4xxx` 租户与配额、`9xxx` 系统，与 [API 文档](./../40-api-spec.md) 第 2 节同源）；全局异常过滤器把异常映射为错误码，杜绝裸抛 500 |
| FR-07 | 健康检查 | `GET /health`（进程存活）、`GET /ready`（依赖就绪：DB / Redis 可选探针）；返回依赖逐项状态 |
| FR-08 | 优雅停机 | 收到 `SIGTERM` 后停止接新请求、等待在途请求完成（超时 10s 强制退出）、释放连接池 |
| FR-09 | CLI 入口 | `fw new <name> --template=<admin|api|cms>`、`fw dev`、`fw build`、`fw check`（配置自检） |
| FR-10 | 请求上下文 | 异步上下文（AsyncLocalStorage）保存 traceId / 当前用户，日志与 DAO 默认携带 |

## 5. 非功能需求（NFR）

- 冷启动时间 ≤ 1.5s（不含 DB 连接）。
- TypeScript `strict: true`，框架包禁止出现 `any`（可用 `unknown` + 收窄）。
- 日志写入支持 stdout（容器友好）与文件（可选），单条 ≤ 8KB 自动截断。
- 框架包对外 API 必须有 JSDoc，`fw check` 能校验配置完整性。

## 6. 关键设计

**目录结构**

```
framework/
  packages/{core,config,logger,orm,cache,auth,queue}
  apps/example-api/
  templates/{admin,api,cms}/
  pnpm-workspace.yaml  turbo.json
```

**配置键约定（前缀即能力切换点）**

```
APP_ENV=prod            APP_PORT=3000
DB_DRIVER=postgres      DB_URL=...
CACHE_DRIVER=redis      CACHE_URL=...
AUTH_STRATEGY=jwt       MQ_DRIVER=bullmq
LOG_LEVEL=info
```

**错误码表（首版）**：`1001` 参数错误、`1002` 资源不存在、`3001` 未登录、`3002` 无权限、`9001` 系统内部错误、`9002` 依赖不可用。

## 7. 验收标准（AC）

- [x] 新建模板项目，`pnpm i && pnpm dev` 在 30 分钟内跑通，`/health` 返回 200。
- [x] 故意删除 `.env` 中的必填项，服务启动失败并打印缺失项名称（非堆栈崩溃）。
- [x] 任意接口返回的响应体都带 `traceId`，且与该请求的日志行 `traceId` 一致。
- [x] 抛出一个业务异常，前端收到结构化错误码与文案，不出现 500 裸错误。
- [x] `kill -TERM` 后，在途请求处理完毕才退出，日志有 `shutdown complete` 记录。
- [x] 日志中出现 `password=` 字样时输出为 `***`。
- [x] `pnpm test` 覆盖 core/config/logger，覆盖率 ≥ 80%（实际 ≥ 92%）。
- [x] 模板项目与框架包源码每个文件都有中文文件头（`@file` / `@author` / `@created`），`pnpm run check:headers` 通过（40 个文件全绿）。

## 8. 依赖与风险

- 依赖：Node 20+、pnpm 9+。
- 风险：异步上下文（AsyncLocalStorage）与部分三方库（如旧版 ORM 钩子）上下文丢失 → 在 M2 联调时验证，必要时用显式传参兜底。

## 10. M1 验收记录（2026-10-12，donttemo）

| AC | 验证方式 | 结果 |
|---|---|---|
| AC-1 模板跑通 | `pnpm build && pnpm dev` → `GET /health` | ✅ `{"status":"ok"}` |
| AC-2 缺必填项启动失败 | 删 `APP_ENV` 跑服务 | ✅ 打印「缺少必填项（请检查 .env / .env.example）」非堆栈 |
| AC-3 traceId 贯通 | 端到端 + 9 项 smoke 脚本 | ✅ 响应头 `X-Trace-Id` === 响应体 `traceId` === 日志行 `traceId` |
| AC-4 业务异常结构化 | `/api/v1/demo/biz-error` | ✅ 2001 + `演示业务异常：库存不足` |
| AC-5 优雅停机 | 单测 `runGracefulShutdown` + 端到端 SIGTERM | ✅ `开始优雅停机` → `app.close` → drain → `shutdown complete` → `exit(0)` |
| AC-6 脱敏 | `/api/v1/demo/log-sensitive` | ✅ 日志输出 `password:"***"` / `accessToken:"***"` |
| AC-7 覆盖率 | `vitest run --coverage` | ✅ config 97.58% / logger 92.72% / core 92.82%（行覆盖） |
| AC-8 文件头 | `pnpm run check:headers` | ✅ 40 个文件全绿 |

**剩余 P1 项**：M2 启动后再补 SQLite/PG/MySQL 三库探针对接 `/ready`；`/metrics` 端点放入 M8 一起交付。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| 日志是否默认接 OpenTelemetry？ | M1 只出结构化日志，OTel 放 M8 | 待定 | M1 评审前 |
| 错误码是否需要中英双语文案？ | 首版中文 + code，前端按 code 映射 | 待定 | M1 评审前 |

## 10. M1 验收记录（2026-10-12，donttemo）
