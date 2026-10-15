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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "idx_jobs_owner_created" ON "jobs"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_jobs_status" ON "jobs"("status");
