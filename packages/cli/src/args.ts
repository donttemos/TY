/*
 * @file CLI 参数解析与命令分派
 * @description 把 index.ts 的分派逻辑抽为可注入的纯函数：`parseOptions` 解析 `--key=value`，
 *   `dispatch` 完成「命令 → 处理器」映射。依赖（各命令实现）与 IO（日志 / 退出码）全部经参数注入，
 *   因此单测可覆盖 help / 未知命令 / 缺参数等全部分支，且不触发真实文件与进程操作。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 * @since v0.1.0
 */

/** 用法说明 */
export const USAGE = `fw — 通用应用框架脚手架

用法：
  fw new <name> --template=<api|admin|cms>   从模板创建项目
  fw dev                                     在当前项目启动开发（透传 pnpm dev）
  fw build                                   在当前项目构建（透传 pnpm build）
  fw check                                   配置自检（校验 .env 完整性）
  fw db:migrate                              应用全部未执行迁移（幂等，--schema=<路径> 可指定）
  fw db:rollback                             回滚最后一次迁移（结构回到上一版本）
  fw db:seed                                 执行 package.json 的 prisma.seed 种子脚本
  fw studio                                  本地可视化工作台（M17 · 只读）
    在 127.0.0.1 起一个本地服务并打开浏览器：项目体检、模型浏览、检查结果。
    --port=<n>          端口（默认 4310；0 表示随机空闲端口）
    --no-open           只起服务，不自动打开浏览器
    --new-token         轮换本地令牌（默认按项目持久化，重启不变；轮换后旧页面失效）
  fw verify                                  黄金链路验收（M16：一条命令看结论）
    --target=ci|real    ci=仓库内建全新项目跑通（SQLite，无 Docker）；real=验证已部署实例
    --skip-browser      只跑到健康检查（不跑浏览器 CRUD）
    --keep              保留生成的验收项目（默认跑完清理）
  fw deploy                                  单机 Docker Compose 部署（M16：一条命令到底）
    首次运行只问三项（域名 / 数据库密码 / Redis 密码，后两项留空自动生成），之后零输入；
    自动完成：预检 → 构建 → 备份 → 迁移（含风险闸门）→ 启动 → 健康检查 → 写报告。
    --plan              只输出计划与迁移风险，不执行任何变更
    --rollback          回退到上一镜像并重启（数据库不回滚）
    --target=compose|bare-metal  部署渠道（默认 compose；bare-metal 透传既有脚本）
    --yes               非交互：缺配置时自动生成密钥
    --skip-backup       跳过备份（无数据变更时可用）
    --seed              执行种子（首装初始化账号/权限；seed 含清场语义，谨慎）
    --allow-destructive 放行破坏性迁移（默认阻断，需确认）
  fw gen crud <模型名,...>                   由数据模型生成前后端 CRUD（M6 / M16：一条命令到底）
    --dry              只打印将创建 / 修改的文件与 diff，不落盘
    --force            覆盖已存在文件（默认跳过并提示）
    --only=<scope>     生成范围：backend | frontend | seed | all（默认 all）
    --all              生成全部可用模型（无位置参数时也可进入交互选择）
    --model=a,b        多模型（等价于位置参数逗号写法）
    --app=<目录名>      后端应用（apps/<app>，默认自动探测）
    --web=<目录名>      前端应用（apps/<web>，默认自动探测）
    --schema=<路径>     prisma schema（默认 <app>/prisma/schema.prisma）
    --fast             只校验后端（跳过前端 vue-tsc；默认前后端都校验）
    --no-verify        跳过生成后类型校验
    --no-migrate       跳过建迁移与应用迁移（只生成代码与接线）
    --no-seed          跳过定向权限种子
    --allow-destructive 放行破坏性迁移（默认阻断，需确认）
  fw review [模型名,...]                      AI 审查生成物（PRD-017 FR-17-23）
    只审 fw.gen.json 记录的产物与接线文件，不扫全仓库；审查只读，不写盘、不改 schema。
    需要环境变量：FW_AI_API_KEY（必填，也接受 OPENAI_API_KEY）/ FW_AI_MODEL（必填）
                  FW_AI_BASE_URL（可选，OpenAI 兼容接口，默认 OpenAI 官方）
    --model=a,b        只审这些模型（等价于位置参数）
    --ai-model=<名>    覆盖 FW_AI_MODEL
    --base-url=<url>   覆盖 FW_AI_BASE_URL（DeepSeek / 自建网关 / Ollama）
    --dry              只列出将发送的文件，不联网、不需要密钥
    --max-files=<n>    文件数上限（默认 40）
    --timeout=<ms>     模型调用超时（默认 120000）
    --chunk-kb=<n>     单次发送的体积预算（默认 24；越小越稳、调用次数越多）
    --per-file         每个文件单独调用一次（等价 --split=file）
    --split=<mode>     auto（默认，按体积装箱）/ file（逐文件）/ model（按模型分组，推荐找设计级问题）
    --raw              额外打印模型原文（默认只打印去重后的汇总）
  fw help                                    显示本帮助
`;

/** db 类命令选项（与 commands/db.ts 的 DbCommandOptions 结构一致） */
export interface DbOptions {
  /** schema 文件路径，默认 prisma/schema.prisma */
  schema?: string;
}

/** gen crud 命令选项（与 gen/gen.ts 的 GenCrudOptions 结构一致） */
export interface GenOptions {
  /** 位置参数：模型名列表 */
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
  /** --no-migrate：跳过迁移 */
  noMigrate?: boolean;
  /** --no-seed：跳过定向种子 */
  noSeed?: boolean;
  /** --allow-destructive：放行破坏性迁移 */
  allowDestructive?: boolean;
  /** --fast：只校验后端 */
  fast?: boolean;
}

/** fw studio 命令选项（与 commands/studio.ts 的 StudioCommandOptions 结构一致） */
export interface StudioCliOptions {
  port?: number;
  noOpen?: boolean;
  /** --new-token：轮换本地令牌 */
  rotateToken?: boolean;
}

/** fw verify 命令选项（与 commands/verify.ts 的 VerifyCommandOptions 结构一致） */
export interface VerifyCliOptions {
  target?: string;
  name?: string;
  model?: string;
  skipBrowser?: boolean;
  keep?: boolean;
  baseUrl?: string;
  username?: string;
  password?: string;
}

/** fw deploy 命令选项（与 commands/deploy.ts 的 DeployCommandOptions 结构一致） */
export interface DeployCliOptions {
  /** --plan：只输出计划 */
  plan?: boolean;
  /** --rollback：回退到上一镜像 */
  rollback?: boolean;
  /** --target=compose|bare-metal */
  target?: string;
  /** --yes：非交互 */
  yes?: boolean;
  /** --skip-backup */
  skipBackup?: boolean;
  /** --seed：执行种子（默认不执行） */
  seed?: boolean;
  /** --allow-destructive */
  allowDestructive?: boolean;
  /** --keep-backups=N */
  keepBackups?: number;
  /** --compose=<路径> */
  composeFile?: string;
  /** --env-file=<路径> */
  envFile?: string;
}

/** fw review 命令选项（与 review/review.ts 的 ReviewOptions 结构一致） */
export interface ReviewCliOptions {
  /** 只审这些模型（位置参数或 --model） */
  models?: string[];
  /** --app=<后端应用目录名> */
  app?: string;
  /** --schema=<路径> */
  schema?: string;
  /** --dry：只列将发送的文件 */
  dry?: boolean;
  /** --ai-model=<名> */
  aiModel?: string;
  /** --base-url=<url> */
  baseUrl?: string;
  /** --max-files=<n> */
  maxFiles?: number;
  /** --timeout=<ms> */
  timeoutMs?: number;
  /** --per-file：逐文件调用 */
  perFile?: boolean;
  /** --split=auto|file|model */
  split?: 'auto' | 'file' | 'model';
  /** --raw：额外打印原文 */
  raw?: boolean;
}

/** 分派所需的命令实现（内置默认见 index.ts，单测注入替身） */
export interface CliDeps {
  /** fw new：从模板创建项目 */
  createProject: (name: string, template: string) => Promise<void>;
  /** fw dev / fw build：透传 pnpm 脚本 */
  pnpmScript: (script: string) => Promise<void>;
  /** fw check：配置自检 */
  check: () => Promise<void>;
  /** fw db:migrate */
  migrate: (options: DbOptions) => Promise<void>;
  /** fw db:rollback */
  rollback: (options: DbOptions) => Promise<void>;
  /** fw db:seed */
  seed: (options: DbOptions) => Promise<void>;
  /** fw gen crud：CRUD 代码生成（M6） */
  genCrud: (options: GenOptions) => Promise<void>;
  /** fw review：AI 审查生成物（M17） */
  review: (options: ReviewCliOptions) => Promise<void>;
  /** fw deploy：单机 Compose 部署（M16） */
  deploy: (options: DeployCliOptions) => Promise<void>;
  /** fw verify：黄金链路验收（M16） */
  verify: (options: VerifyCliOptions) => Promise<void>;
  /** fw studio：本地可视化工作台（M17） */
  studio: (options: StudioCliOptions) => Promise<void>;
}

/** 分派所需的 IO（便于单测断言输出与退出码） */
export interface CliIo {
  /** 标准输出 */
  log: (message: string) => void;
  /** 错误输出 */
  error: (message: string) => void;
  /** 结束进程 */
  exit: (code: number) => void;
}

/**
 * 解析 --key=value 形式的选项
 * @param args 命令行参数（不含命令本身）
 * @returns 选项名到值的映射；非 `--k=v` 形式的参数被忽略
 */
export function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const arg of args) {
    const matched = arg.match(/^--([^=]+)=(.*)$/);
    if (matched) options[matched[1]] = matched[2];
  }
  return options;
}

/**
 * 解析布尔 flag（--dry / --force 等无等号形式）
 * @param args 命令行参数（不含命令本身）
 * @returns flag 名列表（不含 -- 前缀）
 */
export function parseFlags(args: string[]): string[] {
  return args.filter((arg) => /^--[^=]+$/.test(arg)).map((arg) => arg.slice(2));
}

/**
 * 命令分派主函数
 * @param argv 参数列表（已去掉 node 可执行文件与脚本路径，通常为 process.argv.slice(2)）
 * @param deps 命令实现
 * @param io 输出与退出
 */
export async function dispatch(argv: string[], deps: CliDeps, io: CliIo): Promise<void> {
  const [command, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith('--'));
  const options = parseOptions(rest);

  switch (command) {
    case 'new': {
      const name = positional[0];
      if (!name) {
        io.error('缺少项目名：fw new <name> --template=api');
        io.exit(1);
        return;
      }
      await deps.createProject(name, options.template ?? 'api');
      return;
    }
    case 'dev':
    case 'build':
      await deps.pnpmScript(command);
      return;
    case 'check':
      await deps.check();
      return;
    case 'db:migrate':
      await deps.migrate({ schema: options.schema });
      return;
    case 'db:rollback':
      await deps.rollback({ schema: options.schema });
      return;
    case 'db:seed':
      await deps.seed({ schema: options.schema });
      return;
    case 'gen': {
      const sub = positional[0];
      if (sub !== 'crud') {
        io.error(`未知 gen 子命令：${sub ?? '（缺失）'}（当前仅支持：crud）\n`);
        io.log(USAGE);
        io.exit(1);
        return;
      }
      if (options.only !== undefined && !['backend', 'frontend', 'seed', 'all'].includes(options.only)) {
        io.error(`--only 取值不合法：${options.only}（可选：backend / frontend / seed / all）`);
        io.exit(1);
        return;
      }
      const flags = new Set(parseFlags(rest));
      // --model=a,b 与位置参数等价，合并去重
      const fromOption = (options.model ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const models = [...positional.slice(1), ...fromOption];
      await deps.genCrud({
        models,
        all: flags.has('all'),
        only: options.only,
        app: options.app,
        web: options.web,
        schema: options.schema,
        dry: flags.has('dry'),
        force: flags.has('force'),
        noVerify: flags.has('no-verify'),
        noMigrate: flags.has('no-migrate'),
        noSeed: flags.has('no-seed'),
        allowDestructive: flags.has('allow-destructive'),
        fast: flags.has('fast'),
      });
      return;
    }
    case 'studio': {
      const flags = new Set(parseFlags(rest));
      const portRaw = options.port;
      const port = portRaw === undefined ? undefined : Number(portRaw);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        io.error(`--port 取值不合法：${portRaw}（需为 0~65535 的整数）`);
        io.exit(1);
        return;
      }
      await deps.studio({ port, noOpen: flags.has('no-open'), rotateToken: flags.has('new-token') });
      return;
    }
    case 'review': {
      const flags = new Set(parseFlags(rest));
      const fromOption = (options.model ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const maxRaw = options['max-files'];
      const maxFiles = maxRaw === undefined ? undefined : Number(maxRaw);
      if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
        io.error(`--max-files 取值不合法：${maxRaw}（需为 ≥1 的整数）`);
        io.exit(1);
        return;
      }
      const timeoutRaw = options.timeout;
      const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
        io.error(`--timeout 取值不合法：${timeoutRaw}（需为 ≥1000 的整数毫秒）`);
        io.exit(1);
        return;
      }
      await deps.review({
        models: [...positional, ...fromOption],
        app: options.app,
        schema: options.schema,
        dry: flags.has('dry'),
        aiModel: options['ai-model'],
        baseUrl: options['base-url'],
        maxFiles,
        timeoutMs,
        ...(options['chunk-kb'] === undefined
          ? {}
          : { chunkBytes: Number(options['chunk-kb']) * 1024 }),
        ...(flags.has('per-file') ? { perFile: true } : {}),
        ...(flags.has('raw') ? { raw: true } : {}),
        ...(options.split === 'auto' || options.split === 'file' || options.split === 'model'
          ? { split: options.split }
          : {}),
      });
      return;
    }
    case 'verify': {
      const flags = new Set(parseFlags(rest));
      if (options.target !== undefined && !['ci', 'real'].includes(options.target)) {
        io.error(`--target 取值不合法：${options.target}（可选：ci / real）`);
        io.exit(1);
        return;
      }
      await deps.verify({
        target: options.target,
        name: options.name,
        model: options.model,
        skipBrowser: flags.has('skip-browser'),
        keep: flags.has('keep'),
        baseUrl: options.url,
        username: options.user,
        password: options.pass,
      });
      return;
    }
    case 'deploy': {
      const flags = new Set(parseFlags(rest));
      if (options.target !== undefined && !['compose', 'bare-metal'].includes(options.target)) {
        io.error(`--target 取值不合法：${options.target}（可选：compose / bare-metal）`);
        io.exit(1);
        return;
      }
      const keepRaw = options['keep-backups'];
      const keepBackups = keepRaw === undefined ? undefined : Number(keepRaw);
      if (keepBackups !== undefined && (!Number.isInteger(keepBackups) || keepBackups < 1)) {
        io.error(`--keep-backups 取值不合法：${keepRaw}（需为 ≥1 的整数）`);
        io.exit(1);
        return;
      }
      await deps.deploy({
        plan: flags.has('plan'),
        rollback: flags.has('rollback'),
        target: options.target,
        yes: flags.has('yes'),
        skipBackup: flags.has('skip-backup'),
        seed: flags.has('seed'),
        allowDestructive: flags.has('allow-destructive'),
        keepBackups,
        composeFile: options.compose,
        envFile: options['env-file'],
      });
      return;
    }
    case 'help':
    case '--help':
    case undefined:
      io.log(USAGE);
      return;
    default:
      io.error(`未知命令：${command}\n`);
      io.log(USAGE);
      io.exit(1);
  }
}
