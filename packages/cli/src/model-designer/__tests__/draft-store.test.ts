/*
 * @file 草案缓存单测（PRD-017 FR-17-24）
 * @description 生成一次几十秒，刷新就丢不可接受；这里锁死读写、原子替换、损坏降级与体积上限。
 * @author donttemo
 * @created 2026-10-27
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DRAFT_BYTES, clearSavedDraft, draftFilePath, readSavedDraft, saveDraft } from '../draft-store.js';

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-draft-store-'));
  file = path.join(tmpDir, 'draft.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const draft = { protocol_version: '1.0', status: 'draft', revision: 2, models: [{ name: 'Tag' }] };

describe('draft-store', () => {
  it('保存后可读回，savedAt 是 ISO 时间', () => {
    const savedAt = saveDraft(draft, file);
    expect(savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const state = readSavedDraft(file);
    expect(state.saved?.draft.revision).toBe(2);
    expect(state.saved?.savedAt).toBe(savedAt);
  });

  it('覆盖写入只保留最近一份', () => {
    saveDraft(draft, file);
    saveDraft({ ...draft, revision: 3 }, file);
    expect(readSavedDraft(file).saved?.draft.revision).toBe(3);
  });

  it('清空后读回 null', () => {
    saveDraft(draft, file);
    expect(clearSavedDraft(file)).toBe(true);
    expect(readSavedDraft(file).saved).toBeNull();
    expect(clearSavedDraft(file)).toBe(false);
  });

  it('文件损坏时降级为「没有缓存」并说明原因', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken', 'utf8');
    const state = readSavedDraft(file);
    expect(state.saved).toBeNull();
    expect(state.error).toContain('无法解析');
  });

  it('超过体积上限时拒绝写入，不产生半截文件', () => {
    const huge = { ...draft, filler: 'x'.repeat(MAX_DRAFT_BYTES) };
    expect(() => saveDraft(huge, file)).toThrow(/过大/);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('路径按项目哈希隔离，不出现项目路径', () => {
    const a = draftFilePath('F:/work/secret-project', {});
    const b = draftFilePath('F:/work/other', {});
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-project');
  });
});
