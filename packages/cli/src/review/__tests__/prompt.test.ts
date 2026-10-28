/*
 * @file 审查提示词单测（PRD-017 FR-17-23）
 * @description 提示词是产品行为的一部分：必须带项目自己的红线（多租户/权限码/BizError/审计）、
 *   必须给「不编造行号」与「未发现就说未发现」的约束，并且把跳过的文件如实告诉模型。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { buildReviewMessages, REVIEW_SYSTEM_PROMPT } from '../prompt.js';

const file = (path: string, content: string) => ({ path, content, bytes: content.length });

describe('buildReviewMessages', () => {
  it('system 提示词包含项目红线与输出格式', () => {
    for (const keyword of ['tenantId', '权限码', 'BizError', '审计', 'P0', '不要编造', '未发现问题']) {
      expect(REVIEW_SYSTEM_PROMPT).toContain(keyword);
    }
  });

  it('user 消息带文件路径与语言围栏', () => {
    const [system, user] = buildReviewMessages([
      file('src/modules/order/order.service.ts', 'export class S {}'),
      file('src/views/order/index.vue', '<template><div /></template>'),
    ]);
    expect(system.role).toBe('system');
    expect(user.role).toBe('user');
    expect(user.content).toContain('### src/modules/order/order.service.ts');
    expect(user.content).toContain('```ts');
    expect(user.content).toContain('```vue');
    expect(user.content).toContain('待审文件共 2 个');
  });

  it('跳过的文件要如实告知，并禁止据此推断没问题', () => {
    const [, user] = buildReviewMessages([file('a.ts', 'x')], [{ path: 'big.ts', reason: '单文件过大' }]);
    expect(user.content).toContain('审查不完整');
    expect(user.content).toContain('big.ts：单文件过大');
  });

  it('没有跳过项时不产生噪音段落', () => {
    const [, user] = buildReviewMessages([file('a.ts', 'x')]);
    expect(user.content).not.toContain('审查不完整');
  });
});
