-- M10 E-13：站内信表（PRD-010 E-13 / AC10）
-- 通知中心的持久层：业务侧经 @fw/transport 事件面订阅（任务终态 / 队列告警）落成收件人可见的消息。
-- dedupe_key 唯一——事件面可能重复投递（多副本各起一条订阅、任务重试后再次终态），
-- 幂等靠唯一约束而非应用层「先查后写」：并发插入只有一个成功，其余按重复投递忽略。

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL DEFAULT 0,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "content" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "trace_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "read_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "idx_notifications_user_created" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_notifications_user_read" ON "notifications"("user_id", "read_at");
