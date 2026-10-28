/*
 * @file CLI 入口
 * @description 组装真实的命令实现与 IO，交给 args.ts 的 dispatch 分派；
 *   fw new / dev / build / check / db:migrate / db:rollback / db:seed / gen crud 的参数解析见 args.ts。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo db:* 三个命令改为 await 分派（命令实现已异步化）
 * @modified 2026-10-13 donttemo 分派逻辑抽到 args.ts（可注入依赖与 IO，便于单测覆盖全部分支）
 * @modified 2026-10-13 donttemo 接入 M6 gen crud（CRUD 代码生成器，编排见 gen/gen.ts）
 * @modified 2026-10-22 donttemo 接入 M17 review（AI 审查生成物，编排见 review/review.ts）
 * @module cli
 * @since v0.1.0
 */
import { dispatch } from './args.js';
import { runCheck } from './commands/check.js';
import { runDeployCommand } from './commands/deploy.js';
import { runMigrate, runRollback, runSeed } from './commands/db.js';
import { runNew } from './commands/new.js';
import { runPnpmScript } from './commands/run.js';
import { runGenCrud } from './gen/gen.js';
import { runReview } from './review/review.js';
import { aiConfigFilePath, effectiveAiEnv, readAiConfigFile } from './ai/ai-config-store.js';
import { runVerifyCommand } from './commands/verify.js';
import { runStudioCommand } from './commands/studio.js';

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
      genCrud: runGenCrud,
      // 命令实现只关心副作用：审查结论已由 runReview 直接打印
      // 生效配置与 Studio 同口径：页面保存的 AI 路由优先于环境变量
      review: async (options) => {
        const env = effectiveAiEnv(process.env, readAiConfigFile(aiConfigFilePath()).config);
        await runReview(options, { env });
      },
      deploy: runDeployCommand,
      verify: runVerifyCommand,
      studio: runStudioCommand,
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
