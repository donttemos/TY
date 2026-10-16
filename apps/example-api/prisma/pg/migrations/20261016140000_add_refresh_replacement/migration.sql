-- M11.1：refresh_tokens 轮换 CAS 与加密 grace 恢复（ADR-0020）——PG 方言
-- 与 prisma/migrations/20261016140000_add_refresh_replacement 同构。
-- 四列全部 nullable：旧代码与新 schema 互相兼容，回滚 = 旧版本直接跑新库。

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "replaced_by_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_cipher" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_key_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "replacement_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "idx_rt_replaced_by" ON "refresh_tokens"("replaced_by_id");
