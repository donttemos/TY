/*
 * @file 演示自检端点守卫
 * @description M12 W3（PRD-012 OBS-16，ADR-0027）：demo 前缀 / cache-demo / demo-queue / demo-transport 四个
 *   自检控制器默认「非 dev 环境 404」——演示面不得在生产默认暴露（攻击面登记 docs/46 矩阵）。
 *   开关语义：DEMO_ENDPOINTS_ENABLED 显式 true/false 优先；未设置按 APP_ENV=dev 或 NODE_ENV=development
 *   判定（默认安全方向：非 dev 即关）。关闭时返回 404（不暴露端点存在性，而非 403）。
 * @author donttemo
 * @created 2026-10-17
 * @module example-api/common
 */
import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

/** 演示端点是否启用（DEMO_ENDPOINTS_ENABLED 显式优先；未设置按 APP_ENV/NODE_ENV 判定） */
export function isDemoEndpointsEnabled(): boolean {
  const raw = process.env.DEMO_ENDPOINTS_ENABLED;
  if (raw !== undefined && raw.trim() !== '') {
    return raw === 'true' || raw === '1';
  }
  // 未设置：dev 环境默认开，其余（test/prod/default）默认关——默认安全
  return process.env.APP_ENV === 'dev' || process.env.NODE_ENV === 'development';
}

/**
 * 演示端点守卫：关闭环境一律 404（不泄露存在性）
 */
@Injectable()
export class DemoEndpointsGuard implements CanActivate {
  canActivate(): boolean {
    if (isDemoEndpointsEnabled()) return true;
    throw new NotFoundException('演示端点未启用（DEMO_ENDPOINTS_ENABLED）');
  }
}
