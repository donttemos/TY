/*
 * @file fw verify 黄金链路验收（PRD-016 FR-16-15/16/17）
 * @description 用一条命令串联「初始化 → 建模 → 生成 → 迁移 → 种子 → 构建 → 启动 → 浏览器 CRUD → 报告」，
 *   让验收从「人工执行几十条命令」变成「跑一条命令看结论」。
 *   两个 target 共用同一套断言与报告结构：
 *   - ci：在仓库内生成 apps/auto-verify（自动注册为工作区成员），SQLite，无 Docker；
 *   - real：不建项目，直接对已部署实例跑健康检查与浏览器 CRUD（是否先 fw deploy 由调用方决定）。
 *   关键取舍：
 *   - 种子顺序不能颠倒：模板的全量 seed 会清场，必须先 seed 基线再 `fw gen crud`（定向种子写业务权限），
 *     否则生成出来的模块权限会被随后的全量 seed 清掉、菜单消失、浏览器用例必然失败；
 *   - 浏览器用例缺 Playwright 时**明确跳过**而不是伪通过（报告里 stage=skipped + 安装命令）；
 *   - 所有外部依赖（exec / 后台进程 / fetch / 浏览器）可注入，单测不装浏览器、不开端口。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/verify
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { firstLineOf, type Exec } from '../deploy/exec.js';
import { defaultExec, pnpmBin } from '../deploy/exec.js';
import { runDeploy } from '../deploy/deploy.js';

/** 验收目标 */
export type VerifyTarget = 'ci' | 'real';

/** 阶段名 */
export type VerifyStage =
  | 'workspace'
  | 'install'
  | 'model'
  | 'migrate'
  | 'seed'
  | 'generate'
  | 'build'
  | 'boot'
  | 'browser'
  | 'deploy'
  | 'health';

/** 单阶段结果 */
export interface VerifyStageResult {
  name: VerifyStage;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  durationMs: number;
}

/** 验收报告 */
export interface VerifyReport {
  version: 1;
  target: VerifyTarget;
  startedAt: string;
  finishedAt: string;
  result: 'success' | 'failed';
  stages: VerifyStageResult[];
  /** 生成的模块路由（浏览器用例的目标） */
  route?: string;
  /** 应用地址（浏览器用例的 baseURL） */
  baseUrl?: string;
  error?: { stage: VerifyStage; message: string; next: string };
}

/** 后台进程句柄 */
export interface BackgroundProcess {
  /** 停止进程（幂等） */
  stop: () => Promise<void>;
  /** 最近输出（失败时附到错误里） */
  tail: () => string;
}

/** 后台进程拉起函数（可注入） */
export type Spawn = (command: string, args: string[], cwd: string, env?: Record<string, string>) => BackgroundProcess;

/** 浏览器用例执行结果 */
export interface BrowserResult {
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
}

/** 浏览器用例执行器（可注入） */
export type BrowserRunner = (options: {
  /** admin-web 目录 */
  cwd: string;
  /** 应用地址 */
  baseUrl: string;
  /** 生成的模块路由 */
  route: string;
  /** 账号 */
  username: string;
  password: string;
  /** 产物目录 */
  outputDir: string;
}) => Promise<BrowserResult>;

/** 验收选项 */
export interface VerifyOptions {
  /** 仓库根 */
  projectRoot: string;
  /** 目标（默认 ci） */
  target?: VerifyTarget;
  /** 生成项目名（默认 auto-verify） */
  name?: string;
  /** 浏览器用例的模型名（默认 Product） */
  model?: string;
  /** 跳过浏览器阶段 */
  skipBrowser?: boolean;
  /** 保留生成的项目（默认清理） */
  keep?: boolean;
  /** 已部署地址（real 目标） */
  baseUrl?: string;
  /** 登录账号（默认 admin / Admin@123456，与模板 seed 一致） */
  username?: string;
  password?: string;
  /** 健康检查超时 */
  healthTimeoutMs?: number;
}

/** 可注入依赖 */
export interface VerifyDeps {
  exec?: Exec;
  spawn?: Spawn;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  io?: { log: (message: string) => void; error: (message: string) => void };
  browser?: BrowserRunner;
  /** 部署函数（real 目标可选调用；默认 runDeploy） */
  deploy?: typeof runDeploy;
}

/** 报告文件名 */
export const VERIFY_REPORT_FILE = 'verify-report.json';

/** 默认后台进程：输出落日志文件，停止时 SIGTERM 后兜底 SIGKILL */
const defaultSpawn: Spawn = (command, args, cwd, env) => {
  const logFile = path.join(cwd, '.verify-process.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawnProcess(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    detached: false,
  });
  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // 进程已退出
            }
            resolve();
          }, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // 已退出
      }
      try {
        fs.closeSync(fd);
      } catch {
        // 句柄已关闭
      }
    },
    tail: () => {
      try {
        const text = fs.readFileSync(logFile, 'utf8');
        return text.split('\n').slice(-15).join('\n');
      } catch {
        return '';
      }
    },
  };
};

/** 轮询健康检查（与 deploy 的 waitForHealth 同语义，这里不引它以免循环依赖） */
async function waitHealthy(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return true;
    } catch {
      // 未就绪
    }
    await sleep(1000);
  }
  return false;
}

/** 默认浏览器执行器：调用 playwright（未安装则跳过，绝不伪通过） */
export const defaultBrowserRunner: BrowserRunner = async (options) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const run = async (args: string[]): Promise<{ ok: boolean; output: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'playwright', ...args], {
        cwd: options.cwd,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          E2E_BASE_URL: options.baseUrl,
          E2E_ROUTE: options.route,
          E2E_USER: options.username,
          E2E_PASS: options.password,
          E2E_OUTPUT: options.outputDir,
        },
      });
      return { ok: true, output: `${stdout}\n${stderr}`.trim() };
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: (detail.stdout || detail.stderr || detail.message || '').trim() };
    }
  };

  const version = await run(['--version']);
  if (!version.ok) {
    return {
      status: 'skipped',
      detail: '未安装 Playwright：在 apps/admin-web 执行 pnpm add -D @playwright/test && pnpm exec playwright install chromium',
    };
  }
  const result = await run(['test', '--reporter=line']);
  if (result.ok) return { status: 'passed', detail: '浏览器用例通过' };
  // 框架装了但浏览器二进制没下（离线/CI 未装）→ 明确跳过，不伪通过也不误报为用例失败
  if (/Executable doesn't exist|playwright install/i.test(result.output)) {
    return {
      status: 'skipped',
      detail: '浏览器二进制缺失：执行 pnpm --filter admin-web exec playwright install chromium',
    };
  }
  const tail = result.output.split('\n').filter(Boolean).slice(-3).join(' / ');
  return { status: 'failed', detail: tail || '浏览器用例失败' };
};

/**
 * 执行黄金链路验收
 * @param options 选项
 * @param deps 可注入依赖
 */
export async function runVerify(options: VerifyOptions, deps: VerifyDeps = {}): Promise<VerifyReport> {
  const io = deps.io ?? { log: (message: string) => console.log(message), error: (message: string) => console.error(message) };
  const exec = deps.exec ?? defaultExec;
  const spawnBg = deps.spawn ?? defaultSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const browserRunner = deps.browser ?? defaultBrowserRunner;

  const target = options.target ?? 'ci';
  const name = options.name ?? 'auto-verify';
  const model = options.model ?? 'Product';
  const route = `/${model.toLowerCase()}s`;
  const startedAt = now().toISOString();
  const stages: VerifyStageResult[] = [];
  const report: VerifyReport = {
    version: 1,
    target,
    startedAt,
    finishedAt: startedAt,
    result: 'failed',
    stages,
    route,
  };

  const mark = (stage: VerifyStage, status: VerifyStageResult['status'], startedMs: number, detail?: string): void => {
    stages.push({ name: stage, status, detail, durationMs: Date.now() - startedMs });
  };
  const fail: (stage: VerifyStage, message: string, next: string) => never = (stage, message, next) => {
    mark(stage, 'failed', Date.now());
    report.result = 'failed';
    report.finishedAt = now().toISOString();
    report.error = { stage, message, next };
    writeReport(options.projectRoot, report);
    throw new Error(`${message}。${next}`);
  };

  const backgrounds: BackgroundProcess[] = [];
  const cleanup = async (): Promise<void> => {
    for (const bg of backgrounds.reverse()) await bg.stop();
  };

  try {
    // ---------- real：只验证已部署实例 ----------
    if (target === 'real') {
      const baseUrl = options.baseUrl ?? 'http://127.0.0.1';
      report.baseUrl = baseUrl;
      if (!options.skipBrowser && fs.existsSync(path.join(options.projectRoot, '.env.prod'))) {
        const deployStart = Date.now();
        try {
          // io 走第三参（DeployDeps），不是 options——Options 里没有 io
          await (deps.deploy ?? runDeploy)({ projectRoot: options.projectRoot }, { io, fetchImpl, sleep });
          mark('deploy', 'ok', deployStart);
        } catch (error) {
          fail('deploy', firstLineOf(error), '修正后重跑 fw verify --target=real；部署细节见 deploy-report.json');
        }
      } else {
        mark('deploy', 'skipped', Date.now(), '未执行部署（已跳过或缺少 .env.prod）');
      }

      const healthStart = Date.now();
      const healthy = await waitHealthy(`${baseUrl}/health`, options.healthTimeoutMs ?? 60_000, fetchImpl, sleep);
      if (!healthy) fail('health', `健康检查未通过：${baseUrl}/health`, '确认服务已启动：docker compose ps / 查看 app 日志');
      mark('health', 'ok', healthStart);

      if (options.skipBrowser) {
        mark('browser', 'skipped', Date.now(), '--skip-browser');
      } else {
        const browserStart = Date.now();
        const result = await browserRunner({
          cwd: path.join(options.projectRoot, 'apps', 'admin-web'),
          baseUrl,
          route,
          username: options.username ?? 'admin',
          password: options.password ?? 'Admin@123456',
          outputDir: path.join(options.projectRoot, 'verify-artifacts'),
        });
        mark('browser', result.status === 'passed' ? 'ok' : result.status, browserStart, result.detail);
        if (result.status === 'failed') fail('browser', `浏览器 CRUD 未通过：${result.detail}`, '查看 verify-artifacts 下的 trace 与截图');
      }

      report.result = 'success';
      report.finishedAt = now().toISOString();
      writeReport(options.projectRoot, report);
      io.log(`[verify] 通过（target=real）：${stages.filter((s) => s.status === 'ok').length} 个阶段`);
      return report;
    }

    // ---------- ci：仓库内生成一个全新项目并跑通 ----------
    const appsDir = path.join(options.projectRoot, 'apps');
    const projectDir = path.join(appsDir, name);
    const serverDir = path.join(projectDir, 'server');
    const webDir = path.join(projectDir, 'admin-web');
    const cliEntry = path.join(options.projectRoot, 'packages', 'cli', 'dist', 'index.js');

    // 1. 初始化项目（已存在则复用，便于断点重跑）
    const wsStart = Date.now();
    if (fs.existsSync(serverDir)) {
      mark('workspace', 'skipped', wsStart, '复用已存在的验收项目');
    } else {
      try {
        await exec('node', [cliEntry, 'new', name, '--template=admin'], appsDir);
      } catch (error) {
        fail('workspace', `创建验收项目失败：${firstLineOf(error)}`, '先执行 pnpm --filter @fw/cli run build 生成 CLI 产物');
      }
      mark('workspace', 'ok', wsStart, `apps/${name}`);
    }

    // 2. 安装（新成员需要被 pnpm 链接）
    const installStart = Date.now();
    try {
      // 显式 --no-frozen-lockfile：验收项目是新注册的工作区成员，锁定文件必然需要新增 importers。
      // pnpm 在 CI=true 时把 frozen-lockfile 当默认值，不加这个参数会在 GitHub Actions 里
      // 直接 ERR_PNPM_OUTDATED_LOCKFILE——而这条命令就是要在 CI 里跑的。
      await exec(pnpmBin(), ['install', '--no-frozen-lockfile'], options.projectRoot);
      mark('install', 'ok', installStart);
    } catch (error) {
      fail('install', `依赖安装失败：${firstLineOf(error)}`, '在仓库根手工执行 pnpm install 查看完整输出');
    }

    // 3. 写模型（幂等：已存在同名 model 则跳过）
    const modelStart = Date.now();
    const schemaFile = path.join(serverDir, 'prisma', 'schema.prisma');
    if (!fs.existsSync(schemaFile)) fail('model', `schema 不存在：${schemaFile}`, '确认模板完整性（templates/admin/server/prisma）');
    const schemaText = fs.readFileSync(schemaFile, 'utf8');
    if (!new RegExp(`model\\s+${model}\\b`).test(schemaText)) {
      const snippet = `\n/// 验收用模型（fw verify 自动写入）\nmodel ${model} {\n  /// 名称\n  name  String @unique\n  /// 数量\n  qty   Int    @default(0)\n}\n`;
      fs.writeFileSync(schemaFile, `${schemaText.trimEnd()}\n${snippet}`, 'utf8');
      mark('model', 'ok', modelStart, `已写入 model ${model}`);
    } else {
      mark('model', 'skipped', modelStart, `model ${model} 已存在`);
    }

    // 4. 迁移基线 + 生成 Client（全量 seed 之前必须有表，且 seed 会 import @prisma/client）
    const migrateStart = Date.now();
    try {
      // sqlite 文件先落好：Prisma 引擎在沙箱/网络盘上无法自建库文件
      ensureSqliteFile(serverDir);
      await exec(pnpmBin(), ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], serverDir);
      // 不生成 Client 直接 seed 会报 "does not provide an export named 'PrismaClient'"（postinstall 只留空壳）
      await exec(pnpmBin(), ['exec', 'prisma', 'generate', '--schema', 'prisma/schema.prisma'], serverDir);
      mark('migrate', 'ok', migrateStart);
    } catch (error) {
      fail('migrate', `基线迁移失败：${firstLineOf(error)}`, '在 server 目录执行 pnpm exec prisma migrate status 排查');
    }

    // 5. 基线种子（创建 admin 账号；此脚本含清场语义，因此必须排在生成之前）
    const seedStart = Date.now();
    try {
      await exec(pnpmBin(), ['exec', 'tsx', 'prisma/seed.ts'], serverDir);
      mark('seed', 'ok', seedStart, 'admin / Admin@123456');
    } catch (error) {
      fail('seed', `基线种子失败：${firstLineOf(error)}`, '在 server 目录执行 pnpm exec tsx prisma/seed.ts 查看输出');
    }

    // 6. 一条命令生成（含自动接线 + 定向种子 + 后端类型校验）
    const genStart = Date.now();
    try {
      await exec('node', [cliEntry, 'gen', 'crud', model, '--fast'], serverDir);
      mark('generate', 'ok', genStart);
    } catch (error) {
      fail('generate', `生成失败：${firstLineOf(error)}`, '单独执行 fw gen crud 查看完整输出；接线问题看 fw.gen.json');
    }

    // 7. 构建（后端 dist/main.js；前端产出 dist 静态资源——验收要跑用户真正会部署的那份产物）
    const buildStart = Date.now();
    try {
      await exec(pnpmBin(), ['run', 'build'], serverDir);
      await exec(pnpmBin(), ['run', 'build'], webDir);
      mark('build', 'ok', buildStart);
    } catch (error) {
      fail('build', `构建失败：${firstLineOf(error)}`, '在 server / admin-web 目录分别执行 pnpm run build 查看类型错误');
    }

    // 8. 起服务：API 3000 + 前端 preview 5173（preview 走构建产物，且带 /api 代理）
    //    刻意不用 dev server：Vite 的依赖预构建在首屏会返回 504 Outdated Optimize Dep，
    //    浏览器拿到「模块加载失败 → 路由起不来」，表现成登录后弹回登录页——那是开发期独有的假故障，
    //    验收要验的是产物，不是 dev 服务器的预热时序。
    const bootStart = Date.now();
    backgrounds.push(spawnBg('node', ['dist/main.js'], serverDir, { APP_PORT: '3000' }));
    backgrounds.push(spawnBg(pnpmBin(), ['run', 'preview', '--port', '5173', '--strictPort'], webDir));
    const apiReady = await waitHealthy('http://127.0.0.1:3000/health', options.healthTimeoutMs ?? 90_000, fetchImpl, sleep);
    const webReady = await waitHealthy('http://127.0.0.1:5173/', options.healthTimeoutMs ?? 90_000, fetchImpl, sleep);
    if (!apiReady || !webReady) {
      const tail = backgrounds.map((bg) => bg.tail()).filter(Boolean).join('\n');
      fail('boot', `服务未就绪（api=${apiReady} web=${webReady}）`, `检查端口占用与日志：\n${tail.split('\n').slice(-6).join('\n')}`);
    }
    report.baseUrl = 'http://127.0.0.1:5173';
    mark('boot', 'ok', bootStart);

    // 9. 浏览器 CRUD
    if (options.skipBrowser) {
      mark('browser', 'skipped', Date.now(), '--skip-browser');
    } else {
      const browserStart = Date.now();
      const browserTarget = resolveBrowserCwd(options.projectRoot, webDir);
      if (browserTarget.fallback) {
        io.log('[verify] 生成项目未带 Playwright，回落到仓库 apps/admin-web 的用例驱动生成项目前端');
      }
      const result = await browserRunner({
        cwd: browserTarget.cwd,
        baseUrl: report.baseUrl,
        route,
        username: options.username ?? 'admin',
        password: options.password ?? 'Admin@123456',
        outputDir: path.join(options.projectRoot, 'verify-artifacts'),
      });
      mark('browser', result.status === 'passed' ? 'ok' : result.status, browserStart, result.detail);
      if (result.status === 'failed') {
        fail('browser', `浏览器 CRUD 未通过：${result.detail}`, '查看 verify-artifacts 下的 trace 与截图');
      }
    }

    report.result = 'success';
    report.finishedAt = now().toISOString();
    writeReport(options.projectRoot, report);
    io.log(
      `[verify] 通过（target=ci）：${stages.filter((s) => s.status === 'ok').length} 个阶段，跳过 ${stages.filter((s) => s.status === 'skipped').length} 个`,
    );
    return report;
  } finally {
    await cleanup();
    if (target === 'ci' && !options.keep) cleanupWorkspace(options.projectRoot, name);
  }
}

/** 转义正则元字符（项目名参与正则拼接，避免 `.` `*` 之类被当通配） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 选择浏览器用例所在目录
 * @description 优先用生成项目自己的 Playwright 与 e2e 用例（用户 `fw new` 后可自测）；生成项目没装时
 *   回落到框架仓库的 `apps/admin-web`——用例是可见文案级的通用流程（登录 → 新建 → 编辑 → 删除），
 *   baseURL 仍指向生成项目自己的前端（构建产物 preview），因此验的还是生成物，而不是拿框架后台自证。
 *   不做回落时，生成项目里 `pnpm exec playwright` 找不到依赖，CI 会把「浏览器阶段」记为 skipped
 *   却整体判绿——那正是 AC-16-07 最不该出现的假通过。
 * @param projectRoot 仓库根
 * @param webDir 生成项目的 admin-web 目录
 */
export function resolveBrowserCwd(projectRoot: string, webDir: string): { cwd: string; fallback: boolean } {
  const hasPlaywright = (dir: string): boolean =>
    fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test')) ||
    fs.existsSync(path.join(dir, 'playwright.config.ts')) ||
    fs.existsSync(path.join(dir, 'playwright.config.js'));
  if (hasPlaywright(webDir)) return { cwd: webDir, fallback: false };
  const repoWeb = path.join(projectRoot, 'apps', 'admin-web');
  // 项目名恰为 admin-web 时两者同路径，回落无意义
  if (path.resolve(repoWeb) === path.resolve(webDir)) return { cwd: webDir, fallback: false };
  if (hasPlaywright(repoWeb)) return { cwd: repoWeb, fallback: true };
  return { cwd: webDir, fallback: false };
}

/**
 * sqlite 场景预创建数据库文件
 * @description Prisma 的 SQLite 引擎在部分文件系统（沙箱 / 网络盘）上无法自建文件，报
 *   `unable to open database file`；文件已存在时一切正常。路径语义与 Prisma 一致：
 *   `file:` 后的相对路径按 **schema 所在目录** 解析。
 * @param serverDir 后端应用根
 * @param schemaRel schema 相对路径
 */
export function ensureSqliteFile(serverDir: string, schemaRel = 'prisma/schema.prisma'): void {
  const envFile = path.join(serverDir, '.env');
  if (!fs.existsSync(envFile)) return;
  const env = fs.readFileSync(envFile, 'utf8');
  if (!/^DB_DRIVER=sqlite\s*$/m.test(env)) return;
  const matched = env.match(/^DB_URL=file:(.+)$/m);
  if (!matched) return;
  const raw = matched[1].trim();
  // 空串与 `:memory:`（以及任何以冒号开头的形式）不是文件路径，直接跳过
  if (raw === '' || raw.startsWith(':')) return;
  const target = path.resolve(serverDir, path.dirname(schemaRel), raw);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '', { flag: 'a' });
}

/** 写报告 */
function writeReport(projectRoot: string, report: VerifyReport): void {
  try {
    fs.writeFileSync(path.join(projectRoot, VERIFY_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    // 报告写失败不影响结论
  }
}

/**
 * 清理验收项目（目录 + fw new 写入的 workspace 两行）
 * @param projectRoot 仓库根
 * @param name 项目名
 */
export function cleanupWorkspace(projectRoot: string, name: string): void {  const dir = path.join(projectRoot, 'apps', name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 占用中：留给人工清理
  }
  const workspaceFile = path.join(projectRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceFile)) return;
  try {
    const lines = fs.readFileSync(workspaceFile, 'utf8').split('\n');
    // 兼容两种写法：`apps/<name>/server`（修复注册逻辑后）与 `<name>/server`（旧版按项目名注册）
    const memberPattern = new RegExp(`^-\\s*"(?:[^"]*/)?${escapeRegExp(name)}/(?:server|admin-web)"$`);
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (memberPattern.test(trimmed)) return false;
      if (trimmed.startsWith('# ↓ 由 fw new') && trimmed.includes(name)) return false;
      return true;
    });
    fs.writeFileSync(workspaceFile, kept.join('\n'), 'utf8');
  } catch {
    // 清理失败不阻断（多出的 glob 只会让 pnpm 忽略不存在的目录）
  }
}
