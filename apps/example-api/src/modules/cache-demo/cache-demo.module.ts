/*
 * @file 缓存演示模块（M4 验收载体）
 * @description 注册缓存演示服务与控制器；缓存自身由 app.module 中的 CacheModule.forRoot 装配（全局），
 *   本模块只消费注入的 CacheService（CACHE_SERVICE），不做驱动选择——切换 memory/redis 改 .env 即可。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/cache-demo
 */

import { Module } from '@nestjs/common';
import { CacheDemoController } from './cache-demo.controller.js';
import { CacheDemoService } from './cache-demo.service.js';

/**
 * 缓存演示模块
 */
@Module({
  controllers: [CacheDemoController],
  providers: [CacheDemoService],
  exports: [CacheDemoService],
})
export class CacheDemoModule {}
