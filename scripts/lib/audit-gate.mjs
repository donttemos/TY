/*
 * @file 审计事件覆盖分析（check-audit-events 与反向测试共用的纯函数）
 * @description 把「注册表条目 + 待扫描文件（路径 + 内容）」作为输入，输出缺口与提示——
 *   之所以从 CLI 里拆出来，是因为**门禁本身必须能被反向测试**：
 *   故意删掉某事件唯一的写入点后，分析结果必须报「无写入点」；否则那道门禁只是
 *   「注册表里写着有」而不是「代码里真的有」。
 *
 *   写入点判定口径（吸取的教训：注册表自身也定义了全部事件码，且曾在扫描范围内，
 *   于是删掉真实写入调用后门禁照样是绿的）：
 *   ① 定义文件（注册表）**整体排除**——它是「码表」，不是「有人真的记了这条审计」的证据；
 *   ② 直接调用 `recordEvent('x')` / `recordEventSync('x')` 计入写入点；
 *   ③ `event: 'x'` 属性位置计入写入点，但**仅服务端文件**（前端可能把 event 当查询参数，
 *      那不是写入）；
 *   ④ 间接引用只认**显式标注的映射表**（文件内含 `@audit-event-map` 标记，如
 *      `LIFECYCLE_EVENTS[action]`）。不接受「任意字面量出现即算」——那正是漏洞本身。
 *
 *   本文件不含 IO 与全局状态，可被 node --test 直接喂合成输入。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 donttemo M15 安全加固：写入点判定从「任意字面量」收紧到
 *   「定义文件排除 + 真实调用 + event: 属性 + 显式映射表」，并支持反向测试
 * @module scripts
 */

/** 事件码字面量形状：至少两段点分小写（与注册表命名规则一致） */
const CODE_SHAPE = '[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+';

/** @type {RegExp} 属性位置 `event: 'x.y'`（审计写入对象字段） */
export const EVENT_PROPERTY_PATTERN = new RegExp(`(?:^|[^a-zA-Z0-9_])event:\\s*['"](${CODE_SHAPE})['"]`, 'g');

/** @type {RegExp} 直接写入调用 `recordEvent('x.y')` / `recordEventSync('x.y')` */
export const WRITE_CALL_PATTERN = new RegExp(`recordEvent(?:Sync)?\\(\\s*['"](${CODE_SHAPE})['"]`, 'g');

/** @type {RegExp} 任意事件码形态的字符串字面量（**仅**用于显式标注的事件映射表） */
export const ANY_LITERAL_PATTERN = new RegExp(`['"](${CODE_SHAPE})['"]`, 'g');

/**
 * @type {RegExp} 动态事件码调用（无法静态校验，仅提示）
 *
 * 只认「成员调用」（`.recordEvent(`），避免把方法定义 `recordEvent(code: string)` 误报成动态调用。
 */
export const DYNAMIC_CALL_PATTERN = /\.\s*recordEvent(?:Sync)?\(\s*(?!['"])/g;

/**
 * 事件映射表的显式标记：文件里出现该字符串，其事件码字面量才计入写入点
 *
 * 之所以要人写标记：`LIFECYCLE_EVENTS` 这类「动作 → 事件码」映射表是合法写入路径，
 * 但它与「注释里提一句事件码」「文档字符串」在文本上无法自动区分。让映射表自己声明，
 * 比让门禁猜要可靠得多。
 */
export const EVENT_MAP_MARKER = '@audit-event-map';

/**
 * 取字符串在文件中的行号（1 基）
 * @param {string} content 文件内容
 * @param {number} index 字符下标
 * @returns {number} 行号
 */
export function lineOf(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (content[cursor] === '\n') line += 1;
  return line;
}

/**
 * 全量匹配（每次新建正则，避免 lastIndex 状态泄漏到下一个文件）
 * @param {string} content 文件内容
 * @param {RegExp} pattern 全局正则
 * @returns {RegExpExecArray[]} 匹配结果
 */
function matchAll(content, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out = [];
  let match;
  while ((match = re.exec(content)) !== null) out.push(match);
  return out;
}

/**
 * 分析审计事件覆盖
 * @param {object} input 输入
 * @param {Array<{code: string, deprecated?: unknown}>} input.registry 注册表条目
 * @param {Array<{path: string, content: string, countsEventProperty?: boolean}>} input.files 待扫描文件
 *   （`countsEventProperty: false` 表示前端文件：`event:` 只当查询参数，不算写入点）
 * @param {string[]} [input.definitionPaths] 定义文件（注册表）相对路径，整体排除
 * @returns {{
 *   findings: string[],
 *   warnings: string[],
 *   writePoints: Map<string, string[]>,
 *   declaredCount: number,
 *   missing: string[],
 * }} 分析结果
 */
export function analyzeAuditCoverage({ registry, files, definitionPaths = [] }) {
  const registered = new Set(registry.map((item) => item.code));
  const active = registry.filter((item) => !item.deprecated);
  const definitionSet = new Set(definitionPaths);
  /** @type {string[]} */
  const findings = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, string[]>} */
  const writePoints = new Map();
  const declared = [];

  /** 记录一个写入点 */
  const addWritePoint = (code, where) => {
    const list = writePoints.get(code) ?? [];
    list.push(where);
    writePoints.set(code, list);
  };
  const where = (file, content, index) => `${file.path}:${lineOf(content, index)}`;

  for (const file of files) {
    // ① 注册表定义文件整体跳过：它定义全部事件码，绝不能成为「写入点」的证据
    if (definitionSet.has(file.path)) continue;

    const { content } = file;

    // ② 直接写入调用：唯一无条件可信的写入证据
    for (const match of matchAll(content, WRITE_CALL_PATTERN)) {
      const code = match[1];
      if (registered.has(code)) addWritePoint(code, where(file, content, match.index));
      else findings.push(`未登记事件码：${code}（${where(file, content, match.index)}）`);
    }

    // ③ event: 属性位置：服务端文件计入写入点；任何文件出现未登记码都是缺口
    const allowEventProperty = file.countsEventProperty !== false;
    for (const match of matchAll(content, EVENT_PROPERTY_PATTERN)) {
      const code = match[1];
      if (!registered.has(code)) {
        findings.push(`未登记事件码：${code}（${where(file, content, match.index)}）`);
      } else if (allowEventProperty) {
        addWritePoint(code, where(file, content, match.index));
      }
      declared.push(code);
    }

    // ④ 显式标注的事件映射表：整表字面量计入写入点（未登记码同样是缺口）
    if (content.includes(EVENT_MAP_MARKER)) {
      for (const match of matchAll(content, ANY_LITERAL_PATTERN)) {
        const code = match[1];
        if (registered.has(code)) addWritePoint(code, where(file, content, match.index));
        else findings.push(`映射表出现未登记事件码：${code}（${where(file, content, match.index)}）`);
      }
    }

    // ⑤ 动态事件码调用：静态无法校验，只提示
    const dynamicCount = (content.match(DYNAMIC_CALL_PATTERN) ?? []).length;
    if (dynamicCount > 0) {
      warnings.push(`动态事件码调用 ${dynamicCount} 处（无法静态校验）：${file.path}`);
    }
  }

  // ⑥ 每个未废弃条目都必须有真实写入点
  const missing = [];
  for (const item of active) {
    if (!writePoints.has(item.code)) {
      missing.push(item.code);
      findings.push(`注册表条目无写入点：${item.code}（生产代码中找不到真实写入调用或显式映射表条目）`);
    }
  }

  return {
    findings: [...new Set(findings)],
    warnings,
    writePoints,
    declaredCount: declared.length,
    missing,
  };
}
