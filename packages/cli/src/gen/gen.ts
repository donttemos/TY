/*
 * @file fw gen crud 命令编排
 * @description PRD-006 主入口：模型选择（--all / 位置参数 / 交互）→ 渲染计划 → 安全写入 →
 *   生成后校验（失败回滚）→ 下一步清单（FR-10）。
 *   作者解析（git config user.name，回退默认署名并告警，FR-11）、校验器、时钟全部可注入，
 *   单测不触真实 git / tsc / 文件系统之外的副作用。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_AUTHOR, today } from './header.js';
import {
  checkArtifactDrift,
  hashFile,
  makeEntry,
  MANIFEST_FILE,
  mergeArtifactHashes,
  readManifest,
  relativeArtifactPath,
  upsertEntries,
  writeManifest,
  type DriftItem,
  type ModelDrift,
} from './manifest.js';
import type { MigrationAssessment } from './migration.js';
import { PostGenError, runPostGen, type PostGenOptions, type PostGenResult } from './post-gen.js';
import { buildPlan, resolveLayout, type GenScope, type RenderOptions } from './render.js';
import { loadCodegenConfig } from './templates.js';
import { parsePrismaSchema, type ParsedModel } from './schema-parser.js';
import { BASE_FIELDS, kebabCase, pluralize } from './type-map.js';
import { buildWiringPlan, type WiringResult } from './wiring.js';
import { isGitDirty, previewPlan, writePlan, type GenIo } from './writer.js';

const execFileAsync = promisify(execFile);

/** gen crud 命令选项（args.ts 解析后透传） */
export interface GenCrudOptions {
  /** 位置参数：模型名（支持 Order / order / order-item） */
  models?: string[];
  /** --all：全部可用模型 */
  all?: boolean;
  /** --only=backend|frontend|seed|all */
  only?: string;
  /** --app=<后端应用目录名> */
  app?: string;
  /** --web=<前端应用目录名> */
  web?: string;
  /** --schema=<路径> */
  schema?: string;
  /** --dry：只预览不落盘 */
  dry?: boolean;
  /** --force：覆盖已存在文件 */
  force?: boolean;
  /** --no-verify：跳过生成后类型校验 */
  noVerify?: boolean;
  /** --no-migrate：跳过建迁移与应用迁移 */
  noMigrate?: boolean;
  /** --no-seed：跳过定向权限种子 */
  noSeed?: boolean;
  /** --allow-destructive：放行破坏性迁移（默认阻断） */
  allowDestructive?: boolean;
  /** --fast：只校验后端，跳过前端 vue-tsc */
  fast?: boolean;
}

/** 可注入依赖（单测替身） */
export interface GenDeps {
  /** 作者解析（默认 git config user.name → 回退默认署名） */
  author?: () => Promise<string>;
  /** 生成后处理（默认 runPostGen：生成类型 → 双端校验 → 迁移 → 定向种子） */
  postGen?: (options: PostGenOptions) => Promise<PostGenResult>;
  /** 破坏性迁移确认（默认 TTY 下询问 y/N，非 TTY 一律视为拒绝） */
  confirmDestructive?: (assessment: MigrationAssessment) => Promise<boolean>;
  /** 时钟（测试固定日期） */
  now?: () => Date;
  /** 交互式选择（测试替身；默认 readline） */
  selectModels?: (candidates: string[], io: GenIo) => Promise<string[]>;
  /** 输出 */
  io?: GenIo;
}

/** 控制台 IO */
const consoleIo: GenIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** 归一化生成范围 */
function toScope(only?: string): GenScope {
  if (only === undefined || only === 'all') return 'all';
  if (only === 'backend' || only === 'frontend' || only === 'seed') return only;
  throw new Error(`--only 取值不合法：${only}（可选：backend / frontend / seed / all）`);
}

/**
 * 解析作者署名（FR-11）
 * 优先 git config user.name；未配置或 git 不可用时回退仓库默认署名并告警，绝不返回空
 */
async function resolveAuthor(io: GenIo): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.name'], { encoding: 'utf8' });
    const name = stdout.trim();
    if (name) return name;
  } catch {
    // git 未安装或非 git 目录：走回退
  }
  io.log(`[warn] 未检测到 git config user.name，@author 回退为默认署名 ${DEFAULT_AUTHOR}`);
  return DEFAULT_AUTHOR;
}

/**
 * 默认破坏性迁移确认：TTY 下询问一次 y/N；非 TTY（CI / 管道）一律视为拒绝。
 * 拒绝不是错误路径——调用方会给出「加 --allow-destructive 重跑」的明确指引。
 * @param assessment 迁移评估结果
 */
async function defaultConfirmDestructive(assessment: MigrationAssessment): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const detail = assessment.findings.map((finding) => `  - ${finding.reason}（${finding.statement}）`).join('\n');
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n[gen] 检测到破坏性迁移：\n${detail}\n确认执行？（y/N）`, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * 判断某产物路径是否属于指定模型
 * @description 后端模块目录、前端 views 目录、api 文件、种子文件四个位置；
 *   用路径段匹配（而不是 includes 子串），避免 `product` 误吃 `product-extra` 的产物。
 * @param filePath 相对项目根的路径
 * @param kebab 模型 kebab 名
 */
function isArtifactOf(filePath: string, kebab: string): boolean {
  return (
    filePath.includes(`/modules/${kebab}/`) ||
    filePath.includes(`/views/${kebab}/`) ||
    filePath.endsWith(`/api/${kebab}.ts`) ||
    filePath.endsWith(`/seed/${kebab}.seed.ts`)
  );
}

/** 读取 schema 中的可用模型（排除无单字段主键的关联表，无法走 Repository 契约） */
export function listGeneratableModels(schemaFile: string): ParsedModel[] {
  const schema = parsePrismaSchema(fs.readFileSync(schemaFile, 'utf8'));
  return schema.models.filter((model) => model.fields.filter((field) => field.attributes.isId).length === 1);
}

/** 默认交互式选择（逗号分隔多选，回车全选） */
async function defaultSelectModels(candidates: string[], io: GenIo): Promise<string[]> {
  if (!process.stdin.isTTY) {
    throw new Error(`未指定生成模型：请用 fw gen crud <模型名,...> 或 --all（可用模型：${candidates.join(' / ')}）`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`选择要生成的模型（逗号分隔多选，回车全选）\n  ${candidates.join(' / ')}\n> `, resolve);
    });
    const picked = answer
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return picked.length > 0 ? picked : candidates;
  } finally {
    rl.close();
  }
}

/**
 * 执行 fw gen crud
 * @param options 命令选项
 * @param deps 可注入依赖
 */
export async function runGenCrud(options: GenCrudOptions, deps: GenDeps = {}): Promise<void> {
  const io = deps.io ?? consoleIo;
  const projectRoot = process.cwd();
  const scope = toScope(options.only);

  // 1. 布局探测（后端 / 前端应用与 schema 位置）
  const layout = resolveLayout({
    models: [],
    projectRoot,
    app: options.app,
    web: options.web,
    schema: options.schema,
    author: '',
    created: '',
    since: '',
  });

  // 2. 作者与日期（FR-11）
  const author = deps.author ? await deps.author() : await resolveAuthor(io);
  const created = today(deps.now ? deps.now() : new Date());

  // 3. 项目级配置（自定义变量 + 类型覆盖）
  const config = loadCodegenConfig(projectRoot);

  // 4. 模型选择
  let requested: string[];
  if (options.all) {
    requested = listGeneratableModels(layout.schemaFile).map((model) => model.name);
    if (requested.length === 0) {
      throw new Error(`${layout.schemaFile} 中没有可生成的模型（需含单字段主键）`);
    }
  } else if (options.models && options.models.length > 0) {
    requested = options.models;
  } else {
    const candidates = listGeneratableModels(layout.schemaFile).map((model) => model.name);
    if (candidates.length === 0) {
      throw new Error(`${layout.schemaFile} 中没有可生成的模型（需含单字段主键）`);
    }
    const select = deps.selectModels ?? defaultSelectModels;
    requested = await select(candidates, io);
  }

  // 5. 渲染生成计划（dry-run 与真实生成共用同一路径，保证输出一致）
  const renderOptions: RenderOptions = {
    models: requested,
    scope,
    app: options.app,
    web: options.web,
    schema: options.schema,
    author,
    created,
    since: 'v0.1.0',
    projectRoot,
    vars: config.vars,
    typeOverrides: config.typeOverrides,
  };
  const { plan: renderedPlan, models: matchedModels } = buildPlan(renderOptions);

  // 5.1 模型约定前置校验（PRD-016 FR-16-05 补充）：`@fw/db` 的 PrismaRepository 默认按
  //     `deletedAt IS NULL` 过滤、写入时填审计字段，生成代码因此**假定**这些列存在。
  //     缺列时生成与类型校验都过（Prisma Client 只认 schema 里有的字段），但一调接口就是 9001——
  //     黄金链路首跑就栽在这上面。宁可在写盘之前拦住，也不要让用户去读堆栈。
  assertModelConventions(matchedModels);

  // 5.5 接线（PRD-016 FR-16-02）：清单为事实源，框架文件里的标记块按清单全量重建。
  //     前端范围不改接线（前端菜单由种子写入、路由动态加载，无静态注册点），
  //     但已有模型的产物指纹仍要更新——否则 --only=frontend 重跑一次，前端指纹就永远停在旧值。
  const wiringScope = {
    backend: scope === 'all' || scope === 'backend',
    seed: scope === 'all' || scope === 'seed',
  };
  const previousEntries = readManifest(layout.backendRoot).entries;
  const matchedKebabs = new Set(matchedModels.map((model) => kebabCase(model.name)));
  const manifest = wiringScope.backend || wiringScope.seed
    ? upsertEntries(
        { version: 1, entries: previousEntries },
        matchedModels.map((model) => {
          const kebab = kebabCase(model.name);
          return makeEntry({
            model: model.name,
            kebab,
            modulePath: `src/modules/${kebab}/${kebab}.module.ts`,
            seedPath: `prisma/seed/${kebab}.seed.ts`,
            updatedAt: created,
          });
        }),
      )
    : undefined;
  const wiring: WiringResult = manifest
    ? buildWiringPlan(layout, manifest.entries, wiringScope, projectRoot)
    : { plan: [], warnings: [] };
  const plan = [...renderedPlan, ...wiring.plan];

  if (manifest) {
    for (const warning of wiring.warnings) io.log(`[warn] ${warning}`);
    if (wiring.warnings.length === 0) {
      io.log(
        wiring.plan.length > 0
          ? `[gen] 接线：将重写 ${wiring.plan.length} 个框架文件的标记块`
          : '[gen] 接线已是最新（app.module.ts / seed.ts 无变更）',
      );
    }
  }

  if (plan.length === 0) {
    io.log('[gen] 无需变更：产物与接线均已是最新');
    return;
  }

  // 6. 生成物保护（PRD-017 FR-17-14）：先算漂移，再让用户看见「哪些文件会被跳过 / 覆盖」。
  //    统一以**后端应用根**解析（清单就在那里）：从仓库根还是应用目录执行，结论必须一致。
  const drift = checkArtifactDrift(
    layout.backendRoot,
    previousEntries.filter((entry) => matchedKebabs.has(entry.kebab)),
  );
  // 清单口径是后端根；提示与预览口径是项目根（用户要能直接复制去改文件）
  const toProjectPath = (artifactPath: string): string =>
    path.relative(projectRoot, path.resolve(layout.backendRoot, artifactPath)).split(path.sep).join('/');
  const modified = collectDrift(drift, 'modified').map((item) => ({ ...item, path: toProjectPath(item.path) }));
  const missing = collectDrift(drift, 'missing').map((item) => ({ ...item, path: toProjectPath(item.path) }));
  const known = previousEntries.some((entry) => matchedKebabs.has(entry.kebab));
  const tracked = previousEntries.some(
    (entry) => matchedKebabs.has(entry.kebab) && (entry.files ?? []).length > 0,
  );
  reportDrift(io, { modified, missing, tracked, known, force: options.force === true });

  // 7. git 脏工作区告警（FR-07，不阻断）
  if (await isGitDirty(projectRoot)) {
    io.log('[warn] 当前工作区有未提交变更：建议先提交或 stash，避免生成物与手改混在一起难回溯');
  }

  // 8. dry-run：预览后结束（FR-08）
  if (options.dry) {
    previewPlan(plan, {
      projectRoot,
      dry: true,
      force: options.force,
      modifiedPaths: new Set(modified.map((item) => item.path)),
      io,
    });
    printNextSteps(
      matchedModels.map((model) => model.name),
      scope,
      io,
      { migrated: false, seeded: false },
    );
    return;
  }

  // 8. 写入 + 校验 + 失败回滚
  const result = writePlan(plan, { projectRoot, force: options.force, io });
  if (result.written.length === 0) {
    io.log(`[gen] 结果：未写入任何文件（${result.skipped.length} 个产物已存在）`);
    return;
  }
  // 8.5 清单与产物指纹（PRD-016 FR-16-03 + PRD-017 FR-17-14）：
  //     文件落盘后**立即**记录指纹——若等到后处理全部成功才写，环境问题（如 prisma generate 失败）
  //     会让「已存在的产物」永远没有指纹，漂移检测就永远说「不知道」。
  //     校验失败回滚时会把清单一起还原（见下方 catch）。
  const manifestFile = path.join(layout.backendRoot, MANIFEST_FILE);
  const previousManifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : null;
  // 只前端范围不新增清单条目（清单同时是接线事实源，新增条目会谎称已接线），
  // 但已有模型的指纹必须刷新，否则前端产物永远停在旧指纹。
  const hashTargets = manifest
    ? manifest.entries
    : previousEntries.filter((entry) => matchedKebabs.has(entry.kebab));
  if (hashTargets.length > 0) {
    const writtenSet = new Set(result.written);
    let refreshed = 0;
    const withHashes = hashTargets.map((entry) => {
      const updates = renderedPlan
        .filter((file) => file.mode !== 'patch')
        .filter((file) => isArtifactOf(file.path, entry.kebab))
        .filter((file) => writtenSet.has(file.path))
        .map((file) => {
          const absolute = path.resolve(projectRoot, file.path);
          return { path: relativeArtifactPath(layout.backendRoot, absolute), hash: hashFile(absolute) ?? '' };
        })
        .filter((file) => file.hash !== '');
      // 本次没写过的产物（被跳过）沿用旧指纹：既不能凭空记成新基线，也不能把它抹成「未知」
      if (updates.length === 0) return entry;
      refreshed += 1;
      return { ...entry, files: mergeArtifactHashes(entry.files, updates) };
    });
    if (manifest || refreshed > 0) {
      const finalManifest = {
        version: 1 as const,
        entries: withHashes.sort((a, b) => a.model.localeCompare(b.model)),
      };
      writeManifest(layout.backendRoot, finalManifest);
      io.log(
        `[gen] 清单已更新：${finalManifest.entries.length} 个模型记入 fw.gen.json（本次刷新 ${refreshed} 个模型的指纹）`,
      );
    }
  }

  // 8. 生成后处理：类型校验 → 迁移 → 定向种子（PRD-016 FR-16-05/06）
  //    校验失败回滚文件（此时数据库未变更）；迁移/种子失败保留文件只报错（代码与 schema 是对的）
  const postGen = deps.postGen ?? runPostGen;
  try {
    await postGen({
      backendRoot: layout.backendRoot,
      webRoot: layout.webRoot,
      schemaFile: layout.schemaFile,
      models: matchedModels.map((model) => kebabCase(model.name)),
      migrate: options.noMigrate !== true,
      seed: options.noSeed !== true,
      allowDestructive: options.allowDestructive === true,
      confirmDestructive: deps.confirmDestructive ?? defaultConfirmDestructive,
      verify: options.noVerify ? 'none' : options.fast ? 'fast' : 'full',
      io,
    });
  } catch (error) {
    // 注入的替身可能抛普通 Error：按「校验失败」处理，保持 M6 的回滚语义
    const stage = error instanceof PostGenError ? error.stage : 'verify';
    if (stage === 'verify') {
      result.rollback();
      // 清单也要还原：产物被删了却留着指纹，下次会被误判成「用户删了文件」
      try {
        if (previousManifest === null) fs.rmSync(manifestFile, { force: true });
        else fs.writeFileSync(manifestFile, previousManifest, 'utf8');
      } catch {
        // 清单还原失败不掩盖原始错误
      }
      const writtenList = result.written.map((file) => `  - ${file}`).join('\n');
      io.error(`[gen] 已回滚以下文件：\n${writtenList}`);
    }
    throw error;
  }


  // 9. 下一步（PRD-016：只剩「重启并重新登录」一件事）
  printNextSteps(matchedModels.map((model) => model.name), scope, io, {
    migrated: options.noMigrate !== true,
    seeded: options.noSeed !== true,
  });
}

/**
 * 模型通用约定校验（PRD-016 FR-16-05 补充）
 * @description `@fw/db` 的 PrismaRepository 对每个读操作都追加 `deletedAt IS NULL`，写操作填
 *   createdAt/updatedAt/createdBy/updatedBy，按 `id` 主键取单条。缺这些列时生成与类型校验都能通过
 *   （Prisma Client 只校验 schema 里存在的字段），但接口一被调用就 9001——错误发生在运行期、
 *   离原因很远。这里在写盘前直接拒绝，并说清缺哪几个字段。
 * @param models 本次要生成的模型
 */
function assertModelConventions(models: ParsedModel[]): void {
  const problems: string[] = [];
  for (const model of models) {
    const present = new Set(model.fields.map((field) => field.name));
    const missing = [...BASE_FIELDS].filter((field) => !present.has(field));
    if (missing.length > 0) problems.push(`${model.name}（缺 ${missing.join(' / ')}）`);
  }
  if (problems.length > 0) {
    throw new Error(
      `模型不符合框架通用约定：${problems.join('；')}。@fw/db 默认按 deletedAt 过滤软删除、写入时填审计字段，` +
        '缺列会在接口调用时 500（9001）——按模板约定补齐 id / deletedAt / createdAt / updatedAt / createdBy / updatedBy 后重试',
    );
  }
}

/**
 * 从漂移结果里挑出指定状态的文件（带模型名，便于提示是哪个模型的产物）
 * @param drift 各模型漂移结果
 * @param status 目标状态
 */
function collectDrift(drift: ModelDrift[], status: DriftItem['status']): { path: string; model: string }[] {
  return drift.flatMap((item) =>
    item.files.filter((file) => file.status === status).map((file) => ({ path: file.path, model: item.model })),
  );
}

/**
 * 生成前打印「哪些文件会被跳过 / 覆盖」（PRD-017 FR-17-14）
 * @description 只说磁盘现状与本次行为，不替用户做决定：
 *   - modified：不带 --force 会跳过（你的改动保住），带 --force 会覆盖（改动丢失）；
 *   - missing：重新生成会把它建回来；
 *   - 老清单没有指纹：明说「无法判断」，不把未知当安全。
 * @param io 输出
 * @param state 漂移与开关
 */
function reportDrift(
  io: GenIo,
  state: {
    modified: { path: string; model: string }[];
    missing: { path: string; model: string }[];
    tracked: boolean;
    known: boolean;
    force: boolean;
  },
): void {
  const list = (items: { path: string }[]): string =>
    items
      .slice(0, 5)
      .map((item) => `  ${item.path}`)
      .concat(items.length > 5 ? [`  … 另有 ${items.length - 5} 个`] : [])
      .join('\n');

  if (state.known && !state.tracked) {
    io.log(
      '[gen] 生成物保护：清单里这批模型还没有产物指纹（老清单），本次无法判断你是否改过；生成完成后即建立基线',
    );
  }
  if (state.modified.length > 0) {
    const action = state.force
      ? `${state.modified.length} 个文件你改过，本次 --force 会覆盖并丢弃这些修改`
      : `${state.modified.length} 个文件你改过，本次会跳过它们（--force 才覆盖）`;
    io.log(`[warn] 生成物保护：${action}\n${list(state.modified)}`);
  }
  if (state.missing.length > 0) {
    io.log(`[warn] 生成物保护：${state.missing.length} 个文件已被删除，重新生成会重新创建\n${list(state.missing)}`);
  }
}

/**
 * 打印下一步（精简原则 4：不超过 3 行，且只列用户真正需要做的事）
 * @param models 模型名（PascalCase）
 * @param scope 生成范围
 * @param io 输出
 * @param state 迁移与种子是否已由本次命令完成
 */
function printNextSteps(
  models: string[],
  scope: GenScope,
  io: GenIo,
  state: { migrated: boolean; seeded: boolean },
): void {
  io.log('\n[gen] 下一步：');
  if (scope === 'all' || scope === 'backend' || scope === 'frontend') {
    const routes = models.map((model) => `/${pluralize(kebabCase(model))}`).join('、');
    io.log(`  · 重启服务后重新登录（菜单变更需重新登录生效），然后访问 ${routes}`);
  }
  if (!state.migrated) io.log('  · 未执行迁移：fw db:migrate');
  if (!state.seeded) io.log('  · 未写入权限点：fw db:seed');
}
