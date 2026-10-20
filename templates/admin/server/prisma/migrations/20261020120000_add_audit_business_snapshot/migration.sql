-- M15 B1（PRD-015 FR-15-04，ADR-0032 R2/R8）：审计业务快照增列——模板（SQLite 方言）
-- 与 example-api 的 20261020120000 同源；模板不含 audit_log_archives（归档为 example-api 演示能力），
-- 故只改在线表。全列可空：旧代码 / 旧数据零回归。

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "summary" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "target_label" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "actor_label" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "reason" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "audit_source" TEXT;

-- CreateIndex：结果 + 时间组合（运营高频查询「近 N 天被拒绝的操作」）
CREATE INDEX "idx_audit_result_created" ON "audit_logs"("result", "created_at");
