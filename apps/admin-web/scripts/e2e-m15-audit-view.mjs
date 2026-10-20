/*
 * @file M15 审计运营视图浏览器验收（PRD-015 AC-15-01 浏览器侧证据；本地 mock 环境）
 * @description 用本机 Chrome + CDP（Node 内置 WebSocket，零新依赖）真实操作审计页，覆盖用户要求的链路：
 *   ① 列表运营视图：摘要/结果/风险/对象为可读文本，技术列默认收起，「历史记录」降级标签可见；
 *   ② 筛选：结果=已拒绝、风险=高风险（前端按注册表展开成 event 多值）后，行内容与筛选一致；
 *   ③ 详情：业务区字段（事件说明/操作原因/变更前后值）在前，技术详情折叠、展开后出现事件码与请求 ID；
 *   ④ 导出：点击导出派发异步任务（任务条/提示可见）。
 *   另附暗色主题与 1280x720 / 1920x1080 无横向溢出检查。
 *
 *   边界声明（不夸大）：跑在 vite dev + C-06 mock 上，证明的是**前端交互与展示层**行为；
 *   mock 只有演示数据，不等于真机（106.55.32.251）验收。任何 FAIL 退出码 1，SKIP 不影响。
 *
 *   前置：另起 dev server → `pnpm dev --port 5188`（mock 随 vite 插件自动挂载）。
 *   运行：`node scripts/e2e-m15-audit-view.mjs`（cwd = apps/admin-web）
 *   产物：`e2e-artifacts/m15-*.png` + `e2e-artifacts/report-m15.json`
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/scripts
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5188';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334);
const OUT_DIR = path.resolve(process.env.E2E_OUT ?? 'e2e-artifacts');
const ACCOUNT = process.env.E2E_ACCOUNT ?? 'admin';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Admin@123456';

const results = [];
/** status: pass | fail | skip */
function record(id, status, detail = '') {
  results.push({ id, status, detail });
  const tag = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${tag}  ${id}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(200);
  }
  throw new Error(`waitHttp timeout ${url}: ${last}`);
}

// ---- 启动 Chrome ----
const userDataDir = path.join(tmpdir(), `e2e-m15-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();

async function connect() {
  const targets = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    }
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${expression.slice(0, 120)}`);
  return r.result.value;
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await js(expression)) return true;
    } catch {
      // 页面导航中执行上下文可能短暂失效，重试即可
    }
    await sleep(150);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function goto(url, timeoutMs = 30000) {
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`, timeoutMs, `load ${url}`);
  await sleep(700);
}

async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  return path.join(OUT_DIR, `${name}.png`);
}

/** 表格正文 */
const TABLE_TEXT = `[...document.querySelectorAll('.el-table__body tbody tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim())`;

/** 查询区展开（字段 >3 时默认收起，结果/风险/事件都在折叠区） */
async function expandSearch() {
  const expanded = await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-crud-search .el-button')].find((b) => b.innerText.trim() === '展开');
    if (!btn) return 'already';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(400);
  return expanded;
}

/**
 * 选择查询区某个下拉项
 * @param {string} label 表单项标签（如「结果」）
 * @param {string} option 选项文本（如「已拒绝」）
 */
async function pickSelect(label, option) {
  const opened = await js(`(() => {
    const item = [...document.querySelectorAll('.fw-crud-search .el-form-item')]
      .find((el) => el.innerText.replace(/\\s+/g, '').startsWith(${JSON.stringify(label)}));
    if (!item) return 'no-field';
    const wrapper = item.querySelector('.el-select__wrapper');
    if (!wrapper) return 'no-select';
    wrapper.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'opened';
  })()`);
  if (opened !== 'opened') return opened;
  await sleep(400);
  const picked = await js(`(() => {
    const options = [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter((el) => el.offsetParent !== null);
    const target = options.find((el) => el.innerText.trim() === ${JSON.stringify(option)});
    if (!target) return 'no-option:' + options.map((o) => o.innerText.trim()).join('|');
    target.click();
    return 'picked';
  })()`);
  await sleep(300);
  return picked;
}

/** 点击查询按钮并等待列表刷新 */
async function runSearch() {
  await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-crud-search .el-button--primary')].find((b) => b.innerText.includes('查询'));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1200);
}

async function login() {
  let loggedIn = false;
  for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
    await goto(`${BASE}/login`);
    await waitFor(`!!document.querySelector('.fw-login-submit')`, 25000, 'login form');
    await sleep(600);
    const setOk = await js(`(() => {
      const els = [...document.querySelectorAll('.el-input__inner')];
      if (els.length < 2) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const setVal = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      setVal(els[0], ${JSON.stringify(ACCOUNT)});
      setVal(els[1], ${JSON.stringify(PASSWORD)});
      return els[0].value === ${JSON.stringify(ACCOUNT)} && els[1].value === ${JSON.stringify(PASSWORD)};
    })()`);
    if (!setOk) {
      await sleep(800);
      continue;
    }
    await js(`document.querySelector('.fw-login-submit').click()`);
    try {
      await waitFor(`location.pathname !== '/login'`, 8000, 'login redirect');
      loggedIn = true;
    } catch {
      await sleep(800);
    }
  }
  return loggedIn;
}

async function main() {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await viewport(1440, 900);

  // ===== 1. 登录 =====
  const loggedIn = await login();
  record('登录（UI 表单）', loggedIn ? 'pass' : 'fail', loggedIn ? `跳到 ${await js('location.pathname')}` : '3 次重试仍停留登录页');
  if (!loggedIn) throw new Error('登录失败，后续浏览器验收无法进行');

  // ===== 2. 列表运营视图 =====
  await goto(`${BASE}/system/audit-logs`);
  await waitFor(`document.querySelectorAll('.el-table__body tbody tr').length > 0`, 20000, 'audit rows');
  await sleep(600);

  const view = await js(`(() => {
    const headers = [...document.querySelectorAll('.el-table__header th')].map((th) => th.innerText.replace(/\\s+/g, ''));
    const body = document.body.innerText;
    const rows = ${TABLE_TEXT};
    return {
      headers,
      rows,
      hasSummary: rows.some((r) => r.includes('将租户「示例企业」') || r.includes('将用户「bob」')),
      hasResultTag: body.includes('成功') || body.includes('已拒绝'),
      hasRiskTag: body.includes('高风险') || body.includes('注意'),
      hasLegacyTag: body.includes('历史记录'),
      hasTechColumn: headers.includes('traceId'),
      hasEventHeader: headers.includes('事件'),
    };
  })()`);
  record('列表主列为业务字段（事件/结果/风险/对象/操作人/时间）',
    view.hasEventHeader && view.rows.some((r) => r.includes('示例企业') || r.includes('bob')) ? 'pass' : 'fail',
    `表头=${JSON.stringify(view.headers)}`);
  record('摘要为可读中文（不展开 JSON 即可理解）', view.hasSummary ? 'pass' : 'fail', view.rows[0] ?? '');
  record('结果/风险标签可见', view.hasResultTag && view.hasRiskTag ? 'pass' : 'fail', `结果=${view.hasResultTag} 风险=${view.hasRiskTag}`);
  record('技术列默认收起（traceId 不在表头）', view.hasTechColumn ? 'fail' : 'pass', `表头含 traceId=${view.hasTechColumn}`);
  record('旧数据标注「历史记录」（不编造摘要）', view.hasLegacyTag ? 'pass' : 'fail', 'mock seed 含无事件码的旧行');
  await shot('m15-01-list');

  // ===== 3. 筛选：结果 =====
  await expandSearch();
  const resultPick = await pickSelect('结果', '已拒绝');
  await runSearch();
  const denied = await js(`(() => {
    const rows = ${TABLE_TEXT};
    return { total: rows.length, allDenied: rows.length > 0 && rows.every((r) => r.includes('已拒绝')), sample: rows[0] ?? '' };
  })()`);
  record('筛选「结果=已拒绝」后行内容一致', resultPick === 'picked' && denied.allDenied ? 'pass' : 'fail',
    `pick=${resultPick} 行数=${denied.total} 首行=${denied.sample}`);
  await shot('m15-02-filter-denied');

  // ===== 4. 筛选：风险（前端按注册表展开 event 多值） =====
  // 先重置结果筛选，避免两个条件叠加导致空结果
  await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-crud-search .el-button')].find((b) => b.innerText.trim() === '重置');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1000);
  await expandSearch();
  const riskPick = await pickSelect('风险', '高风险');
  await runSearch();
  const highRisk = await js(`(() => {
    const rows = ${TABLE_TEXT};
    return { total: rows.length, allHigh: rows.length > 0 && rows.every((r) => r.includes('高风险')), sample: rows[0] ?? '' };
  })()`);
  record('筛选「风险=高风险」按事件集合展开且结果一致', riskPick === 'picked' && highRisk.allHigh ? 'pass' : 'fail',
    `pick=${riskPick} 行数=${highRisk.total} 首行=${highRisk.sample}`);
  await shot('m15-03-filter-high-risk');

  // 重置回全量，供详情使用
  await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-crud-search .el-button')].find((b) => b.innerText.trim() === '重置');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1200);

  // ===== 5. 详情：业务区 + 技术折叠 =====
  const opened = await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-table-actions button')].find((b) => b.innerText.trim() === '详情');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.el-drawer__body')`, 10000, 'detail drawer');
  await sleep(800);
  const detail = await js(`(() => {
    const body = document.querySelector('.el-drawer__body')?.innerText ?? '';
    const wrap = document.querySelector('.el-collapse-item__wrap');
    return {
      hasHeadline: !!document.querySelector('.fw-audit-headline-title'),
      hasReason: body.includes('操作原因'),
      hasDiff: body.includes('变更前后值'),
      hasTech: body.includes('技术详情'),
      // 折叠态判定不能看 innerText：el-collapse 用 max-height 过渡，文案仍在 DOM 里
      techHeight: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1,
    };
  })()`);
  record('详情业务区优先（摘要/原因/变更对照）', opened && detail.hasHeadline && detail.hasReason && detail.hasDiff ? 'pass' : 'fail',
    `打开=${opened} 摘要=${detail.hasHeadline} 原因=${detail.hasReason} 变更=${detail.hasDiff}`);
  record('技术详情默认折叠（内容区高度≈0）', detail.hasTech && detail.techHeight >= 0 && detail.techHeight <= 4 ? 'pass' : 'fail',
    `折叠标题=${detail.hasTech} 内容区高度=${detail.techHeight}px`);
  await shot('m15-04-detail');

  // 展开技术详情
  await js(`(() => {
    const head = document.querySelector('.el-collapse-item__header');
    if (head) head.click();
    return true;
  })()`);
  await sleep(700);
  const tech = await js(`(() => {
    const body = document.querySelector('.el-drawer__body')?.innerText ?? '';
    const wrap = document.querySelector('.el-collapse-item__wrap');
    return {
      hasEventCode: body.includes('事件码'),
      hasRequestId: body.includes('请求 ID'),
      hasRaw: body.includes('原始 before / after'),
      techHeight: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1,
    };
  })()`);
  record('展开技术详情可见事件码/请求 ID/原始快照', tech.hasEventCode && tech.hasRequestId && tech.hasRaw && tech.techHeight > 20 ? 'pass' : 'fail',
    `事件码=${tech.hasEventCode} 请求ID=${tech.hasRequestId} 原始=${tech.hasRaw} 高度=${tech.techHeight}px`);
  await shot('m15-05-detail-tech');

  // 关闭抽屉
  await js(`(() => {
    const close = document.querySelector('.el-drawer__close-btn');
    if (close) close.click();
    return true;
  })()`);
  await sleep(500);

  // ===== 6. 导出派发 =====
  const exportClicked = await js(`(() => {
    const btn = [...document.querySelectorAll('.fw-crud-toolbar button')].find((b) => b.innerText.trim() === '导出');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1500);
  const exportState = await js(`(() => {
    const body = document.body.innerText;
    const message = [...document.querySelectorAll('.el-message')].map((m) => m.innerText).join(' ');
    const jobBar = document.querySelector('.fw-job-bar, [class*="job-bar"]');
    return { clicked: ${'true'}, message, hasJobBar: !!jobBar, dispatched: /导出任务已派发/.test(message) || /审计日志导出/.test(body) };
  })()`);
  record('点击导出派发异步任务（提示或任务条可见）', exportClicked && (exportState.dispatched || exportState.hasJobBar) ? 'pass' : 'fail',
    `提示=${exportState.message || '(无)'} 任务条=${exportState.hasJobBar}`);
  await shot('m15-06-export');

  // ===== 7. 暗色主题 =====
  await js(`(() => {
    const btn = document.querySelector('.fw-navbar-right .el-dropdown .el-button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);
  const darkClicked = await js(`(() => {
    const items = [...document.querySelectorAll('.el-dropdown-menu__item')];
    const dark = items.find((e) => e.textContent.includes('暗色') || e.textContent.toLowerCase().includes('dark'));
    if (!dark) return false;
    dark.click();
    return true;
  })()`);
  await sleep(700);
  const isDark = await js(`document.documentElement.classList.contains('dark')`);
  record('暗色主题下审计页可读', darkClicked && isDark ? 'pass' : 'fail', `切换=${darkClicked} html.dark=${isDark}`);
  await shot('m15-07-dark');

  // 恢复浅色（避免影响分辨率截图观感）
  await js(`(() => {
    const btn = document.querySelector('.fw-navbar-right .el-dropdown .el-button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  await js(`(() => {
    const items = [...document.querySelectorAll('.el-dropdown-menu__item')];
    const light = items.find((e) => e.textContent.includes('浅色') || e.textContent.toLowerCase().includes('light'));
    if (light) light.click();
    return true;
  })()`);
  await sleep(400);

  // ===== 8. 分辨率 =====
  for (const [w, h, name] of [[1280, 720, 'm15-08-1280x720'], [1920, 1080, 'm15-09-1920x1080']]) {
    await viewport(w, h);
    await goto(`${BASE}/system/audit-logs`);
    await waitFor(`document.querySelectorAll('.el-table__body tbody tr').length > 0`, 15000, 'rows');
    await sleep(500);
    const overflow = await js(`(() => {
      const d = document.scrollingElement;
      return { scrollWidth: d.scrollWidth, innerWidth: window.innerWidth };
    })()`);
    const ok = overflow.scrollWidth <= overflow.innerWidth + 1;
    record(`${w}x${h} 审计页无横向溢出`, ok ? 'pass' : 'fail', `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`);
    await shot(name);
  }
}

try {
  await main();
} catch (e) {
  record('脚本执行异常', 'fail', String(e && e.message ? e.message : e));
} finally {
  try {
    await shot('m15-99-last-state');
  } catch {
    // 忽略收尾截图失败
  }
  try {
    ws?.close();
  } catch {
    // ignore
  }
  chrome.kill();
  await sleep(300);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Windows 上 Chrome 可能仍占用目录，忽略
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'report-m15.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n合计：pass=${results.length - failed - skipped} fail=${failed} skip=${skipped}`);
  console.log(`报告：${path.join(OUT_DIR, 'report-m15.json')}`);
  process.exit(failed > 0 ? 1 : 0);
}
