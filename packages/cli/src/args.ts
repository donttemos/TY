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
  fw help                                    显示本帮助
`;

/** db 类命令选项（与 commands/db.ts 的 DbCommandOptions 结构一致） */
export interface DbOptions {
  /** schema 文件路径，默认 prisma/schema.prisma */
  schema?: string;
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
