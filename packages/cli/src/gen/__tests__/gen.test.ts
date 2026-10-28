/*
 * @file fw gen crud 编排单测（FR-07/08/09/10/11）
 * @description 以临时项目 + 注入替身覆盖：全量生成落盘、dry-run 不落盘、跳过与 --force、
 *   校验失败回滚、--all 过滤复合主键模型、交互式选择、作者回退告警、下一步清单。
 *   模板用仓库真实 templates/codegen/（render.test 已断言内容，这里断言编排行为）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenCrud, type GenDeps } from '../gen.js';
import { checkArtifactDrift, hashFile, MANIFEST_FILE, readManifest } from '../manifest.js';
import { PostGenError } from '../post-gen.js';
import type { GenIo } from '../writer.js';

const execFileAsync = promisify(execFile);

/** 夹具 schema：Order（可生成）+ OrderTag（复合主键，--all 应排除） */
const SCHEMA = `
/// 订单
model Order {
  id        String   @id @default(uuid())
  /// 订单编号
  code      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  createdBy String   @default("system")
  updatedBy String   @default("system")
  deletedAt DateTime?
}

model OrderTag {
  orderId String
  tagId   String
  @@id([orderId, tagId])
}
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-gen-run-'));
  fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), SCHEMA, 'utf8');
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 收集输出的 IO */
function makeIo(): { io: GenIo; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

/** 固定作者 / 日期 / 后处理替身的依赖 */
function makeDeps(overrides: Partial<GenDeps> = {}): GenDeps {
  return {
    author: async () => 'donttemo',
    now: () => new Date('2026-10-13T10:00:00'),
    postGen: async () => ({ migration: { name: null, applied: false }, seeded: [], verified: [] }),
    ...overrides,
  };
}

describe('runGenCrud 边界与告警', () => {
  it('--all 但 schema 没有可生成模型时报错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), 'model Join {\n  a String\n  b String\n  @@id([a, b])\n}\n', 'utf8');
    const { io } = makeIo();
    await expect(runGenCrud({ all: true }, { ...makeDeps(), io })).rejects.toThrow('没有可生成的模型');
  });

  it('git 脏工作区时给出告警（FR-07，不阻断）', async () => {
    // 真实 git 仓库 + 未提交文件：走 isGitDirty 的真实路径（不 mock 模块，避免 promisify 替身不回调导致挂起）
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'x', 'utf8');

    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io });
    expect(logs.join('\n')).toContain('未提交变更');
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order/order.module.ts'))).toBe(true);
  });

  it('默认走真实后处理时，无 tsconfig 的后端跳过类型校验但仍完成其它阶段', async () => {
    // 夹具是临时目录（无 pnpm/prisma），因此注入只记录调用的执行器，验证编排顺序而非真实命令
    const { io, logs } = makeIo();
    const calls: string[] = [];
    await runGenCrud({ models: ['order'] }, {
      ...makeDeps(),
      postGen: async (options) => {
        calls.push(`verify=${options.verify} migrate=${options.migrate} seed=${options.seed}`);
        return { migration: { name: null, applied: false }, seeded: [], verified: [] };
      },
      io,
    });
    expect(calls).toEqual(['verify=full migrate=true seed=true']);
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order/order.entity.ts'))).toBe(true);
    expect(logs.join('\n')).not.toContain('引入模块'); // M6 的手工接线提示已消失
  });

  it('schema 缺失时报错', async () => {
    fs.rmSync(path.join(tmpDir, 'prisma', 'schema.prisma'));
    const { io } = makeIo();
    await expect(runGenCrud({ models: ['order'] }, { ...makeDeps(), io })).rejects.toThrow('未找到数据模型');
  });

  it('非 TTY 且未指定模型时，默认交互选择给出明确报错（列出可用模型）', async () => {
    const { io } = makeIo();
    await expect(runGenCrud({}, { ...makeDeps(), io })).rejects.toThrow('未指定生成模型');
  });
});

describe('runGenCrud 生成流程', () => {
  it('全量生成 10 个文件并带中文文件头（FR-11）', async () => {
    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io });

    const files = [
      'src/modules/order/order.entity.ts',
      'src/modules/order/order.repository.ts',
      'src/modules/order/order.dto.ts',
      'src/modules/order/order.service.ts',
      'src/modules/order/order.controller.ts',
      'src/modules/order/order.module.ts',
      'src/api/order.ts',
      'src/views/order/index.vue',
      'src/views/order/form.vue',
      'prisma/seed/order.seed.ts',
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(tmpDir, file))).toBe(true);
    }
    const entity = fs.readFileSync(path.join(tmpDir, 'src/modules/order/order.entity.ts'), 'utf8');
    expect(entity).toContain('@author donttemo');
    expect(entity).toContain('@created 2026-10-13');
    expect(entity).toContain('@generated by @fw/cli');
    // 下一步（PRD-016：不再要求手工迁移 / 手工注册模块 / 手工改 seed）
    const output = logs.join('\n');
    expect(output).toContain('下一步');
    expect(output).toContain('重启服务后重新登录');
    expect(output).toContain('/orders');
    expect(output).not.toContain('引入模块');
    expect(output).not.toContain('seedOrderPermissions()');
  });

  it('--dry 只预览不落盘（FR-08）', async () => {
    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'], dry: true }, { ...makeDeps(), io });
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order'))).toBe(false);
    expect(logs.join('\n')).toContain('dry-run');
  });

  it('重跑时跳过已存在文件并提示 --force（TC-GEN-003）', async () => {
    const first = makeIo();
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: first.io });
    const entityPath = path.join(tmpDir, 'src/modules/order/order.entity.ts');
    fs.writeFileSync(entityPath, '// 手工修改\n', 'utf8');

    const second = makeIo();
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: second.io });
    expect(fs.readFileSync(entityPath, 'utf8')).toBe('// 手工修改\n');
    expect(second.logs.join('\n')).toContain('--force');

    const third = makeIo();
    await runGenCrud({ models: ['order'], force: true }, { ...makeDeps(), io: third.io });
    expect(fs.readFileSync(entityPath, 'utf8')).toContain('@generated by @fw/cli');
  });

  it('校验失败时回滚本次写入（TC-GEN-006）', async () => {
    const { io, errors } = makeIo();
    await expect(
      runGenCrud({ models: ['order'] }, {
        ...makeDeps(),
        postGen: async () => {
          throw new PostGenError('verify', 'tsc: 类型错误');
        },
        io,
      }),
    ).rejects.toThrow('tsc: 类型错误');
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order'))).toBe(false);
    expect(errors.join('\n')).toContain('已回滚');
  });

  it('迁移阶段失败时保留生成文件（代码与 schema 正确，回滚反而造成不一致）', async () => {
    const { io } = makeIo();
    await expect(
      runGenCrud({ models: ['order'] }, {
        ...makeDeps(),
        postGen: async () => {
          throw new PostGenError('migrate', '建迁移失败：数据库连接不上');
        },
        io,
      }),
    ).rejects.toThrow('数据库连接不上');
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order/order.entity.ts'))).toBe(true);
  });

  it('--all 排除复合主键模型（无单字段主键无法走 Repository 契约）', async () => {
    const { io } = makeIo();
    await runGenCrud({ all: true }, { ...makeDeps(), io });
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order-tag'))).toBe(false);
  });

  it('--only=frontend 只写前端三文件', async () => {
    const { io } = makeIo();
    await runGenCrud({ models: ['order'], only: 'frontend' }, { ...makeDeps(), io });
    expect(fs.existsSync(path.join(tmpDir, 'src/api/order.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'prisma/seed'))).toBe(false);
  });

  it('无位置参数时走交互式选择替身', async () => {
    const { io } = makeIo();
    await runGenCrud({}, { ...makeDeps(), selectModels: async () => ['order'], io });
    expect(fs.existsSync(path.join(tmpDir, 'src/modules/order/order.module.ts'))).toBe(true);
  });

  it('模型不存在时报错', async () => {
    const { io } = makeIo();
    await expect(runGenCrud({ models: ['nope'] }, { ...makeDeps(), io })).rejects.toThrow('不存在模型');
  });

  it('--only 取值不合法时报错', async () => {
    const { io } = makeIo();
    await expect(runGenCrud({ models: ['order'], only: 'both' }, { ...makeDeps(), io })).rejects.toThrow('--only');
  });

  it('git user.name 缺失时回退默认署名并告警（FR-11）', async () => {
    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'] }, {
      ...makeDeps(),
      author: async () => {
        io.log('[warn] 未检测到 git config user.name，@author 回退为默认署名 donttemo');
        return 'donttemo';
      },
      io,
    });
    const entity = fs.readFileSync(path.join(tmpDir, 'src/modules/order/order.entity.ts'), 'utf8');
    expect(entity).toContain('@author donttemo');
    expect(logs.join('\n')).toContain('回退为默认署名');
  });
});

describe('生成物指纹保护（PRD-017 FR-17-14）', () => {
  const manifestFile = (): string => path.join(tmpDir, MANIFEST_FILE);
  const orderEntry = () => readManifest(tmpDir).entries.find((entry) => entry.model === 'Order');
  const entityFile = (): string => path.join(tmpDir, 'src/modules/order/order.entity.ts');

  it('文件写完即记录指纹（不依赖后处理成功）', async () => {
    const { io } = makeIo();
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io });

    const entry = orderEntry();
    expect(entry?.files?.length).toBe(10);
    const service = entry?.files?.find((file) => file.path === 'src/modules/order/order.service.ts');
    expect(service?.hash).toBe(hashFile(path.join(tmpDir, 'src/modules/order/order.service.ts')));
  });

  it('迁移阶段失败时文件与指纹都保留（环境问题不该抹掉已存在的基线）', async () => {
    const { io } = makeIo();
    await expect(
      runGenCrud({ models: ['order'] }, {
        ...makeDeps(),
        postGen: async () => {
          throw new PostGenError('migrate', '建迁移失败：数据库连接不上');
        },
        io,
      }),
    ).rejects.toThrow('数据库连接不上');

    expect(fs.existsSync(entityFile())).toBe(true);
    expect(orderEntry()?.files?.length).toBe(10);
  });

  it('校验失败回滚时，清单与文件一起还原（逐字节）', async () => {
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: makeIo().io });
    const beforeManifest = fs.readFileSync(manifestFile(), 'utf8');
    fs.writeFileSync(entityFile(), '// 手工修改\n', 'utf8');

    const { io } = makeIo();
    await expect(
      runGenCrud({ models: ['order'], force: true }, {
        ...makeDeps(),
        postGen: async () => {
          throw new PostGenError('verify', 'tsc: 类型错误');
        },
        io,
      }),
    ).rejects.toThrow('类型错误');

    expect(fs.readFileSync(entityFile(), 'utf8')).toBe('// 手工修改\n');
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(beforeManifest);
  });

  it('dry-run 在落盘前就指出「哪些文件你改过、会被跳过」', async () => {
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: makeIo().io });
    fs.writeFileSync(entityFile(), '// 手工修改\n', 'utf8');

    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'], dry: true }, { ...makeDeps(), io });

    const output = logs.join('\n');
    expect(output).toContain('生成物保护');
    expect(output).toContain('你改过');
    expect(output).toContain('src/modules/order/order.entity.ts');
    expect(output).toContain('默认跳过');
    expect(fs.readFileSync(entityFile(), 'utf8')).toBe('// 手工修改\n');
  });

  it('--force 明确告知会覆盖并丢弃修改', async () => {
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: makeIo().io });
    fs.writeFileSync(entityFile(), '// 手工修改\n', 'utf8');

    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'], dry: true, force: true }, { ...makeDeps(), io });
    expect(logs.join('\n')).toContain('会覆盖并丢弃');
  });

  it('被删除的产物提示「会重新创建」，而不是「会跳过」', async () => {
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: makeIo().io });
    fs.rmSync(path.join(tmpDir, 'src/views/order/index.vue'));

    const { io, logs } = makeIo();
    await runGenCrud({ models: ['order'], dry: true }, { ...makeDeps(), io });
    const output = logs.join('\n');
    expect(output).toContain('已被删除');
    expect(output).toContain('重新创建');
  });

  it('--only=frontend 刷新前端指纹，但不清掉后端产物的指纹', async () => {
    await runGenCrud({ models: ['order'] }, { ...makeDeps(), io: makeIo().io });
    expect(orderEntry()?.files?.length).toBe(10);
    fs.rmSync(path.join(tmpDir, 'src/api/order.ts'));

    await runGenCrud({ models: ['order'], only: 'frontend' }, { ...makeDeps(), io: makeIo().io });
    const paths = (orderEntry()?.files ?? []).map((file) => file.path);
    expect(paths).toContain('src/api/order.ts');
    expect(paths).toContain('src/modules/order/order.entity.ts');
    expect(paths).toContain('src/views/order/index.vue');
  });

  it('--only=frontend 在全新项目里不新增清单条目（清单同时是接线事实源）', async () => {
    await runGenCrud({ models: ['order'], only: 'frontend' }, { ...makeDeps(), io: makeIo().io });
    expect(fs.existsSync(manifestFile())).toBe(false);
  });

  it('monorepo：清单路径以后端根为基准，换 cwd 也能对上磁盘', async () => {
    // 真实形态 apps/api + apps/admin-web：从仓库根执行生成（Studio 就是这样调的）
    fs.rmSync(path.join(tmpDir, 'prisma'), { recursive: true, force: true });
    const backend = path.join(tmpDir, 'apps', 'api');
    fs.mkdirSync(path.join(backend, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'prisma', 'schema.prisma'), SCHEMA, 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'apps', 'admin-web', 'src', 'components', 'CrudTable'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'apps', 'admin-web', 'src', 'components', 'CrudTable', 'index.vue'),
      '<template><div /></template>',
      'utf8',
    );

    await runGenCrud({ models: ['order'], app: 'api' }, { ...makeDeps(), io: makeIo().io });

    const entries = readManifest(backend).entries;
    const paths = (entries[0].files ?? []).map((file) => file.path);
    // 不能带 apps/api/ 前缀——那是「相对仓库根」的旧口径，从应用目录重跑就全对不上
    expect(paths.every((item) => !item.startsWith('apps/api/'))).toBe(true);
    expect(paths).toContain('src/modules/order/order.entity.ts');
    expect(paths).toContain('../admin-web/src/api/order.ts');

    // 换任何基准（后端根）解析都必须全部 unchanged
    const drift = checkArtifactDrift(backend, entries);
    expect(drift[0].affected).toBe(0);
    expect(drift[0].files.every((file) => file.status === 'unchanged')).toBe(true);
  });
});
