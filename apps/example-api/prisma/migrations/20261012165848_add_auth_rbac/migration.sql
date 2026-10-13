-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "username" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT,
    "avatar" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "last_login_at" DATETIME,
    "last_login_ip" TEXT,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "is_system" INTEGER NOT NULL DEFAULT 0,
    "data_scope" TEXT NOT NULL DEFAULT 'self',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'api',
    "module" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "user_role" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    PRIMARY KEY ("user_id", "role_id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    PRIMARY KEY ("role_id", "permission_id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parent_id" TEXT NOT NULL DEFAULT '0',
    "name" TEXT NOT NULL,
    "path" TEXT,
    "component" TEXT,
    "icon" TEXT,
    "permission_code" TEXT,
    "visible" INTEGER NOT NULL DEFAULT 1,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "expire_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "login_ip" TEXT,
    "user_agent" TEXT,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "user_id" TEXT,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "trace_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_tenant" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_users_status" ON "users"("status");

-- CreateIndex
CREATE INDEX "idx_roles_tenant" ON "roles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_roles_tenant_code" ON "roles"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "idx_permissions_type" ON "permissions"("type");

-- CreateIndex
CREATE INDEX "idx_permissions_module" ON "permissions"("module");

-- CreateIndex
CREATE INDEX "idx_ur_role" ON "user_role"("role_id");

-- CreateIndex
CREATE INDEX "idx_ur_user" ON "user_role"("user_id");

-- CreateIndex
CREATE INDEX "idx_menus_parent" ON "menus"("parent_id");

-- CreateIndex
CREATE INDEX "idx_menus_perm" ON "menus"("permission_code");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_rt_user" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "idx_rt_family" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "idx_rt_expire" ON "refresh_tokens"("expire_at");

-- CreateIndex
CREATE INDEX "idx_audit_tenant" ON "audit_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_audit_user" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "idx_audit_action" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "idx_audit_target" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_audit_trace" ON "audit_logs"("trace_id");

-- CreateIndex
CREATE INDEX "idx_audit_created" ON "audit_logs"("created_at");
