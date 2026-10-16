-- M10 E-10：审计日志归档表（PRD-010 AC7）——PG 方言
-- 与 prisma/migrations/20261015210000_add_audit_archives 同构

-- CreateTable
CREATE TABLE "audit_log_archives" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "user_id" TEXT,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "idx_audit_archive_user" ON "audit_log_archives"("user_id");

-- CreateIndex
CREATE INDEX "idx_audit_archive_module" ON "audit_log_archives"("module");

-- CreateIndex
CREATE INDEX "idx_audit_archive_created" ON "audit_log_archives"("created_at");
