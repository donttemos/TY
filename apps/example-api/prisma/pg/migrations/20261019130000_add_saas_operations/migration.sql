-- M13（PRD-013，ADR-0029~0031）：SaaS 运营基础十表——PostgreSQL 方言
-- 由 prisma migrate diff（HEAD schema → 新增 M13 模型段）生成；与 sqlite 迁移语义逐条对应。
-- active_marker 方案与三库一致性说明见 ADR-0029 §3.3。

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_versions" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    "remark" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "window_type" TEXT NOT NULL DEFAULT 'day',
    "execution" TEXT NOT NULL DEFAULT 'hard',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "quota_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_quotas" (
    "id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "quota_key" TEXT NOT NULL,
    "limit_value" BIGINT NOT NULL,
    "execution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "plan_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_version_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "active_marker" TEXT,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "reason" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_quotas" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quota_key" TEXT NOT NULL,
    "override_value" BIGINT NOT NULL,
    "execution" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "tenant_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_quota_windows" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quota_key" TEXT NOT NULL,
    "window_type" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "limit_value" BIGINT NOT NULL,
    "execution" TEXT NOT NULL DEFAULT 'hard',
    "warned_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_quota_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quota_key" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'api',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_rollups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quota_key" TEXT NOT NULL,
    "window_type" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "total_quantity" BIGINT NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_lifecycle_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_status" TEXT,
    "toStatus" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "actor_id" TEXT,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "trace_id" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_lifecycle_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "idx_plan_versions_plan" ON "plan_versions"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_plan_versions_plan_version" ON "plan_versions"("plan_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "quota_definitions_key_key" ON "quota_definitions"("key");

-- CreateIndex
CREATE INDEX "idx_plan_quotas_version" ON "plan_quotas"("plan_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_plan_quotas_version_key" ON "plan_quotas"("plan_version_id", "quota_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_active_marker_key" ON "tenant_subscriptions"("active_marker");

-- CreateIndex
CREATE INDEX "idx_tenant_subscriptions_tenant" ON "tenant_subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_tenant_subscriptions_version" ON "tenant_subscriptions"("plan_version_id");

-- CreateIndex
CREATE INDEX "idx_tenant_subscriptions_status" ON "tenant_subscriptions"("status");

-- CreateIndex
CREATE INDEX "idx_tenant_quotas_tenant" ON "tenant_quotas"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_tenant_quotas_tenant_key" ON "tenant_quotas"("tenant_id", "quota_key");

-- CreateIndex
CREATE INDEX "idx_tenant_quota_windows_tenant" ON "tenant_quota_windows"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_tenant_quota_windows_window" ON "tenant_quota_windows"("tenant_id", "quota_key", "window_type", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_idempotency_key_key" ON "usage_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_usage_events_tenant_metric_time" ON "usage_events"("tenant_id", "quota_key", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_usage_rollups_tenant" ON "usage_rollups"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_usage_rollups_window" ON "usage_rollups"("tenant_id", "quota_key", "window_type", "window_start");

-- CreateIndex
CREATE INDEX "idx_tenant_lifecycle_tenant_time" ON "tenant_lifecycle_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_tenant_lifecycle_action" ON "tenant_lifecycle_logs"("action");

