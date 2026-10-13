# @file 项目模板说明
# @description fw new 生成的 API 项目使用说明
# @author donttemo
# @created 2026-10-09

# __APP_NAME__

由 `@fw/cli` 生成的 API 服务项目。

## 快速开始

```bash
cp .env.example .env   # 按需修改
pnpm i
pnpm build
pnpm dev               # http://localhost:3000/health
```

## 内置能力（M1）

- `GET /health` — 存活探针
- `GET /ready` — 就绪探针（依赖逐项状态）
- `GET /api/v1/demo/ok` — 统一响应包装（code=0 + traceId）
- `GET /api/v1/demo/biz-error` — 业务异常结构化错误码
- `GET /api/v1/demo/log-sensitive` — 敏感字段脱敏日志
- `SIGTERM` 优雅停机（等待在途请求，超时 10s 强制退出）

## 配置

见 `.env.example`；全部配置键由 zod 校验，缺失或非法时启动即失败并列出问题项。
