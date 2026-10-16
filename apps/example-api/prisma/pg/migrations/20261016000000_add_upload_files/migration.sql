-- M10 E-09：附件元数据表（PRD-010 E-09 / @fw/storage 文件存储端口）——PG 方言
-- 与 prisma/migrations/20261016000000_add_upload_files 同构

-- CreateTable
CREATE TABLE "upload_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateIndex
CREATE INDEX "idx_upload_owner" ON "upload_files"("owner_id");
