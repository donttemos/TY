-- M11.1：refresh_tokens 轮换 CAS 与加密 grace 恢复（ADR-0020）——模板 SQLite 方言
-- 与 example-api prisma/migrations/20261016140000_add_refresh_replacement 同构。

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "replaced_by_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_cipher" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_key_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_expires_at" DATETIME;

-- CreateIndex
CREATE INDEX "idx_rt_replaced_by" ON "refresh_tokens"("replaced_by_id");
