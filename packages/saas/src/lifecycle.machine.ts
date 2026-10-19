/*
 * @file 生命周期状态机（纯函数）
 * @description ADR-0031 合法迁移表的唯一权威实现：判定与执行分离——本模块只做判定，
 *   执行（条件更新 + 日志）在 LifecycleService。改迁移规则只改这里，测试逐条对表。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import type { LifecycleAction, LifecycleStatus } from './types.js';

/**
 * 合法迁移表（ADR-0031 §2.2 唯一权威）：
 *   pending  -activate->  active
 *   active   -expire->    grace          （到期任务，前置：订阅过期且宽限窗口 > 0，调用方校验）
 *   active   -freeze->    frozen
 *   grace    -freeze->    frozen         （宽限期满，系统任务）
 *   grace    -resume->    active         （续订）
 *   frozen   -resume->    active         （恢复）
 *   active / grace / frozen -terminate-> terminated
 *   terminated -dispose-> 终态（保留期满处置；无迁出）
 */
export const TRANSITIONS: Readonly<Record<LifecycleStatus, Partial<Record<LifecycleAction, LifecycleStatus>>>> = {
  pending: { activate: 'active' },
  active: { expire: 'grace', freeze: 'frozen', terminate: 'terminated' },
  grace: { freeze: 'frozen', resume: 'active', terminate: 'terminated' },
  frozen: { resume: 'active', terminate: 'terminated' },
  terminated: { dispose: 'terminated' },
};

/** 判定 from 状态下 action 是否合法，合法返回目标态，否则 null */
export function resolveTransition(from: LifecycleStatus, action: LifecycleAction): LifecycleStatus | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

/** 全量枚举合法迁移键（供测试逐条对表与文档核对） */
export function listTransitions(): Array<{ from: LifecycleStatus; action: LifecycleAction; to: LifecycleStatus }> {
  const out: Array<{ from: LifecycleStatus; action: LifecycleAction; to: LifecycleStatus }> = [];
  for (const from of Object.keys(TRANSITIONS) as LifecycleStatus[]) {
    for (const [action, to] of Object.entries(TRANSITIONS[from])) {
      out.push({ from, action: action as LifecycleAction, to: to as LifecycleStatus });
    }
  }
  return out;
}
