/*
 * @file 设计令牌层护栏测试（M10/E-15 暗色模式）
 * @description 令牌层是"视觉契约"的落点，本测试把 docs/25-ui-prototype.md §2.1 的两列取值与派生口径写成断言，
 *   防止暗色变体被删改后无人察觉：
 *   ① 浅色 / 暗色两块逐项匹配原型 §2.1（主/成功/警告/危险/信息 + 文本三级 + 背景/卡片/边框）；
 *   ② 每套主题下六语义色（含 error 别名）的派生档齐全，且逐项等于混色公式的预计算值
 *      （浅色向白混色、暗色向黑混色、dark-2 反向）——本仓刻意不用 color-mix()，见文件内说明；
 *   ③ 每套主题的 -rgb 三元组与基色一致；暗色块声明的每个 --fw-* 令牌在浅色块同样声明；
 *   ④ .vue 组件零颜色字面量（换皮肤只改令牌文件，含正向例外登记位）；
 *   ⑤ index.css 里 Element Plus 暗色变量必须先于本仓令牌文件（同特异性下后写者胜）。
 * @author donttemo
 * @created 2026-10-16
 * @module admin-web/styles
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 定位包内文件：vitest 的 import.meta.url 在本仓宿主环境下不是 file: URL（fileURLToPath 直接抛错），
 * 故按 cwd 解析（包内跑 = 包根，仓库根跑 = 仓库根），两处都试后给出可诊断的报错。
 */
function pkgFile(relative: string): string {
  const candidates = [`${process.cwd()}/${relative}`, `${process.cwd()}/apps/admin-web/${relative}`];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`未找到文件 ${relative}（cwd=${process.cwd()}）`);
  return found;
}

const variablesCss = readFileSync(pkgFile('src/styles/variables.css'), 'utf8');
const indexCss = readFileSync(pkgFile('src/styles/index.css'), 'utf8');
const srcDir = pkgFile('src');

/** 原型 §2.1 浅色列（docs/25-ui-prototype.md） */
const PROTOTYPE_LIGHT: Record<string, string> = {
  '--fw-text-1': '#1f2329',
  '--fw-text-2': '#4e5969',
  '--fw-text-3': '#86909c',
  '--fw-bg': '#f5f7fa',
  '--fw-surface': '#ffffff',
  '--fw-border': '#e5e6eb',
  '--el-color-primary': '#2f6bff',
  '--el-color-success': '#18a058',
  '--el-color-warning': '#f0a020',
  '--el-color-danger': '#d93026',
  '--el-color-info': '#4098fc',
};

/** 原型 §2.1 暗色列（docs/25-ui-prototype.md） */
const PROTOTYPE_DARK: Record<string, string> = {
  '--fw-text-1': '#e5e6eb',
  '--fw-text-2': '#a9aeb8',
  '--fw-text-3': '#7a7f8a',
  '--fw-bg': '#17171a',
  '--fw-surface': '#232324',
  '--fw-border': '#2e2e30',
  '--el-color-primary': '#5b8cff',
  '--el-color-success': '#36ad6a',
  '--el-color-warning': '#f2c037',
  '--el-color-danger': '#e0574d',
  '--el-color-info': '#5aa8ff',
};

/** 语义色族（--el-color-error 与 danger 同值，Element Plus 双别名） */
const SEMANTIC_FAMILIES = ['primary', 'success', 'warning', 'danger', 'error', 'info'] as const;

/** 派生档与目标色占比（与 store/app.ts 的 applyPrimaryColor 同口径） */
const TINTS: ReadonlyArray<[string, number]> = [
  ['light-3', 0.3],
  ['light-5', 0.5],
  ['light-7', 0.7],
  ['light-8', 0.8],
  ['light-9', 0.9],
  ['dark-2', 0.2],
];

/** 取指定选择器的声明块（选择器需顶格书写；块内为平铺声明，无嵌套规则） */
function extractBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match?.[1]) throw new Error(`未在 variables.css 中找到样式块：${selector}`);
  return match[1];
}

/** 声明块 → 令牌映射 */
function parseDeclarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result[match[1] as string] = (match[2] as string).trim();
  }
  return result;
}

const lightTokens = parseDeclarations(extractBlock(variablesCss, ':root'));
const darkTokens = parseDeclarations(extractBlock(variablesCss, 'html.dark'));

/** 双主题对照表：浅色块 / 暗色块 + 各自的派生档混色目标 */
const THEMES: ReadonlyArray<[string, Record<string, string>, string, string]> = [
  ['浅色', lightTokens, '#ffffff', '#000000'],
  ['暗色', darkTokens, '#000000', '#ffffff'],
];

/** #rrggbb → 通道数组 */
function channels(hex: string): number[] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
}

/** 混色公式（独立重实现，用于校验令牌文件的预计算值；口径 = 逐通道四舍五入） */
function mix(color: string, target: string, weight: number): string {
  const from = channels(color);
  const to = channels(target);
  return `#${from.map((value, index) => Math.round(value + ((to[index] as number) - value) * weight).toString(16).padStart(2, '0')).join('')}`;
}

/** #rrggbb → 'r, g, b' */
function rgbTriplet(hex: string): string {
  return channels(hex).join(', ');
}

/** 去掉注释后的源码（注释里的示例色值不算硬编码） */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** 递归收集组件源码（.vue，测试目录除外） */
function collectVueFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectVueFiles(path));
    } else if (entry.name.endsWith('.vue')) {
      files.push(path);
    }
  }
  return files;
}

describe('设计令牌层（E-15 暗色变体）', () => {
  it('浅色块逐项匹配原型 §2.1 浅色列', () => {
    for (const [token, value] of Object.entries(PROTOTYPE_LIGHT)) {
      expect(lightTokens[token]?.toLowerCase(), token).toBe(value);
    }
  });

  it('暗色块逐项匹配原型 §2.1 暗色列（缺失或改值即失败）', () => {
    for (const [token, value] of Object.entries(PROTOTYPE_DARK)) {
      expect(darkTokens[token]?.toLowerCase(), token).toBe(value);
    }
  });

  it('六语义色的派生档齐全，且逐项等于混色公式的预计算值（浅向白 / 暗向黑，dark-2 反向）', () => {
    for (const [label, tokens, lightTarget, darkTarget] of THEMES) {
      for (const family of SEMANTIC_FAMILIES) {
        const base = tokens[`--el-color-${family}`]?.toLowerCase();
        expect(base, `${label} ${family} 基色`).toBeTruthy();
        for (const [tint, weight] of TINTS) {
          const target = tint === 'dark-2' ? darkTarget : lightTarget;
          expect(tokens[`--el-color-${family}-${tint}`], `${label} --el-color-${family}-${tint}`).toBe(mix(base as string, target, weight));
        }
      }
    }
  });

  it('两套主题下 -rgb 三元组与基色一致（EP 有规则以 rgba(var(--x-rgb), α) 取色）', () => {
    for (const [label, tokens] of THEMES) {
      for (const family of SEMANTIC_FAMILIES) {
        expect(tokens[`--el-color-${family}-rgb`], `${label} ${family}`).toBe(rgbTriplet(tokens[`--el-color-${family}`] as string));
      }
    }
  });

  it('派生档不使用 color-mix()（构建期 CSS 管线会静默丢弃，导致产线回落组件库默认色）', () => {
    // 只看声明体：文件头注释里对该陷阱的说明文字不算
    expect(stripComments(variablesCss)).not.toMatch(/color-mix\(/);
  });

  it('暗色块声明的每个 --fw-* 令牌在浅色块同样声明（无暗色独有令牌）', () => {
    const darkOnly = Object.keys(darkTokens).filter((token) => token.startsWith('--fw-') && !(token in lightTokens));
    expect(darkOnly).toEqual([]);
  });

  it('.vue 组件零颜色字面量（颜色只能来自设计令牌）', () => {
    const pattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;
    // 正向例外登记位：确需在组件内联色的场景（如画布绘制）在此登记并写明理由
    const allowed: string[] = [];
    const offenders: string[] = [];
    for (const file of collectVueFiles(srcDir)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        const record = `${file.replace(srcDir, 'src').replace(/\\/g, '/')}:${line} ${match[0]}`;
        if (!allowed.some((entry) => record.includes(entry))) offenders.push(record);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('index.css 中 Element Plus 暗色变量先于本仓令牌文件（覆盖顺序不可颠倒）', () => {
    const darkVars = indexCss.indexOf('element-plus/theme-chalk/dark/css-vars.css');
    const ownTokens = indexCss.indexOf("'./variables.css'");
    expect(darkVars).toBeGreaterThan(-1);
    expect(ownTokens).toBeGreaterThan(-1);
    expect(darkVars).toBeLessThan(ownTokens);
  });

  it('暗色结构性令牌映射落到 --fw-* 语义令牌（避免两套调色板并存）', () => {
    const structural = ['--el-bg-color-page', '--el-bg-color', '--el-bg-color-overlay', '--el-fill-color-blank', '--el-text-color-primary'];
    for (const token of structural) {
      expect(darkTokens[token], `暗色 ${token}`).toMatch(/^var\(--fw-/);
      expect(lightTokens[token], `浅色 ${token}`).toMatch(/^var\(--fw-/);
    }
  });
});
