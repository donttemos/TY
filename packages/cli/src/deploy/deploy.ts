/*
 * @file fw deploy 编排（PRD-016 FR-16-10/11/12/13/14）
 * @description 单机 Docker Compose 一条命令部署，阶段严格串行且**失败即停**：
 *   环境（首次向导）→ 预检 → 计划 → 构建 → 备份 → 迁移（含风险闸门）→ 启动 → 健康 → 报告。
 *   关键取舍：
 *   - 迁移前必须备份成功（备份不可用直接中止，避免破坏性迁移没有退路）；
 *   - 健康检查失败自动回退到上一镜像并重启，**数据库不回滚**（迁移不可逆，只能靠备份人工恢复）；
 *   - 迁移风险只评估「本次新增的迁移文件」——清单里记录了上次已应用的集合，无需连库比对；
 *   - 首次部署没有历史基线，跳过风险闸门但显式说明（否则任何存量删列迁移都会卡住首次上线）。
 *   exec / shell / fetch / ask 全部可注入，单测不依赖 docker、网络与真实 stdin。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { assessSql, summarizeAssessment, type MigrationAssessment } from '../gen/migration.js';
import { resolveLayout } from '../gen/render.js';
import { backupDatabase, type BackupResult } from './backup.js';
import {
  composeBuild,
  composeMigrate,
  composePreflight,
  composeSeed,
  composeUp,
  waitForHealth,
  type ComposeContext,
  type HealthResult,
} from './compose.js';
import {
  DEPLOY_ENV_FILE,
  fillNonInteractive,
  missingKeys,
  readDeployEnv,
  runWizard,
  writeDeployEnv,
  type Asker,
  type EnvEntries,
} from './env-file.js';
import { defaultExec, defaultShell, firstLineOf, type Exec, type Shell } from './exec.js';

/** 部署清单文件名（项目根） */
export const DEPLOY_MANIFEST_FILE = 'deploy.manifest.json';
/** 部署报告文件名（项目根） */
export const DEPLOY_REPORT_FILE = 'deploy-report.json';
/** 默认 compose 文件 */
const DEFAULT_COMPOSE_FILE = 'deploy/docker-compose.prod.yml';
/** 健康检查地址端口 */
const DEFAULT_APP_PORT = 3000;

/** 部署目标 */
export type DeployTarget = 'compose' | 'bare-metal';

/** 阶段名 */
export type DeployStage = 'env' | 'preflight' | 'plan' | 'build' | 'backup' | 'migrate' | 'seed' | 'up' | 'health';

/** 单阶段结果 */
export interface StageResult {
  name: DeployStage;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
}

/** 部署报告（同时写入 deploy-report.json） */
export interface DeployReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  target: DeployTarget;
  image: string;
  result: 'success' | 'failed' | 'planned';
  stages: StageResult[];
  backup?: { file: string; bytes: number };
  migration?: { applied: string[]; risk: string };
  health?: HealthResult;
  error?: { stage: DeployStage; message: string; next: string };
}

/** 部署清单（记录当前与上一镜像、已应用迁移，供回退与风险比对） */
export interface DeployManifest {
  version: 1;
  current?: { image: string; deployedAt: string };
  previous?: { image: string; deployedAt: string };
  appliedMigrations: string[];
}

/** 部署选项 */
export interface DeployOptions {
  /** 项目根 */
  projectRoot: string;
  /** compose 文件（相对项目根） */
  composeFile?: string;
  /** 环境文件（相对项目根） */
  envFile?: string;
  /** 目标渠道（本轮只实现 compose；bare-metal 透传既有脚本） */
  target?: DeployTarget;
  /** 只输出计划不执行 */
  plan?: boolean;
  /** 回退到上一镜像 */
  rollback?: boolean;
  /** 非交互（缺配置时自动生成密钥） */
  yes?: boolean;
  /** 跳过备份（不推荐，仅限已知无数据变更） */
  skipBackup?: boolean;
  /** 执行种子（默认不执行：seed 脚本自带清场语义） */
  seed?: boolean;
  /** 允许破坏性迁移 */
  allowDestructive?: boolean;
  /** 备份保留份数 */
  keepBackups?: number;
  /** 健康检查超时 */
  healthTimeoutMs?: number;
}

/** 可注入依赖 */
export interface DeployDeps {
  exec?: Exec;
  shell?: Shell;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  ask?: Asker;
  now?: () => Date;
  io?: { log: (message: string) => void; error: (message: string) => void };
  /** 破坏性迁移确认（默认 TTY 询问，非 TTY 拒绝） */
  confirmDestructive?: (assessment: MigrationAssessment) => Promise<boolean>;
}

/** 默认确认：TTY 询问，非 TTY 一律拒绝 */
async function defaultConfirmDestructive(assessment: MigrationAssessment): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const detail = assessment.findings.map((finding) => `  - ${finding.reason}（${finding.statement}）`).join('\n');
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n[deploy] 本次迁移含破坏性操作：\n${detail}\n确认执行？（y/N）`, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** 默认提问（TTY 读一行） */
function defaultAsker(): Asker {
  return async (question, placeholder) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const suffix = placeholder ? `（默认 ${placeholder}）` : '';
      return await new Promise<string>((resolve) => rl.question(`${question}${suffix}: `, resolve));
    } finally {
      rl.close();
    }
  };
}

/** 读取部署清单（不存在返回空） */
export function readManifest(projectRoot: string): DeployManifest {
  const file = path.join(projectRoot, DEPLOY_MANIFEST_FILE);
  if (!fs.existsSync(file)) return { version: 1, appliedMigrations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeployManifest>;
    return { version: 1, current: parsed.current, previous: parsed.previous, appliedMigrations: parsed.appliedMigrations ?? [] };
  } catch {
    // 清单损坏不应阻断部署：当作首次部署处理（代价只是少一次风险比对）
    return { version: 1, appliedMigrations: [] };
  }
}

/** 写入部署清单 */
export function writeManifest(projectRoot: string, manifest: DeployManifest): void {
  fs.writeFileSync(path.join(projectRoot, DEPLOY_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** 列出迁移目录（按名称升序） */
function listMigrations(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 计算本次新增迁移并评估风险（只读本地文件，不连库）
 * @param backendRoot 后端应用根
 * @param appliedMigrations 清单里记录的上次已应用集合
 * @param schemaRel schema 相对后端应用根的路径（决定迁移目录：schema 同级 migrations/）
 */
export function assessNewMigrations(
  backendRoot: string,
  appliedMigrations: string[],
  schemaRel = 'prisma/schema.prisma',
): { names: string[]; assessment: MigrationAssessment | null; dir: string } {
  const dir = path.join(backendRoot, path.dirname(schemaRel), 'migrations');
  const names = listMigrations(dir);
  const fresh = names.filter((name) => !appliedMigrations.includes(name));
  if (fresh.length === 0) return { names: [], assessment: null, dir };
  const sql = fresh
    .map((name) => {
      const file = path.join(dir, name, 'migration.sql');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    })
    .join(';\n');
  return { names: fresh, assessment: assessSql(sql), dir };
}

/** 镜像标签：时间戳 + 短随机，避免同 tag 覆盖导致「以为回退了其实没换」 */
export function nextImageTag(now: Date, suffix: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `fw-app:${stamp}-${suffix}`;
}

/** 写报告文件 */
function writeReport(projectRoot: string, report: DeployReport): void {
  try {
    fs.writeFileSync(path.join(projectRoot, DEPLOY_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    // 报告写失败不影响部署结论
  }
}

/**
 * 执行部署
 * @param options 选项
 * @param deps 可注入依赖
 */
export async function runDeploy(options: DeployOptions, deps: DeployDeps = {}): Promise<DeployReport> {
  const io = deps.io ?? { log: (message: string) => console.log(message), error: (message: string) => console.error(message) };
  const exec = deps.exec ?? defaultExec;
  const shell = deps.shell ?? defaultShell;
  const now = deps.now ?? (() => new Date());
  const envFileRel = options.envFile ?? DEPLOY_ENV_FILE;
  const composeFileRel = options.composeFile ?? DEFAULT_COMPOSE_FILE;
  const target = options.target ?? 'compose';
  const projectRoot = options.projectRoot;
  const startedAt = now().toISOString();
  const stages: StageResult[] = [];
  const manifest = readManifest(projectRoot);

  const report: DeployReport = {
    version: 1,
    startedAt,
    finishedAt: startedAt,
    target,
    image: manifest.current?.image ?? '',
    result: 'failed',
    stages,
  };

  /** 记录阶段并返回 false 表示应中止 */
  const mark = (stage: DeployStage, status: StageResult['status'], detail?: string): void => {
    stages.push({ name: stage, status, detail });
  };

  /** 统一失败出口：写报告 + 抛出（消息已含阶段与下一步） */
  const fail: (stage: DeployStage, message: string, next: string) => never = (stage, message, next) => {
    mark(stage, 'failed', message);
    report.result = 'failed';
    report.finishedAt = now().toISOString();
    report.error = { stage, message, next };
    writeReport(projectRoot, report);
    throw new Error(`${message}。${next}`);
  };

  // 0. 渠道边界：裸机只做薄包装透传，不改既有脚本内部
  if (target === 'bare-metal') {
    try {
      await exec('bash', ['deploy/scripts/bare-metal-deploy.sh'], projectRoot);
    } catch (error) {
      fail('preflight', `裸机部署脚本失败：${firstLineOf(error)}`, '查看 /opt/fw/shared/deploy.log 定位具体步骤');
    }
    mark('preflight', 'ok', '已透传裸机部署脚本');
    report.result = 'success';
    report.finishedAt = now().toISOString();
    writeReport(projectRoot, report);
    return report;
  }

  // 1. 环境：首次向导（缺键才问），之后零输入
  const existing = readDeployEnv(projectRoot);
  let entries: EnvEntries = { ...existing.entries };
  if (missingKeys(entries).length > 0) {
    // --plan 必须无副作用：不提问、不写文件，只推算将使用的配置
    // 非 TTY 且未注入提问器时也不提问（CI 里挂住等 stdin 比缺少引导更糟）
    const askable = !options.yes && !options.plan;
    const ask = askable ? (deps.ask ?? (process.stdin.isTTY ? defaultAsker() : undefined)) : undefined;
    const wizard = ask
      ? await runWizard({ ask, existing: entries })
      : fillNonInteractive(entries, nextImageTag(now(), 'init'));
    entries = wizard.entries;
    if (options.plan) {
      mark('env', 'skipped', '仅计划：未写入配置');
    } else {
      writeDeployEnv(path.join(projectRoot, envFileRel), entries);
      mark('env', 'ok', wizard.generated.length > 0 ? `已生成 ${wizard.generated.join('、')}` : '已写入配置');
      io.log(
        `[deploy] 配置已写入 ${envFileRel}${wizard.generated.length > 0 ? `（自动生成：${wizard.generated.join('、')}，不回显）` : ''}`,
      );
      if (!ask) io.log('[deploy] 非交互环境：已自动生成密钥（等同 --yes）');
    }
  } else {
    mark('env', 'skipped', '沿用已有 .env.prod');
  }

  const composeContext: ComposeContext = { projectRoot, composeFile: composeFileRel, envFile: envFileRel, exec };

  // 2. 回退模式：只换镜像 + 重启 + 健康检查
  if (options.rollback) {
    const previous = manifest.previous;
    if (!previous) fail('plan', '没有可回退的上一版本', '查看 deploy.manifest.json 确认历史记录');
    entries.APP_IMAGE = previous.image;
    writeDeployEnv(path.join(projectRoot, envFileRel), entries);
    io.log(`[deploy] 回退到 ${previous.image}`);
    await composeUp(composeContext, io);
    const health = await waitForHealth(`http://127.0.0.1:${entries.APP_PORT ?? DEFAULT_APP_PORT}/health`, {
      timeoutMs: options.healthTimeoutMs,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
    report.health = health;
    if (!health.ok) fail('health', `回退后健康检查未通过（${health.lastError ?? '无响应'}）`, '执行 docker compose logs --tail=100 app 查看启动异常');
    mark('health', 'ok', `${health.attempts} 次探测通过`);
    writeManifest(projectRoot, { ...manifest, current: previous, previous: manifest.current });
    report.result = 'success';
    report.image = previous.image;
    report.finishedAt = now().toISOString();
    writeReport(projectRoot, report);
    io.log('[deploy] 回退完成');
    return report;
  }

  // 3. 预检
  try {
    await composePreflight(composeContext, io);
    mark('preflight', 'ok');
  } catch (error) {
    fail('preflight', firstLineOf(error), '补齐后重跑 fw deploy；也可 service 名逐个启动排查');
  }

  // 4. 计划：算镜像标签、迁移差异与风险
  const layout = resolveLayout({
    models: [],
    projectRoot,
    author: '',
    created: '',
    since: '',
  });
  const imageTag = nextImageTag(now(), (manifest.current?.image.split('-').pop() ?? '0').slice(0, 4));
  const schemaRel = entries.PRISMA_SCHEMA || 'prisma/schema.prisma';
  const pending = assessNewMigrations(layout.backendRoot, manifest.appliedMigrations, schemaRel);
  const firstDeploy = !manifest.current;
  const risky = pending.assessment && pending.assessment.risk !== 'safe';

  io.log(`[deploy] 计划：镜像 ${imageTag}｜新增迁移 ${pending.names.length} 个｜备份 ${options.skipBackup ? '跳过' : '执行'}`);
  if (pending.assessment) io.log(`[deploy] 迁移风险：${summarizeAssessment(pending.assessment)}`);
  if (firstDeploy && risky) {
    io.log('[warn] 首次部署没有历史基线，跳过迁移风险闸门（请自行确认历史迁移对现有数据安全）');
  }
  if (firstDeploy && !options.seed) {
    io.log('[warn] 首次部署通常需要初始化账号与权限：可加 --seed（会执行 prisma/seed.ts，注意其清场语义）');
  }
  mark('plan', 'ok', `新增迁移 ${pending.names.length} 个`);

  if (options.plan) {
    report.result = 'planned';
    report.image = imageTag;
    report.finishedAt = now().toISOString();
    writeReport(projectRoot, report);
    io.log('[deploy] 仅输出计划（--plan），未执行任何变更');
    return report;
  }

  // 迁移风险闸门（首次部署除外：没有基线可比，且通常是空库）
  if (risky && !firstDeploy && pending.assessment) {
    const approved =
      options.allowDestructive === true ||
      (await (deps.confirmDestructive ?? defaultConfirmDestructive)(pending.assessment));
    if (!approved) {
      fail('plan', `迁移被阻断：${summarizeAssessment(pending.assessment)}`, '确认可接受后加 --allow-destructive 重跑');
    }
  }

  // 5. 构建
  try {
    await composeBuild(composeContext, io);
    mark('build', 'ok', imageTag);
  } catch (error) {
    fail('build', firstLineOf(error), '执行 docker compose build app 查看完整构建日志');
  }

  // 6. 备份（迁移前必须有可读备份）
  let backup: BackupResult | undefined;
  if (options.skipBackup) {
    mark('backup', 'skipped', '--skip-backup');
  } else {
    try {
      backup = await backupDatabase({
        projectRoot,
        backupDir: path.join(projectRoot, 'backups'),
        composeFile: composeFileRel,
        envFile: envFileRel,
        service: 'postgres',
        dbUser: 'fw',
        dbName: 'fw',
        keep: options.keepBackups ?? 5,
        shell,
        now: now(),
      });
      report.backup = { file: path.basename(backup.file), bytes: backup.bytes };
      mark('backup', 'ok', `${path.basename(backup.file)}（${Math.round(backup.bytes / 1024)}KB）`);
    } catch (error) {
      fail('backup', firstLineOf(error), '确认 postgres 已启动且密码正确；无数据变更时可加 --skip-backup');
    }
  }

  // 7. 迁移
  try {
    await composeMigrate(composeContext, io);
    mark('migrate', 'ok', `${pending.names.length} 个`);
    report.migration = {
      applied: pending.names,
      risk: pending.assessment ? pending.assessment.risk : 'none',
    };
  } catch (error) {
    fail('migrate', firstLineOf(error), `已备份到 ${report.backup?.file ?? '（未备份）'}，修正后可重跑 fw deploy`);
  }

  // 8.5 种子（显式 --seed 才执行：seed 脚本自带清场语义，自动执行会清数据）
  if (options.seed) {
    try {
      await composeSeed(composeContext, io);
      mark('seed', 'ok');
    } catch (error) {
      fail('seed', firstLineOf(error), '种子失败不影响服务运行；修正后可执行 fw db:seed 单独重试');
    }
  }

  // 9. 启动 + 健康
  await composeUp(composeContext, io);
  mark('up', 'ok');
  const healthUrl = `http://127.0.0.1:${entries.APP_PORT ?? DEFAULT_APP_PORT}/health`;
  const health = await waitForHealth(healthUrl, {
    timeoutMs: options.healthTimeoutMs,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
  report.health = health;
  if (!health.ok) {
    // 失败回退：换回上一镜像重启（数据库不回滚）
    if (manifest.current) {
      io.error(`[deploy] 健康检查未通过，回退到 ${manifest.current.image}`);
      entries.APP_IMAGE = manifest.current.image;
      writeDeployEnv(path.join(projectRoot, envFileRel), entries);
      try {
        await composeUp(composeContext, io);
        const retry = await waitForHealth(healthUrl, {
          timeoutMs: options.healthTimeoutMs,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
        });
        report.health = retry;
      } catch {
        // 回退本身失败：保留原始失败原因，避免掩盖
      }
    }
    fail(
      'health',
      `健康检查未通过（${health.lastError ?? '无响应'}，${health.attempts} 次）`,
      `已${manifest.current ? '回退到上一镜像' : '无可回退版本'}；数据库未回滚${report.backup ? `，备份见 backups/${report.backup.file}` : ''}。执行 docker compose logs --tail=100 app 定位`,
    );
  }
  mark('health', 'ok', `${health.attempts} 次探测通过`);

  // 10. 落盘清单（当前/上一镜像 + 已应用迁移）
  const migrationsDir = path.join(layout.backendRoot, path.dirname(schemaRel), 'migrations');
  const appliedMigrations = listMigrations(migrationsDir);
  writeManifest(projectRoot, {
    version: 1,
    current: { image: imageTag, deployedAt: report.startedAt },
    previous: manifest.current,
    appliedMigrations,
  });

  report.result = 'success';
  report.image = imageTag;
  report.finishedAt = now().toISOString();
  writeReport(projectRoot, report);
  io.log(`[deploy] 完成：${imageTag}｜健康 ${health.attempts} 次通过｜报告 ${DEPLOY_REPORT_FILE}`);
  return report;
}
