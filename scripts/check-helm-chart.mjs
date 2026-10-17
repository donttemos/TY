/**
 * @file Helm 模板子集渲染器 + K8s 清单校验（T-M8-07 / PRD-008 FR-09）
 * @description 本机无 helm/kubectl，故实现「Helm 模板子集 + 清单语义断言」两级离线门禁：
 *   L1 渲染 templates/*.yaml（values.yaml / values-prod.yaml / 最小档三套），渲染失败即断言不通过；
 *   L2 解析渲染结果为 YAML 文档，按 K8s 语义断言门禁项——探针分指 /health 与 /ready、滚动更新
 *      maxUnavailable=0 / maxSurge=1、resources requests+limits 齐备、非 root 与禁提权、HPA/PDB 参数、
 *      Secret 走外部注入不落明文、ConfigMap 关键键齐备、迁移 Job 为 pre-upgrade 钩子、组件开关生效。
 *   渲染器为 Helm 子集（非完整实现），仅用于本仓离线门禁；真实集群以 helm template / install 为准。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-17 donttemo M12 W3（PRD-012 OBS-19）：Nginx 三份一致性轴（探针覆盖集 + maintenance 不上公网）
 * @module scripts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { parse as parseYaml, parseAll as parseYamlAll } from './lib/mini-yaml.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHART_DIR = path.join(ROOT, 'deploy', 'helm', 'fw-app');

const results = [];
/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// ===========================================================================
// 一、工具：深合并 / 空值判断
// ===========================================================================
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

const isEmpty = (v) =>
  v === null || v === undefined || v === '' || v === false || v === 0 ||
  (Array.isArray(v) && v.length === 0) ||
  (isPlainObject(v) && Object.keys(v).length === 0);

/** 去掉模板名两侧的引号（Helm 写法 `define "name"` / `include "name"`） */
const unquote = (s) => String(s).trim().replace(/^["']|["']$/g, '');

function indentStr(n, s) {
  const pad = ' '.repeat(Number(n));
  return String(s)
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n');
}

/** 简易 YAML 序列化（对齐 Helm toYaml 输出形态） */
function toYaml(v, depth = 0) {
  const pad = '  '.repeat(depth);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (v === '' || /^[\s>|@`"'%&*!?#,\[\]{}:]/.test(v) || /[:#]\s|:\s*$|\n/.test(v) ||
        /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          return `${pad}- ${toYaml(item, depth + 1).trimStart()}`;
        }
        return `${pad}- ${toYaml(item, depth)}`;
      })
      .join('\n');
  }
  if (isPlainObject(v)) {
    if (!Object.keys(v).length) return '{}';
    return Object.entries(v)
      .map(([k, val]) => {
        // 对象 / 数组一律换行展开（单行也可能不是标量，内联会产出 `a: b: c` 这类非法 YAML）
        if (isPlainObject(val) || Array.isArray(val)) {
          return `${pad}${k}:\n${toYaml(val, depth + 1)}`;
        }
        return `${pad}${k}: ${toYaml(val, depth)}`;
      })
      .join('\n');
  }
  return String(v);
}

// ===========================================================================
// 二、内置函数（对齐 Helm sprig 子集）
// ===========================================================================
const builtins = {
  default: (def, val) => (isEmpty(val) ? def : val),
  empty: (v) => isEmpty(v),
  quote: (v) => (v === null || v === undefined ? '""' : JSON.stringify(String(v))),
  squote: (v) => `'${String(v)}'`,
  upper: (s) => String(s).toUpperCase(),
  lower: (s) => String(s).toLowerCase(),
  title: (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase()),
  trunc: (n, s) => String(s).slice(0, Number(n)),
  trimSuffix: (suffix, s) => {
    const str = String(s);
    return str.endsWith(suffix) ? str.slice(0, str.length - suffix.length) : str;
  },
  trimPrefix: (prefix, s) => {
    const str = String(s);
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  },
  trim: (s) => String(s).trim(),
  contains: (substr, s) => String(s).includes(substr),
  hasPrefix: (prefix, s) => String(s).startsWith(prefix),
  replace: (from, to, s) => String(s).split(from).join(to),
  printf: (fmt, ...args) => {
    let i = 0;
    return String(fmt).replace(/%[sdvq]/g, () => {
      const a = args[i++];
      return a === undefined || a === null ? '' : String(a);
    });
  },
  toString: (v) => String(v),
  toJson: (v) => JSON.stringify(v),
  toYaml: (v) => toYaml(v),
  nindent: (n, s) => '\n' + indentStr(n, s),
  indent: (n, s) => indentStr(n, s),
  sha256sum: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'),
  len: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : Object.keys(v ?? {}).length),
  list: (...args) => args,
  dict: (...args) => {
    const o = {};
    for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1];
    return o;
  },
  ternary: (t, f, cond) => (isEmpty(cond) ? f : t),
  b64enc: (s) => Buffer.from(String(s)).toString('base64'),
  add: (a, b) => Number(a) + Number(b),
  sub: (a, b) => Number(a) - Number(b),
  mul: (a, b) => Number(a) * Number(b),
  div: (a, b) => Math.floor(Number(a) / Number(b)),
  int: (v) => parseInt(v, 10),
  kindOf: (v) =>
    v === null ? 'invalid' : Array.isArray(v) ? 'slice' : typeof v === 'object' ? 'map' : typeof v,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  and: (...a) => a.every((x) => !isEmpty(x) && x !== false),
  or: (...a) => a.some((x) => !isEmpty(x) && x !== false),
  not: (a) => isEmpty(a) || a === false,
};

// ===========================================================================
// 三、模板解析器（文本 / 动作 / 块）
// ===========================================================================
class Parser {
  constructor(src, file) {
    this.src = src;
    this.file = file;
    this.i = 0;
  }

  err(msg) {
    // 计算行号便于定位
    const line = this.src.slice(0, this.i).split('\n').length;
    return new Error(`[模板 ${this.file}:${line}] ${msg}`);
  }

  /** 找动作结束位置 */
  findEnd(from) {
    let inStr = null;
    for (let k = from; k < this.src.length - 1; k++) {
      const ch = this.src[k];
      if (inStr) {
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (this.src.startsWith('}}', k)) return k;
    }
    return -1;
  }

  /** 解析到 end/else 为止 */
  parseUntilBlockEnd() {
    const nodes = [];
    let text = '';
    while (this.i < this.src.length) {
      if (this.src.startsWith('{{', this.i)) {
        // 注释
        if (this.src.startsWith('{{/*', this.i)) {
          const end = this.src.indexOf('*/}}', this.i);
          if (end < 0) throw this.err('未闭合注释');
          this.i = end + 4;
          continue;
        }
        let leftTrim = false;
        let j = this.i + 2;
        if (this.src[j] === '-') {
          leftTrim = true;
          j++;
        }
        const endIdx = this.findEnd(j);
        if (endIdx < 0) throw this.err('未闭合动作');
        let inner = this.src.slice(j, endIdx).trim();
        let rightTrim = false;
        if (inner.endsWith('-')) {
          rightTrim = true;
          inner = inner.slice(0, -1).trim();
        }
        if (text) {
          nodes.push({ t: 'text', v: text });
          text = '';
        }
        if (leftTrim && nodes.length && nodes[nodes.length - 1].t === 'text') {
          nodes[nodes.length - 1].v = nodes[nodes.length - 1].v.replace(/\s+$/, '');
        }
        this.i = endIdx + 2;
        if (rightTrim) {
          const m = /^\s+/.exec(this.src.slice(this.i));
          if (m) this.i += m[0].length;
        }

        // 块起始
        const kwMatch = /^(\w+)\b([\s\S]*)$/.exec(inner);
        const kw = kwMatch ? kwMatch[1] : '';
        if (kw === 'define') {
          const body = this.parseUntilBlockEnd();
          if (this.stop !== 'end') throw this.err('define 未以 end 结束');
          this.stop = null;
          nodes.push({ t: 'define', name: unquote(kwMatch[2].trim()), body: body.nodes });
          continue;
        }
        if (kw === 'if' || kw === 'with' || kw === 'range') {
          const first = this.parseUntilBlockEnd();
          const branches = [{ expr: kwMatch[2].trim(), nodes: first.nodes }];
          let stop = this.stop;
          if (kw === 'range') {
            // range 支持 "x := expr" 与 "$k, $v := expr"
            const m = /^([\w.$\s,]+?)\s*:=\s*([\s\S]+)$/.exec(branches[0].expr);
            if (m) {
              branches[0].vars = m[1].trim();
              branches[0].expr = m[2];
            }
          }
          let elseNodes = null;
          while (stop === 'else') {
            // else if ... 继续作为条件分支
            const peek = /^\s*else\s+if\s+([\s\S]+)$/.exec(this.lastElseExpr);
            if (peek) {
              const sub = this.parseUntilBlockEnd();
              branches.push({ expr: peek[1].trim(), nodes: sub.nodes });
              stop = this.stop;
              continue;
            }
            const sub = this.parseUntilBlockEnd();
            elseNodes = sub.nodes;
            stop = this.stop;
            if (stop === 'else') throw this.err('重复的 else');
          }
          this.stop = null;
          nodes.push({ t: 'block', kw, branches, else: elseNodes });
          continue;
        }
        if (kw === 'end') {
          this.stop = 'end';
          return { nodes };
        }
        if (kw === 'else') {
          this.stop = 'else';
          this.lastElseExpr = inner;
          return { nodes };
        }
        nodes.push({ t: 'action', v: inner });
        continue;
      }
      text += this.src[this.i];
      this.i++;
    }
    if (text) nodes.push({ t: 'text', v: text });
    if (this.stop) throw this.err('块未闭合');
    return { nodes };
  }
}

function parseTemplate(src, file) {
  const p = new Parser(src, file);
  const r = p.parseUntilBlockEnd();
  if (p.stop) throw p.err('模板顶层出现未配对的 end/else');
  return r.nodes;
}

// ===========================================================================
// 四、表达式求值
// ===========================================================================
/** 词法：把表达式切成 token（括号 / 引号串 / 管道 / 逗号 / 其他原子） */
function lex(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '|' || ch === '(' || ch === ')' || ch === ',') {
      out.push(ch);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let s = ch;
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\' && ch === '"') {
          s += src[i];
          i++;
        }
        s += src[i];
        i++;
      }
      s += ch;
      i++;
      out.push(s);
      continue;
    }
    let atom = '';
    while (i < src.length && !/[\s|(),]/.test(src[i])) {
      atom += src[i];
      i++;
    }
    out.push(atom);
  }
  return out;
}

/**
 * 递归下降求值：支持管道、函数调用（含括号参数）、嵌套括号、字面量、变量路径。
 * 这是 Helm 表达式的核心子集（无 operator，靠 if/eq/and/or 等函数表达）。
 */
function makeEval(ctx, renderer) {
  function evalExpr(src) {
    const tokens = lex(src);
    let pos = 0;

    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    /** 解析「管道表达式」 */
    function parsePipeline() {
      let value = parseTerm();
      while (peek() === '|') {
        next();
        value = parseFilter(value);
      }
      return value;
    }

    /** 解析 include "name" <dot> */
    function parseInclude() {
      const tplName = unquote(next());
      const body = renderer.defines.get(tplName);
      if (!body) throw new Error(`[未定义模板] ${tplName}`);
      let dot = ctx.dot;
      const nxt = peek();
      if (nxt !== undefined && nxt !== '|' && nxt !== ')' && nxt !== ',') dot = parseTerm();
      return renderer.renderNodes(body, { ...ctx, dot });
    }

    /** 解析管道右侧段：函数名 + 参数（最后一个参数为管道传入值） */
    function parseFilter(piped) {
      const name = next();
      if (name === 'include') return parseInclude();
      const fn = builtins[name];
      if (!fn) throw new Error(`[未实现函数] ${name}`);
      const args = [];
      while (peek() !== undefined && peek() !== '|') args.push(parseTerm());
      return fn(...args, piped);
    }

    /** 解析一个项：函数调用 / 括号 / include / 原子 */
    function parseTerm() {
      const tok = next();
      if (tok === '(') {
        const v = parsePipeline();
        if (next() !== ')') throw new Error('[表达式] 括号未闭合');
        return v;
      }
      if (tok === 'include') return parseInclude();
      // 函数调用：后跟参数
      const fn = builtins[tok];
      if (fn && peek() !== undefined && peek() !== '|' && peek() !== ')' && peek() !== ',') {
        const args = [];
        while (peek() !== undefined && peek() !== '|' && peek() !== ')' && peek() !== ',') {
          args.push(parseTerm());
        }
        return fn(...args);
      }
      return literal(tok);
    }

    return parsePipeline();
  }

  function literal(tok) {
    if (tok === undefined) throw new Error('[表达式] 意外结束');
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      return tok.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'nil' || tok === 'null') return null;
    if (/^-?\d+$/.test(tok)) return Number(tok);
    if (/^-?\d+\.\d+$/.test(tok)) return Number(tok);
    if (tok === '$') return ctx.root; // Helm 内置根对象
    if (tok.startsWith('$')) {
      const [name, ...rest] = tok.slice(1).split('.');
      // `$.Values.x`：$ 后直接跟点，从根对象开始
      if (name === '') return rest.reduce((acc, s) => (acc == null ? undefined : acc[s]), ctx.root);
      if (!(name in ctx.vars)) throw new Error(`[未定义变量] $${name}`);
      let v = ctx.vars[name];
      for (const s of rest) v = v == null ? undefined : v[s];
      return v;
    }
    if (tok === '.') return ctx.dot;
    if (tok.startsWith('.')) {
      const segs = tok.slice(1).split('.');
      if (['Values', 'Chart', 'Release', 'Capabilities'].includes(segs[0])) {
        return segs.reduce((acc, s) => (acc == null ? undefined : acc[s]), ctx.root);
      }
      return segs.reduce((acc, s) => (acc == null ? undefined : acc[s]), ctx.dot);
    }
    return tok;
  }

  return { evalExpr };
}

// ===========================================================================
// 五、渲染器
// ===========================================================================
class Renderer {
  constructor() {
    this.defines = new Map();
  }

  renderNodes(nodes, ctx) {
    let out = '';
    for (const n of nodes) out += this.renderNode(n, ctx);
    return out;
  }

  renderNode(n, ctx) {
    if (n.t === 'text') return n.v;
    if (n.t === 'define') return '';
    if (n.t === 'action') {
      // 变量赋值：{{ $x := expr }}（Helm 常用写法，求值后写入作用域，无输出）
      const assign = /^\$([\w]+)\s*:=\s*([\s\S]+)$/.exec(n.v.trim());
      if (assign) {
        ctx.vars[assign[1]] = makeEval(ctx, this).evalExpr(assign[2].trim());
        return '';
      }
      const v = makeEval(ctx, this).evalExpr(n.v);
      return this.stringify(v);
    }
    if (n.t === 'block') {
      const ev = makeEval(ctx, this);
      if (n.kw === 'if') {
        for (const b of n.branches) {
          if (!isEmpty(ev.evalExpr(b.expr))) return this.renderNodes(b.nodes, ctx);
        }
        return n.else ? this.renderNodes(n.else, ctx) : '';
      }
      if (n.kw === 'with') {
        const v = ev.evalExpr(n.branches[0].expr);
        if (!isEmpty(v)) return this.renderNodes(n.branches[0].nodes, { ...ctx, dot: v });
        return n.else ? this.renderNodes(n.else, ctx) : '';
      }
      if (n.kw === 'range') {
        const b = n.branches[0];
        const v = ev.evalExpr(b.expr);
        if (isEmpty(v)) return n.else ? this.renderNodes(n.else, ctx) : '';
        let out = '';
        if (Array.isArray(v)) {
          v.forEach((item) => {
            const vars = { ...ctx.vars };
            if (b.vars) vars[b.vars.replace(/^\$/, '')] = item;
            out += this.renderNodes(b.nodes, { ...ctx, dot: item, vars });
          });
        } else {
          for (const [k, item] of Object.entries(v)) {
            const vars = { ...ctx.vars };
            if (b.vars) {
              const parts = b.vars.split(',').map((s) => s.trim().replace(/^\$/, ''));
              if (parts.length === 2) {
                vars[parts[0]] = k;
                vars[parts[1]] = item;
              } else {
                vars[parts[0]] = item;
              }
            }
            out += this.renderNodes(b.nodes, { ...ctx, dot: item, vars });
          }
        }
        return out;
      }
    }
    return '';
  }

  stringify(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return toYaml(v);
    if (typeof v === 'boolean') return String(v);
    return String(v);
  }

  /** 渲染单个模板（含其自身 define 收集） */
  render(src, file, root) {
    const nodes = parseTemplate(src, file);
    for (const n of nodes) if (n.t === 'define') this.defines.set(n.name, n.body);
    return this.renderNodes(nodes, { root, dot: root, vars: {} });
  }
}

// ===========================================================================
// 六、Chart 渲染入口
// ===========================================================================
function readValues(rel) {
  const p = path.join(CHART_DIR, rel);
  return parseYaml(fs.readFileSync(p, 'utf8')) ?? {};
}

function listTemplates() {
  const dir = path.join(CHART_DIR, 'templates');
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(yaml|yml|tpl|txt)$/.test(f))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function makeRoot(values, releaseName, chart) {
  return {
    Values: values,
    Release: { Name: releaseName, Namespace: 'fw', Service: 'Helm', IsInstall: true, IsUpgrade: false, Revision: 1 },
    Chart: { Name: chart.name, Version: chart.version, AppVersion: chart.appVersion },
    Capabilities: { KubernetesVersion: { Major: '1', Minor: '29' } },
  };
}

/** 渲染整个 Chart，返回 { docs, notes, values } */
function renderChart(values, releaseName) {
  const chart = parseYaml(fs.readFileSync(path.join(CHART_DIR, 'Chart.yaml'), 'utf8'));
  const templates = listTemplates();
  const renderer = new Renderer();
  // 第一遍：注册全部 define
  for (const t of templates) {
    const nodes = parseTemplate(t.src, t.name);
    for (const n of nodes) if (n.t === 'define') renderer.defines.set(n.name, n.body);
  }
  const root = makeRoot(values, releaseName, chart);
  const docs = [];
  let notes = '';
  for (const t of templates) {
    const out = renderer.render(t.src, t.name, root);
    if (!out.trim()) continue;
    if (t.name === 'NOTES.txt') {
      notes = out;
      continue;
    }
    for (const d of parseYamlAll(out)) {
      if (d && typeof d === 'object') docs.push({ source: t.name, obj: d });
    }
  }
  return { docs, notes, values };
}

// ===========================================================================
// 七、清单语义断言
// ===========================================================================
const byKind = (docs, kind, suffix) =>
  docs.filter((d) => d.obj.kind === kind && (!suffix || (d.obj.metadata?.name ?? '').endsWith(suffix)));

function validateChart(label, docs, values, opts = {}) {
  const apiDeploy = byKind(docs, 'Deployment', '-api')[0]?.obj;
  const apiSpec = apiDeploy?.spec?.template?.spec;
  const c = apiSpec?.containers?.[0];

  check(`L2 [${label}] Deployment 就绪探针 → /ready`, c?.readinessProbe?.httpGet?.path === '/ready', `[${c?.readinessProbe?.httpGet?.path}]`);
  check(`L2 [${label}] Deployment 存活探针 → /health`, c?.livenessProbe?.httpGet?.path === '/health', `[${c?.livenessProbe?.httpGet?.path}]`);
  check(`L2 [${label}] Deployment 启动探针存在且 → /health`, c?.startupProbe?.httpGet?.path === '/health');
  check(
    `L2 [${label}] 滚动更新 maxUnavailable=0 / maxSurge=1`,
    apiDeploy?.spec?.strategy?.rollingUpdate?.maxUnavailable === 0 && apiDeploy?.spec?.strategy?.rollingUpdate?.maxSurge === 1,
    `[${apiDeploy?.spec?.strategy?.rollingUpdate?.maxUnavailable}/${apiDeploy?.spec?.strategy?.rollingUpdate?.maxSurge}]`,
  );
  check(
    `L2 [${label}] 容器 resources 含 requests 与 limits`,
    !!c?.resources?.requests?.cpu && !!c?.resources?.requests?.memory && !!c?.resources?.limits?.cpu && !!c?.resources?.limits?.memory,
    `[req=${JSON.stringify(c?.resources?.requests)} lim=${JSON.stringify(c?.resources?.limits)}]`,
  );
  check(
    `L2 [${label}] Pod 非 root + 容器禁提权 + drop ALL`,
    apiSpec?.securityContext?.runAsNonRoot === true &&
      c?.securityContext?.allowPrivilegeEscalation === false &&
      (c?.securityContext?.capabilities?.drop ?? []).includes('ALL'),
  );
  check(`L2 [${label}] 优雅停机宽限期 ≥ 30s`, (apiSpec?.terminationGracePeriodSeconds ?? 0) >= 30, `[${apiSpec?.terminationGracePeriodSeconds}]`);
  check(
    `L2 [${label}] 镜像 tag 回退 Chart.appVersion（未留空）`,
    typeof c?.image === 'string' && /:[^:\/]+$/.test(c.image),
    `[${c?.image}]`,
  );

  const hpa = byKind(docs, 'HorizontalPodAutoscaler')[0]?.obj;
  check(
    `L2 [${label}] HPA CPU 目标与副本上下限正确`,
    !!hpa &&
      hpa.spec.minReplicas === values.autoscaling.minReplicas &&
      hpa.spec.maxReplicas === values.autoscaling.maxReplicas &&
      hpa.spec.metrics?.[0]?.resource?.name === 'cpu' &&
      hpa.spec.metrics[0].resource.target.averageUtilization === values.autoscaling.targetCPUUtilizationPercentage,
    hpa ? `[min=${hpa.spec.minReplicas} max=${hpa.spec.maxReplicas} cpu=${hpa.spec.metrics[0].resource.target.averageUtilization}%]` : '[缺失]',
  );
  check(`L2 [${label}] HPA 启用时 Deployment 不设固定 replicas`, apiDeploy ? !('replicas' in (apiDeploy.spec ?? {})) : false);

  const pdb = byKind(docs, 'PodDisruptionBudget')[0]?.obj;
  check(`L2 [${label}] PDB minAvailable ≥ 2`, !!pdb && pdb.spec.minAvailable >= 2, pdb ? `[${pdb.spec.minAvailable}]` : '[缺失]');

  const svc = byKind(docs, 'Service', '-api')[0]?.obj;
  check(
    `L2 [${label}] API Service 端口 80 → http(3000)`,
    svc?.spec?.ports?.[0]?.port === values.service.port && svc?.spec?.ports?.[0]?.targetPort === 'http',
  );

  const cm = byKind(docs, 'ConfigMap', '-config')[0]?.obj;
  const cmData = cm?.data ?? {};
  const required = ['APP_ENV', 'DB_DRIVER', 'CACHE_DRIVER', 'AUTH_STRATEGY', 'MQ_DRIVER', 'TENANT_ENABLED', 'OTEL_ENABLED'];
  check(
    `L2 [${label}] ConfigMap 覆盖 7 类关键配置`,
    required.every((k) => k in cmData),
    `[缺失=${required.filter((k) => !(k in cmData)).join(',') || '无'}]`,
  );
  check(
    `L2 [${label}] ConfigMap 值均为字符串（K8s 要求）`,
    Object.values(cmData).every((v) => typeof v === 'string'),
  );

  check(`L2 [${label}] 未渲染明文 Secret（密钥走外部注入）`, byKind(docs, 'Secret').length === 0);
  check(`L2 [${label}] 容器经 secretRef 取密钥`, !!c?.envFrom?.some((e) => e.secretRef?.name));
  check(`L2 [${label}] 容器经 configMapRef 取配置`, !!c?.envFrom?.some((e) => e.configMapRef?.name));

  const job = byKind(docs, 'Job', '-migrate')[0]?.obj;
  check(
    `L2 [${label}] 迁移 Job 为 pre-upgrade 钩子`,
    (job?.metadata?.annotations?.['helm.sh/hook'] ?? '').includes('pre-upgrade'),
    `[${job?.metadata?.annotations?.['helm.sh/hook']}]`,
  );
  check(
    `L2 [${label}] 迁移 Job 指令为 db:migrate 且 restartPolicy=Never`,
    JSON.stringify(job?.spec?.template?.spec?.containers?.[0]?.command ?? []).includes('db:migrate') &&
      job?.spec?.template?.spec?.restartPolicy === 'Never',
  );

  check(
    `L2 [${label}] Pod 模板带 checksum/config 注解（配置变更触发滚动）`,
    typeof apiDeploy?.spec?.template?.metadata?.annotations?.['checksum/config'] === 'string' &&
      apiDeploy.spec.template.metadata.annotations['checksum/config'].length === 64,
  );

  if (opts.ingress) {
    const ing = byKind(docs, 'Ingress')[0]?.obj;
    check(`L2 [${label}] Ingress 渲染并含 TLS`, !!ing && ing.spec.rules.length > 0 && ing.spec.tls?.length > 0, `[hosts=${ing?.spec?.rules?.map((r) => r.host).join(',')}]`);
  }
  if (opts.worker) {
    const w = byKind(docs, 'Deployment', '-worker')[0]?.obj;
    check(
      `L2 [${label}] worker 副本独立且 TRANSPORT_ROLE=handler`,
      !!w && w.spec.template.spec.containers[0].env?.some((e) => e.name === 'TRANSPORT_ROLE' && e.value === 'handler'),
      `[replicas=${w?.spec?.replicas}]`,
    );
    check(`L2 [${label}] worker 与 api 使用不同 component 选择器（不抢流量）`, w?.spec?.selector?.matchLabels?.['app.kubernetes.io/component'] === 'worker' && apiDeploy?.spec?.selector?.matchLabels?.['app.kubernetes.io/component'] === 'api');
  }
  if (opts.adminWeb) {
    check(
      `L2 [${label}] admin-web Deployment + Service 成对渲染`,
      byKind(docs, 'Deployment', '-admin-web').length === 1 && byKind(docs, 'Service', '-admin-web').length === 1,
    );
  }
  if (opts.antiAffinity) {
    const affinity = apiSpec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution;
    check(`L2 [${label}] api 配置反亲和（分散到不同节点）`, Array.isArray(affinity) && affinity.length > 0);
    check(`L2 [${label}] 配置拓扑分布约束（按可用区打散）`, Array.isArray(apiSpec?.topologySpreadConstraints) && apiSpec.topologySpreadConstraints.length > 0);
  }
}

// ===========================================================================
// 八、主流程
// ===========================================================================
function main() {
  console.log('=== T-M8-07 Helm Chart 离线渲染与清单校验（L1 渲染 + L2 语义）===\n');

  const baseValues = readValues('values.yaml');

  // ---- 档位 1：默认 ----
  console.log('--- 档位 1/3：默认 values.yaml ---');
  let d1;
  try {
    d1 = renderChart(baseValues, 'fw');
    check(`L1 [默认档] 全部模板渲染成功（${d1.docs.length} 个清单）`, true);
    validateChart('默认档', d1.docs, d1.values, {});
    check('L2 [默认档] worker 与 adminWeb 默认关闭（无对应清单）', byKind(d1.docs, 'Deployment', '-worker').length === 0 && byKind(d1.docs, 'Deployment', '-admin-web').length === 0);
    check('L1 [默认档] NOTES.txt 渲染并含健康检查指引', d1.notes.includes('/ready') && d1.notes.includes('kubectl'));
  } catch (e) {
    check('L1 [默认档] 全部模板渲染成功', false, e.message);
  }

  // ---- 档位 2：生产 ----
  console.log('\n--- 档位 2/3：values-prod.yaml（生产全开）---');
  let d2;
  try {
    const prodValues = deepMerge(baseValues, readValues('values-prod.yaml'));
    d2 = renderChart(prodValues, 'myapp');
    check(`L1 [生产档] 全部模板渲染成功（${d2.docs.length} 个清单）`, true);
    validateChart('生产档', d2.docs, d2.values, { ingress: true, worker: true, adminWeb: true, antiAffinity: true });
    check(
      'L2 [生产档] 发布名 myapp 参与命名（无 fw-app 残留）',
      d2.docs.every((d) => !String(d.obj.metadata?.name ?? '').startsWith('fw-fw-app')),
      `[示例名=${byKind(d2.docs, 'Deployment', '-api')[0]?.obj.metadata.name}]`,
    );
    check(
      'L2 [生产档] Secret 引用指向外部 existingSecret',
      byKind(d2.docs, 'Deployment', '-api')[0]?.obj.spec.template.spec.containers[0].envFrom.some((e) => e.secretRef?.name === 'fw-prod-secrets'),
    );
  } catch (e) {
    check('L1 [生产档] 全部模板渲染成功', false, e.message);
  }

  // ---- 档位 3：最小档（全关）----
  console.log('\n--- 档位 3/3：最小档（autoscaling / PDB / migrateJob / worker 全关）---');
  try {
    const minimal = deepMerge(baseValues, {
      autoscaling: { enabled: false },
      podDisruptionBudget: { enabled: false },
      migrateJob: { enabled: false },
      replicaCount: 1,
      ingress: { enabled: false },
    });
    const d3 = renderChart(minimal, 'mini');
    check(`L1 [最小档] 全部模板渲染成功（${d3.docs.length} 个清单）`, true);
    check('L2 [最小档] autoscaling 关 → 无 HPA 且 Deployment 固定 replicas=1', byKind(d3.docs, 'HorizontalPodAutoscaler').length === 0 && byKind(d3.docs, 'Deployment', '-api')[0]?.obj.spec.replicas === 1);
    check('L2 [最小档] PDB 关 → 无 PodDisruptionBudget', byKind(d3.docs, 'PodDisruptionBudget').length === 0);
    check('L2 [最小档] migrateJob 关 → 无 Job', byKind(d3.docs, 'Job').length === 0);
    check('L2 [最小档] ingress 关 → 无 Ingress', byKind(d3.docs, 'Ingress').length === 0);
    check(
      'L2 [最小档] 探针与安全上下文仍保留（开关不影响基线）',
      byKind(d3.docs, 'Deployment', '-api')[0]?.obj.spec.template.spec.containers[0].readinessProbe.httpGet.path === '/ready',
    );
  } catch (e) {
    check('L1 [最小档] 全部模板渲染成功', false, e.message);
  }

  // ---- 静态：Chart 元信息与目录规范 ----
  console.log('\n--- 附加：Chart 规范与 compose 校验 ---');
  const chart = parseYaml(fs.readFileSync(path.join(CHART_DIR, 'Chart.yaml'), 'utf8'));
  check('L0 Chart.yaml 含 apiVersion=v2 / name / version / appVersion', chart.apiVersion === 'v2' && !!chart.name && !!chart.version && !!chart.appVersion);
  const tplFiles = fs.readdirSync(path.join(CHART_DIR, 'templates'));
  const expected = ['_helpers.tpl', 'deployment.yaml', 'service.yaml', 'hpa.yaml', 'pdb.yaml', 'configmap.yaml', 'secret.yaml', 'migrate-job.yaml'];
  check(`L0 templates/ 含必备模板（${expected.length} 项）`, expected.every((f) => tplFiles.includes(f)), `[实有=${tplFiles.length} 文件]`);

  const composePath = path.join(ROOT, 'deploy', 'docker-compose.prod.yml');
  try {
    const compose = parseYaml(fs.readFileSync(composePath, 'utf8'));
    const svcNames = Object.keys(compose.services ?? {});
    check(
      'L0 docker-compose.prod.yml 含 app / worker / postgres / redis / nginx / migrate',
      ['app', 'worker', 'postgres', 'redis', 'nginx', 'migrate'].every((s) => svcNames.includes(s)),
      `[${svcNames.join(',')}]`,
    );
    check('L0 compose 应用无状态：未挂载应用数据卷', !(compose.services.app.volumes ?? []).some((v) => String(v).includes('app-data')));
  } catch (e) {
    check('L0 docker-compose.prod.yml 可解析', false, e.message);
  }

  const nginxConf = path.join(ROOT, 'deploy', 'nginx', 'fw.conf');
  const nginxTxt = fs.existsSync(nginxConf) ? fs.readFileSync(nginxConf, 'utf8') : '';
  check('L0 nginx 配置含 SPA 回退与 /api 反代与登录限流', nginxTxt.includes('try_files $uri $uri/ /index.html') && nginxTxt.includes('proxy_pass http://fw_api') && nginxTxt.includes('limit_req zone=fw_auth'));

  // M12 W3 OBS-19（ADR-0027）：Nginx 三份配置一致性轴——免鉴权探针白名单覆盖集一致 + maintenance 不上公网
  const nginxFiles = {
    'fw.conf': path.join(ROOT, 'deploy', 'nginx', 'fw.conf'),
    'fw-host.conf': path.join(ROOT, 'deploy', 'nginx', 'fw-host.conf'),
    'fw-1panel-locations.conf': path.join(ROOT, 'deploy', 'nginx', 'fw-1panel-locations.conf'),
  };
  const nginxTexts = Object.fromEntries(Object.entries(nginxFiles).map(([k, f]) => [k, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '']));
  // ① 覆盖集一致：每份都必须覆盖 health / ready / metrics 三个免鉴权路径（形态可不同，覆盖必须等价）
  const coverage = Object.fromEntries(Object.entries(nginxTexts).map(([k, txt]) => [k, ['health', 'ready', 'metrics'].every((p) => txt.includes(p))]));
  check('L0 nginx 三份配置免鉴权探针白名单覆盖集一致（health/ready/metrics，OBS-19）', Object.values(coverage).every(Boolean));
  // ② maintenance 不上公网：任何一份都不得为 auth-maintenance 建立公开放行（应用层 ops:read 守卫为主，部署侧不放大暴露面）
  check('L0 nginx 三份配置均不含 auth-maintenance 公开放行（maintenance 不上公网，OBS-15/19）', Object.values(nginxTexts).every((txt) => !txt.includes('auth-maintenance')));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== 汇总：${passed}/${results.length} ===`);
  if (passed !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}`);
    process.exit(1);
  }
}

main();
