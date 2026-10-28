/*
 * @file Studio 任务执行器单测（PRD-017 FR-17-13）
 * @description 用假进程覆盖：输出按行收集与上限、成功/失败状态、失败摘要取「像错误的那行」、
 *   同一时刻只允许一个任务、以及未知任务查询。不真起子进程。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { JobManager, type JobProcess, type JobSpawner } from '../jobs.js';

/** 可控假进程：测试里手动触发输出与退出 */
function makeFakeSpawner(): {
  spawner: JobSpawner;
  emit: (line: string) => void;
  exit: (code: number | null) => void;
  calls: { command: string; args: string[]; cwd: string }[];
} {
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const process: JobProcess = {
    onLine: (handler) => lineHandlers.push(handler),
    onExit: (handler) => exitHandlers.push(handler),
  };
  return {
    spawner: (command, args, cwd) => {
      calls.push({ command, args, cwd });
      return process;
    },
    emit: (line) => lineHandlers.forEach((handler) => handler(line)),
    exit: (code) => exitHandlers.forEach((handler) => handler(code)),
    calls,
  };
}

describe('JobManager', () => {
  it('启动时记录动作与命令，输出按行累积', () => {
    const fake = makeFakeSpawner();
    const manager = new JobManager(fake.spawner, () => new Date('2026-10-22T00:00:00Z'));
    const id = manager.start({ action: 'gen crud Product', command: 'node', args: ['index.js', 'gen'], cwd: '/tmp/p' });

    expect(fake.calls[0]).toEqual({ command: 'node', args: ['index.js', 'gen'], cwd: '/tmp/p' });
    fake.emit('[gen] 已生成：a.ts');
    fake.emit('[gen] 已接线：app.module.ts');

    const job = manager.get(id);
    expect(job?.status).toBe('running');
    expect(job?.lines).toEqual(['[gen] 已生成：a.ts', '[gen] 已接线：app.module.ts']);
    expect(job?.finishedAt).toBeNull();
  });

  it('退出码 0 → succeeded', () => {
    const fake = makeFakeSpawner();
    const manager = new JobManager(fake.spawner);
    const id = manager.start({ action: 'gen', command: 'node', args: [], cwd: '/' });
    fake.emit('done');
    fake.exit(0);
    expect(manager.get(id)?.status).toBe('succeeded');
    expect(manager.get(id)?.exitCode).toBe(0);
    expect(manager.get(id)?.finishedAt).not.toBeNull();
    expect(manager.isBusy()).toBe(false);
  });

  it('非 0 退出 → failed，并挑出「像错误」的一行做摘要', () => {
    const fake = makeFakeSpawner();
    const manager = new JobManager(fake.spawner);
    const id = manager.start({ action: 'gen', command: 'node', args: [], cwd: '/' });
    fake.emit('warn 这是一个告警，不该当错误');
    fake.emit('starting');
    fake.emit('Error: P1012 schema invalid');
    fake.emit('cleanup');
    fake.exit(1);

    const job = manager.get(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('P1012');
  });

  it('同一时刻只允许一个任务（写操作会互相踩）', () => {
    const fake = makeFakeSpawner();
    const manager = new JobManager(fake.spawner);
    manager.start({ action: 'gen', command: 'node', args: [], cwd: '/' });
    expect(() => manager.start({ action: 'gen2', command: 'node', args: [], cwd: '/' })).toThrow(/已有任务在执行/);
    fake.exit(0);
    expect(() => manager.start({ action: 'gen3', command: 'node', args: [], cwd: '/' })).not.toThrow();
  });

  it('输出行数有上限，超出时保留尾部', () => {
    const fake = makeFakeSpawner();
    const manager = new JobManager(fake.spawner);
    const id = manager.start({ action: 'gen', command: 'node', args: [], cwd: '/' });
    for (let index = 0; index < 2100; index += 1) fake.emit(`line-${index}`);
    const job = manager.get(id);
    expect(job?.lines.length).toBe(2000);
    expect(job?.lines[1999]).toBe('line-2099');
  });

  it('未知任务返回 null', () => {
    const manager = new JobManager(makeFakeSpawner().spawner);
    expect(manager.get('job-999')).toBeNull();
  });
});
