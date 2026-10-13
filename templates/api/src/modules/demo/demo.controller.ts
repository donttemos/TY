/*
 * @file 演示端点（模板）
 * @description 生成后可删除或替换为真实业务接口
 * @author donttemo
 * @created 2026-10-09
 * @module demo
 * @since v0.1.0
 */
import { Controller, Get } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';

const logger = Logger.for('demo');

/**
 * 演示控制器：路径前缀 /api/v1/demo
 */
@Controller('/api/v1/demo')
export class DemoController {
  /** 正常请求：统一响应包装（code=0 + traceId） */
  @Get('ok')
  ok(): { hello: string } {
    return { hello: 'fw' };
  }

  /** 业务异常：结构化错误码 */
  @Get('biz-error')
  bizError(): never {
    throw new BizError(ErrorCode.BIZ_FAILED, '演示业务异常');
  }

  /** 敏感日志：password/token 自动脱敏为 *** */
  @Get('log-sensitive')
  logSensitive(): { logged: boolean } {
    logger.info('用户尝试登录', { username: 'alice', password: 'secret-123', accessToken: 'jwt-abc' });
    return { logged: true };
  }
}
