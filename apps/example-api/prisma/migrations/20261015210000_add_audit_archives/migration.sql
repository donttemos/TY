-- M10 E-10：审计日志归档表（PRD-010 AC7）
-- 在线表 audit_logs 按保留天数（AUDIT_ARCHIVE_RETENTION_DAYS）迁入的冷存副本；
-- 主键与在线表一致（归档写入按主键 upsert 幂等，崩溃重跑不产生重复）

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
    "created_at" DATETIME NOT NULL,
    "archived_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "idx_audit_archive_user" ON "audit_log_archives"("user_id");

-- CreateIndex
CREATE INDEX "idx_audit_archive_module" ON "audit_log_archives"("module");

-- CreateIndex
CREATE INDEX "idx_audit_archive_created" ON "audit_log_archives"("created_at");
