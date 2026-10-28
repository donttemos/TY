/*
 * @file 提示词与文档同步单测（PRD-017 FR-17-24）
 * @description 代码里的系统提示词与 docs/51 是同一份契约的两个副本：
 *   靠规则编号 R1~R17 做同步锚点，并把文档里的商品示例直接丢进校验器——
 *   示例一旦不合法，说明契约与实现已经漂移。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGNER_SYSTEM_PROMPT } from '../prompt.js';
import { validateModelDraft } from '../draft-schema.js';

/** 定位 docs/51（兼容从 packages/cli 或仓库根运行） */
function readDoc(): string {
  const candidates = [
    path.resolve(process.cwd(), '../../docs/51-ai-model-designer-agent.md'),
    path.resolve(process.cwd(), 'docs/51-ai-model-designer-agent.md'),
  ];
  const hit = candidates.find((file) => fs.existsSync(file));
  if (!hit) throw new Error(`找不到 docs/51（尝试过：${candidates.join('、')}）`);
  return fs.readFileSync(hit, 'utf8');
}

describe('docs/51 与代码提示词同步', () => {
  it('R1~R17 在文档与代码中同时存在', () => {
    const doc = readDoc();
    for (let index = 1; index <= 17; index += 1) {
      const rule = `R${index}`;
      expect(doc, `文档缺少 ${rule}`).toContain(`${rule} `);
      expect(DESIGNER_SYSTEM_PROMPT, `提示词缺少 ${rule}`).toContain(`${rule} `);
    }
  });

  it('文档中的商品示例能通过校验器（契约未漂移）', () => {
    const doc = readDoc();
    // 容忍 CRLF：仓库在 Windows 工作区是 CRLF，git 归一化后入库为 LF
    const blocks = [...doc.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]);
    // 第 1 块是输入信封，第 2 块是输出示例
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const example = JSON.parse(blocks[1]) as Record<string, unknown>;
    const issues = validateModelDraft(example, {
      existingModels: ['Category'],
      baseRevision: 0,
      mode: 'create',
    });
    expect(issues).toEqual([]);
  });

  it('文档声明了参数上限与异常码（与实现同名）', () => {
    const doc = readDoc();
    for (const token of ['recommended_call_params', 'generation_profile', 'E_REVISION_CONFLICT', 'E_JSON_PARSE', 'max_output_tokens']) {
      expect(doc).toContain(token);
    }
  });
});
