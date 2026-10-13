/*
 * @file 配置校验错误
 * @description 把 zod 校验失败转成人类可读的聚合错误：逐条列出缺失项名称或非法取值与可选值列表；启动时捕获后打印本错误而非堆栈崩溃。
 * @author donttemo
 * @created 2026-10-09
 * @module config
 * @since v0.1.0
 */
import { ENUM_OPTIONS } from './env-schema.js';

/** 单个配置项的问题描述 */
export interface ConfigIssue {
  /** 配置键名，如 APP_ENV */
  key: string;
  /** 人类可读的问题说明 */
  message: string;
}

/**
 * 配置校验失败异常：聚合全部问题一次性抛出，message 为多行中文说明
 */
export class ConfigValidationError extends Error {
  /** 逐项问题列表 */
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    const lines = issues.map((i) => `  - ${i.key}: ${i.message}`);
    super(`配置校验失败，共 ${issues.length} 项问题：\n${lines.join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/** zod issue code 到中文说明的映射 */
const CODE_MESSAGES: Record<string, string> = {
  invalid_type: '类型错误',
  invalid_enum_value: '取值不在允许范围内',
  too_small: '长度或数值过小',
  too_big: '长度或数值过大',
};

/**
 * 把 zod 的 issues 翻译成中文说明
 * @param issues zod 校验返回的 issue 数组
 * @returns 翻译后的配置问题列表
 */
export function translateIssues(issues: Array<{ path: (string | number)[]; code: string; message: string }>): ConfigIssue[] {
  return issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    const options = ENUM_OPTIONS[key];
    const reason = CODE_MESSAGES[issue.code] ?? issue.code;
    if (issue.code === 'invalid_type' && issue.message.includes('Required')) {
      return { key, message: '缺少必填项（请检查 .env / .env.example）' };
    }
    if (issue.code === 'invalid_enum_value' && options) {
      return { key, message: `${reason}，可选值：${options.join(' / ')}` };
    }
    return { key, message: `${reason}（${issue.message}）` };
  });
}
