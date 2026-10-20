/*
 * @file 审计拦截器
 * @description 消费 `@Audit({ module, action, targetType })` 元数据：请求成功后自动落一条审计记录
 *   （操作人取守卫写入的 request.user、IP / UA 取请求、after 取响应体、targetId 取路由参数）。
 *   刻意不记录 before：变更前值只有业务层知道（需先查旧值），由业务在服务层显式调用
 *   AuditService.record({ before, after }) 补全，避免拦截器内额外查询或猜测。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo AuditService 改值导入（类型导入会让 DI 元数据退化为 Object）
 * @module @fw/auth
 */

import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap, type Observable } from 'rxjs';
import { AuditService } from './audit.service.js';
import { META_AUDIT } from './constants.js';
import type { AuditMeta } from './decorators.js';
import type { GuardRequest } from './rbac.guard.js';
// AuditService 必须值导入：类型位置引用会让 emitDecoratorMetadata 发出 Object，Nest 无法解析依赖

/** 拦截器用到的请求补充字段 */
interface AuditRequest extends GuardRequest {
  params?: Record<string, string>;
  body?: unknown;
}

/**
 * 审计拦截器：注册为 APP_INTERCEPTOR
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  /**
   * @param reflector 元数据读取
   * @param audit 审计服务
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  /**
   * 拦截并记录
   * @param context 执行上下文
   * @param next 处理器
   * @returns 原可观察流（记录不改变响应）
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(META_AUDIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();

    const request = context.switchToHttp().getRequest<AuditRequest>();
    const idParam = meta.idParam ?? 'id';

    return next.handle().pipe(
      tap((response: unknown) => {
        this.audit.record({
          userId: request.user?.id ?? null,
          module: meta.module,
          action: meta.action,
          targetType: meta.targetType ?? null,
          targetId: request.params?.[idParam] ?? null,
          after: response,
          ip: request.ip ?? null,
          userAgent:
            typeof request.headers?.['user-agent'] === 'string' ? (request.headers['user-agent'] as string) : null,
          // PRD-015 FR-15-13 / ADR-0032 R5：拦截器只能证明「HTTP 成功返回」，
          // 不代表业务已完成——来源标记让运营与取证能区分兜底行与领域行
          auditSource: 'interceptor',
        });
      }),
    );
  }
}
