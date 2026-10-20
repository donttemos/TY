#!/usr/bin/env node
/*
 * @file 三方一致性门禁（框架包 ↔ example-api ↔ admin 模板）
 * @description 把「框架包实现、example-api 参考实现、admin 模板生成结果」三份同源实现拉平八轴对撞
 *   （A 模板调用面自洽 / B 模板 ⊆ 参考实现 / C 权限码三方同源 / D Prisma 共有模型字段一致 /
 *   E 框架依赖面 / F 配置键面 / G 错误码表单一来源 / H 审计导出 CSV 单元格编码同源），任一轴失败即退出码 1；0 = 全绿；
 *   2 = 解析失败（宁可将 CI 挂红，也不放行未知状态）。背景与各轴细则见下方注释块——
 *   仓库里有三份「同一套框架能力」的实现，任何一份单方面演进都会让另外两份悄悄漂移：
 *   ① 框架包实现（packages/*）：权限码 PERM / 配置键 ENV_KEY_PATHS / 框架控制器 / auth 核心表契约；
 *   ② example-api（apps/example-api）：框架能力的参考实现（全量装配 + 全量种子 + 全量文档键）；
 *   ③ admin 模板生成结果（templates/admin/{server,admin-web}）：fw new --template=admin 的静态资产，
 *      是参考实现的「裁剪子集」，却是每个落地项目的起点。
 *   既有 check-api-parity 只覆盖 admin-web ↔ 后端两侧；模板侧（E-08 起）没有任何对撞，
 *   「模板前端调了模板后端没有的端点」「模板种子发明了框架与参考实现都不知道的权限码」
 *   「example-api 给 auth 核心表加了列而模板没跟」这类漂移，只在用户拿生成项目联调时才第一次暴露。
 * @author donttemo
 * @created 2026-10-17
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-03）：新增轴 G 错误码表单一来源对撞
 * @modified 2026-10-20 donttemo M15 安全加固：新增轴 H 审计导出 CSV 单元格编码同源
 *   （@fw/auth csv.ts ↔ admin-web mock/csv-cell.ts 的危险前缀锚点必须逐字一致）
 * @module scripts
 */

/*
 * 八轴对撞细则：
 *     轴 A 路由面·生成结果自洽：模板 admin-web 调用面 ⊆ 模板后端路由面
 *         （模板 server 控制器 + 其装配的框架包控制器——按模块类名判定装配，未装配不计入）；
 *     轴 B 路由面·模板是参考实现的裁剪子集：模板后端路由面 ⊆ example-api 路由面；
 *     轴 C 权限码三方同源：框架 PERM（含 @fw/queue 的 QUEUE_PERM_*）为唯一权威——
 *         C1 模板 admin-web 使用的码 ⊆ 模板种子声明 ∪ 框架码（前端有的码生成库必须种）；
 *         C2 模板种子声明的应用码 ⊆ example-api 种子声明 ∪ 框架码（模板不发明新码）；
 *         C3/C4 两侧控制器 @Permissions 使用的码 ⊆ 本侧种子声明 ∪ 框架码（守卫的码库里必须有）；
 *     轴 D Prisma 共有模型字段一致：两 schema 共有模型的字段名/类型/属性逐一比对
 *         （@fw/auth 的 Store 契约读写这些表；example-api 改列模板漏改 = 生成项目运行期崩）；
 *     轴 E 框架依赖面：模板声明的 @fw/* 必须存在且为 workspace:*，源码 import 的必须已声明；
 *     轴 F 配置键面：模板 .env.example 的键 ⊆ ENV_KEY_PATHS ∩ example-api .env.example
 *         （example-api .env.example 同时反向 ⊆ ENV_KEY_PATHS）；
 *     轴 G 错误码表单一来源（PRD-012 OBS-03）：@fw/core ErrorCode 为唯一权威——
 *         error-codes.json 工件与源同源（gen-error-codes-json --check）+ 前端 BIZ_CODE / 模板
 *         BIZ_CODE / mock CODE 三副本值集合与 core 全集逐一相等（篡改任意一份即构建失败）；
 *     轴 H 审计导出 CSV 单元格编码同源（PRD-015 FR-15-19 安全加固）：mock 是独立进程、不装
 *         Nest，防护实现必然有两份（@fw/auth 的 csv.ts ↔ admin-web mock/csv-cell.ts）——
 *         两侧的「危险前缀正则 + 中和前缀」锚点必须逐字相同（单侧收紧即「dev 全绿、真机被
 *         Excel 求值」）；行为一致性另有两侧同组向量单测兜底。
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  collectBackendRoutes,
  collectFrontendCalls,
  collectTsFiles,
  endpointKey,
  normalizeMethod,
  stripComments,
} from './lib/api-parity-core.mjs';

const ROOT = process.cwd();
const API_BASE = '/api/v1';

const TPL = join(ROOT, 'templates/admin');
const TPL_SERVER_SRC = join(TPL, 'server/src');
const TPL_WEB_SRC = join(TPL, 'admin-web/src');
const EX_API_SRC = join(ROOT, 'apps/example-api/src');
const PACKAGES_DIR = join(ROOT, 'packages');

/** 框架控制器 → 注册它的模块类（未在应用里引用该类名 = 未装配，其路由不计入该应用路由面） */
const CONTROLLER_MODULE = {
  '@fw/core': 'FwCoreModule',
  '@fw/cache': 'CacheModule',
  '@fw/queue': 'QueueModule',
};

/** 权限码形状：资源:操作（资源段可含连字符——demo-item:read；亦覆盖 system:config:read 三段式） */
const CODE_SHAPE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;

const failures = [];
const hints = [];

function fail(axis, message) {
  failures.push(`[${axis}] ${message}`);
}
function hint(axis, message) {
  hints.push(`[${axis}] ${message}`);
}

async function readText(file) {
  return readFile(file, 'utf8');
}

/* ============================== 轴 A / B：路由面 ============================== */

/** 应用源码里 import 过的框架包集合 */
async function collectImportedFwPackages(srcDir) {
  const imported = new Set();
  for (const file of await collectTsFiles(srcDir)) {
    const text = await readText(file);
    for (const m of text.matchAll(/from\s+'(@fw\/[a-z-]+)[^']*'/g)) imported.add(m[1]);
  }
  return imported;
}

/** 应用实际装配的框架控制器路由（按模块类名判定；未装配的包其控制器不计入） */
async function collectMountedFrameworkRoutes(srcDir) {
  const imported = await collectImportedFwPackages(srcDir);
  const mounted = [];
  for (const pkg of imported) {
    const moduleClass = CONTROLLER_MODULE[pkg];
    if (!moduleClass) continue;
    // 模块类名以词边界出现在任一路径文件里即视为装配（imports: [CacheModule] / forRoot 调用同效）
    let referenced = false;
    for (const file of await collectTsFiles(srcDir)) {
      const text = await readText(file);
      if (new RegExp(`\\b${moduleClass}\\b`).test(text)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) continue;
    const pkgDir = join(PACKAGES_DIR, pkg.replace('@fw/', ''), 'src');
    const { routes } = await collectBackendRoutes([pkgDir]);
    mounted.push(...routes);
  }
  return { routes: mounted, imported };
}

async function axisRoutes() {
  const tplFrontend = await collectFrontendCalls(TPL_WEB_SRC, API_BASE);
  const tplServer = await collectBackendRoutes([TPL_SERVER_SRC]);
  const tplFw = await collectMountedFrameworkRoutes(TPL_SERVER_SRC);
  const exApi = await collectBackendRoutes([EX_API_SRC]);
  const exFw = await collectMountedFrameworkRoutes(EX_API_SRC);

  const tplRoutes = [...tplServer.routes, ...tplFw.routes];
  const exRoutes = [...exApi.routes, ...exFw.routes];
  const tplKeys = new Set(tplRoutes.map((r) => endpointKey(r.method, r.path)));
  const exKeys = new Set(exRoutes.map((r) => endpointKey(r.method, r.path)));

  // 动态调用面（CrudTable 的 props.api 等）：路径首段即模板变量，运行时才确定，不计缺口
  const dynamic = tplFrontend.filter((c) => c.path.startsWith(`${API_BASE}:dyn`));
  const staticCalls = tplFrontend.filter((c) => !c.path.startsWith(`${API_BASE}:dyn`));
  const callKeys = new Set(staticCalls.map((c) => endpointKey(c.method, c.path)));

  console.log('[triway][A] 模板前端调用面 %d 个端点 ↔ 模板后端路由面 %d 个（模板 server %d + 装配框架包 %d）',
    callKeys.size, tplKeys.size, tplServer.routes.length, tplFw.routes.length);
  console.log('[triway][B] 模板后端路由面 %d 个 ⊆ example-api 路由面 %d 个（example-api %d + 装配框架包 %d）',
    tplKeys.size, exKeys.size, exApi.routes.length, exFw.routes.length);
  if (dynamic.length > 0) {
    hint('A', `运行时动态路径（无法静态校验，共 ${dynamic.length} 处调用）：${[...new Set(dynamic.map((c) => c.source))].map((f) => relative(ROOT, f)).join('、')}`);
  }

  // 轴 A：前端调用但模板路由面缺失 → 生成项目里点下去就是 404
  const missingA = staticCalls.filter((c) => !tplKeys.has(endpointKey(c.method, c.path)));
  for (const c of missingA) {
    fail('A', `模板前端调用但模板路由面缺失（生成项目接入即 404）：${endpointKey(c.method, c.path)} ← ${relative(ROOT, c.source)}`);
  }

  // 轴 B：模板有而 example-api 无 → 模板独立演化，与参考实现漂移
  const onlyTpl = tplRoutes.filter((r) => !exKeys.has(endpointKey(r.method, r.path)));
  for (const r of onlyTpl) {
    fail('B', `模板注册了 example-api 没有的路由（模板独立演化）：${endpointKey(r.method, r.path)} ← ${relative(ROOT, r.source)}`);
  }

  // 仅提示：模板路由面前端未调用（register/refresh 由请求层拦截器直连等，属正常）
  const unused = tplRoutes.filter((r) => !callKeys.has(endpointKey(r.method, r.path)));
  if (unused.length > 0) {
    hint('A', `模板路由面前端未调用（属正常，仅提示 ${unused.length} 个）：${unused.map((r) => endpointKey(r.method, r.path)).join('、')}`);
  }
}

/* ============================== 轴 C：权限码 ============================== */

/** 框架权限码：@fw/auth 的 PERM 对象值 + 各包 export const *PERM* = 'code' */
async function collectFrameworkCodes() {
  const values = new Set();
  const byName = new Map(); // 'PERM.USER_READ' / 'QUEUE_PERM_LIST' → 'user:read'
  const authConstants = join(PACKAGES_DIR, 'auth/src/constants.ts');
  const text = await readText(authConstants);
  const blockStart = text.indexOf('export const PERM = {');
  if (blockStart === -1) throw new Error('未找到 @fw/auth 的 PERM 定义（packages/auth/src/constants.ts）');
  const blockEnd = text.indexOf('\n}', blockStart);
  const block = text.slice(blockStart, blockEnd);
  for (const m of block.matchAll(/^\s{2}([A-Z_]+):\s*'([^']+)'/gm)) {
    values.add(m[2]);
    byName.set(`PERM.${m[1]}`, m[2]);
  }
  // 其它框架包的权限码常量（如 @fw/queue 的 QUEUE_PERM_LIST / QUEUE_PERM_MANAGE）
  for (const pkg of await readdir(PACKAGES_DIR)) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of await collectTsFiles(srcDir)) {
      if (file.endsWith('.test.ts')) continue;
      const pkgText = await readText(file);
      for (const m of pkgText.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*PERM[A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
        values.add(m[2]);
        byName.set(m[1], m[2]);
      }
    }
  }
  return { values, byName };
}

/** 解析 @Permissions(ARG) 实参：'raw' | PERM.X | QUEUE_PERM_X | [混合数组] */
function parsePermissionArgs(rawArgs, fw) {
  const codes = [];
  const unresolved = [];
  const parts = rawArgs.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const quoted = part.match(/^['"`]([^'"`]+)['"`]$/);
    if (quoted) {
      codes.push(quoted[1]);
      continue;
    }
    const ident = part.match(/^([A-Za-z_][A-Za-z0-9_.]*)$/);
    if (ident) {
      const value = fw.byName.get(ident[1]);
      if (value !== undefined) codes.push(value);
      else unresolved.push(ident[1]);
      continue;
    }
    // 数组形式 ["a", PERM.X]：抽取其中的字面量与标识符
    for (const m of part.matchAll(/['"`]([^'"`]+)['"`]/g)) codes.push(m[1]);
    for (const m of part.matchAll(/\b(PERM\.[A-Z_]+|[A-Z][A-Z0-9_]*PERM[A-Z0-9_]*)\b/g)) {
      const value = fw.byName.get(m[1]);
      if (value !== undefined) codes.push(value);
      else unresolved.push(m[1]);
    }
  }
  return { codes, unresolved };
}

/** 控制器守卫使用的权限码（*.controller.ts 的 @Permissions） */
async function collectControllerCodes(srcDir, fw) {
  const used = [];
  const unresolved = [];
  for (const file of await collectTsFiles(srcDir)) {
    if (!file.endsWith('.controller.ts')) continue;
    const text = stripComments(await readText(file));
    for (const m of text.matchAll(/@Permissions\(([^)]*)\)/g)) {
      const { codes, unresolved: un } = parsePermissionArgs(m[1], fw);
      for (const code of codes) used.push({ code, source: file });
      unresolved.push(...un.map((u) => ({ name: u, source: file })));
    }
  }
  return { used, unresolved };
}

/** 种子声明的权限码：PERM.X 引用归框架，裸字面量归应用声明 */
async function collectSeedCodes(seedPaths, fw) {
  const app = new Map(); // code → source
  const framework = new Set();
  const rawFrameworkDuplicates = [];
  const files = [];
  for (const target of seedPaths) {
    if (!existsSync(target)) continue;
    const stat = await import('node:fs').then((fs) => fs.statSync(target));
    if (stat.isDirectory()) files.push(...(await collectTsFiles(target)));
    else files.push(target);
  }
  for (const file of files) {
    const text = stripComments(await readText(file));
    for (const m of text.matchAll(/\b(PERM\.[A-Z_]+|[A-Z][A-Z0-9_]*PERM[A-Z0-9_]*)\b/g)) {
      const value = fw.byName.get(m[1]);
      if (value !== undefined) framework.add(value);
    }
    for (const m of text.matchAll(/'([^']+)'/g)) {
      const code = m[1];
      if (!CODE_SHAPE.test(code)) continue;
      if (fw.values.has(code)) {
        rawFrameworkDuplicates.push({ code, source: file });
        framework.add(code);
      } else if (!app.has(code)) {
        app.set(code, file);
      }
    }
  }
  return { app, framework, rawFrameworkDuplicates };
}

/** 前端使用的权限码：v-permission / hasPermission('x') / hasPermi('x') / permission: 'x' */
async function collectWebCodes(srcDir) {
  const used = [];
  for (const file of await collectTsFiles(srcDir)) {
    let text = await readText(file);
    if (file.endsWith('.vue')) text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = stripComments(text);
    const patterns = [
      /v-permission\s*=\s*"([^"]*)"/g,
      /\bhasPerm(?:ission|i)\(\s*'([^']+)'\s*\)/g,
      /\bpermission:\s*'([^']+)'/g,
    ];
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        // v-permission 属性值可能是数组形式 ["a","b"]，逐个抽取
        for (const code of m[1].matchAll(/'([^']+)'/g)) {
          if (CODE_SHAPE.test(code[1])) used.push({ code: code[1], source: file });
        }
        if (CODE_SHAPE.test(m[1])) used.push({ code: m[1], source: file });
      }
    }
  }
  return used;
}

async function axisPermissions(fw) {
  const tplSeed = await collectSeedCodes([
    join(TPL, 'server/prisma/seed.ts'),
    join(TPL, 'server/prisma/seed'),
  ], fw);
  const exSeed = await collectSeedCodes([
    join(ROOT, 'apps/example-api/prisma/seed.ts'),
    join(ROOT, 'apps/example-api/prisma/seed'),
  ], fw);
  const tplCtl = await collectControllerCodes(TPL_SERVER_SRC, fw);
  const exCtl = await collectControllerCodes(EX_API_SRC, fw);
  const tplWeb = await collectWebCodes(TPL_WEB_SRC);

  const tplDeclared = new Set([...tplSeed.app.keys(), ...tplSeed.framework]);
  const exDeclared = new Set([...exSeed.app.keys(), ...exSeed.framework]);
  const referencePool = new Set([...exDeclared, ...fw.values]);

  console.log('[triway][C] 框架权限码 %d 个；模板种子声明 %d 个（框架 %d + 应用 %d）；example-api 种子声明 %d 个',
    fw.values.size, tplDeclared.size, tplSeed.framework.size, tplSeed.app.size, exDeclared.size);

  // C1：模板 admin-web 使用的码，生成库必须种得出（或框架内置）
  const webMissing = tplWeb.filter((u) => !tplDeclared.has(u.code));
  for (const u of webMissing) {
    fail('C1', `模板 admin-web 使用权限码 ${u.code}，但模板种子未声明（按钮/入口将永不出现）：${relative(ROOT, u.source)}`);
  }

  // C2：模板种子声明的应用码，必须是框架码或参考实现已声明的码（模板不发明新码）
  for (const [code, source] of tplSeed.app) {
    if (!referencePool.has(code)) {
      fail('C2', `模板种子发明了框架与 example-api 均未声明的权限码 ${code}：${relative(ROOT, source)}`);
    }
  }

  // C3/C4：控制器守卫的码，本侧种子必须声明（守卫一个种不出的码 = 端点永久 3002）
  for (const [label, rule, ctl, declared] of [
    ['example-api', 'C3', exCtl, exDeclared],
    ['模板', 'C4', tplCtl, tplDeclared],
  ]) {
    const missing = ctl.used.filter((u) => !declared.has(u.code) && !fw.values.has(u.code));
    for (const u of missing) {
      fail(rule, `${label}控制器 @Permissions(${u.code}) 未被本侧种子声明（端点将永久 3002）：${relative(ROOT, u.source)}`);
    }
    for (const u of ctl.unresolved) {
      hint(rule, `${label}控制器 @Permissions 引用无法静态解析的标识符 ${u.name}（需人工核对）：${relative(ROOT, u.source)}`);
    }
  }

  // 仅提示：种子里的裸字面量与框架码重复（应改用 PERM 常量，保持同源）
  for (const dup of [...tplSeed.rawFrameworkDuplicates, ...exSeed.rawFrameworkDuplicates]) {
    hint('C', `种子以裸字面量书写框架权限码 ${dup.code}（建议改用 PERM 常量保持同源）：${relative(ROOT, dup.source)}`);
  }
}

/* ============================== 轴 D：Prisma 模型 ============================== */

/** 解析 schema：模型名 → { fields: Map<name, signature>, blockAttrs: string[] } */
function parsePrismaModels(text) {
  const models = new Map();
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const fields = new Map();
    const blockAttrs = [];
    for (const rawLine of match[2].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('@@')) {
        blockAttrs.push(line);
        continue;
      }
      const field = line.match(/^(\w+)\s+(\S+)(.*)$/);
      if (!field) continue;
      // 字段签名 = 名 + 类型 + 属性（剥掉 @map 列名映射——两仓表名字段映射约定不同，属应用层选择）
      const attrs = field[3].replace(/@map\("[^"]*"\)/g, '').replace(/\s+/g, ' ').trim();
      fields.set(field[1], `${field[2]}${attrs ? ` ${attrs}` : ''}`);
    }
    models.set(name, { fields, blockAttrs });
  }
  return models;
}

async function axisModels() {
  const exSchema = parsePrismaModels(await readText(join(ROOT, 'apps/example-api/prisma/schema.prisma')));
  const tplSchema = parsePrismaModels(await readText(join(TPL, 'server/prisma/schema.prisma')));
  const shared = [...exSchema.keys()].filter((name) => tplSchema.has(name));
  console.log('[triway][D] Prisma 共有模型 %d 个（example-api %d / 模板 %d，模板按设计不含租户/任务/配置中心等面）',
    shared.length, exSchema.size, tplSchema.size);

  for (const name of shared) {
    const exFields = exSchema.get(name).fields;
    const tplFields = tplSchema.get(name).fields;
    const exOnly = [...exFields.keys()].filter((f) => !tplFields.has(f));
    const tplOnly = [...tplFields.keys()].filter((f) => !exFields.has(f));
    const changed = [...exFields.keys()].filter((f) => tplFields.has(f) && exFields.get(f) !== tplFields.get(f));
    if (exOnly.length > 0) {
      fail('D', `模型 ${name}：example-api 有字段而模板没有（@fw Store 契约变化未同步到模板）：${exOnly.join('、')}`);
    }
    if (tplOnly.length > 0) {
      fail('D', `模型 ${name}：模板有字段而 example-api 没有（模板独立演化）：${tplOnly.join('、')}`);
    }
    for (const f of changed) {
      fail('D', `模型 ${name}.${f} 签名不一致：example-api「${exFields.get(f)}」vs 模板「${tplFields.get(f)}」`);
    }
    const exAttrs = exSchema.get(name).blockAttrs.join(' | ');
    const tplAttrs = tplSchema.get(name).blockAttrs.join(' | ');
    if (exAttrs !== tplAttrs) {
      hint('D', `模型 ${name} 块级属性（索引/表名）不同：example-api「${exAttrs}」vs 模板「${tplAttrs}」`);
    }
  }
}

/* ============================== 轴 E：框架依赖面 ============================== */

async function collectFwImports(srcDir) {
  const imported = new Set();
  for (const file of await collectTsFiles(srcDir)) {
    const text = await readText(file);
    for (const m of text.matchAll(/from\s+'(@fw\/[a-z-]+)[^']*'/g)) imported.add(m[1]);
  }
  return imported;
}

async function axisDependencies() {
  const targets = [
    { label: '模板 server', pkgJson: join(TPL, 'server/package.json'), srcDir: TPL_SERVER_SRC },
    { label: '模板 admin-web', pkgJson: join(TPL, 'admin-web/package.json'), srcDir: TPL_WEB_SRC },
  ];
  for (const target of targets) {
    const pkg = JSON.parse(await readText(target.pkgJson));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const fwDeclared = [...declared].filter((name) => name.startsWith('@fw/'));
    for (const name of fwDeclared) {
      const dir = join(PACKAGES_DIR, name.replace('@fw/', ''));
      if (!existsSync(join(dir, 'package.json'))) {
        fail('E', `${target.label} 声明了不存在的框架包 ${name}（packages/ 下无此包）`);
        continue;
      }
      const spec = (pkg.dependencies ?? {})[name] ?? (pkg.devDependencies ?? {})[name];
      if (spec !== 'workspace:*') {
        fail('E', `${target.label} 对 ${name} 的版本规格是「${spec}」而非 workspace:*（E-08 实测结论：生成项目依赖只能走工作区成员 + workspace:*）`);
      }
    }
    const imported = await collectFwImports(target.srcDir);
    for (const name of imported) {
      if (!declared.has(name)) {
        fail('E', `${target.label} 源码 import 了未在 package.json 声明的框架包 ${name}（生成项目安装即缺依赖）`);
      }
    }
    console.log('[triway][E] %s：声明框架包 %d 个，源码 import %d 个', target.label, fwDeclared.length, imported.size);
  }
}

/* ============================== 轴 F：配置键面 ============================== */

function parseEnvExample(text) {
  const keys = new Set();
  for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) keys.add(m[1]);
  return keys;
}

async function collectRegisteredEnvKeys() {
  const text = await readText(join(PACKAGES_DIR, 'config/src/env-schema.ts'));
  const start = text.indexOf('export const ENV_KEY_PATHS = {');
  if (start === -1) throw new Error('未找到 ENV_KEY_PATHS 注册表（packages/config/src/env-schema.ts）');
  const end = text.indexOf('\n}', start);
  const keys = new Set();
  for (const m of text.slice(start, end).matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)) keys.add(m[1]);
  return keys;
}

async function axisConfigKeys() {
  const registered = await collectRegisteredEnvKeys();
  const tplKeys = parseEnvExample(await readText(join(TPL, 'server/.env.example')));
  const exKeys = parseEnvExample(await readText(join(ROOT, 'apps/example-api/.env.example')));
  console.log('[triway][F] 配置键：ENV_KEY_PATHS 登记 %d 个；模板 .env.example %d 个；example-api .env.example %d 个',
    registered.size, tplKeys.size, exKeys.size);

  for (const key of tplKeys) {
    if (!registered.has(key)) {
      fail('F', `模板 .env.example 的配置键 ${key} 未登记 ENV_KEY_PATHS（配置中心与热更白名单派生漏网）`);
    }
    if (!exKeys.has(key)) {
      fail('F', `模板 .env.example 的配置键 ${key} 未在 example-api .env.example 登记（模板引用了参考实现不知道的键）`);
    }
  }
  for (const key of exKeys) {
    if (!registered.has(key)) {
      fail('F', `example-api .env.example 的配置键 ${key} 未登记 ENV_KEY_PATHS（参考实现文档键越出注册表）`);
    }
  }
}

/* ============================== 轴 G：错误码表单一来源（PRD-012 OBS-03） ============================== */

/** 解析前端/模板 BIZ_CODE 或 mock CODE 常量块（值集合比较；键名允许差异，如 BUSINESS vs BIZ_FAILED） */
function parseBizCodeBlock(text, blockName) {
  const start = text.indexOf(`const ${blockName} = {`);
  if (start === -1) throw new Error(`未找到 ${blockName} 常量块`);
  const end = text.indexOf('} as const;', start);
  if (end === -1) throw new Error(`未找到 ${blockName} 常量块结束（} as const）`);
  const values = new Map(); // code number → key
  for (const m of text.slice(start, end).matchAll(/^\s{2}([A-Z_]+):\s*(\d+),/gm)) {
    values.set(Number(m[2]), m[1]);
  }
  return values;
}

async function axisErrorCodes() {
  // ① 工件同源：error-codes.json 必须与 @fw/core 源一致（--check 模式，不一致即退出 1）
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(ROOT, 'scripts/gen-error-codes-json.mjs'), '--check'], { stdio: 'inherit' });

  const coreText = await readText(join(PACKAGES_DIR, 'core/src/errors/error-codes.ts'));
  const coreCodes = {};
  const codeStart = coreText.indexOf('export const ErrorCode = {');
  const codeEnd = coreText.indexOf('\n} as const;', codeStart);
  for (const m of coreText.slice(codeStart, codeEnd).matchAll(/^\s{2}([A-Z_]+):\s*(\d+),/gm)) coreCodes[m[1]] = Number(m[2]);
  const coreValues = new Set(Object.values(coreCodes));

  // ② 三副本值集合与 core 全集逐一相等（前端 / 模板 / mock）
  const copies = [
    ['前端 BIZ_CODE', join(ROOT, 'apps/admin-web/src/utils/biz-error.ts'), 'BIZ_CODE'],
    ['模板 BIZ_CODE', join(TPL_WEB_SRC, 'utils/biz-error.ts'), 'BIZ_CODE'],
    ['mock CODE', join(ROOT, 'apps/admin-web/mock/handlers.ts'), 'CODE'],
  ];
  for (const [label, file, block] of copies) {
    const values = parseBizCodeBlock(await readText(file), block);
    const missing = [...coreValues].filter((v) => !values.has(v));
    const extra = [...values.keys()].filter((v) => !coreValues.has(v));
    for (const v of missing) fail('G', `${label} 缺少错误码 ${v}（码表单一来源：@fw/core ErrorCode 为唯一权威，PRD-012 OBS-03）`);
    for (const v of extra) fail('G', `${label} 发明了码表外的错误码 ${v}（零新增错误码纪律，PRD-012 NG12-2）`);
    console.log('[triway][G] %s：%d 个码 vs core %d 个', label, values.size, coreValues.size);
  }
}

/* ============================== 轴 H：审计导出 CSV 单元格编码同源 ============================== */

/** 取「const 名字 = 值;」的右值文本（去空白，只做锚点比较） */
function extractConstValue(text, name) {
  const match = text.match(new RegExp(`const\\s+${name}\\s*=\\s*(.+?);`));
  return match ? match[1].replace(/\s+/g, '') : null;
}

/**
 * 审计导出 CSV 单元编码：框架实现（@fw/auth）与 mock 实现必须是同一套防护规则
 *
 * mock 不引用框架包（独立进程、不装 Nest），所以防护实现必然有两份。两份实现靠单测
 * 逐向量对齐（packages/auth、apps/admin-web/mock、apps/example-api 三处同一组载荷），
 * 这里再对「危险前缀正则 + 中和前缀」两个锚点做文本级对撞：
 * 任一侧单独改规则（例如只在一侧加了 `@`）都会在此变红——mock 产物与真实产物
 * 不一致的话，「dev 全绿、真机被 Excel 求值」这条路径又回来了。
 */
async function axisCsvEncoding() {
  const frameworkPath = join(PACKAGES_DIR, 'auth/src/csv.ts');
  const mockPath = join(ROOT, 'apps/admin-web/mock/csv-cell.ts');
  if (!existsSync(frameworkPath) || !existsSync(mockPath)) {
    fail('H', `CSV 编码实现缺失：${existsSync(frameworkPath) ? mockPath : frameworkPath}（框架与 mock 各必须有一份同源实现）`);
    return;
  }
  const framework = await readText(frameworkPath);
  const mock = await readText(mockPath);
  const anchors = ['FORMULA_TRIGGER', 'TEXT_GUARD'];

  for (const name of anchors) {
    const fwValue = extractConstValue(framework, name);
    const mockValue = extractConstValue(mock, name);
    if (!fwValue) fail('H', `@fw/auth 的 csv.ts 缺少锚点 ${name}（公式注入防护的单一事实来源）`);
    if (!mockValue) fail('H', `apps/admin-web/mock/csv-cell.ts 缺少锚点 ${name}（mock 导出的 CSV 会与后端行为不一致）`);
    if (fwValue && mockValue && fwValue !== mockValue) {
      fail('H', `${name} 两侧不一致：@fw/auth=${fwValue} vs mock=${mockValue}（改防护规则必须同步 mock）`);
    }
  }

  for (const [label, text] of [['@fw/auth csv.ts', framework], ['mock/csv-cell.ts', mock]]) {
    if (!/export function escapeCsvCell\(/.test(text)) {
      fail('H', `${label} 未导出 escapeCsvCell（两侧同名同语义，测试才能逐向量对齐）`);
    }
  }

  console.log('[triway][H] CSV 单元格编码：框架与 mock 的防护锚点一致（%s）', anchors.join(' / '));
}

/* ============================== 主流程 ============================== */

async function main() {
  const fw = await collectFrameworkCodes();
  await axisRoutes();
  await axisPermissions(fw);
  await axisModels();
  await axisDependencies();
  await axisConfigKeys();
  await axisErrorCodes();
  await axisCsvEncoding();

  if (hints.length > 0) {
    console.log('\n[triway] 提示（不阻断，共 %d 条）：', hints.length);
    for (const h of hints) console.log('    - %s', h);
  }

  if (failures.length > 0) {
    console.error('\n[triway] 三方不一致（共 %d 处，请对齐框架包 / example-api / admin 模板）：', failures.length);
    for (const f of failures) console.error('    - %s', f);
    process.exit(1);
  }

  console.log('\n[triway] OK：框架包 ↔ example-api ↔ admin 模板八轴全绿（路由×2 / 权限码 / 模型 / 依赖 / 配置键 / 错误码表 / CSV 编码）');
  process.exit(0);
}

main().catch((error) => {
  console.error('[triway] 解析失败：', error);
  process.exit(2);
});
