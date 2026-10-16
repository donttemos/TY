-- M10 E-09：附件元数据表（PRD-010 E-09 / @fw/storage 文件存储端口）
-- 文件内容经 StoragePort 落盘或落对象存储，本表只存元数据与归属（数据字典 §3.19）。

-- CreateTable
CREATE TABLE "upload_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateIndex
CREATE INDEX "idx_upload_owner" ON "upload_files"("owner_id");
