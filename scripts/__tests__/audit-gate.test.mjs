#!/usr/bin/env node
/*
 * @file 审计事件门禁的反向测试（node:test）
 * @description 门禁通过不等于覆盖完整——本文件专门证明「门禁会红」：
 *   - 删掉某事件**唯一**的写入调用后，分析结果必须报「无写入点」；
 *   - 只在注册表定义文件里出现的事件码**不再**被当成写入点（这正是此前的漏判）；
 *   - 没有 `@audit-event-map` 标记的文件里的字面量不算写入点，映射表算；
 *   - 前端文件的 `event:`（查询参数）不算写入点；
 *   - 未登记事件码（`event:` 属性 / 映射表）必须报缺口。
 *
 *   纯函数测试，不依赖文件系统与真实仓库，毫秒级完成；由 `pnpm run check:audit-events:test`
 *   （CI base 作业紧随门禁步骤）执行，避免「把判定逻辑改宽松了但没人发现」。
 * @author donttemo
 * @created 2026-10-20
 * @module scripts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENT_MAP_MARKER, analyzeAuditCoverage, lineOf } from '../lib/audit-gate.mjs';

/** 注册表定义文件（分析时必须整体排除） */
const DEFINITIONS = ['packages/auth/src/audit-events.ts'];

/** 合成注册表：三条有效 + 一条废弃 */
const REGISTRY = [
  { code: 'user.create' },
  { code: 'user.update' },
  { code: 'saas.lifecycle.freeze' },
  { code: 'legacy.retired.event', deprecated: { since: '0.1.0' } },
];

/** 一条带显式映射表标记的文件内容 */
const MAP_FILE = `// ${EVENT_MAP_MARKER}\nconst LIFECYCLE_EVENTS = { freeze: 'saas.lifecycle.freeze' };\n`;

/** 跑一次分析 */
function analyze(files) {
  return analyzeAuditCoverage({ registry: REGISTRY, files, definitionPaths: DEFINITIONS });
}

/** 覆盖全部有效事件的健康输入 */
function healthyFiles() {
  return [
    { path: 'apps/example-api/src/users.controller.ts', content: "this.audit.recordEvent('user.create', {});" },
    { path: 'apps/example-api/src/rbac.controller.ts', content: "this.audit.recordEvent('user.update', { userId });" },
    { path: 'apps/example-api/src/saas-ops.controller.ts', content: MAP_FILE },
  ];
}

describe('审计门禁 · 通过路径', () => {
  it('每个有效事件都有真实写入点时无缺口（废弃条目不需要写入点）', () => {
    const result = analyze(healthyFiles());
    assert.deepEqual(result.findings, [], `意外缺口：${result.findings.join(' / ')}`);
    assert.deepEqual(result.missing, []);
    assert.equal(result.writePoints.get('user.create')?.length, 1);
    assert.equal(result.writePoints.get('saas.lifecycle.freeze')?.length, 1);
  });

  it('recordEventSync 与 event: 属性同样算写入点（两种真实写入语法）', () => {
    const result = analyze([
      { path: 'apps/example-api/src/config-bridge.ts', content: "await this.audit.recordEventSync('user.create', {});" },
      { path: 'packages/auth/src/refresh-token.service.ts', content: "audit.record({ userId, event: 'user.update', result: 'denied' });" },
      { path: 'apps/example-api/src/saas-ops.controller.ts', content: MAP_FILE },
    ]);
    assert.deepEqual(result.missing, []);
  });
});

describe('审计门禁 · 反向验证（删除写入点必须红）', () => {
  it('删掉唯一写入调用 → 该事件报「无写入点」', () => {
    const files = healthyFiles().filter((file) => !file.content.includes("'user.update'"));
    const result = analyze(files);
    assert.ok(result.missing.includes('user.update'), `应报缺失，实际：${JSON.stringify(result.missing)}`);
    assert.ok(
      result.findings.some((finding) => finding.includes('注册表条目无写入点：user.update')),
      '缺口文案应明确指出事件码',
    );
  });

  it('只在注册表定义文件里出现 → 不算写入点（此前的漏判点）', () => {
    const result = analyze([
      { path: 'apps/example-api/src/users.controller.ts', content: "this.audit.recordEvent('user.create', {});" },
      { path: 'apps/example-api/src/saas-ops.controller.ts', content: MAP_FILE },
      { path: DEFINITIONS[0], content: "export const AUDIT_EVENTS = [{ code: 'user.update' }];" },
    ]);
    assert.ok(result.missing.includes('user.update'));
  });

  it('没有 @audit-event-map 标记的文件里的字面量不算写入点（注释/文档提一句不算接入）', () => {
    const result = analyze([
      ...healthyFiles().filter((file) => !file.content.includes("'user.update'")),
      { path: 'apps/example-api/src/readme-notes.ts', content: "export const NOTE = 'user.update 是更新用户的事件';" },
    ]);
    assert.ok(result.missing.includes('user.update'));
  });

  it('前端文件的 event: 属性不算写入点（那是查询参数，不是记录审计）', () => {
    const result = analyze([
      ...healthyFiles().filter((file) => !file.content.includes("'user.update'")),
      { path: 'apps/admin-web/src/api/audit.ts', content: "const query = { event: 'user.update' };", countsEventProperty: false },
    ]);
    assert.ok(result.missing.includes('user.update'));
  });
});

describe('审计门禁 · 未登记事件码', () => {
  it('event: 位置出现未登记码 → 缺口', () => {
    const result = analyze([
      ...healthyFiles(),
      { path: 'apps/example-api/src/probe.ts', content: "audit.record({ event: 'user.dstroy' });" },
    ]);
    assert.ok(result.findings.some((finding) => finding.includes('未登记事件码：user.dstroy')));
  });

  it('直接调用位置出现未登记码 → 缺口', () => {
    const result = analyze([...healthyFiles(), { path: 'apps/example-api/src/probe.ts', content: "this.audit.recordEvent('saas.plan.publsh', {});" }]);
    assert.ok(result.findings.some((finding) => finding.includes('未登记事件码：saas.plan.publsh')));
  });

  it('映射表里拼错事件码 → 缺口（显式映射不是免检区）', () => {
    const result = analyze([
      { path: 'apps/example-api/src/users.controller.ts', content: "this.audit.recordEvent('user.create', {});" },
      { path: 'apps/example-api/src/rbac.controller.ts', content: "this.audit.recordEvent('user.update', {});" },
      { path: 'apps/example-api/src/saas-ops.controller.ts', content: `// ${EVENT_MAP_MARKER}\nconst MAP = { freeze: 'saas.lifecycle.freez' };\n` },
    ]);
    assert.ok(result.findings.some((finding) => finding.includes('映射表出现未登记事件码：saas.lifecycle.freez')));
    assert.ok(result.missing.includes('saas.lifecycle.freeze'));
  });
});

describe('审计门禁 · 行号定位', () => {
  it('缺口能定位到具体行（排障时直接跳到写入点）', () => {
    const content = "line1\nline2\naudit.recordEvent('user.nope.event', {});\n";
    assert.equal(lineOf(content, content.indexOf('user.nope.event')), 3);
  });
});
