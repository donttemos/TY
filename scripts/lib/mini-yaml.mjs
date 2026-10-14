/**
 * @file 极简 YAML 解析器（T-M8-07 校验脚本内嵌，零外部依赖）
 * @description 仅覆盖本仓 Helm Chart / compose 所需的 YAML 子集：
 *   块映射、块序列（含 "key: [a, b]" 行内序列与 "- key: val" 对象元素）、标量（引号 / 布尔 / 数字 / null）、
 *   多行字符串（| 与 >）、注释与空行、文档分隔（--- / ...）。
 *   不支持锚点 / 别名 / 复杂标签 / 流式映射嵌套 —— 本仓文件未使用，遇未知语法抛错而非静默容错。
 * @author donttemo
 * @created 2026-10-14
 * @module scripts
 */

/** 解析 YAML 文本为 JS 值（返回 docs 数组，多文档） */
export function parseAll(text) {
  const lines = prepare(text);
  const anchors = { __map: {} };
  const docs = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '' || lines[i].trim() === '---') {
      i++;
      continue;
    }
    if (lines[i].trim() === '...') {
      i++;
      continue;
    }
    const { value, next } = parseNode(lines, i, 0, anchors);
    docs.push(value);
    i = next;
    // 跳到下一个文档分隔
    while (i < lines.length && lines[i].trim() !== '---') {
      if (lines[i].trim() !== '' && lines[i].trim() !== '...') {
        throw new Error(`[YAML] 第 ${i + 1} 行出现游离内容：${lines[i]}`);
      }
      i++;
    }
  }
  return docs;
}

/** 解析单文档 */
export function parse(text) {
  const docs = parseAll(text);
  return docs.length ? docs[0] : null;
}

/** 预处理：去注释、保留原始缩进、保留多行块 */
function prepare(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    // 整行注释
    if (/^\s*#/.test(line)) {
      out.push('');
      continue;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/** 取某行缩进宽度 */
const indentOf = (line) => line.match(/^ */)[0].length;

/** 跳过空行 */
function skipBlank(lines, i) {
  while (i < lines.length && lines[i].trim() === '') i++;
  return i;
}

/**
 * 解析一个节点
 * @param lines 行数组
 * @param i 起始行
 * @param indent 当前节点应有缩进
 */
function parseNode(lines, i, indent, anchors) {
  i = skipBlank(lines, i);
  if (i >= lines.length) return { value: null, next: i };
  const line = lines[i];
  const curIndent = indentOf(line);
  if (curIndent < indent) return { value: null, next: i };

  if (/^\s*-\s/.test(line) || line.trim() === '-') {
    return parseSequence(lines, i, curIndent, anchors);
  }
  return parseMapping(lines, i, curIndent, anchors);
}

/** 块序列 */
function parseSequence(lines, i, indent, anchors) {
  const arr = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const cur = indentOf(line);
    if (cur < indent) break;
    if (cur > indent) throw new Error(`[YAML] 第 ${i + 1} 行序列缩进异常：${line}`);
    if (!/^-(\s|$)/.test(line.trim()) && cur === indent) break;

    const rest = line.trim().slice(1).replace(/^\s+/, '');
    if (rest === '') {
      // "- " 后换行：子节点在更深缩进
      const r = parseNode(lines, i + 1, indent + 1, anchors);
      arr.push(r.value);
      i = r.next;
      continue;
    }
    // "- key: val" 形式：把该项当作映射，首行需虚拟提升缩进
    if (/^[^\s:]+:(\s|$)/.test(rest) || /^"[^"]*":(\s|$)/.test(rest) || /^'[^']*':(\s|$)/.test(rest)) {
      const virtualLines = lines.slice();
      virtualLines[i] = ' '.repeat(indent + 2) + rest;
      const r = parseMapping(virtualLines, i, indent + 2, anchors);
      arr.push(r.value);
      i = r.next;
      continue;
    }
    // 标量 / 锚点 / 别名元素
    arr.push(parseValueToken(rest, anchors));
    i++;
  }
  return { value: arr, next: i };
}

/** 块映射 */
function parseMapping(lines, i, indent, anchors) {
  const obj = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.trim() === '---' || line.trim() === '...') break;
    const cur = indentOf(line);
    if (cur < indent) break;
    if (cur > indent) throw new Error(`[YAML] 第 ${i + 1} 行映射缩进异常：${line}`);
    if (/^-(\s|$)/.test(line.trim())) break;

    const { key, valueRaw } = splitKeyValue(line.trim(), i + 1);

    // 合并键 <<: *anchor（或 [*a, *b]）
    if (key === '<<') {
      for (const ref of valueRaw.startsWith('[') ? splitFlow(valueRaw.slice(1, -1)) : [valueRaw]) {
        const m = /^\*([\w-]+)$/.exec(ref.trim());
        if (!m) throw new Error(`[YAML] 第 ${i + 1} 行 << 只支持别名引用`);
        Object.assign(obj, anchors[m[1]] ?? {});
      }
      i++;
      continue;
    }

    // 纯锚点定义：&name（值在后续嵌套块 / 同缩进序列）
    const anchorOnly = /^&([\w-]+)$/.exec(valueRaw);
    if (anchorOnly) {
      const nextI = skipBlank(lines, i + 1);
      if (nextI < lines.length && indentOf(lines[nextI]) > indent) {
        const r = parseNode(lines, nextI, indent + 1, anchors);
        obj[key] = r.value;
        anchors[anchorOnly[1]] = r.value;
        i = r.next;
      } else if (nextI < lines.length && indentOf(lines[nextI]) === indent && /^-(\s|$)/.test(lines[nextI].trim())) {
        const r = parseSequence(lines, nextI, indent, anchors);
        obj[key] = r.value;
        anchors[anchorOnly[1]] = r.value;
        i = r.next;
      } else {
        obj[key] = null;
        anchors[anchorOnly[1]] = null;
        i = nextI;
      }
      continue;
    }

    if (valueRaw === '') {
      // 可能是嵌套块，或空值
      const nextI = skipBlank(lines, i + 1);
      if (nextI < lines.length && indentOf(lines[nextI]) > indent) {
        const r = parseNode(lines, nextI, indent + 1, anchors);
        obj[key] = r.value;
        i = r.next;
      } else if (
        nextI < lines.length &&
        indentOf(lines[nextI]) === indent &&
        /^-(\s|$)/.test(lines[nextI].trim())
      ) {
        // 同缩进的序列属于该键
        const r = parseSequence(lines, nextI, indent, anchors);
        obj[key] = r.value;
        i = r.next;
      } else {
        obj[key] = null;
        i = nextI;
      }
      continue;
    }
    // 多行块标量
    if (valueRaw === '|' || valueRaw === '>' || /^[|>][-+]?$/.test(valueRaw)) {
      const { value, next } = parseBlockScalar(lines, i + 1, indent, valueRaw);
      obj[key] = value;
      i = next;
      continue;
    }
    obj[key] = parseValueToken(valueRaw, anchors);
    i++;
  }
  return { value: obj, next: i };
}

/** 标量 / 锚点 / 别名 值处理 */
function parseValueToken(raw, anchors) {
  const v = raw.trim();
  // 别名 *name
  const alias = /^\*([\w-]+)$/.exec(v);
  if (alias) {
    if (!(alias[1] in anchors)) throw new Error(`[YAML] 未定义别名 *${alias[1]}（可能在本文件之外定义）`);
    return anchors[alias[1]];
  }
  // 锚点 + 行内值：&name value
  const anchored = /^&(\w+)\s+([\s\S]+)$/.exec(v);
  if (anchored) {
    const val = parseScalar(anchored[2]);
    anchors[anchored[1]] = val;
    return val;
  }
  return parseScalar(v);
}

/** 拆分 "key: value"，处理引号键与值内冒号 */
function splitKeyValue(text, lineNo) {
  let key = '';
  let i = 0;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    i = 1;
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') i++;
      key += text[i];
      i++;
    }
    i++; // 跳过闭合引号
  } else {
    while (i < text.length && text[i] !== ':') {
      key += text[i];
      i++;
    }
  }
  if (text[i] !== ':') throw new Error(`[YAML] 第 ${lineNo} 行缺少键值分隔冒号：${text}`);
  let rest = text.slice(i + 1);
  // 冒号后必须跟空白或结束
  if (rest !== '' && !/^\s/.test(rest)) {
    // 形如 a:b（非键）——本仓不出现
    throw new Error(`[YAML] 第 ${lineNo} 行非法键值：${text}`);
  }
  rest = rest.replace(/^\s+/, '');
  return { key: key.trim(), valueRaw: stripComment(rest) };
}

/** 去行尾注释（引号外的 # 且前置空白） */
function stripComment(v) {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  let inStr = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trim();
  }
  return v.trim();
}

/** 标量解析 */
function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  // 行内序列 [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((s) => parseScalar(s));
  }
  // 行内映射 {a: b}
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitFlow(inner)) {
      const { key, valueRaw } = splitKeyValue(pair.trim(), 0);
      obj[key] = parseScalar(valueRaw);
    }
    return obj;
  }
  return v;
}

/** 逗号切分（忽略引号与括号内） */
function splitFlow(src) {
  const out = [];
  let cur = '';
  let inStr = null;
  let depth = 0;
  for (const ch of src) {
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 多行块标量（| 保留换行 / > 折行） */
function parseBlockScalar(lines, i, parentIndent, marker) {
  const chunk = [];
  let blockIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      chunk.push('');
      i++;
      continue;
    }
    const cur = indentOf(line);
    if (cur <= parentIndent) break;
    if (blockIndent === null) blockIndent = cur;
    chunk.push(line.slice(blockIndent));
    i++;
  }
  // 去掉尾部空行
  while (chunk.length && chunk[chunk.length - 1] === '') chunk.pop();
  const fold = marker.startsWith('>');
  const keep = marker.endsWith('+');
  const strip = marker.endsWith('-');
  let value = fold ? chunk.join(' ').replace(/  +/g, ' ') : chunk.join('\n');
  if (!strip && !keep) value += '\n';
  return { value, next: i };
}
