-- M11.3：refresh_tokens 客户端指纹绑定（ADR-0022）——SQLite 方言
-- rotated_fingerprint 可空：NULL 仅来自 M11.1 存量行或 AUTH_FINGERPRINT=off（决策 3）。

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_fingerprint" TEXT;
