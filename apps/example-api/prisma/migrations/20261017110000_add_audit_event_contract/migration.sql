-- M12 W1（PRD-012 OBS-06，ADR-0025）：audit_logs / audit_log_archives 统一审计事件契约增列——SQLite 方言
-- 全列可空：旧代码 / 旧数据零回归（M11.1 增列先例）；归档表与在线表同构（E-10 不变量不受影响）。

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "category" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "event" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "result" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "family_id" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "jti" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "request_id" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "category" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "event" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "result" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "family_id" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "jti" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "request_id" TEXT;

-- CreateIndex
CREATE INDEX "idx_audit_event" ON "audit_logs"("event");

-- CreateIndex
CREATE INDEX "idx_audit_family" ON "audit_logs"("family_id");

-- CreateIndex
CREATE INDEX "idx_audit_request" ON "audit_logs"("request_id");

-- CreateIndex
CREATE INDEX "idx_audit_category_created" ON "audit_logs"("category", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_archive_event" ON "audit_log_archives"("event");

-- CreateIndex
CREATE INDEX "idx_audit_archive_family" ON "audit_log_archives"("family_id");

-- CreateIndex
CREATE INDEX "idx_audit_archive_request" ON "audit_log_archives"("request_id");

-- CreateIndex
CREATE INDEX "idx_audit_archive_category" ON "audit_log_archives"("category", "archived_at");
