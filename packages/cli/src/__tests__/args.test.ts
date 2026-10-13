/*
 * @file CLI 参数解析与命令分派单测
 * @description 覆盖 parseOptions / parseFlags 的解析规则与 dispatch 的全部分支：
 *   help / 未知命令 / new 缺项目名 / new 模板透传与默认值 / dev 与 build / check /
 *   db 三命令的 schema 传递 / gen crud 的模型、布尔 flag 与 --only 校验（M6）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 增补 gen crud 分派与 parseFlags 用例（M6）
 * @module cli
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatch, parseFlags, parseOptions, USAGE } from '../args.js';
import type { CliDeps, CliIo } from '../args.js';

/** 被 spy 的记录型 IO */
interface RecordedIo {
  io: CliIo;
  logs: string[];
  errors: string[];
  exits: number[];
}

/** 记录输出与退出码的测试 IO */
function makeIo(): RecordedIo {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    logs,
    errors,
    exits,
    io: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      exit: (code) => exits.push(code),
    },
  };
}

/** 全部命令实现都是替身的依赖 */
interface MockedDeps {
  createProject: ReturnType<typeof vi.fn>;
  pnpmScript: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  migrate: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  seed: ReturnType<typeof vi.fn>;
  genCrud: ReturnType<typeof vi.fn>;
}

/** 构造替身依赖（所有命令默认成功） */
function makeDeps(): MockedDeps {
  return {
    createProject: vi.fn(async () => undefined),
    pnpmScript: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    migrate: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    seed: vi.fn(async () => undefined),
    genCrud: vi.fn(async () => undefined),
  };
}

/** 以 CliDeps 视角调用 dispatch（替身与真实签名结构一致） */
function run(argv: string[], deps: MockedDeps, io: CliIo): Promise<void> {
  return dispatch(argv, deps as unknown as CliDeps, io);
}

describe('parseOptions', () => {
  it('解析 --key=value 形式', () => {
    expect(parseOptions(['--template=api', '--schema=prisma/x.prisma'])).toEqual({
      template: 'api',
      schema: 'prisma/x.prisma',
    });
  });

  it('忽略非选项参数与无等号的 --flag', () => {
    expect(parseOptions(['my-app', '--force', '--env=dev'])).toEqual({ env: 'dev' });
  });

  it('允许值为空串', () => {
    expect(parseOptions(['--schema='])).toEqual({ schema: '' });
  });

  it('同名选项后者覆盖前者', () => {
    expect(parseOptions(['--a=1', '--a=2'])).toEqual({ a: '2' });
  });

  it('无参数时返回空对象', () => {
    expect(parseOptions([])).toEqual({});
  });
});

describe('parseFlags', () => {
  it('解析无等号的布尔 flag', () => {
    expect(parseFlags(['order', '--dry', '--force', '--app=web'])).toEqual(['dry', 'force']);
  });

  it('无 flag 时返回空数组', () => {
    expect(parseFlags(['order', '--app=web'])).toEqual([]);
  });
});

describe('dispatch', () => {
  it('无参数时打印用法且不退出', async () => {
    const { io, logs, exits } = makeIo();
    await run([], makeDeps(), io);
    expect(logs).toEqual([USAGE]);
    expect(exits).toEqual([]);
  });

  it('help 与 --help 均打印用法', async () => {
    const first = makeIo();
    await run(['help'], makeDeps(), first.io);
    const second = makeIo();
    await run(['--help'], makeDeps(), second.io);
    expect(first.logs).toEqual([USAGE]);
    expect(second.logs).toEqual([USAGE]);
  });

  it('未知命令时输出错误并以 1 退出', async () => {
    const { io, logs, errors, exits } = makeIo();
    await run(['frobnicate'], makeDeps(), io);
    expect(errors[0]).toContain('未知命令：frobnicate');
    expect(logs).toEqual([USAGE]);
    expect(exits).toEqual([1]);
  });

  it('new 缺少项目名时报错退出，且不创建项目', async () => {
    const deps = makeDeps();
    const { io, errors, exits } = makeIo();
    await run(['new'], deps, io);
    expect(errors[0]).toContain('缺少项目名');
    expect(exits).toEqual([1]);
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it('new 未指定模板时默认 api', async () => {
    const deps = makeDeps();
    const { io } = makeIo();
    await run(['new', 'my-system'], deps, io);
    expect(deps.createProject).toHaveBeenCalledWith('my-system', 'api');
  });

  it('new 透传模板选项', async () => {
    const deps = makeDeps();
    const { io } = makeIo();
    await run(['new', 'my-system', '--template=admin'], deps, io);
    expect(deps.createProject).toHaveBeenCalledWith('my-system', 'admin');
  });

  it('dev 与 build 透传同名 pnpm 脚本', async () => {
    const devDeps = makeDeps();
    await run(['dev'], devDeps, makeIo().io);
    const buildDeps = makeDeps();
    await run(['build'], buildDeps, makeIo().io);
    expect(devDeps.pnpmScript).toHaveBeenCalledWith('dev');
    expect(buildDeps.pnpmScript).toHaveBeenCalledWith('build');
  });

  it('check 调用配置自检', async () => {
    const deps = makeDeps();
    await run(['check'], deps, makeIo().io);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it('db:migrate / db:rollback / db:seed 分派到各自实现', async () => {
    const deps = makeDeps();
    await run(['db:migrate'], deps, makeIo().io);
    await run(['db:rollback'], deps, makeIo().io);
    await run(['db:seed'], deps, makeIo().io);
    expect(deps.migrate).toHaveBeenCalledWith({ schema: undefined });
    expect(deps.rollback).toHaveBeenCalledWith({ schema: undefined });
    expect(deps.seed).toHaveBeenCalledWith({ schema: undefined });
  });

  it('db 命令把 --schema 选项传给实现', async () => {
    const deps = makeDeps();
    await run(['db:migrate', '--schema=prisma/custom.prisma'], deps, makeIo().io);
    expect(deps.migrate).toHaveBeenCalledWith({ schema: 'prisma/custom.prisma' });
  });
});

describe('dispatch gen crud（M6）', () => {
  it('位置参数模型与布尔 flag / 键值选项一并透传', async () => {
    const deps = makeDeps();
    await run(['gen', 'crud', 'order', '--dry', '--only=backend', '--app=example-api'], deps, makeIo().io);
    expect(deps.genCrud).toHaveBeenCalledWith({
      models: ['order'],
      all: false,
      only: 'backend',
      app: 'example-api',
      web: undefined,
      schema: undefined,
      dry: true,
      force: false,
      noVerify: false,
    });
  });

  it('--model=a,b 与位置参数合并', async () => {
    const deps = makeDeps();
    await run(['gen', 'crud', 'order', '--model=user,role'], deps, makeIo().io);
    expect(deps.genCrud).toHaveBeenCalledWith(expect.objectContaining({ models: ['order', 'user', 'role'] }));
  });

  it('--all 与 --force / --no-verify 透传', async () => {
    const deps = makeDeps();
    await run(['gen', 'crud', '--all', '--force', '--no-verify'], deps, makeIo().io);
    expect(deps.genCrud).toHaveBeenCalledWith(
      expect.objectContaining({ all: true, force: true, noVerify: true, models: [] }),
    );
  });

  it('--only 取值不合法时报错退出', async () => {
    const deps = makeDeps();
    const { io, errors, exits } = makeIo();
    await run(['gen', 'crud', 'order', '--only=both'], deps, io);
    expect(errors[0]).toContain('--only 取值不合法');
    expect(exits).toEqual([1]);
    expect(deps.genCrud).not.toHaveBeenCalled();
  });

  it('未知 gen 子命令时报错退出', async () => {
    const deps = makeDeps();
    const { io, errors, exits } = makeIo();
    await run(['gen', 'rest'], deps, io);
    expect(errors[0]).toContain('未知 gen 子命令');
    expect(exits).toEqual([1]);
  });

  it('gen 缺子命令时报错退出', async () => {
    const deps = makeDeps();
    const { io, errors, exits } = makeIo();
    await run(['gen'], deps, io);
    expect(errors[0]).toContain('未知 gen 子命令');
    expect(exits).toEqual([1]);
  });
});
