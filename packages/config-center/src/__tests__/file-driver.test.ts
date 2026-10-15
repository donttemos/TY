/*
 * @file 本地文件事实源驱动测试
 * @description PRD-009 FR-02：mtime 轮询（指纹变化才回调）、原子写（临时文件 + rename、写后指纹自抑制）、
 *   读失败 / 语法错误不回调（上层 fail-keep）、缺失返回 null（上层 fail-open）、stop 释放定时器。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClearIntervalFn, SetIntervalFn } from '../drivers/file.driver.js';
import { FileConfigDriver } from '../drivers/file.driver.js';

/** 测试桩的宽松别名 */
type SetIntervalLike = SetIntervalFn;
type ClearIntervalLike = ClearIntervalFn;

/** 每个用例独立的临时目录 */
let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-config-center-'));
  file = path.join(dir, 'runtime.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 手动触发一次轮询（绕过真实定时器；覆盖 setInterval 注入路径） */
type Tick = () => Promise<void>;

/** 构建驱动并返回手动触发轮询的 tick（定时器注入桩；tick 等待本轮 poll 落定） */
function makeDriver(targetFile: string, onChange: (snapshot: Record<string, unknown>) => void = () => undefined): { driver: FileConfigDriver; tick: Tick } {
  let body: (() => void) | undefined;
  const driver = new FileConfigDriver({
    file: targetFile,
    pollSeconds: 1,
    setIntervalFn: ((fn: () => void) => {
      body = fn;
      return 0;
    }) as SetIntervalLike,
    clearIntervalFn: (() => undefined) as ClearIntervalLike,
  });
  driver.watch(onChange);
  return {
    driver,
    tick: async () => {
      body?.();
      await driver.settle();
    },
  };
}

describe('FileConfigDriver · load', () => {
  it('文件缺失 → null（上层 fail-open）', async () => {
    const driver = new FileConfigDriver({ file, pollSeconds: 1 });
    await expect(driver.load()).resolves.toBeNull();
  });

  it('合法 JSON 对象 → 解析结果', async () => {
    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'debug' }));
    const driver = new FileConfigDriver({ file, pollSeconds: 1 });
    await expect(driver.load()).resolves.toEqual({ 'log.level': 'debug' });
  });

  it('语法错误 → null + 不抛出（fail-keep 语义由上层表达）', async () => {
    fs.writeFileSync(file, '{ broken');
    const driver = new FileConfigDriver({ file, pollSeconds: 1 });
    await expect(driver.load()).resolves.toBeNull();
  });

  it('空文件 → 空对象', async () => {
    fs.writeFileSync(file, '   ');
    const driver = new FileConfigDriver({ file, pollSeconds: 1 });
    await expect(driver.load()).resolves.toEqual({});
  });

  it('顶层非对象（数组 / 标量 / null）→ null', async () => {
    for (const text of ['[]', '1', 'null']) {
      fs.writeFileSync(file, text);
      const driver = new FileConfigDriver({ file, pollSeconds: 1 });
      await expect(driver.load()).resolves.toBeNull();
    }
  });
});

describe('FileConfigDriver · write（原子写）', () => {
  it('写入后文件内容为 JSON 快照，目录不存在自动创建，无临时文件残留', async () => {
    const nested = path.join(dir, 'nested', 'runtime.json');
    const driver = new FileConfigDriver({ file: nested, pollSeconds: 1 });

    await driver.write({ 'log.level': 'debug', 'cache.ttl': 600 });

    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ 'log.level': 'debug', 'cache.ttl': 600 });
    expect(fs.readdirSync(path.dirname(nested)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('写入后更新指纹：紧随的轮询不把本次写入当外部变更（自抑制）', async () => {
    const onChange = vi.fn();
    const { driver, tick } = makeDriver(file, onChange);

    await driver.write({ 'log.level': 'debug' });
    await tick();

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('FileConfigDriver · watch（mtime 轮询）', () => {
  it('指纹变化 → 回调外部快照；同指纹重复轮询不回调', async () => {
    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'info' }));
    const onChange = vi.fn();
    const { tick } = makeDriver(file, onChange);

    // 首轮：指纹相对构造时（null）变化 → 回调
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ 'log.level': 'info' });

    // 内容未变 → 不回调
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);

    // 内容变化 → 再回调
    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'debug' }));
    await tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ 'log.level': 'debug' });
  });

  it('轮询期间文件损坏 → 不回调（保持上层快照）；修复后自动追上', async () => {
    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'info' }));
    const onChange = vi.fn();
    const { tick } = makeDriver(file, onChange);
    await tick();

    fs.writeFileSync(file, '{ corrupt');
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);

    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'warn' }));
    await tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ 'log.level': 'warn' });
  });

  it('轮询期间文件暂时移除 → 不回调不抛错', async () => {
    fs.writeFileSync(file, JSON.stringify({ 'log.level': 'info' }));
    const onChange = vi.fn();
    const { tick } = makeDriver(file, onChange);
    await tick();

    fs.rmSync(file);
    await expect(tick()).resolves.toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('FileConfigDriver · 生命周期', () => {
  it('重复 watch 幂等；stop 清理定时器', async () => {
    const cleared: Array<unknown> = [];
    const driver = new FileConfigDriver({
      file,
      pollSeconds: 1,
      setIntervalFn: ((fn: () => void) => {
        void fn;
        return 7;
      }) as SetIntervalLike,
      clearIntervalFn: ((id: unknown) => {
        cleared.push(id);
      }) as ClearIntervalLike,
    });
    driver.watch(() => undefined);
    driver.watch(() => undefined); // 幂等：不重复建定时器

    await driver.stop();
    expect(cleared).toEqual([7]);
  });
});
