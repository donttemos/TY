/*
 * @file 种子数据脚本
 * @description fw db:seed 执行本脚本：初始化演示字典数据。
 *   M3 起由框架 seed 扩展初始化角色/管理员/权限点（PRD-002 FR-09）。
 * @author donttemo
 * @created 2026-10-12
 * @module __APP_NAME__
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** 初始字典数据 */
const DICTS = [
  { code: 'user_status', label: '用户状态' },
  { code: 'order_status', label: '订单状态' },
];

async function main(): Promise<void> {
  for (const dict of DICTS) {
    // upsert 保证可重复执行（幂等）
    await prisma.dict.upsert({
      where: { code: dict.code },
      create: dict,
      update: dict,
    });
  }
  console.log(`[seed] 已写入 ${DICTS.length} 条字典`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
