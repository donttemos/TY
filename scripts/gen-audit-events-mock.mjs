#!/usr/bin/env node
/*
 * @file 生成 mock 侧审计事件注册表（PRD-015 FR-15-01）
 * @description admin-web 的 mock 是独立进程，拿不到 `@fw/auth` 的运行时；若手抄一份事件表，
 *   必然与后端漂移（B3 首版只抄了 12 条，页面上大半事件显示「未登记」）。
 *   本脚本从后端注册表**生成** `apps/admin-web/mock/audit-events.ts`，
 *   `check:audit-events` 会校验生成物是否最新——生成物不是手写文件。
 *
 *   运行：pnpm run gen:audit-events-mock（改动注册表后必须重跑）
 * @author donttemo
 * @created 2026-10-20
 * @module scripts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const OUT = join(ROOT, 'apps', 'admin-web', 'mock', 'audit-events.ts');

/** 生成文件内容（确定性输出，供门禁逐字节比对） */
export async function buildMockAuditEventsFile() {
  const registry = await import(pathToFileURL(join(ROOT, 'packages', 'auth', 'src', 'audit-events.ts')).href);
  const rows = registry.AUDIT_EVENTS.map((item) => ({
    code: item.code,
    name: item.name,
    category: item.category,
    risk: item.risk,
    summaryTemplate: item.summaryTemplate ?? null,
    reviewRequired: item.reviewRequired ?? false,
  }));

  const body = rows
    .map(
      (row) =>
        `  { code: ${JSON.stringify(row.code)}, name: ${JSON.stringify(row.name)}, category: ${JSON.stringify(row.category)}, risk: ${JSON.stringify(row.risk)}, summaryTemplate: ${JSON.stringify(row.summaryTemplate)}, reviewRequired: ${row.reviewRequired} },`,
    )
    .join('\n');

  return `/*
 * @file 审计事件注册表（mock 侧，**自动生成，勿手改**）
 * @description 由 scripts/gen-audit-events-mock.mjs 从 packages/auth/src/audit-events.ts 生成。
 *   mock 是独立进程，无法 import 后端运行时；手抄必然漂移（B3 首版只抄 12 条，
 *   页面上大半事件显示「未登记」）。改动注册表后运行 \`pnpm run gen:audit-events-mock\`，
 *   \`check:audit-events\` 会校验本文件是否最新。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/mock
 */

/** 事件定义（仅演示所需字段；完整定义以服务端下发为准） */
export const MOCK_AUDIT_EVENTS = [
${body}
] as const;
`;
}

/** CLI 入口 */
async function main() {
  const content = await buildMockAuditEventsFile();
  writeFileSync(OUT, content, 'utf8');
  console.log('[audit-events-mock] 已生成 %s', OUT);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
