/*
 * @file 开放接口示例（E-07：apikey 策略端到端载体）
 * @description AUTH_STRATEGY 枚举里 `apikey` 的名实相符载体：`@AuthStrategy('apikey')` 让该路由
 *   脱离默认 jwt 策略，凭 `X-Api-Key`（可选 HMAC 签名，约定见 docs/41）访问。
 *   权限来自 AUTH_API_KEYS 条目声明的 scope（空 scope = 无任何权限，默认拒绝），
 *   不走登录流程、不进登录限流。开放接口的真实业务形态（三方系统对接）参照本路由扩展。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/demo
 */

import { Controller, Get } from '@nestjs/common';
import { AuthStrategyDecorator, CurrentUser } from '@fw/auth';
import type { RequestUser } from '@fw/auth';

/**
 * 开放接口控制器：/api/v1/open（apikey 策略）
 */
@Controller('/api/v1/open')
export class OpenController {
  /** 存活自检：apikey 策略命中即可访问（鉴权信息回显供冒烟断言身份与 scope 生效） */
  @AuthStrategyDecorator('apikey')
  @Get('ping')
  ping(@CurrentUser() user: RequestUser): Record<string, unknown> {
    return {
      pong: true,
      subject: user.username,
      via: user.via,
      scopes: user.permissions,
    };
  }
}
