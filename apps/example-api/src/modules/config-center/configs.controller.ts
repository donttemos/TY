/*
 * @file 配置中心管理端点（M9/PRD-009 FR-06，api-spec §3.10）
 * @description GET  /api/v1/configs       需 system:config:read —— 白名单键当前生效值 + 运行元信息
 *              （boot 键 env 独占，不进列表——列出只会诱导修改；不可热更语义由 5001 覆盖）
 *              PUT  /api/v1/configs/:key  需 system:config:write —— 白名单键在线修改，
 *              走单一生效管道（校验 → 审计 → 持久化 → 应用 → 通知）。
 *              错误语义：白名单外（boot 键）400/5001；值非法 400/5002（details 带原因）；
 *              键不存在 404/5003；越权 403/3002；未启用 400/1004。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import { Body, Controller, Get, Inject, Param, Put, Req } from '@nestjs/common';
import { PERM, CurrentUser, Permissions } from '@fw/auth';
import { BizError, ErrorCode } from '@fw/core';
import type { ConfigCenterMeta, ConfigEntryView, ConfigWriteResult } from '@fw/config-center';
import { CONFIG_CENTER, CONFIG_CENTER_STATE } from './config-center.tokens.js';
import type { ConfigCenterService } from '@fw/config-center';
import type { Request } from 'express';

/** GET /configs 响应 */
interface ConfigListResponse {
  configs: ConfigEntryView[];
  meta: ConfigCenterMeta;
}

/**
 * 配置管理控制器：/api/v1/configs
 */
@Controller('/api/v1/configs')
export class ConfigsController {
  constructor(
    @Inject(CONFIG_CENTER) private readonly center: ConfigCenterService,
    @Inject(CONFIG_CENTER_STATE) private readonly state: { enabled: boolean },
  ) {}

  /** 白名单键当前生效值列表 + 运行元信息 */
  @Permissions(PERM.CONFIG_READ)
  @Get()
  list(): ConfigListResponse {
    return { configs: this.center.list(), meta: this.center.meta() };
  }

  /** 修改白名单键（写权限独立授予；审计由配置中心管道统一落盘，此处不重复 @Audit） */
  @Permissions(PERM.CONFIG_WRITE)
  @Put(':key')
  async update(
    @Param('key') key: string,
    @Body() body: { value?: unknown },
    @CurrentUser('id') operatorId: string,
    @CurrentUser('username') operator: string,
    @Req() request: Request,
  ): Promise<ConfigWriteResult> {
    // 未启用：不读文件不起轮询的零开销形态下，在线修改没有事实源，语义上整体不可用
    if (!this.state.enabled) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '配置中心未启用（CONFIG_CENTER_ENABLED=false），运行时参数不可在线修改');
    }
    if (!body || !('value' in body)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'body.value 必填（新配置值，JSON 语义）');
    }
    return this.center.write(key, body.value, { source: 'api', operator, operatorId });
  }
}
