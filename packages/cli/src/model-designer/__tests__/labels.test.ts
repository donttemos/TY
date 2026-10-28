/*
 * @file 中文标注推断单测
 * @description 只做「展示用」推断：常见词必须准、认不出必须空（宁可不显示也不乱译）。
 * @author donttemo
 * @created 2026-10-28
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { docCommentOf, splitTokens, suggestLabel } from '../labels.js';

describe('splitTokens', () => {
  it('拆驼峰、下划线与连续大写', () => {
    expect(splitTokens('UserProfile')).toEqual(['User', 'Profile']);
    expect(splitTokens('user_id')).toEqual(['user', 'id']);
    expect(splitTokens('APIKey')).toEqual(['API', 'Key']);
  });
});

describe('suggestLabel', () => {
  it('常见模型与字段', () => {
    expect(suggestLabel('User')).toBe('用户');
    expect(suggestLabel('UserProfile')).toBe('用户资料');
    expect(suggestLabel('OrderItem')).toBe('订单条目');
    expect(suggestLabel('DemoItem')).toBe('演示条目');
    expect(suggestLabel('createdAt')).toBe('创建时间');
    expect(suggestLabel('updatedAt')).toBe('更新时间');
    expect(suggestLabel('userId')).toBe('用户 ID');
    expect(suggestLabel('sku')).toBe('SKU');
  });

  it('后缀补充：stockCount → 库存数量', () => {
    expect(suggestLabel('stockCount')).toBe('库存数量');
  });

  it('认不出的名字返回空串，不硬翻', () => {
    expect(suggestLabel('Xyzzy')).toBe('');
    expect(suggestLabel('')).toBe('');
  });
});

describe('docCommentOf', () => {
  it('读取 /// 注释正文', () => {
    expect(docCommentOf('  /// 用户 ID')).toBe('用户 ID');
    expect(docCommentOf('///昵称')).toBe('昵称');
    expect(docCommentOf('// 普通注释')).toBeNull();
    expect(docCommentOf('model User {')).toBeNull();
  });
});
