/*
 * @file 队列演示端点（M7 验收载体）
 * @description 暴露 /api/v1/demo-queue/* 供 scripts/smoke-queue.mjs 逐条验证 PRD-007 的 P0 验收：
 *   入队与执行（TC-JOB-001）、延时、重试退避（TC-JOB-003）、终态失败进死信与重放（TC-JOB-004/005）、
 *   幂等只执行一次（TC-JOB-006）、并发与限速（TC-JOB-007）、定时任务与手动触发（TC-JOB-002）、
 *   暂停/恢复/清空与指标（FR-09）。
 *   与 cache-demo 一致整体标 @Public()：框架自检路由，不承载业务数据；
 *   生产可用的管理面在 /api/v1/admin/queue（受 system:queue:* 权限保护）。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/demo-queue
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Public } from '@fw/auth';
import { DemoQueueService } from './demo-queue.service.js';

/**
 * 队列演示控制器：路径前缀 /api/v1/demo-queue
 */
@Public()
@Controller('/api/v1/demo-queue')
export class DemoQueueController {
  constructor(private readonly service: DemoQueueService) {}

  /** 派发正常任务 */
  @Post('echo')
  async echo(@Query('value') value = 'v1'): Promise<{ id: string; name: string; queue: string; runAt: string }> {
    const handle = await this.service.dispatch('demo.echo', { value });
    return { id: handle.id, name: handle.name, queue: handle.queue, runAt: handle.runAt.toISOString() };
  }

  /** 派发延时任务 */
  @Post('delayed')
  async delayed(@Query('ms') ms = '300', @Query('value') value = 'later'): Promise<{ id: string; runAt: string }> {
    const handle = await this.service.dispatch('demo.echo', { value }, { delay: Number.parseInt(ms, 10) || 0 });
    return { id: handle.id, runAt: handle.runAt.toISOString() };
  }

  /** 派发可重试任务（前 failTimes 次失败，backoffMs 为每次退避间隔） */
  @Post('flaky')
  async flaky(@Query('failTimes') failTimes = '2', @Query('backoffMs') backoffMs = '200'): Promise<{ id: string }> {
    const times = Math.max(1, Number.parseInt(failTimes, 10) || 1);
    const backoff = Math.max(10, Number.parseInt(backoffMs, 10) || 200);
    const handle = await this.service.dispatch('demo.flaky', { failTimes: times }, { attempts: times + 1, backoff: [backoff] });
    return { id: handle.id };
  }

  /** 派发终态失败任务（抛 PermanentJobError，不重试直接死信） */
  @Post('permanent')
  async permanent(@Query('reason') reason = '参数非法'): Promise<{ id: string }> {
    const handle = await this.service.dispatch('demo.permanent', { reason }, { attempts: 4 });
    return { id: handle.id };
  }

  /** 批量派发慢任务（观测并发上限与限速） */
  @Post('slow')
  async slow(@Query('count') count = '5', @Query('ms') ms = '200', @Query('tag') tag = 'batch'): Promise<{ ids: string[] }> {
    const total = Math.min(200, Math.max(1, Number.parseInt(count, 10) || 1));
    const duration = Math.max(0, Number.parseInt(ms, 10) || 0);
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const handle = await this.service.dispatch('demo.slow', { ms: duration, tag: `${tag}-${i}` });
      ids.push(handle.id);
    }
    return { ids };
  }

  /** 派发幂等任务（同一 orderId 在窗口期内只执行一次） */
  @Post('idempotent')
  async idempotent(@Query('orderId') orderId = 'o-1', @Query('ttl') ttl = '300'): Promise<{ id: string; key: string }> {
    const key = `demo:order:${orderId}`;
    const handle = await this.service.dispatch(
      'demo.idempotent',
      { orderId },
      { idempotencyKey: key, idempotencyTtlSeconds: Number.parseInt(ttl, 10) || 300 },
    );
    return { id: handle.id, key };
  }

  /** 直接派发任意已注册任务（探索用）：JSON body 传 name/payload/options */
  @Post('dispatch')
  async dispatchArbitrary(@Body() body: { name?: string; payload?: unknown; options?: Record<string, unknown> }): Promise<{ id: string }> {
    const handle = await this.service.dispatch(body.name ?? 'demo.echo', body.payload ?? {}, body.options ?? {});
    return { id: handle.id };
  }

  /** 执行台账（任务名可筛选） */
  @Get('ledger')
  ledger(@Query('name') name?: string): unknown {
    return this.service.ledgerSnapshot(name);
  }

  /** 队列状态与积压 */
  @Get('stats')
  async stats(): Promise<Awaited<ReturnType<DemoQueueService['stats']>>> {
    return this.service.stats();
  }

  /** 指标快照 */
  @Get('metrics')
  metrics(): ReturnType<DemoQueueService['metrics']> {
    return this.service.metrics();
  }

  /** 已注册任务名（验证启动期自动扫描） */
  @Get('handlers')
  handlers(): { names: string[] } {
    return { names: this.service.handlers() };
  }

  /** 定时任务快照 */
  @Get('crons')
  crons(): ReturnType<DemoQueueService['crons']> {
    return this.service.crons();
  }

  /** 手动触发定时任务（仍走分布式锁） */
  @Post('cron-tick')
  async cronTick(@Query('name') name?: string): Promise<{ results: Array<{ name: string; acquired: boolean }> }> {
    return { results: await this.service.tick(name) };
  }

  /** 死信列表 */
  @Get('dead-letters')
  async deadLetters(@Query('queue') queue?: string): Promise<{ total: number; items: unknown[] }> {
    const items = await this.service.deadLetters(queue);
    return { total: items.length, items };
  }

  /** 重放单条死信 */
  @Post('dead-letters/:id/requeue')
  async requeue(@Param('id') id: string): Promise<{ id: string; requeued: boolean }> {
    return { id, requeued: await this.service.requeue(id) };
  }

  /** 清理死信 */
  @Post('purge')
  async purge(@Query('queue') queue?: string): Promise<{ removed: number }> {
    return { removed: await this.service.purge(queue) };
  }

  /** 取消尚未执行的任务 */
  @Post('cancel')
  async cancel(@Query('id') id: string): Promise<{ id: string; cancelled: boolean }> {
    return { id, cancelled: await this.service.cancel(id) };
  }

  /** 暂停消费 */
  @Post('pause')
  async pause(): Promise<{ paused: true }> {
    await this.service.pause();
    return { paused: true };
  }

  /** 恢复消费 */
  @Post('resume')
  async resume(): Promise<{ resumed: true }> {
    await this.service.resume();
    return { resumed: true };
  }

  /** 清空等待中的任务 */
  @Post('drain')
  async drain(): Promise<{ removed: number }> {
    return { removed: await this.service.drain() };
  }

  /** 复位台账并清空死信（冒烟分阶段复位） */
  @Post('reset')
  async reset(): Promise<{ ledger: true; deadLetters: number }> {
    return this.service.reset();
  }
}
