#!/usr/bin/env node
/*
 * @file 码表工件生成器（PRD-012 OBS-03，ADR-0025 §2.2 码表单一来源）
 * @description 从唯一权威 @fw/core 的 error-codes.ts（ErrorCode + ERROR_CODE_META）生成可消费工件
 *   packages/core/error-codes.json。前端与 mock 不直接依赖后端包（OQ-6：避免打包后端代码与循环依赖），
 *   一致性由 check-triway-consistency 的码表轴（axis G）构建期断言锁定——人为篡改任意一份副本即构建失败。
 *   用法：`pnpm gen:error-codes`（或 `node scripts/gen-error-codes-json.mjs [--check]`）。
 *   --check 模式只校验已提交工件是否与源同源（供门禁调用），不写文件。
 * @author donttemo
 * @created 2026-10-17
 * @module scripts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOURCE = join(ROOT, 'packages/core/src/errors/error-codes.ts');
const TARGET = join(ROOT, 'packages/core/error-codes.json');

/** 从 TS 源解析 ErrorCode 常量块与 ERROR_CODE_META 块（结构受门禁约束，保持简单正则） */
export async function parseErrorCodeTable() {
  const text = await readFile(SOURCE, 'utf8');
  const codeStart = text.indexOf('export const ErrorCode = {');
  const codeEnd = text.indexOf('\n} as const;', codeStart);
  if (codeStart === -1 || codeEnd === -1) throw new Error('未找到 ErrorCode 常量块（packages/core/src/errors/error-codes.ts）');
  const codes = {};
  for (const m of text.slice(codeStart, codeEnd).matchAll(/^\s{2}([A-Z_]+):\s*(\d+),/gm)) {
    codes[m[1]] = Number(m[2]);
  }

  const metaStart = text.indexOf('export const ERROR_CODE_META: Record<BizErrorCode, ErrorCodeMeta> = {');
  const metaEnd = text.indexOf('\n};', metaStart);
  if (metaStart === -1 || metaEnd === -1) throw new Error('未找到 ERROR_CODE_META 块');
  const meta = {};
  for (const m of text.slice(metaStart, metaEnd).matchAll(/^\s{2}\[ErrorCode\.([A-Z_]+)\]:\s*\{\s*http:\s*(\d+),\s*message:\s*'([^']*)'\s*\},/gm)) {
    meta[codes[m[1]]] = { http: Number(m[2]), message: m[3] };
  }

  if (Object.keys(codes).length === 0 || Object.keys(meta).length === 0) {
    throw new Error('码表解析结果为空（error-codes.ts 结构变化时须同步本解析器）');
  }
  for (const key of Object.keys(codes)) {
    if (codes[key] !== 0 && !meta[codes[key]]) {
      throw new Error(`错误码 ${key}(${codes[key]}) 缺少 ERROR_CODE_META 条目（http + message 必填）`);
    }
  }
  return { codes, meta };
}

async function main() {
  const check = process.argv.includes('--check');
  const table = await parseErrorCodeTable();
  const artifact = JSON.stringify({ generatedFrom: 'packages/core/src/errors/error-codes.ts', ...table }, null, 2) + '\n';
  if (check) {
    const committed = await readFile(TARGET, 'utf8');
    if (committed !== artifact) {
      console.error('[gen-error-codes] error-codes.json 与 @fw/core 码表不同源——运行 `pnpm gen:error-codes` 重新生成');
      process.exit(1);
    }
    console.log('[gen-error-codes] OK：error-codes.json 与 @fw/core 码表同源（%d 个码）', Object.keys(table.codes).length);
    return;
  }
  await writeFile(TARGET, artifact, 'utf8');
  console.log('[gen-error-codes] 已生成 %s（%d 个码）', 'packages/core/error-codes.json', Object.keys(table.codes).length);
}

main().catch((error) => {
  console.error('[gen-error-codes] 解析失败：', error);
  process.exit(2);
});
