/*
 * @file 单测：异步任务中心（N-02）
 * @description 直接实例化 JobCenterService 验证任务生命周期契约：派发即返回（不阻塞）、
 *   归属人隔离、进度单调收敛、成功 / 失败 / 产物超限三条终态路径、重跑状态机、
 *   登记表裁剪。执行体由测试注入，不依赖真实业务。
 * @modified 2026-10-15 donttemo M10/E-16：新增产物上限可配断言（MemoryJobDriver 注入口径）
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { JobCenterService, type JobArtifact, type JobReporter } from './job-center.service.js';
import { MemoryJobDriver } from './drivers/job-memory.driver.js';

/** 让出事件循环，使派发后的后台执行（void this.execute）跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 立即成功的执行体 */
function instantRunner(artifact?: JobArtifact) {
  return async (): Promise<JobArtifact | null> => artifact ?? null;
}

describe('JobCenterService', () => {
  it('派发后立即返回 pending 视图（不等执行完成）', () => {
    const service = new JobCenterService();
    let release: (() => void) | undefined;
    const view = service.create({
      type: 'test.hold',
      title: '挂起任务',
      ownerId: 'u-1',
      traceId: 'trace-test',
      runner: () => new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
    });

    expect(view.status).toBe('pending');
    expect(view.progress).toBe(0);
    expect(view.id).toMatch(/^job-/);
    expect(view.traceId).toBe('trace-test');
    expect(view.createdAt).toBe(view.updatedAt);

    // 存储条目已进入 running：execute 同步启动（runner 首次 await 前就翻状态），
    // 「派发不等执行」体现在响应快照仍是 pending，且 runner 未 resolve 前接口早已返回
    expect(service.get(view.id, 'u-1')?.status).toBe('running');
    release?.();
  });

  it('按归属人隔离读取：非归属人一律 null（不泄露存在性）', () => {
    const service = new JobCenterService();
    const view = service.create({ type: 'test', title: 't', ownerId: 'u-1', runner: instantRunner() });
    expect(service.get(view.id, 'u-2')).toBeNull();
    expect(service.get(view.id, 'u-1')).not.toBeNull();
  });

  it('执行成功：进度收敛到 100 并带出产物文件名', async () => {
    const service = new JobCenterService();
    const view = service.create({
      type: 'test.export',
      title: '导出',
      ownerId: 'u-1',
      runner: async (report: JobReporter) => {
        report(30, '查询中');
        report(80, '生成中');
        return { fileName: 'out.csv', contentType: 'text/csv', content: 'a,b\n1,2\n' };
      },
    });
    await flush();

    const done = service.get(view.id, 'u-1');
    expect(done?.status).toBe('succeeded');
    expect(done?.progress).toBe(100);
    expect(done?.message).toBe('已完成，可下载');
    expect(done?.fileName).toBe('out.csv');
    expect(service.artifact(view.id, 'u-1')?.content).toBe('a,b\n1,2\n');
  });

  it('进度上报单调收敛：越界值被钳制，回退值不把进度拉低', async () => {
    const service = new JobCenterService();
    const seen: number[] = [];
    const view = service.create({
      type: 'test.progress',
      title: '进度',
      ownerId: 'u-1',
      runner: async (report: JobReporter) => {
        report(10);
        report(150); // 钳到 100
        report(50); // 不回退
        seen.push(1);
        return null;
      },
    });
    await flush();
    expect(seen).toHaveLength(1);
    // 终态强制 100，中间过程通过 progress 单调性验证（见下一个用例）
    expect(service.get(view.id, 'u-1')?.progress).toBe(100);
  });

  it('进度单调性：执行中读取到的进度只增不减', async () => {
    const service = new JobCenterService();
    const samples: number[] = [];
    const view = service.create({
      type: 'test.monotonic',
      title: '单调',
      ownerId: 'u-1',
      runner: async (report: JobReporter) => {
        for (let i = 0; i < 5; i += 1) {
          report(50 - i * 10); // 试图把进度往下压
          await flush();
        }
        return null;
      },
    });
    for (let i = 0; i < 6; i += 1) {
      samples.push(service.get(view.id, 'u-1')?.progress ?? -1);
      await flush();
    }
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] as number);
    }
  });

  it('执行体抛错：状态 failed、error 可读、无产物', async () => {
    const service = new JobCenterService();
    const view = service.create({
      type: 'test.fail',
      title: '失败',
      ownerId: 'u-1',
      runner: async () => {
        throw new Error('下游超时');
      },
    });
    await flush();

    const done = service.get(view.id, 'u-1');
    expect(done?.status).toBe('failed');
    expect(done?.error).toBe('下游超时');
    expect(done?.message).toBe('执行失败，可重试');
    expect(service.artifact(view.id, 'u-1')).toBeNull();
  });

  it('产物超限：任务失败并给出可读原因（不静默截断）', async () => {
    const service = new JobCenterService();
    const view = service.create({
      type: 'test.huge',
      title: '超大产物',
      ownerId: 'u-1',
      runner: async () => ({ fileName: 'big.csv', contentType: 'text/csv', content: 'x'.repeat(20 * 1024 * 1024 + 1) }),
    });
    await flush();

    const done = service.get(view.id, 'u-1');
    expect(done?.status).toBe('failed');
    expect(done?.error).toContain('20MB');
    expect(service.artifact(view.id, 'u-1')).toBeNull();
  });

  it('M10/E-16：产物上限可配（JOB_ARTIFACT_MAX_MB）——按配置值判定且文案同步', async () => {
    // 1MB 上限：略超即失败，错误原因按配置值回显（不再是硬编码 20MB）
    const service = new JobCenterService(new MemoryJobDriver({ maxArtifactChars: 1024 * 1024 }));
    const view = service.create({
      type: 'test.huge',
      title: '超大产物',
      ownerId: 'u-1',
      runner: async () => ({ fileName: 'big.csv', contentType: 'text/csv', content: 'x'.repeat(1024 * 1024 + 1) }),
    });
    await flush();

    const done = service.get(view.id, 'u-1');
    expect(done?.status).toBe('failed');
    expect(done?.error).toContain('1MB');
    expect(service.artifact(view.id, 'u-1')).toBeNull();

    // 上限内的产物照常成功（配置收紧不影响正常导出）
    const ok = service.create({
      type: 'test.small',
      title: '小产物',
      ownerId: 'u-1',
      runner: async () => ({ fileName: 'ok.csv', contentType: 'text/csv', content: 'x'.repeat(1024) }),
    });
    await flush();
    expect(service.get(ok.id, 'u-1')?.status).toBe('succeeded');
    expect(service.artifact(ok.id, 'u-1')?.content).toHaveLength(1024);
  });

  it('重跑状态机：仅失败任务可重跑；成功 / 执行中拒绝并给原因', async () => {
    const service = new JobCenterService();

    const failed = service.create({ type: 't', title: 't', ownerId: 'u-1', runner: async () => { throw new Error('boom'); } });
    await flush();
    const retried = service.retry(failed.id, 'u-1');
    expect(retried.view?.status).toBe('pending');
    expect(retried.reason).toBeUndefined();
    await flush();
    // 重跑沿用同一执行体，仍会失败（状态可再次观察）
    expect(service.get(failed.id, 'u-1')?.status).toBe('failed');

    const ok = service.create({ type: 't', title: 't', ownerId: 'u-1', runner: instantRunner() });
    await flush();
    const okRetry = service.retry(ok.id, 'u-1');
    expect(okRetry.view?.status).toBe('succeeded');
    expect(okRetry.reason).toBe('任务已成功，无需重跑');

    let release: (() => void) | undefined;
    const running = service.create({
      type: 't',
      title: 't',
      ownerId: 'u-1',
      runner: () => new Promise<null>((resolve) => { release = () => resolve(null); }),
    });
    await flush();
    const runningRetry = service.retry(running.id, 'u-1');
    expect(runningRetry.view?.status).toBe('running');
    expect(runningRetry.reason).toBe('任务正在执行中，无需重跑');
    release?.();
  });

  it('重跑非归属人任务返回空视图（转 404）', async () => {
    const service = new JobCenterService();
    const failed = service.create({ type: 't', title: 't', ownerId: 'u-1', runner: async () => { throw new Error('boom'); } });
    await flush();
    expect(service.retry(failed.id, 'u-2').view).toBeNull();
  });

  it('登记表裁剪：超出上限先丢最旧的已结束任务，进行中的不丢', async () => {
    const service = new JobCenterService();
    const first = service.create({ type: 't', title: 't', ownerId: 'u-1', runner: instantRunner() });
    await flush();
    expect(service.get(first.id, 'u-1')).not.toBeNull();

    // 追加 200 个立即结束的任务，触发裁剪（MAX_ENTRIES=200）
    const later: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const view = service.create({ type: 't', title: `t-${i}`, ownerId: 'u-1', runner: instantRunner() });
      later.push(view.id);
    }
    await flush();

    // 最旧的已结束任务被裁掉；最后一个仍在
    expect(service.get(first.id, 'u-1')).toBeNull();
    expect(service.get(later[later.length - 1] as string, 'u-1')).not.toBeNull();
  });
});
