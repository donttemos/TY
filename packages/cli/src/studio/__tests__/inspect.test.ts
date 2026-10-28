/*
 * @file 项目体检单测（PRD-017 FR-17-01/02）
 * @description 用临时项目覆盖：布局识别（monorepo / admin 模板 / 单项目）、模型与「已生成」标记、
 *   待执行迁移（来自部署清单，不连库）、结构问题上报、环境体检项，以及 schema 缺失时的降级。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../../deploy/exec.js';
import { inspectProject } from '../inspect.js';

let tmpDir: string;

/** 造一个 monorepo 形态的项目 */
function makeMonorepo(schema = 'model Product {\n  id String @id\n}\n\nmodel DemoItem {\n  id String @id\n  name String\n}\n'): void {
  const backend = path.join(tmpDir, 'apps', 'example-api');
  fs.mkdirSync(path.join(backend, 'prisma', 'migrations', '20260101_init'), { recursive: true });
  fs.mkdirSync(path.join(backend, 'prisma', 'migrations', '20260202_add_field'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'prisma', 'schema.prisma'), schema, 'utf8');
  fs.writeFileSync(
    path.join(backend, 'fw.gen.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          model: 'DemoItem',
          kebab: 'demo-item',
          modulePath: 'src/modules/demo-item/demo-item.module.ts',
          moduleClass: 'DemoItemModule',
          seedPath: 'prisma/seed/demo-item.seed.ts',
          seedExport: 'seedDemoItemPermissions',
          permissionCodes: ['demo-item:read'],
          updatedAt: '2026-10-22',
        },
      ],
    }),
    'utf8',
  );
  const web = path.join(tmpDir, 'apps', 'admin-web');
  fs.mkdirSync(path.join(web, 'src', 'components', 'CrudTable'), { recursive: true });
  fs.writeFileSync(path.join(web, 'src', 'components', 'CrudTable', 'index.vue'), '<template />', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'deploy.manifest.json'),
    JSON.stringify({ version: 1, appliedMigrations: ['20260101_init'] }),
    'utf8',
  );
}

const dirtyExec: Exec = async () => ({ stdout: ' M schema.prisma\n', stderr: '' });
const cleanExec: Exec = async () => ({ stdout: '', stderr: '' });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-inspect-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('inspectProject', () => {
  it('monorepo 形态：识别布局、模型与已生成标记', async () => {
    makeMonorepo();
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.shape).toBe('monorepo');
    expect(result.layout.backendRoot).toBe('apps/example-api');
    expect(result.layout.webRoot).toBe('apps/admin-web');
    expect(result.layout.schemaExists).toBe(true);
    expect(result.schema.models.map((model) => model.name)).toEqual(['Product', 'DemoItem']);
    expect(result.schema.models.find((model) => model.name === 'DemoItem')?.generated).toBe(true);
    expect(result.schema.models.find((model) => model.name === 'Product')?.generated).toBe(false);
    expect(result.manifest.models).toEqual(['DemoItem']);
  });

  it('待执行迁移只算部署清单之后新增的（不连库）', async () => {
    makeMonorepo();
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.migrations.total).toBe(2);
    expect(result.migrations.pending).toBe(1);
  });

  it('没有部署清单时不谎报「全部待执行」，只标记为无基线', async () => {
    makeMonorepo();
    fs.rmSync(path.join(tmpDir, 'deploy.manifest.json'));
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.migrations.total).toBe(2);
    expect(result.migrations.baseline).toBe(false);
    expect(result.migrations.pending).toBe(0);
    const check = result.environment.find((item) => item.name === '待执行迁移');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('无部署基线');
  });

  it('admin 模板形态（server + admin-web 兄弟目录）被识别', async () => {
    const project = path.join(tmpDir, 'my-system');
    const server = path.join(project, 'server');
    fs.mkdirSync(path.join(server, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(server, 'prisma', 'schema.prisma'), 'model A {\n  id String @id\n}\n', 'utf8');
    fs.mkdirSync(path.join(project, 'admin-web', 'src', 'components', 'CrudTable'), { recursive: true });
    fs.writeFileSync(path.join(project, 'admin-web', 'src', 'components', 'CrudTable', 'index.vue'), '<template />', 'utf8');

    const result = await inspectProject(server, cleanExec);
    expect(result.shape).toBe('admin-template');
    expect(result.layout.webRoot).toBe('../admin-web');
  });

  it('单项目形态：前后端同根', async () => {
    fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), 'model A {\n  id String @id\n}\n', 'utf8');
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.shape).toBe('single');
    expect(result.layout.webRoot).toBe('.');
  });

  it('结构问题被上报到 issues 与环境项', async () => {
    makeMonorepo('model Bad {\n  id String\n  id String\n  weird NotType\n}\n');
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.schema.issues.some((issue) => issue.message.includes('字段名重复'))).toBe(true);
    expect(result.environment.find((item) => item.name === '结构自检')?.status).toBe('error');
  });

  it('schema 缺失时降级为错误项，不抛异常', async () => {
    fs.mkdirSync(path.join(tmpDir, 'apps', 'example-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.schema.exists).toBe(false);
    expect(result.schema.error).toContain('schema 不存在');
    expect(result.environment.find((item) => item.name === 'Schema')?.status).toBe('error');
  });

  it('git 脏工作区记为告警；git 不可用也不报错', async () => {
    makeMonorepo();
    const dirty = await inspectProject(tmpDir, dirtyExec);
    expect(dirty.environment.find((item) => item.name === '工作区')?.status).toBe('warn');

    const broken: Exec = async () => {
      throw new Error('git not found');
    };
    const fallback = await inspectProject(tmpDir, broken);
    expect(fallback.environment.find((item) => item.name === '工作区')?.detail).toContain('非 git');
  });

  it('S1 动作白名单为空（只读）', async () => {
    makeMonorepo();
    const result = await inspectProject(tmpDir, cleanExec);
    expect(result.actions).toEqual([]);
  });
});
