/*
 * @file 租户管理存储端口与 Prisma 实现（N-01，api-spec §3.9）
 * @description 平台管理员视角的租户生命周期能力：分页列表 / 详情 / 开租户 / 改套餐与状态 / 停用 / 隔离级别迁移。
 *   与 @fw/tenant 的 TenantStorePort 分工：
 *     - TenantStorePort：运行时**解析**用（按 code 查一条，供守卫 fail-closed 判定，只读）；
 *     - TenantAdminStore：管理面**维护**能力（写操作 + 列表增强字段），不改动框架包契约，避免回归。
 *   与 `users.tenant_id` 的 bigint 语义对齐：主键为十进制数字字符串，新租户取「现有最大数字 ID + 1」，
 *   保证与种子（'0'=legacy / '1'=acme / '2'=off / '3'=dedicated）同一取值空间。
 *   db_url_enc 只存密文；对外视图只暴露 `dedicatedDbConfigured` 布尔位，绝不下发明文或密文。
 *   **status 写权**（ADR-0031 §2.3 / ADR-0029 §2.4）：本端口**不提供任何 status 迁移写点**——
 *   状态变更一律由 TenantAdminController 交给 TenantLifecycleService（条件更新 + 迁移日志），
 *   本端口只在开租户时写初始态 1。视图如实透出五态编值（0 存量停用 / 1 / 2 / 3 / 4 / 5）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-21 donttemo P0 收口：移除 disableTenant 与 update.status 直写；视图透出五态真实编值
 * @module example-api/tenant
 */

import { Inject, Injectable } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { DB_CLIENT, PrismaRepository, type PageResult, type PrismaClientLike } from '@fw/db';
import type { BaseEntity, Sort } from '@fw/db';
import { TENANT_CODE_PATTERN, type TenantIsolation } from '@fw/tenant';
import { decryptDbUrl, encryptDbUrl } from './db-url-crypto.js';

/** tenants 表行（Prisma 生成类型的本地投影） */
interface TenantRow extends Omit<BaseEntity, 'id'> {
  id: string;
  code: string;
  name: string;
  isolation: string;
  dbUrlEnc: string | null;
  plan: string | null;
  status: number;
  expireAt: Date | null;
}

/**
 * 租户状态 Int（ADR-0029 §2.4 五态编码，读写口径与 SaasStore 完全一致）：
 * 0 存量停用（读作 frozen）/ 1 active / 2 grace / 3 frozen / 4 terminated / 5 pending。
 * 管理端视图**如实透出**真实编值——此前把非 1 一律折叠成 0，使 grace/frozen/terminated
 * 在管理端全部显示为「停用」，并给「启用」留出了绕过终止态的入口。
 */
export type TenantStatus = 0 | 1 | 2 | 3 | 4 | 5;

/** 合法编值集合（未知脏值 fail-closed 归 3，见 toTenantStatus） */
const KNOWN_TENANT_STATUS: readonly number[] = [0, 1, 2, 3, 4, 5];

/** 租户对外视图（C-06 契约 §3.9 TenantView；不含任何连接串信息） */
export interface TenantView {
  id: string;
  code: string;
  name: string;
  isolation: TenantIsolation;
  plan: string | null;
  status: TenantStatus;
  expireAt: string | null;
  /** 是否已配置独立库连接串（dedicated 迁移完成的标志位；只回传布尔位） */
  dedicatedDbConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 分页查询入参 */
export interface TenantAdminQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  isolation?: string;
  status?: number;
  sort?: Sort<TenantRow>;
}

/** 开租户入参 */
export interface TenantCreateInput {
  code: string;
  name: string;
  isolation: TenantIsolation;
  plan?: string | null;
  expireAt?: string | null;
  /** dedicated 必填：独立库连接串（明文，落库前加密） */
  dbUrl?: string | null;
}

/** 更新入参（不含 code / isolation：code 是解析键，isolation 一律走 migrate；
 *  **不含 status**：状态是生命周期动作而非可直写字段，写权唯一归属 TenantLifecycleService，见 ADR-0031 §2.3） */
export interface TenantUpdateInput {
  name?: string;
  plan?: string | null;
  expireAt?: string | null;
}

/** 隔离级别白名单 */
const ISOLATIONS: readonly TenantIsolation[] = ['shared', 'dedicated'];

/** legacy 租户 ID：存量单租户数据的归属租户，停用 / 迁移都会让历史数据整体不可达，一律拒绝 */
export const LEGACY_TENANT_ID = '0';

/** 租户管理存储注入令牌 */
export const TENANT_ADMIN_STORE = Symbol('FW_TENANT_ADMIN_STORE');

/**
 * 租户管理存储端口
 */
export interface TenantAdminStore {
  /** 分页列表 */
  pageTenants(query: TenantAdminQuery): Promise<PageResult<TenantView>>;
  /** 按主键查（软删返回 null） */
  findTenantViewById(id: string): Promise<TenantView | null>;
  /** 按编码查（唯一性预检，避免把唯一约束冲突抛成 500） */
  findTenantByCode(code: string): Promise<TenantView | null>;
  /** 开租户：编码唯一、dedicated 必须带连接串（初始状态写 1 是本端口唯一的 status 写点） */
  createTenant(input: TenantCreateInput): Promise<TenantView>;
  /** 改名称 / 套餐 / 到期时间（**不接受 status**：状态迁移走 TenantLifecycleService） */
  updateTenant(id: string, patch: TenantUpdateInput): Promise<TenantView>;
  /** 隔离级别迁移（控制面切换：写 isolation 与连接串密文） */
  setTenantIsolation(id: string, isolation: TenantIsolation, dbUrl: string | null): Promise<TenantView>;
  /** 该租户下的账号数（停用 / 迁移前的规模提示） */
  countTenantUsers(id: string): Promise<number>;
}

/**
 * TenantAdminStore 的 Prisma 实现
 */
@Injectable()
export class PrismaTenantAdminStore implements TenantAdminStore {
  private readonly tenants: PrismaRepository<TenantRow>;

  /** @param client DbModule 提供的插桩 PrismaClient */
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {
    this.tenants = new PrismaRepository<TenantRow>(client, 'tenant');
  }

  async pageTenants(query: TenantAdminQuery): Promise<PageResult<TenantView>> {
    const where: Record<string, unknown> = {};
    if (query.keyword) {
      where.OR = [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }];
    }
    if (query.isolation) where.isolation = query.isolation;
    if (query.status !== undefined) where.status = query.status;
    const result = await this.tenants.page({ page: query.page, pageSize: query.pageSize, where, sort: query.sort });
    return { ...result, items: result.items.map((row) => toView(row)) };
  }

  async findTenantViewById(id: string): Promise<TenantView | null> {
    const row = await this.tenants.findById(id);
    return row ? toView(row) : null;
  }

  async findTenantByCode(code: string): Promise<TenantView | null> {
    const row = await this.tenants.findOne({ code });
    return row ? toView(row) : null;
  }

  async createTenant(input: TenantCreateInput): Promise<TenantView> {
    const code = input.code?.trim() ?? '';
    if (!TENANT_CODE_PATTERN.test(code)) {
      throw new BizError(ErrorCode.BAD_REQUEST, '租户编码仅允许小写字母 / 数字 / 连字符，长度 1–64，且以字母或数字开头');
    }
    if (!input.name?.trim()) throw new BizError(ErrorCode.BAD_REQUEST, '租户名称必填');
    const isolation = assertIsolation(input.isolation);
    assertDbUrlForIsolation(isolation, input.dbUrl ?? null);
    if (await this.findTenantByCode(code)) {
      throw new BizError(ErrorCode.CONFLICT, `租户编码已存在：${code}`);
    }

    const row = await this.tenants.create({
      id: await this.nextTenantId(),
      code,
      name: input.name.trim(),
      isolation,
      dbUrlEnc: input.dbUrl ? encryptDbUrl(input.dbUrl) : null,
      plan: input.plan ?? null,
      status: 1,
      expireAt: input.expireAt ? new Date(input.expireAt) : null,
    } as Partial<TenantRow>);
    return toView(row as TenantRow);
  }

  async updateTenant(id: string, patch: TenantUpdateInput): Promise<TenantView> {
    const before = await this.tenants.findById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '租户不存在');
    const data: Partial<TenantRow> = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new BizError(ErrorCode.BAD_REQUEST, '租户名称不能为空');
      data.name = patch.name.trim();
    }
    if (patch.plan !== undefined) data.plan = patch.plan;
    if (patch.expireAt !== undefined) data.expireAt = patch.expireAt ? new Date(patch.expireAt) : null;
    const row = await this.tenants.update(id, data);
    return toView(row as TenantRow);
  }

  async setTenantIsolation(id: string, isolation: TenantIsolation, dbUrl: string | null): Promise<TenantView> {
    if (id === LEGACY_TENANT_ID) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '存量单租户（legacy）不可迁移隔离级别：其数据分布在共享库，切换数据源会整体失联');
    }
    const before = await this.tenants.findById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '租户不存在');
    const target = assertIsolation(isolation);
    assertDbUrlForIsolation(target, dbUrl);
    const current = before.isolation === 'dedicated' ? 'dedicated' : 'shared';
    if (current === target) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, `租户已是 ${target} 隔离级别，无需迁移`);
    }
    const row = await this.tenants.update(id, {
      isolation: target,
      dbUrlEnc: dbUrl ? encryptDbUrl(dbUrl) : null,
    } as Partial<TenantRow>);
    return toView(row as TenantRow);
  }

  async countTenantUsers(id: string): Promise<number> {
    const delegate = (this.client as unknown as Record<string, { count: (args: unknown) => Promise<number> }>).user;
    return delegate.count({ where: { tenantId: BigInt(id), deletedAt: null } });
  }

  /**
   * 生成下一个租户 ID：现有最大数字 ID + 1。
   * 主键是十进制数字字符串（与 users.tenant_id 的 bigint 对齐），不能像其他表那样用 uuid。
   */
  private async nextTenantId(): Promise<string> {
    const rows = await this.tenants.list();
    let max = 0;
    for (const row of rows) {
      if (/^[0-9]+$/.test(row.id)) max = Math.max(max, Number(row.id));
    }
    return String(max + 1);
  }
}

/** 状态编值归一：已知码原样透出；未知脏值 fail-closed 归 3（frozen），与 SaasStore 读口径一致 */
function toTenantStatus(raw: number): TenantStatus {
  return (KNOWN_TENANT_STATUS.includes(raw) ? raw : 3) as TenantStatus;
}

/** 行 → 视图 */
function toView(row: TenantRow): TenantView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isolation: row.isolation === 'dedicated' ? 'dedicated' : 'shared',
    plan: row.plan,
    status: toTenantStatus(row.status),
    expireAt: row.expireAt ? row.expireAt.toISOString() : null,
    // 只回传「是否已配置」；密文与明文都不出网
    dedicatedDbConfigured: Boolean(row.dbUrlEnc),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 校验并归一隔离级别 */
function assertIsolation(value: unknown): TenantIsolation {
  if (typeof value !== 'string' || !ISOLATIONS.includes(value as TenantIsolation)) {
    throw new BizError(ErrorCode.BAD_REQUEST, `isolation 仅支持 ${ISOLATIONS.join(' / ')}`);
  }
  return value as TenantIsolation;
}

/** dedicated 必须有连接串；shared 不接受连接串（避免留下「切回共享库但密文还在」的错觉） */
function assertDbUrlForIsolation(isolation: TenantIsolation, dbUrl: string | null): void {
  if (isolation === 'dedicated' && (!dbUrl || !dbUrl.trim())) {
    throw new BizError(ErrorCode.BAD_REQUEST, 'dedicated 隔离级别必须提供独立库连接串 dbUrl');
  }
  if (isolation === 'shared' && dbUrl) {
    throw new BizError(ErrorCode.BAD_REQUEST, 'shared 隔离级别不接受 dbUrl（连接串会在迁移时清除）');
  }
}

/** 密文可解密性自检（迁移前校验密钥与密文匹配，避免落一个永远解不开的连接串） */
export function assertDecryptable(enc: string): void {
  decryptDbUrl(enc);
}
