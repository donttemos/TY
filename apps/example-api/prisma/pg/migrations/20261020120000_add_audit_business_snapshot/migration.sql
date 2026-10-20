-- M15 B1（PRD-015 FR-15-04，ADR-0032 R2/R8）：audit_logs / audit_log_archives 业务快照增列——PostgreSQL 方言
-- 全列可空：旧代码 / 旧数据零回归；归档表与在线表同构（E-10 不变量）。

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "summary" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "target_label" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "actor_label" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "reason" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "audit_source" TEXT;

ALTER TABLE "audit_log_archives" ADD COLUMN "summary" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "target_label" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "actor_label" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "reason" TEXT;
ALTER TABLE "audit_log_archives" ADD COLUMN "audit_source" TEXT;

-- CreateIndex：结果 + 时间组合（运营高频查询「近 N 天被拒绝的操作」）
CREATE INDEX "idx_audit_result_created" ON "audit_logs"("result", "created_at");
CREATE INDEX "idx_audit_archive_result_created" ON "audit_log_archives"("result", "created_at");
