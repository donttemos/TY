-- M10 P0：任务登记表（E-01）与配置快照历史（E-02）
-- 与 prisma/migrations/20261015180000_add_jobs、20261015185000_add_config_snapshots 同构（PG 方言）

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "trace_id" TEXT,
    "file_name" TEXT,
    "artifact_content" TEXT,
    "artifact_content_type" TEXT,
    "owner_id" TEXT NOT NULL,
    "params" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "config_snapshots" (
    "version" INTEGER NOT NULL PRIMARY KEY,
    "overlay" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE INDEX "idx_jobs_owner_created" ON "jobs"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_jobs_status" ON "jobs"("status");
