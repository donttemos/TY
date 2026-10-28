/*
 * @file 审查提示词（PRD-017 FR-17-23）
 * @description 提示词按「本框架的真实约束」写，而不是通用代码审查清单：
 *   多租户隔离、权限码、BizError、审计事件、分页上限都是本项目里最容易生成错的点。
 *   明确要求「只报能确证的问题、给文件与行号、不贴大段代码」，避免模型输出无法核对的套话。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/review
 * @since v0.8.0
 */

import type { ReviewFile, SkippedFile } from './collect.js';

/** 聊天消息（与 OpenAI 兼容接口同构；assistant 用于重试时回放上一次输出） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 系统提示词：角色 + 关注点 + 输出契约 */
export const REVIEW_SYSTEM_PROMPT = `你是资深后端/前端代码审查者。审查对象是 "fw" 代码生成器刚生成的 CRUD 代码（NestJS + Prisma + Vue 3）。

只报告你能从给定代码中**确证**的问题；不要臆测未提供的文件，不要复述实现，不要输出寒暄与总结性夸奖。

按以下优先级检查：
1. P0 安全：权限码缺失或写错、未校验 tenantId 导致跨租户读写、注入风险、敏感信息（密钥/密码/令牌）出现在代码或日志里、未限制的批量操作；
2. P0 正确性：字段与 schema 不一致、空值/边界未处理、事务边界错误、分页或排序失效、软删除未过滤；
3. P1 契约：DTO 未校验、直接抛裸 Error（本项目要求 BizError + 错误码）、审计事件缺失、返回结构与接口契约不符；
4. P2 可维护性：重复代码、命名不清、N+1 查询、无意义注释。

输出格式（严格）：
- 每条一行：\`[P0|P1|P2] 文件:行 — 问题 → 建议\`
- 行号必须来自你看到的内容；无法定位到行时写 \`文件 —\`，不要编造；
- 同一文件同一问题只报一次；
- 若没有发现问题，只输出一行：\`未发现问题\`。`;

/**
 * 拼装审查消息
 * @param files 待审文件
 * @param skipped 被跳过的文件（让模型知道审查不完整，不得据此推断「没问题」）
 * @returns system + user 两条消息
 */
export function buildReviewMessages(files: ReviewFile[], skipped: SkippedFile[] = []): ChatMessage[] {
  const header = [
    `待审文件共 ${files.length} 个（路径相对后端应用根）：`,
    ...(skipped.length > 0
      ? ['', `另有 ${skipped.length} 个文件未提供（审查不完整，不要据缺失文件下结论）：`, ...skipped.map((item) => `- ${item.path}：${item.reason}`)]
      : []),
    '',
  ].join('\n');

  const body = files
    .map((file) => {
      const lang = file.path.endsWith('.vue') ? 'vue' : file.path.endsWith('.json') ? 'json' : 'ts';
      return `### ${file.path}\n\`\`\`${lang}\n${file.content}\n\`\`\``;
    })
    .join('\n\n');

  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `${header}\n${body}` },
  ];
}
