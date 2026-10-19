#!/usr/bin/env node
/*
 * @file 存量租户 SaaS 回填脚本（M13，ADR-0029 §2.2）
 * @description 把存量 `tenants.plan/status/expireAt` 映射到新领域模型（**幂等**：按租户无订阅才建，重复执行零副作用）：
 *   - 确保 `default` 套餐 + v1 published 版本存在（无则建；不发明配额项，plan_quotas 留空 = 不限额）；
 *   - status=1（启用）→ 建 active 订阅（active_marker=tenantId，expireAt 沿用 tenants.expireAt）；
 *   - status=0（停用）→ 建 cancelled 订阅（不占 marker；租户冻结语义由 tenants.status=0 读作 frozen 承载）；
 *   - 已有任何订阅记录的租户 → 跳过；
 *   - 不改写 tenants 三列（派生只读列，由领域服务写路径回填，ADR-0029 §2.2）。
 *   用法：`node scripts/backfill-saas.mjs`（读 cwd 的 .env DB_URL；--dry-run 只打印计划）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// ---- .env 轻加载（cwd = apps/example-api；与 @fw/config 读 cwd/.env 同口径） ----
const envPath = new URL('../.env', import.meta.url);
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* 无 .env 时依赖外部环境变量 */
}

const DRY_RUN = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

async function ensureDefaultPlan() {
  let plan = await prisma.plan.findUnique({ where: { code: 'default' } });
  if (plan) {
    const versions = await prisma.planVersion.findMany({ where: { planId: plan.id } });
    const published = versions.filter((v) => v.status === 'published');
    if (published.length > 0) return { plan, version: published.sort((a, b) => b.version - a.version)[0], created: false };
  }
  if (DRY_RUN) return { plan: { id: '(dry)', code: 'default' }, version: { id: '(dry)', version: 1 }, created: true };
  plan ??= await prisma.plan.create({ data: { code: 'default', name: '基础版', description: '存量租户回填默认套餐（M13 回填脚本）' } });
  const maxVersion = await prisma.planVersion.aggregate({ where: { planId: plan.id }, _max: { version: true } });
  const version = await prisma.planVersion.create({
    data: { planId: plan.id, version: (maxVersion._max.version ?? 0) + 1, status: 'published', remark: 'M13 存量回填', publishedAt: new Date() },
  });
  return { plan, version, created: true };
}

async function main() {
  const { plan, version, created } = await ensureDefaultPlan();
  console.log(`[backfill] 套餐 ${plan.code} ${created ? '新建' : '复用'}，版本 v${version.version}（${version.id}）`);

  const tenants = await prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
  const stats = { total: tenants.length, created: 0, cancelled: 0, skipped: 0 };
  for (const t of tenants) {
    const existing = await prisma.tenantSubscription.findFirst({ where: { tenantId: t.id } });
    if (existing) {
      stats.skipped += 1;
      continue;
    }
    const active = t.status === 1;
    if (DRY_RUN) {
      console.log(`[backfill][dry] tenant=${t.id}(${t.code}) status=${t.status} → ${active ? 'active 订阅' : 'cancelled 订阅'} expireAt=${t.expireAt?.toISOString() ?? 'null'}`);
    } else {
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planId: plan.id,
          planVersionId: version.id,
          status: active ? 'active' : 'cancelled',
          activeMarker: active ? t.id : null,
          effectiveAt: t.createdAt ?? new Date(),
          expireAt: t.expireAt,
          closedAt: active ? null : new Date(),
          reason: 'M13 存量回填（ADR-0029 §2.2）',
        },
      });
    }
    if (active) stats.created += 1;
    else stats.cancelled += 1;
  }

  console.log(`[backfill] 完成：total=${stats.total} active新建=${stats.created} cancelled=${stats.cancelled} 跳过(已有订阅)=${stats.skipped}${DRY_RUN ? '（dry-run 未写库）' : ''}`);
}

main()
  .catch((e) => {
    console.error('[backfill] 失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
