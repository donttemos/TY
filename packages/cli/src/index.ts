/*
 * @file CLI 入口
 * @description 组装真实的命令实现与 IO，交给 args.ts 的 dispatch 分派；
 *   fw new / dev / build / check / db:migrate / db:rollback / db:seed 的参数解析见 args.ts。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo db:* 三个命令改为 await 分派（命令实现已异步化）
 * @modified 2026-10-13 donttemo 分派逻辑抽到 args.ts（可注入依赖与 IO，便于单测覆盖全部分支）
 * @module cli
 * @since v0.1.0
 */
import { dispatch } from './args.js';
import { runCheck } from './commands/check.js';
import { runMigrate, runRollback, runSeed } from './commands/db.js';
import { runNew } from './commands/new.js';
import { runPnpmScript } from './commands/run.js';

/** 分派主函数：注入真实实现与进程 IO */
async function main(): Promise<void> {
  await dispatch(
    process.argv.slice(2),
    {
      createProject: runNew,
      pnpmScript: runPnpmScript,
      check: runCheck,
      migrate: runMigrate,
      rollback: runRollback,
      seed: runSeed,
    },
    {
      log: (message) => console.log(message),
      error: (message) => console.error(message),
      exit: (code) => process.exit(code),
    },
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
