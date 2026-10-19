-- CreateTable
CREATE TABLE `DemoItem` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdBy` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updatedBy` VARCHAR(191) NOT NULL DEFAULT 'system',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `username` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `avatar` VARCHAR(191) NULL,
    `status` INTEGER NOT NULL DEFAULT 1,
    `last_login_at` DATETIME(3) NULL,
    `last_login_ip` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `users_username_key`(`username`),
    UNIQUE INDEX `users_phone_key`(`phone`),
    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `idx_users_tenant`(`tenant_id`),
    INDEX `idx_users_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `remark` VARCHAR(191) NULL,
    `is_system` INTEGER NOT NULL DEFAULT 0,
    `data_scope` VARCHAR(191) NOT NULL DEFAULT 'self',
    `sort` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_roles_tenant`(`tenant_id`),
    UNIQUE INDEX `uk_roles_tenant_code`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'api',
    `module` VARCHAR(191) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `permissions_code_key`(`code`),
    INDEX `idx_permissions_type`(`type`),
    INDEX `idx_permissions_module`(`module`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_role` (
    `user_id` VARCHAR(191) NOT NULL,
    `role_id` VARCHAR(191) NOT NULL,

    INDEX `idx_ur_role`(`role_id`),
    INDEX `idx_ur_user`(`user_id`),
    PRIMARY KEY (`user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permission` (
    `role_id` VARCHAR(191) NOT NULL,
    `permission_id` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`role_id`, `permission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `menus` (
    `id` VARCHAR(191) NOT NULL,
    `parent_id` VARCHAR(191) NOT NULL DEFAULT '0',
    `name` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NULL,
    `component` VARCHAR(191) NULL,
    `icon` VARCHAR(191) NULL,
    `permission_code` VARCHAR(191) NULL,
    `visible` INTEGER NOT NULL DEFAULT 1,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_menus_parent`(`parent_id`),
    INDEX `idx_menus_perm`(`permission_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `parent_id` VARCHAR(191) NOT NULL DEFAULT '0',
    `code` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `leader_id` VARCHAR(191) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_dept_tenant`(`tenant_id`),
    INDEX `idx_dept_parent`(`parent_id`),
    UNIQUE INDEX `uk_dept_tenant_code`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_department` (
    `user_id` VARCHAR(191) NOT NULL,
    `department_id` VARCHAR(191) NOT NULL,
    `is_primary` INTEGER NOT NULL DEFAULT 0,

    INDEX `idx_ud_dept`(`department_id`),
    PRIMARY KEY (`user_id`, `department_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(191) NOT NULL,
    `family_id` VARCHAR(191) NOT NULL,
    `expire_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `login_ip` VARCHAR(191) NULL,
    `user_agent` VARCHAR(191) NULL,
    `replaced_by_id` VARCHAR(191) NULL,
    `replacement_cipher` TEXT NULL,
    `replacement_key_id` VARCHAR(191) NULL,
    `replacement_expires_at` DATETIME(3) NULL,
    `rotated_fingerprint` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `refresh_tokens_token_hash_key`(`token_hash`),
    INDEX `idx_rt_user`(`user_id`),
    INDEX `idx_rt_family`(`family_id`),
    INDEX `idx_rt_expire`(`expire_at`),
    INDEX `idx_rt_replaced_by`(`replaced_by_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `user_id` VARCHAR(191) NULL,
    `module` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NULL,
    `event` VARCHAR(191) NULL,
    `result` VARCHAR(191) NULL,
    `family_id` VARCHAR(191) NULL,
    `jti` VARCHAR(191) NULL,
    `request_id` VARCHAR(191) NULL,
    `target_type` VARCHAR(191) NULL,
    `target_id` VARCHAR(191) NULL,
    `before_value` JSON NULL,
    `after_value` JSON NULL,
    `ip` VARCHAR(191) NULL,
    `user_agent` VARCHAR(191) NULL,
    `trace_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_audit_tenant`(`tenant_id`),
    INDEX `idx_audit_user`(`user_id`),
    INDEX `idx_audit_action`(`action`),
    INDEX `idx_audit_target`(`target_type`, `target_id`),
    INDEX `idx_audit_trace`(`trace_id`),
    INDEX `idx_audit_event`(`event`),
    INDEX `idx_audit_family`(`family_id`),
    INDEX `idx_audit_request`(`request_id`),
    INDEX `idx_audit_category_created`(`category`, `created_at`),
    INDEX `idx_audit_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log_archives` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `user_id` VARCHAR(191) NULL,
    `module` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NULL,
    `event` VARCHAR(191) NULL,
    `result` VARCHAR(191) NULL,
    `family_id` VARCHAR(191) NULL,
    `jti` VARCHAR(191) NULL,
    `request_id` VARCHAR(191) NULL,
    `target_type` VARCHAR(191) NULL,
    `target_id` VARCHAR(191) NULL,
    `before_value` JSON NULL,
    `after_value` JSON NULL,
    `ip` VARCHAR(191) NULL,
    `user_agent` VARCHAR(191) NULL,
    `trace_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `archived_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_audit_archive_user`(`user_id`),
    INDEX `idx_audit_archive_module`(`module`),
    INDEX `idx_audit_archive_event`(`event`),
    INDEX `idx_audit_archive_family`(`family_id`),
    INDEX `idx_audit_archive_request`(`request_id`),
    INDEX `idx_audit_archive_category`(`category`, `archived_at`),
    INDEX `idx_audit_archive_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenants` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isolation` VARCHAR(191) NOT NULL DEFAULT 'shared',
    `db_url_enc` VARCHAR(191) NULL,
    `plan` VARCHAR(191) NULL,
    `status` INTEGER NOT NULL DEFAULT 1,
    `expire_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `tenants_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dict_categories` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `remark` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `dict_categories_code_key`(`code`),
    INDEX `idx_dict_cat_deleted`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dict_items` (
    `id` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `color` VARCHAR(191) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_dict_item_category`(`category_id`),
    INDEX `idx_dict_item_deleted`(`deleted_at`),
    UNIQUE INDEX `uk_dict_item_category_value`(`category_id`, `value`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `message` VARCHAR(191) NULL,
    `error` VARCHAR(191) NULL,
    `trace_id` VARCHAR(191) NULL,
    `file_name` VARCHAR(191) NULL,
    `artifact_content` VARCHAR(191) NULL,
    `artifact_content_type` VARCHAR(191) NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `params` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_jobs_owner_created`(`owner_id`, `created_at`),
    INDEX `idx_jobs_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `config_snapshots` (
    `version` INTEGER NOT NULL,
    `overlay` VARCHAR(191) NOT NULL,
    `applied_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` BIGINT NOT NULL DEFAULT 0,
    `user_id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `level` VARCHAR(191) NOT NULL DEFAULT 'info',
    `title` VARCHAR(191) NOT NULL,
    `content` VARCHAR(191) NULL,
    `ref_type` VARCHAR(191) NULL,
    `ref_id` VARCHAR(191) NULL,
    `trace_id` VARCHAR(191) NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notifications_dedupe_key_key`(`dedupe_key`),
    INDEX `idx_notifications_user_created`(`user_id`, `created_at`),
    INDEX `idx_notifications_user_read`(`user_id`, `read_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_files` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NULL,
    `original_name` VARCHAR(191) NOT NULL,
    `stored_name` VARCHAR(191) NOT NULL,
    `mime_type` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_upload_owner`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `plans_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_versions` (
    `id` VARCHAR(191) NOT NULL,
    `plan_id` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'published',
    `remark` VARCHAR(191) NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_plan_versions_plan`(`plan_id`),
    UNIQUE INDEX `uk_plan_versions_plan_version`(`plan_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quota_definitions` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `unit` VARCHAR(191) NOT NULL,
    `window_type` VARCHAR(191) NOT NULL DEFAULT 'day',
    `execution` VARCHAR(191) NOT NULL DEFAULT 'hard',
    `description` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `quota_definitions_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_quotas` (
    `id` VARCHAR(191) NOT NULL,
    `plan_version_id` VARCHAR(191) NOT NULL,
    `quota_key` VARCHAR(191) NOT NULL,
    `limit_value` BIGINT NOT NULL,
    `execution` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_plan_quotas_version`(`plan_version_id`),
    UNIQUE INDEX `uk_plan_quotas_version_key`(`plan_version_id`, `quota_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_subscriptions` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `plan_id` VARCHAR(191) NOT NULL,
    `plan_version_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `active_marker` VARCHAR(191) NULL,
    `effective_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expire_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `reason` VARCHAR(191) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    UNIQUE INDEX `tenant_subscriptions_active_marker_key`(`active_marker`),
    INDEX `idx_tenant_subscriptions_tenant`(`tenant_id`),
    INDEX `idx_tenant_subscriptions_version`(`plan_version_id`),
    INDEX `idx_tenant_subscriptions_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_quotas` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `quota_key` VARCHAR(191) NOT NULL,
    `override_value` BIGINT NOT NULL,
    `execution` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL DEFAULT 'system',
    `updated_by` VARCHAR(191) NOT NULL DEFAULT 'system',

    INDEX `idx_tenant_quotas_tenant`(`tenant_id`),
    UNIQUE INDEX `uk_tenant_quotas_tenant_key`(`tenant_id`, `quota_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_quota_windows` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `quota_key` VARCHAR(191) NOT NULL,
    `window_type` VARCHAR(191) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `used` BIGINT NOT NULL DEFAULT 0,
    `limit_value` BIGINT NOT NULL,
    `execution` VARCHAR(191) NOT NULL DEFAULT 'hard',
    `warned_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_tenant_quota_windows_tenant`(`tenant_id`),
    UNIQUE INDEX `uk_tenant_quota_windows_window`(`tenant_id`, `quota_key`, `window_type`, `window_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usage_events` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `quota_key` VARCHAR(191) NOT NULL,
    `quantity` BIGINT NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'api',
    `idempotency_key` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `usage_events_idempotency_key_key`(`idempotency_key`),
    INDEX `idx_usage_events_tenant_metric_time`(`tenant_id`, `quota_key`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usage_rollups` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `quota_key` VARCHAR(191) NOT NULL,
    `window_type` VARCHAR(191) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `total_quantity` BIGINT NOT NULL,
    `event_count` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_usage_rollups_tenant`(`tenant_id`),
    UNIQUE INDEX `uk_usage_rollups_window`(`tenant_id`, `quota_key`, `window_type`, `window_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_lifecycle_logs` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `from_status` VARCHAR(191) NULL,
    `toStatus` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `actor_type` VARCHAR(191) NOT NULL DEFAULT 'user',
    `actor_id` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NULL,
    `user_agent` VARCHAR(191) NULL,
    `trace_id` VARCHAR(191) NULL,
    `request_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_tenant_lifecycle_tenant_time`(`tenant_id`, `created_at`),
    INDEX `idx_tenant_lifecycle_action`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

