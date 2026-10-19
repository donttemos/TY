/*
 * @file ConfirmWithReason 单测（M14/PRD-014 FR-14-08）
 * @description 钉住统一原因收集入口语义：① 确认且非空 → trim 后返回；② 选填留空 → undefined；
 *   ③ 取消/关闭 → null（绝不吞输入、绝不用 undefined 冒充取消）；④ required 时空值被校验器拦截。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/components
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, default: actual.default, ElMessageBox: { ...actual.ElMessageBox, prompt: vi.fn() } };
});

import { ElMessageBox } from 'element-plus';
import { confirmWithReason } from '@/components/ConfirmWithReason/index';

describe('confirmWithReason（统一原因收集入口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('确认且非空：trim 后返回原因', async () => {
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: '  违规操作  ' } as never);
    const r = await confirmWithReason({ title: '冻结', message: '输入原因' });
    expect(r).toBe('违规操作');
    expect(ElMessageBox.prompt).toHaveBeenCalledTimes(1);
  });

  it('选填留空：返回 undefined（无原因但确认执行）', async () => {
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: '   ' } as never);
    const r = await confirmWithReason({ title: '开通', message: '输入原因（可留空）' });
    expect(r).toBeUndefined();
  });

  it('取消/关闭：返回 null（调用方不得执行操作）', async () => {
    vi.mocked(ElMessageBox.prompt).mockRejectedValue(new Error('cancel'));
    const r = await confirmWithReason({ title: '终止', message: '输入原因' });
    expect(r).toBeNull();
  });

  it('required 模式：注入非空校验器（空值提示必填）', async () => {
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: '依据' } as never);
    await confirmWithReason({ title: '终止', message: '输入原因', required: true });
    const call = vi.mocked(ElMessageBox.prompt).mock.calls[0][2] as { inputValidator?: (v: string) => boolean | string };
    expect(typeof call.inputValidator).toBe('function');
    expect(call.inputValidator!('  ')).toBe('原因必填，请说明操作依据');
    expect(call.inputValidator!('依据')).toBe(true);

    // 必填但确认为空 → 返回 null（防线兜底）
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: '' } as never);
    const r = await confirmWithReason({ title: '终止', message: '输入原因', required: true });
    expect(r).toBeNull();
  });
});
