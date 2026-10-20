-- M15 B1（PRD-015 FR-15-04，ADR-0032 R2/R8）：audit_logs / audit_log_archives 业务快照增列——MySQL 方言
-- 全列可空：旧代码 / 旧数据零回归；归档表与在线表同构（E-10 不变量）。
-- 说明：mysql 侧 init 为压缩基线（含 M12 六列），本迁移以增量方式落地，不重写历史迁移。

-- AlterTable
ALTER TABLE `audit_logs`
    ADD COLUMN `summary` VARCHAR(255) NULL,
    ADD COLUMN `target_label` VARCHAR(128) NULL,
    ADD COLUMN `actor_label` VARCHAR(64) NULL,
    ADD COLUMN `reason` VARCHAR(255) NULL,
    ADD COLUMN `audit_source` VARCHAR(16) NULL;

ALTER TABLE `audit_log_archives`
    ADD COLUMN `summary` VARCHAR(255) NULL,
    ADD COLUMN `target_label` VARCHAR(128) NULL,
    ADD COLUMN `actor_label` VARCHAR(64) NULL,
    ADD COLUMN `reason` VARCHAR(255) NULL,
    ADD COLUMN `audit_source` VARCHAR(16) NULL;

-- CreateIndex：结果 + 时间组合（运营高频查询「近 N 天被拒绝的操作」）
CREATE INDEX `idx_audit_result_created` ON `audit_logs`(`result`, `created_at`);
CREATE INDEX `idx_audit_archive_result_created` ON `audit_log_archives`(`result`, `created_at`);
