-- Create tenants table (PRD-008 FR-01/FR-02)
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isolation" TEXT NOT NULL DEFAULT 'shared',
    "db_url_enc" TEXT,
    "plan" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "expire_at" DATETIME,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- 特意使用非 uuid 的稳定 ID：与 users.tenant_id 的 bigint 语义对齐（'0' = 存量单租户数据）
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");
