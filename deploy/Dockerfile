# @file 生产镜像（PRD-016 FR-16-08）
# @description 单机 Compose 部署用的多阶段构建，产出两个目标：
#   - runtime（默认）：NestJS 应用运行镜像，非 root、含 Prisma 引擎、node dist/main.js 启动；
#   - migrator：含 prisma CLI 与 tsx 的迁移/种子镜像——因为 prisma 与 @fw/cli 都在 devDependencies，
#     runtime 镜像若裁掉 devDeps 就跑不了迁移，所以迁移必须是独立目标。
#   取舍说明：runtime 直接复用 build 阶段的完整 /repo（含 node_modules），不做依赖裁剪——
#   工作区包之间是 workspace: 软链，裁剪会打断链接；镜像偏大但可构建、可运行，优先正确性。
#   构建参数 PRISMA_SCHEMA 必须与运行时 DB_DRIVER 匹配（postgres → prisma/pg/schema.prisma）。
# @author donttemo
# @created 2026-10-22
# @module deploy
# @since v0.8.0

ARG NODE_VERSION=22.22.2

# ---------- 基础层：node + pnpm（corepack） ----------
FROM node:${NODE_VERSION}-alpine AS base
# libc6-compat / openssl：Prisma 引擎在 Alpine 上的硬依赖
RUN apk add --no-cache libc6-compat openssl
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /repo

# ---------- 依赖层：先只拷清单，最大化层缓存 ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/example-api/package.json apps/example-api/
COPY apps/admin-web/package.json apps/admin-web/
COPY packages/auth/package.json packages/auth/
COPY packages/cache/package.json packages/cache/
COPY packages/cli/package.json packages/cli/
COPY packages/config/package.json packages/config/
COPY packages/config-center/package.json packages/config-center/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY packages/queue/package.json packages/queue/
COPY packages/saas/package.json packages/saas/
COPY packages/storage/package.json packages/storage/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/tenant/package.json packages/tenant/
COPY packages/transport/package.json packages/transport/
RUN pnpm install --frozen-lockfile

# ---------- 构建层：生成 Prisma Client + 按拓扑序编译框架包与应用 ----------
FROM deps AS build
# 必须与运行时 DB_DRIVER 匹配：postgres → prisma/pg/schema.prisma
ARG PRISMA_SCHEMA=prisma/pg/schema.prisma
COPY . .
# generate 不连库，但 schema 必须存在；client 生成到默认 @prisma/client（应用源码按此导入）
RUN pnpm --filter example-api exec prisma generate --schema ${PRISMA_SCHEMA}
# 顺序即依赖序，漏包会让 example-api 取不到 dist（与 CI 同一份列表）
RUN for pkg in \
      @fw/config @fw/logger @fw/core @fw/config-center @fw/db @fw/auth \
      @fw/cache @fw/cli @fw/queue @fw/saas @fw/tenant @fw/transport \
      @fw/telemetry @fw/storage; do \
      pnpm --filter "$pkg" run build || exit 1; \
    done \
 && pnpm --filter example-api run build \
 && pnpm --filter admin-web run build

# ---------- 迁移/种子层：保留 devDependencies（prisma CLI + tsx） ----------
FROM build AS migrator
WORKDIR /repo/apps/example-api
ENV NODE_ENV=production
# 命令由编排传入（migrate deploy 或 tsx prisma/seed.ts），这里只给默认动作
CMD ["sh", "-c", "pnpm exec prisma migrate deploy --schema ${PRISMA_SCHEMA}"]

# ---------- 运行层：非 root，仅运行编译产物 ----------
FROM base AS runtime
ENV NODE_ENV=production \
    APP_ENV=prod
COPY --from=build /repo /repo
# COPY 后属主是 root；运行用户必须是 node（避免容器内以 root 跑应用）
RUN chown -R node:node /repo
WORKDIR /repo/apps/example-api
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
