/*
 * @file 生成接线标记块单测（PRD-016 FR-16-02/FR-16-03）
 * @description 覆盖整块重写、幂等、缩进、空块、以及缺失 / 重复 / 顺序颠倒三类结构异常的明确报错。
 *   重点锁死「绝不猜测位置」：结构不对就抛错，避免生成器把用户代码改坏。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import {
  GEN_BLOCKS,
  GenMarkerError,
  beginMarker,
  emptyBlock,
  endMarker,
  hasBlock,
  readBlock,
  replaceBlock,
} from '../markers.js';

/** 构造一个含标记块的 app.module.ts 片段 */
const moduleSource = [
  "import { Module } from '@nestjs/common';",
  '// <fw:gen:imports>',
  '// </fw:gen:imports>',
  '',
  '@Module({',
  '  imports: [',
  '    // <fw:gen:modules>',
  '    // </fw:gen:modules>',
  '  ],',
  '})',
  'export class AppModule {}',
].join('\n');

describe('replaceBlock 整块重写', () => {
  it('把正文写入标记块内，块外内容保持不变', () => {
    const next = replaceBlock(moduleSource, 'imports', "import { ProductModule } from './product.js';");
    expect(next).toContain("import { ProductModule } from './product.js';");
    expect(next).toContain("import { Module } from '@nestjs/common';");
    expect(next).toContain('export class AppModule {}');
    // 标记仍在，且顺序正确
    expect(next.indexOf(beginMarker('imports'))).toBeLessThan(next.indexOf(endMarker('imports')));
  });

  it('幂等：同一正文重跑两次产出完全一致（不累积重复片段）', () => {
    const body = "import { ProductModule } from './product.js';";
    const once = replaceBlock(moduleSource, 'imports', body);
    const twice = replaceBlock(once, 'imports', body);
    expect(twice).toBe(once);
    expect(once.split('ProductModule').length - 1).toBe(1);
  });

  it('替换为新正文时旧正文被整块清掉（不是追加）', () => {
    const first = replaceBlock(moduleSource, 'imports', "import { A } from './a.js';");
    const second = replaceBlock(first, 'imports', "import { B } from './b.js';");
    expect(second).not.toContain("import { A } from './a.js';");
    expect(second).toContain("import { B } from './b.js';");
  });

  it('支持缩进（数组项场景），空行不加缩进', () => {
    const next = replaceBlock(moduleSource, 'modules', 'ProductModule,\n\nOrderModule,', { indent: '    ' });
    expect(next).toContain('    ProductModule,\n\n    OrderModule,');
  });

  it('空正文清空块内内容，且不留多余空行', () => {
    const filled = replaceBlock(moduleSource, 'modules', 'ProductModule,', { indent: '    ' });
    const cleared = replaceBlock(filled, 'modules', '');
    expect(cleared).toContain('    // <fw:gen:modules>\n    // </fw:gen:modules>');
  });

  it('CRLF 输入统一为 LF', () => {
    const crlf = moduleSource.replace(/\n/g, '\r\n');
    const next = replaceBlock(crlf, 'imports', "import { X } from './x.js';");
    expect(next).not.toContain('\r');
  });
});

describe('replaceBlock 结构异常必须报错', () => {
  it('缺少标记块时抛 GenMarkerError 并提示补标记', () => {
    const source = "import { Module } from '@nestjs/common';";
    expect(() => replaceBlock(source, 'imports', 'x')).toThrow(GenMarkerError);
    expect(() => replaceBlock(source, 'imports', 'x')).toThrow(/缺少生成器标记块/);
  });

  it('标记块重复时抛错（只保留一对）', () => {
    const duplicated = `${moduleSource}\n// <fw:gen:imports>\n// </fw:gen:imports>`;
    expect(() => replaceBlock(duplicated, 'imports', 'x')).toThrow(/重复出现/);
  });

  it('结束标记在起始标记之前时抛错', () => {
    const inverted = '// </fw:gen:imports>\n// <fw:gen:imports>';
    expect(() => replaceBlock(inverted, 'imports', 'x')).toThrow(/结束标记出现在起始标记之前/);
  });

  it('报错信息带上文件路径（便于定位）', () => {
    expect(() => replaceBlock('nothing', 'imports', 'x', { file: 'apps/x/src/app.module.ts' })).toThrow(
      /apps\/x\/src\/app\.module\.ts/,
    );
  });
});

describe('readBlock / hasBlock / emptyBlock', () => {
  it('readBlock 返回块内正文，不含标记行', () => {
    const filled = replaceBlock(moduleSource, 'modules', 'ProductModule,', { indent: '    ' });
    expect(readBlock(filled, 'modules', 'app.module.ts').trim()).toBe('ProductModule,');
  });

  it('hasBlock 只在成对存在时为真', () => {
    expect(hasBlock(moduleSource, 'imports')).toBe(true);
    expect(hasBlock(moduleSource, 'seed-calls')).toBe(false);
    expect(hasBlock('// <fw:gen:imports>', 'imports')).toBe(false);
  });

  it('emptyBlock 产出成对标记，可被 replaceBlock 直接接管', () => {
    const block = emptyBlock(GEN_BLOCKS.SEED_CALLS.id, '  ');
    expect(block).toBe('  // <fw:gen:seed-calls>\n  // </fw:gen:seed-calls>');
    const source = `async function main() {\n${block}\n}\n`;
    expect(replaceBlock(source, 'seed-calls', '  await seedProductPermissions();')).toContain(
      '  await seedProductPermissions();',
    );
  });
});
