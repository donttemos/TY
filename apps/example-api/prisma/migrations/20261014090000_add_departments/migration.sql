-- Create departments + user_department (PRD-008 FR-05, M8 T-M8-04)
-- departments：组织部门树（parent_id='0' 为顶级；code 租户内唯一，可为空）
-- user_department：用户-部门关联（多部门；is_primary 标主部门）
-- 主键为 UUID 字符串，与 users/roles 等 M3 表一致（数据字典中的 bigint 为逻辑描述）
CREATE TABLE "departments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "parent_id" TEXT NOT NULL DEFAULT '0',
    "code" TEXT,
    "name" TEXT NOT NULL,
    "leader_id" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE "user_department" (
    "user_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "is_primary" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("user_id", "department_id")
);

CREATE INDEX "idx_dept_tenant" ON "departments"("tenant_id");

CREATE INDEX "idx_dept_parent" ON "departments"("parent_id");

CREATE UNIQUE INDEX "uk_dept_tenant_code" ON "departments"("tenant_id", "code");

CREATE INDEX "idx_ud_dept" ON "user_department"("department_id");
