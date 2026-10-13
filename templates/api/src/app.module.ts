/*
 * @file 应用根模块（模板）
 * @description 组装框架核心与业务模块；新增模块在此追加 import
 * @author donttemo
 * @created 2026-10-09
 * @since v0.1.0
 */
import { Module } from '@nestjs/common';
import { FwCoreModule } from '@fw/core';
import { DemoModule } from './modules/demo/demo.module.js';

/**
 * 应用根模块
 */
@Module({
  imports: [FwCoreModule.forRoot(), DemoModule],
})
export class AppModule {}
