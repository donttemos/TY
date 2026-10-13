/*
 * @file 缓存演示端点（M4 验收载体）
 * @description 暴露 /api/v1/demo-cache/* 供 scripts/smoke-cache.mjs 逐条验证 PRD-004 的 P0 验收：
 *   统一接口与命中回源（TC-CACHE-002）、标签失效（003）、单飞（004）、空值占位（005）、
 *   分布式锁只跑一次（009）、降级（007，另起 redis 不可达实例验证）。
 *   与 demo 模块一致整体标 @Public()：框架自检路由，不承载业务数据。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/cache-demo
 */

import { Controller, Get, Post, Query } from '@nestjs/common';
import { Public } from '@fw/auth';
import { CacheDemoService } from './cache-demo.service.js';

/**
 * 缓存演示控制器：路径前缀 /api/v1/demo-cache
 */
@Public()
@Controller('/api/v1/demo-cache')
export class CacheDemoController {
  constructor(private readonly service: CacheDemoService) {}

  /** 写入后读取同一个键（验证统一接口 + 全局前缀） */
  @Get('put-and-pick')
  async putAndPick(@Query('key') key = 'k1', @Query('value') value = 'v1'): Promise<{ value: string | undefined; driver: string }> {
    await this.service.put(key, value);
    return { value: await this.service.pick(key), driver: this.service.stats().driver };
  }

  /** @Cacheable 逐出演示：返回数据与该桶的回源次数 */
  @Get('find-user')
  async findUser(@Query('id') id = '1'): Promise<{ user: unknown; loads: number }> {
    return { user: await this.service.findUser(id), loads: this.service.loadCount(`user:${id}`) };
  }

  /** 回源包装（命中值）；delayMs 放大回源耗时以验证单飞 */
  @Get('wrap')
  async wrap(@Query('key') key = 'hot', @Query('delayMs') delayMs = '0'): Promise<{ value: string | undefined; loads: number }> {
    const value = await this.service.loadOrMiss(key, false, Number.parseInt(delayMs, 10) || 0);
    return { value, loads: this.service.loadCount(`item:${key}`) };
  }

  /** 回源包装（不存在的值 → 空值占位，防穿透） */
  @Get('wrap-miss')
  async wrapMiss(@Query('key') key = 'ghost', @Query('delayMs') delayMs = '0'): Promise<{ value: string | undefined; loads: number }> {
    const value = await this.service.loadOrMiss(key, true, Number.parseInt(delayMs, 10) || 0);
    return { value, loads: this.service.loadCount(`item:${key}`) };
  }

  /** 查询某桶的回源次数（并发断言用） */
  @Get('loads')
  loads(@Query('key') key?: string): { loads: number } {
    return { loads: this.service.loadCount(key) };
  }

  /** 缓存指标快照（命中率 / 单飞合并数 / 标签失效数 / 降级数 / 驱动） */
  @Get('stats')
  stats(): ReturnType<CacheDemoService['stats']> {
    return this.service.stats();
  }

  /** 清空回源计数（冒烟分阶段复位） */
  @Post('reset')
  reset(): { ok: true } {
    this.service.resetCounts();
    return { ok: true };
  }

  /** 按标签失效 */
  @Post('invalidate')
  async invalidate(@Query('tag') tag = 'demo:user:1'): Promise<{ removed: number }> {
    return { removed: await this.service.invalidate(tag) };
  }

  /** 获取锁并保持指定时长（集群单跑语义） */
  @Post('lock-hold')
  async lockHold(@Query('key') key = 'job', @Query('ms') ms = '1000'): Promise<{ acquired: boolean }> {
    return { acquired: await this.service.holdLock(key, Number.parseInt(ms, 10) || 1000) };
  }

  /** 尝试获取并立即释放锁 */
  @Get('lock-try')
  async lockTry(@Query('key') key = 'job'): Promise<{ acquired: boolean }> {
    return { acquired: await this.service.tryLock(key) };
  }
}
