#!/usr/bin/env node
/*
 * @file 禁裸抛门禁（PRD-012 OBS-02，ADR-0025 三类治理）
 * @description 扫描生产代码的 `throw new Error(`，强制全框架错误经唯一模型 `@fw/core BizError` 产出，
 *   杜绝「裸抛被 GlobalExceptionFilter 一律收敛 9001、丢失精确语义」。沿既有门禁范式（check-no-raw-sql 同款）：
 *
 *   扫描范围：packages 与 apps 各包 src、templates 各模板的 server/src 下的 .ts 生产文件
 *   （排除测试：__tests__/ 目录、*.test.ts、*.spec.ts、*.d.ts；排除前端 mock：mock/ 目录）。
 *
 *   白名单（不视为违规）：
 *     ① packages/cli/** —— CLI 不暴露 HTTP，错误直达开发者终端，无信封收敛问题（PRD-012 OBS-02）；
 *     ② 行级显式豁免注解 `// fw-allow-raw-throw: <理由>` —— 非目录级通配，每处必须给理由；
 *        既有豁免：TokenService（ADR-0020 Rule 8 冻结，NG12-6 / AC-OBS-10 diff=0）与
 *        demo 演示本体（演示对象就是「未知异常收敛 9001」语义本身）。
 *
 *   退出码：0 = 生产目录零未豁免命中；1 = 存在未豁免裸抛（CI 阻断）。
 * @author donttemo
 * @created 2026-10-17
 * @module scripts
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const EXEMPT_MARKER = 'fw-allow-raw-throw:';
const PATTERN = /throw\s+new\s+Error\s*\(/g;

/** 白名单目录：CLI 不暴露 HTTP（PRD-012 OBS-02 显式白名单，非豁免注解） */
const WHITELIST_DIRS = ['packages/cli'];

/**
 * 白名单文件（单文件精确豁免，非目录级通配；理由登记 ADR-0025 §2.1）：
 * packages/auth/src/token.service.ts —— ADR-0020 Rule 8 冻结 TokenService（NG12-6 / AC-OBS-10
 * 要求文件 diff = 0，因此不能加行内豁免注解）；其 4 处裸抛为启动期配置 fail-fast（×2）
 * 与②类解密路由内部信号（×2，调用方捕获映射），语义上即统一表达。
 */
const WHITELIST_FILES = ['packages/auth/src/token.service.ts'];

/** 是否测试 / 声明文件（与 check-file-headers 的生产文件口径一致） */
function isTestOrDecl(relPath) {
  const segs = relPath.split(sep);
  if (segs.includes('__tests__') || segs.includes('mock')) return true;
  return /\.(test|spec|d)\.ts$/.test(relPath);
}

/** 是否白名单路径（CLI 或精确文件）—— rel 统一正斜杠比较，兼容 Windows 分隔符 */
function isWhitelisted(relPath) {
  const norm = relPath.split(sep).join('/');
  if (WHITELIST_FILES.includes(norm)) return true;
  return WHITELIST_DIRS.some((dir) => norm.startsWith(dir + '/'));
}

async function collectTsFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SCAN_ROOTS = [];
for (const group of ['packages', 'apps', 'templates']) {
  const groupDir = join(ROOT, group);
  let entries;
  try {
    entries = await readdir(groupDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // templates 只扫 server 侧（模板 admin-web 前端无裸抛面，且与 check 口径一致）
    if (group === 'templates') {
      const serverSrc = join(groupDir, entry.name, 'server', 'src');
      try {
        if ((await stat(serverSrc)).isDirectory()) SCAN_ROOTS.push(serverSrc);
      } catch {
        /* 模板无 server 侧则跳过 */
      }
      continue;
    }
    const srcDir = join(groupDir, entry.name, 'src');
    try {
      if ((await stat(srcDir)).isDirectory()) SCAN_ROOTS.push(srcDir);
    } catch {
      /* 无 src 则跳过 */
    }
  }
}

const violations = [];
let scanned = 0;
let exempted = 0;

for (const srcDir of SCAN_ROOTS) {
  const files = await collectTsFiles(srcDir);
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (isTestOrDecl(rel)) continue;
    if (isWhitelisted(rel)) continue;
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    scanned += 1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // 注释行不参与匹配（doc 注释里的「禁止裸 throw new Error()」不是抛错点）
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      PATTERN.lastIndex = 0;
      if (!PATTERN.test(lines[i])) continue;
      if (lines[i].includes(EXEMPT_MARKER)) {
        const reason = lines[i].split(EXEMPT_MARKER)[1]?.trim();
        if (!reason) {
          violations.push(`${rel}:${i + 1}  豁免注解缺少理由（fw-allow-raw-throw: 后必须写明原因）`);
        } else {
          exempted += 1;
        }
        continue;
      }
      violations.push(`${rel}:${i + 1}  ${trimmed.slice(0, 110)}`);
    }
  }
}

console.log('[no-raw-throw] 扫描生产文件 %d 个；行级显式豁免 %d 处；白名单文件 %d 个；未豁免裸抛 %d 处', scanned, exempted, WHITELIST_FILES.length, violations.length);

if (violations.length > 0) {
  console.error('\n[no-raw-throw] 生产目录存在未豁免的裸 throw new Error（统一改用 @fw/core BizError，或补行级豁免注解并写明理由）：');
  for (const v of violations) console.error('    - %s', v);
  console.error('\n    修复方式：① 业务/配置/依赖语义 → new BizError(ErrorCode.XXX, message)（码表见 packages/core/src/errors/error-codes.ts）；');
  console.error('              ② 确需保留裸抛（②类内部信号 / Rule 8 冻结 / 演示本体）→ 行尾加 `// fw-allow-raw-throw: <理由>` 并在 ADR-0025 登记。');
  process.exit(1);
}

console.log('[no-raw-throw] OK：生产目录零未豁免裸抛（PRD-012 OBS-02）');
process.exit(0);
