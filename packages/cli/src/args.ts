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
  fw gen crud <模型名,...>                   由数据模型生成前后端 CRUD（M6）
    --dry              只打印将创建 / 修改的文件与 diff，不落盘
    --force            覆盖已存在文件（默认跳过并提示）
    --only=<scope>     生成范围：backend | frontend | seed | all（默认 all）
    --all              生成全部可用模型（无位置参数时也可进入交互选择）
    --model=a,b        多模型（等价于位置参数逗号写法）
    --app=<目录名>      后端应用（apps/<app>，默认自动探测）
    --web=<目录名>      前端应用（apps/<web>，默认自动探测）
    --schema=<路径>     prisma schema（默认 <app>/prisma/schema.prisma）
    --no-verify        跳过生成后编译校验（默认对后端应用跑 tsc --noEmit，失败自动回滚）
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
