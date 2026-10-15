-- CreateTable
CREATE TABLE "config_snapshots" (
    "version" INTEGER NOT NULL PRIMARY KEY,
    "overlay" TEXT NOT NULL,
    "applied_at" DATETIME NOT NULL
);
