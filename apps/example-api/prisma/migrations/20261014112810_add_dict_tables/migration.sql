-- CreateTable
CREATE TABLE "dict_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateTable
CREATE TABLE "dict_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "color" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "updated_by" TEXT NOT NULL DEFAULT 'system'
);

-- CreateIndex
CREATE UNIQUE INDEX "dict_categories_code_key" ON "dict_categories"("code");

-- CreateIndex
CREATE INDEX "idx_dict_cat_deleted" ON "dict_categories"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_dict_item_category" ON "dict_items"("category_id");

-- CreateIndex
CREATE INDEX "idx_dict_item_deleted" ON "dict_items"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_dict_item_category_value" ON "dict_items"("category_id", "value");
