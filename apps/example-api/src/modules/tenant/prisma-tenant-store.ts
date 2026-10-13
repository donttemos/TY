/*
 * @file 租户存储的 Prisma 实现（业务侧适配器）
 * @description 把 @fw/tenant 的 TenantStorePort 端口映射到 example-api 的 `tenants` 表
 *   （数据字典 §3.10）。`id` 为稳定字符串（'0' = 存量单租户数据，'1'… 为 M8 建租户），
 *   与 users.tenant_id 的 bigint 语义逐字对齐；软删过滤与审计字段由表结构通用约定保证。
 *   M8 T-M8-02：dedicated 租户的 db_url_enc 在此解密为 dbUrl（AES-256-GCM，见 db-url-crypto），
 *   解密失败直接抛错（租户不可用 → 403），绝不降级为共享库。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-02 解密 db_url_enc（dedicated 独立库连接串）
 * @module example-api/tenant
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import type { TenantInfo, TenantStorePort } from '@fw/tenant';
import { decryptDbUrl } from './db-url-crypto.js';

/** tenants 表行（Prisma 生成类型的本地投影，避免直接依赖 @prisma/client 泛型） */
interface TenantRow {
  id: string;
  code: string;
  name: string;
  isolation: string;
  dbUrlEnc: string | null;
  status: number;
  expireAt: Date | null;
  deletedAt: Date | null;
}

/** 行 → 租户信息投影 */
function toInfo(row: TenantRow): TenantInfo {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isolation: row.isolation === 'dedicated' ? 'dedicated' : 'shared',
    // dedicated 租户解密独立库连接串；shared 租户无密文（dbUrl=null）
    dbUrl: row.dbUrlEnc ? decryptDbUrl(row.dbUrlEnc) : null,
    status: row.status === 1 ? 1 : 0,
    expireAt: row.expireAt ? row.expireAt.toISOString() : null,
  };
}

/**
 * 租户存储实现：单查询按 code 定位（含软删过滤），供 TenantService 缓存与 fail-closed 判定
 */
@Injectable()
export class PrismaTenantStore implements TenantStorePort {
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  async findTenantByCode(code: string): Promise<TenantInfo | null> {
    const delegate = (this.client as unknown as Record<string, { findFirst: (args: unknown) => Promise<TenantRow | null> }>).tenant;
    const row = await delegate.findFirst({ where: { code, deletedAt: null } });
    return row ? toInfo(row) : null;
  }
}
