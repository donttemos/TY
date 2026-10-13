-- Add tenant identity to the shared-table test model.
ALTER TABLE "TestUser" ADD COLUMN "tenantId" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "TestUser_tenantId_id_idx" ON "TestUser"("tenantId", "id");
