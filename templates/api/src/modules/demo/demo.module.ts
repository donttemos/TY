/*
 * @file 演示模块定义（模板）
 * @description 生成后可删除或替换为真实业务模块
 * @author donttemo
 * @created 2026-10-09
 * @module demo
 * @since v0.1.0
 */
import { Module } from '@nestjs/common';
import { DemoController } from './demo.controller.js';

/**
 * 演示模块：验证统一响应 / 错误码 / 脱敏日志 / traceId
 */
@Module({
  controllers: [DemoController],
})
export class DemoModule {}
