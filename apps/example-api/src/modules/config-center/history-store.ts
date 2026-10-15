/*
 * @file 配置快照历史存储（M10 E-02）
 * @description `ConfigHistoryPort` 的 Prisma 实现（`config_snapshots` 表，数据字典 §3.16）：
 *   快照历史与版本基线下沉持久层——多副本下 A 实例写入的版本对 B 实例可见（回滚跨实例一致，
 *   PRD-010 AC2）。append 语义为 upsert（外部事实源轮询与本地推进可能同号，后写者覆盖）；
 *   淘汰策略：保留最近 20 版（与框架 MAX_HISTORY 同口径），超出淘汰最旧。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import type { ConfigHistoryPort, ConfigSnapshotEntry } from '@fw/config-center';

/** 保留版本数（与 @fw/config-center 的环形表上限同口径） */
const KEEP_VERSIONS = 20;

/** config_snapshots 表行投影 */
interface SnapshotRow {
  version: number;
  overlay: string;
  appliedAt: Date;
}

/** delegate 形状（本地投影，避免依赖生成类型） */
interface SnapshotDelegate {
  upsert(args: { where: { version: number }; create: { version: number; overlay: string; appliedAt: Date }; update: { overlay: string; appliedAt: Date } }): Promise<SnapshotRow>;
  findFirst(args: Record<string, unknown>): Promise<SnapshotRow | null>;
  findMany(args: Record<string, unknown>): Promise<SnapshotRow[]>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

/** 行 → 历史条目投影 */
function toEntry(row: SnapshotRow): ConfigSnapshotEntry {
  return {
    version: row.version,
    at: row.appliedAt.toISOString(),
    overlay: JSON.parse(row.overlay) as Record<string, unknown>,
  };
}

/**
 * Prisma 实现：config_snapshots 表（多实例共享的快照历史与版本基线）
 */
@Injectable()
export class PrismaConfigHistoryStore implements ConfigHistoryPort {
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  private get delegate(): SnapshotDelegate {
    return (this.client as unknown as Record<string, SnapshotDelegate>).configSnapshot;
  }

  async append(entry: ConfigSnapshotEntry): Promise<void> {
    const overlay = JSON.stringify(entry.overlay);
    await this.delegate.upsert({
      where: { version: entry.version },
      create: { version: entry.version, overlay, appliedAt: new Date(entry.at) },
      update: { overlay, appliedAt: new Date(entry.at) },
    });
    // 淘汰：只保留最近 KEEP_VERSIONS 版（version 降序窗口之外的删除）
    const keep = await this.delegate.findMany({
      orderBy: { version: 'desc' },
      take: KEEP_VERSIONS,
    });
    const minKeep = keep.length > 0 ? keep[keep.length - 1].version : entry.version;
    await this.delegate.deleteMany({ where: { version: { lt: minKeep } } });
  }

  async latest(): Promise<ConfigSnapshotEntry | null> {
    const row = await this.delegate.findFirst({ orderBy: { version: 'desc' } });
    return row ? toEntry(row) : null;
  }

  async findByVersion(version: number): Promise<ConfigSnapshotEntry | null> {
    const row = await this.delegate.findFirst({ where: { version } });
    return row ? toEntry(row) : null;
  }

  async list(limit: number): Promise<ConfigSnapshotEntry[]> {
    const rows = await this.delegate.findMany({ orderBy: { version: 'desc' }, take: limit });
    return rows.map(toEntry);
  }
}
