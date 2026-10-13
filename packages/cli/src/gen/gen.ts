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
import { buildPlan, resolveLayout, type GenScope, type RenderOptions } from './render.js';
import { loadCodegenConfig } from './templates.js';
import { parsePrismaSchema, type ParsedModel } from './schema-parser.js';
import { kebabCase, pascalCase } from './type-map.js';
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
  /** --no-verify：跳过生成后编译校验 */
  noVerify?: boolean;
}

/** 可注入依赖（单测替身） */
export interface GenDeps {
  /** 作者解析（默认 git config user.name → 回退默认署名） */
  author?: () => Promise<string>;
  /** 生成后校验（默认对后端应用跑 tsc --noEmit） */
  validate?: (backendRoot: string, io: GenIo) => Promise<void>;
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
 * 默认生成后校验：对后端应用执行 tsc --noEmit（NFR：生成代码必须通过编译，失败由调用方回滚）
 * 前端应用（vue-tsc）较慢，默认手动执行，见下一步清单
 */
async function defaultValidate(backendRoot: string, io: GenIo): Promise<void> {
  const tsconfig = path.join(backendRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    io.log(`[gen] 后端应用无 tsconfig.json（${backendRoot}），跳过编译校验`);
    return;
  }
  io.log(`[gen] 编译校验：${path.relative(process.cwd(), backendRoot) || backendRoot}（tsc --noEmit）…`);
  try {
    await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'], {
      cwd: backendRoot,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    const output = (detail.stderr || detail.stdout || detail.message || '').trim();
    throw new Error(`生成代码编译校验未通过：\n${output}`);
  }
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
  const { plan } = buildPlan(renderOptions);
  if (plan.length === 0) {
    io.log('[gen] 没有需要生成的文件');
    return;
  }

  // 6. git 脏工作区告警（FR-07，不阻断）
  if (await isGitDirty(projectRoot)) {
    io.log('[warn] 当前工作区有未提交变更：建议先提交或 stash，避免生成物与手改混在一起难回溯');
  }

  // 7. dry-run：预览后结束（FR-08）
  if (options.dry) {
    previewPlan(plan, { projectRoot, dry: true, force: options.force, io });
    printNextSteps(requested, scope, io);
    return;
  }

  // 8. 写入 + 校验 + 失败回滚
  const result = writePlan(plan, { projectRoot, force: options.force, io });
  if (result.written.length === 0) {
    io.log('[gen] 没有写入任何文件（已存在文件默认不覆盖，--force 才覆盖）');
    return;
  }
  if (!options.noVerify) {
    const validate = deps.validate ?? defaultValidate;
    try {
      await validate(layout.backendRoot, io);
    } catch (error) {
      result.rollback();
      const writtenList = result.written.map((file) => `  - ${file}`).join('\n');
      io.error(`[gen] 校验失败，已回滚以下文件：\n${writtenList}`);
      throw error;
    }
  }

  // 9. 下一步清单（FR-10）
  printNextSteps(requested, scope, io);
}

/** 打印生成后自检与下一步清单（FR-10） */
function printNextSteps(models: string[], scope: GenScope, io: GenIo): void {
  // 归一命名：模块名 / seed 函数用 PascalCase，迁移名用 kebab-case
  const pascalModels = models.map((model) => pascalCase(model));
  const kebabModels = models.map((model) => kebabCase(model));
  io.log('\n[gen] 下一步：');
  let step = 1;
  if (scope === 'all' || scope === 'backend' || scope === 'seed') {
    io.log(`  ${step}. 应用迁移（表已存在可跳过）：pnpm exec prisma migrate dev --name ${kebabModels.map((m) => `create_${m}`).join('_')}`);
    step += 1;
    io.log(`  ${step}. 引入模块：在 app.module.ts 的 imports 中加入 ${pascalModels.map((m) => `${m}Module`).join('、')}`);
    step += 1;
  }
  if (scope === 'all' || scope === 'seed') {
    io.log(`  ${step}. 写入权限点与菜单：在 prisma/seed.ts 引用 ${pascalModels.map((m) => `seed${m}Permissions()`).join('、')}，然后 fw db:seed（菜单变更后重新登录生效）`);
    step += 1;
  }
  if (scope === 'all' || scope === 'backend') {
    io.log(`  ${step}. 重启服务访问 /api/v1/<模型复数>；枚举字段需先在字典管理建对应字典（dictCode 见生成代码）`);
    step += 1;
  }
  if (scope === 'all' || scope === 'frontend') {
    io.log(`  ${step}. 前端校验：pnpm --filter admin-web lint（vue-tsc）；外键下拉数据源见生成代码中的 TODO`);
    step += 1;
  }
  io.log(`  ${step}. 文件头门禁：pnpm run check:headers（生成文件均带中文文件头）`);
}
