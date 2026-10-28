/*
 * @file 项目体检（TY Studio S1 / PRD-017 FR-17-01/02）
 * @description Studio 的**只读**数据来源：直接读项目文件，不经 CLI 子进程，也不复制任何业务规则。
 *   产出固定结构给页面用：布局识别、schema 摘要与结构问题、生成清单、环境体检、待执行迁移。
 *   设计取舍：
 *   - 布局复用 gen/render 的 resolveLayout（四种项目形态一处判断，含 admin 模板的 server+admin-web 兄弟目录）；
 *   - 待迁移数复用 deploy 的 assessNewMigrations（清单记录已应用集合，无需连库）；
 *   - 任何一项读失败都降级为「不可用 + 原因」，不让整个体检 500——页面要能显示“哪里坏了”。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { assessNewMigrations, readManifest as readDeployManifest } from '../deploy/deploy.js';
import type { Exec } from '../deploy/exec.js';
import { defaultExec, firstLineOf } from '../deploy/exec.js';
import { readManifest as readGenManifest } from '../gen/manifest.js';
import { resolveLayout } from '../gen/render.js';
import { splitSchema, structuralIssues, parseModel, type SchemaIssue } from './schema-doc.js';

/** 项目布局（相对仓库根，统一 `/` 分隔） */
export interface ProjectLayoutInfo {
  backendRoot: string;
  webRoot: string;
  schemaFile: string;
  /** schema 是否真实存在 */
  schemaExists: boolean;
}

/** schema 中的模型摘要 */
export interface ModelSummary {
  name: string;
  fieldCount: number;
  /** 是否已在生成清单里（已生成业务代码） */
  generated: boolean;
}

/** 生成清单摘要 */
export interface ManifestInfo {
  file: string;
  exists: boolean;
  models: string[];
}

/** 环境体检项 */
export interface EnvCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** 体检结果 */
export interface ProjectInspection {
  /** 项目根（绝对路径） */
  root: string;
  /** 项目形态：monorepo（apps/<x>）/ admin-template（server+admin-web）/ single（单包） */
  shape: 'monorepo' | 'admin-template' | 'single';
  layout: ProjectLayoutInfo;
  schema: {
    exists: boolean;
    models: ModelSummary[];
    enums: string[];
    issues: SchemaIssue[];
    /** 读取失败原因（存在时为 null） */
    error: string | null;
  };
  manifest: ManifestInfo;
  migrations: { total: number; pending: number; dir: string; baseline: boolean };
  environment: EnvCheck[];
  /** 当前可执行的动作白名单（S1 只读，恒为空数组） */
  actions: string[];
}

/** 相对项目根的路径（统一 `/`） */
function rel(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).split(path.sep).join('/') || '.';
}

/**
 * 判断项目形态
 * @param projectRoot 项目根
 * @param backendRoot 后端根
 * @param webRoot 前端根
 */
function detectShape(projectRoot: string, backendRoot: string, webRoot: string): ProjectInspection['shape'] {
  if (fs.existsSync(path.join(projectRoot, 'apps'))) return 'monorepo';
  if (path.resolve(backendRoot) !== path.resolve(webRoot)) return 'admin-template';
  return 'single';
}

/**
 * 读取 schema 摘要（失败降级，不抛错）
 * @param schemaFile schema 绝对路径
 * @param generatedModels 生成清单里的模型名
 */
function readSchemaSummary(
  schemaFile: string,
  generatedModels: string[],
): ProjectInspection['schema'] {
  if (!fs.existsSync(schemaFile)) {
    return { exists: false, models: [], enums: [], issues: [], error: `schema 不存在：${schemaFile}` };
  }
  try {
    const text = fs.readFileSync(schemaFile, 'utf8');
    const blocks = splitSchema(text);
    const models = blocks
      .filter((block) => block.kind === 'model' && block.name)
      .map((block) => ({
        name: block.name as string,
        fieldCount: parseModel(block).fields.length,
        generated: generatedModels.includes(block.name as string),
      }));
    const enums = blocks.filter((block) => block.kind === 'enum' && block.name).map((block) => block.name as string);
    return { exists: true, models, enums, issues: structuralIssues(text), error: null };
  } catch (error) {
    return { exists: true, models: [], enums: [], issues: [], error: firstLineOf(error) };
  }
}

/**
 * 项目体检
 * @param projectRoot 项目根
 * @param exec 执行器（git 状态用；可注入）
 */
export async function inspectProject(projectRoot: string, exec: Exec = defaultExec): Promise<ProjectInspection> {
  const layout = resolveLayout({ models: [], projectRoot, author: '', created: '', since: '' });
  const shape = detectShape(projectRoot, layout.backendRoot, layout.webRoot);

  // 清单：模型名用于标记「已生成」
  let manifest: ManifestInfo = { file: '', exists: false, models: [] };
  try {
    const parsed = readGenManifest(layout.backendRoot);
    manifest = {
      file: rel(projectRoot, path.join(layout.backendRoot, 'fw.gen.json')),
      exists: fs.existsSync(path.join(layout.backendRoot, 'fw.gen.json')),
      models: parsed.entries.map((entry) => entry.model),
    };
  } catch (error) {
    manifest = { file: rel(projectRoot, path.join(layout.backendRoot, 'fw.gen.json')), exists: true, models: [], error: firstLineOf(error) } as ManifestInfo & { error: string };
  }

  const schema = readSchemaSummary(layout.schemaFile, manifest.models);

  // 待迁移数：清单记录上次已应用集合，不连库
  let migrations: ProjectInspection['migrations'] = { total: 0, pending: 0, dir: '', baseline: false };
  try {
    const schemaRel = rel(layout.backendRoot, layout.schemaFile);
    // 已应用迁移记在**部署清单**（deploy.manifest.json）里，不是生成清单；两者同名函数，必须区分
    const deployManifest = readDeployManifest(projectRoot);
    const hasBaseline = fs.existsSync(path.join(projectRoot, 'deploy.manifest.json'));
    const applied = deployManifest.appliedMigrations ?? [];
    const result = assessNewMigrations(layout.backendRoot, applied, schemaRel);
    const dir = path.dirname(path.join(layout.backendRoot, schemaRel));
    const total = fs.existsSync(path.join(dir, 'migrations'))
      ? fs.readdirSync(path.join(dir, 'migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
      : 0;
    // 没有部署清单 = 没有比对基准：不谎报「全部待执行」，只如实说「不知道」
    migrations = {
      total,
      pending: hasBaseline ? result.names.length : 0,
      dir: rel(projectRoot, path.join(dir, 'migrations')),
      baseline: hasBaseline,
    };
  } catch {
    migrations = { total: 0, pending: 0, dir: '', baseline: false };
  }

  const environment: EnvCheck[] = [
    {
      name: 'Node',
      status: 'ok',
      detail: process.version,
    },
    {
      name: '依赖',
      status: fs.existsSync(path.join(projectRoot, 'node_modules')) ? 'ok' : 'error',
      detail: fs.existsSync(path.join(projectRoot, 'node_modules')) ? 'node_modules 已就绪' : '未安装：pnpm install',
    },
    {
      name: 'CLI 产物',
      status: fs.existsSync(path.join(projectRoot, 'packages', 'cli', 'dist', 'index.js')) ? 'ok' : 'warn',
      detail: fs.existsSync(path.join(projectRoot, 'packages', 'cli', 'dist', 'index.js'))
        ? 'dist 已构建'
        : '缺少 dist：pnpm --filter @fw/cli run build',
    },
    {
      name: 'Schema',
      status: schema.exists ? (schema.error ? 'error' : 'ok') : 'error',
      detail: schema.error ?? `${schema.models.length} 个模型 / ${schema.enums.length} 个枚举`,
    },
    {
      name: '结构自检',
      status: schema.issues.some((issue) => issue.level === 'error') ? 'error' : schema.issues.length > 0 ? 'warn' : 'ok',
      detail:
        schema.issues.length === 0
          ? '无问题'
          : schema.issues.map((issue) => `${issue.level === 'error' ? '错误' : '告警'}：${issue.message}`).join('；'),
    },
    {
      name: '待执行迁移',
      status: migrations.baseline && migrations.pending === 0 ? 'ok' : 'warn',
      detail: !migrations.baseline
        ? `无部署基线（共 ${migrations.total} 个迁移，部署一次后才有比对基准）`
        : migrations.pending > 0
          ? `${migrations.pending} 个待执行（共 ${migrations.total}）`
          : `已同步（共 ${migrations.total}）`,
    },
  ];

  // git 脏工作区：读不到就跳过（非 git 目录不报错）
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], projectRoot);
    const dirty = stdout.trim() !== '';
    environment.push({
      name: '工作区',
      status: dirty ? 'warn' : 'ok',
      detail: dirty ? '有未提交变更（生成前建议先提交，便于回溯）' : '干净',
    });
  } catch {
    environment.push({ name: '工作区', status: 'warn', detail: '非 git 仓库或 git 不可用' });
  }

  return {
    root: projectRoot,
    shape,
    layout: {
      backendRoot: rel(projectRoot, layout.backendRoot),
      webRoot: rel(projectRoot, layout.webRoot),
      schemaFile: rel(projectRoot, layout.schemaFile),
      schemaExists: schema.exists,
    },
    schema,
    manifest,
    migrations,
    environment,
    actions: [],
  };
}
