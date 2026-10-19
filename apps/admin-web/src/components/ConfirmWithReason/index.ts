/*
 * @file ConfirmWithReason —— 危险操作原因确认统一入口（M14/PRD-014 FR-14-08）
 * @description 全站唯一的原因收集入口：包装 ElMessageBox.prompt，归一化「原因收集」语义——
 *   输入 trim、required 时空值拦截（前端校验）、取消返回 null（与确认返回值区分）。
 *   任何需要落库 reason 的写操作（生命周期迁移 / 订阅取消 / 后续终止类）必须走本入口，
 *   杜绝 M13「prompt 返回值被丢弃、原因从未落库」类缺陷再现（PRD-014 U-14-1）。
 *   必填策略沿 OQ-14-5 默认倾向：危险动作（freeze/terminate/dispose）调用方传 required，
 *   普通动作（activate/resume）选填。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/components
 */
import { ElMessageBox } from 'element-plus';

export interface ConfirmWithReasonOptions {
  /** 弹窗标题 */
  title: string;
  /** 说明文案 */
  message: string;
  /** 原因是否必填（默认选填） */
  required?: boolean;
  /** 输入框占位文案 */
  placeholder?: string;
}

/**
 * 危险操作原因确认：
 * - 确认且输入非空 → 返回 trim 后的原因字符串；
 * - 确认但留空：required=false → undefined（无原因）；required=true → null（前端拦截，不应发生）；
 * - 取消/关闭 → null。
 */
export async function confirmWithReason(options: ConfirmWithReasonOptions): Promise<string | null | undefined> {
  try {
    const { value } = await ElMessageBox.prompt(options.message, options.title, {
      type: 'warning',
      inputValue: '',
      inputPlaceholder: options.placeholder ?? (options.required ? '必填' : '可留空'),
      inputValidator: options.required
        ? (input: string) => (input.trim().length > 0 ? true : '原因必填，请说明操作依据')
        : undefined,
    });
    const trimmed = value?.trim();
    return trimmed ? trimmed : options.required ? null : undefined;
  } catch {
    return null;
  }
}
