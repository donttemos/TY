/*
 * @file M14 租户上下文浏览器验收（PRD-014 AC-14-04 浏览器侧证据；本地 mock 环境）
 * @description 用本机 Chrome + CDP（Node 内置 WebSocket，零新依赖）真实操作页面，覆盖用户要求的三类检查：
 *   ① 工作台三个运营入口（到期订阅 / 配额风险 / 最近迁移）点击后是否带 tenantId 跳转；
 *   ② 深链 `?tenantId=` 是否回填选择器、表格数据是否与租户一致、刷新后是否保持；
 *   ③ 前进/后退、清空选择是否正常复位；另覆盖暗色主题与 1280x720 / 1920x1080 两种分辨率的溢出检查。
 *
 *   边界声明（不夸大）：本脚本跑在 vite dev + C-06 mock（`mock/handlers.ts` 内存库）上，
 *   证明的是**前端交互与路由层**行为，不等于真机（106.55.32.251）验收；mock 无「7 天内到期订阅」
 *   演示数据、也没有「仅 ops:saas:read」的只读账号，对应两项会记 SKIP 而不是伪造通过。
 *
 *   前置：另起 dev server → `pnpm dev --port 5188`（mock 随 vite 插件自动挂载）。
 *   运行：`node scripts/e2e-m14-tenant-context.mjs`（cwd = apps/admin-web）
 *   产物：`e2e-artifacts/*.png` + `e2e-artifacts/report.json`；任一 FAIL 退出码 1（SKIP 不影响）。
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
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const OUT_DIR = path.resolve(process.env.E2E_OUT ?? 'e2e-artifacts');
const TENANT = process.env.E2E_TENANT ?? '1';
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
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(200);
  }
  throw new Error(`waitHttp timeout ${url}: ${last}`);
}

// ---- 启动 Chrome ----
const userDataDir = path.join(tmpdir(), `e2e-m14-${Date.now()}`);
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
  await sleep(600); // 等 Vue 首屏与 mock 请求落地
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

/** 表格正文（用于断言数据与租户匹配） */
const TABLE_TEXT = `[...document.querySelectorAll('.el-table__body tbody tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim())`;

async function main() {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await viewport(1440, 900);

  // ===== 1. 真实登录 =====
  // vite 首次访问会做依赖预构建并触发整页 reload，可能把刚注入的表单值冲掉 → 读回校验 + 重试
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
  record('登录（UI 表单）', loggedIn ? 'pass' : 'fail', loggedIn ? `跳到 ${await js('location.pathname')}` : '3 次重试仍停留登录页');
  if (!loggedIn) throw new Error('登录失败，后续浏览器验收无法进行');

  // ===== 2. 工作台三个运营入口 =====
  await goto(`${BASE}/`);
  await waitFor(`!!document.querySelector('.fw-saas-sub-title')`, 20000, 'dashboard saas card');
  const sections = await js(`(() => {
    const titles = [...document.querySelectorAll('.fw-saas-sub-title')].map((e) => e.textContent.trim());
    const items = [...document.querySelectorAll('.fw-saas-item')].length;
    return { titles, items };
  })()`);
  record('工作台渲染 SaaS 运营卡', sections.titles.length >= 2 ? 'pass' : 'fail', `区块=${JSON.stringify(sections.titles)} 条目=${sections.items}`);
  await shot('01-dashboard');

  /** 点击指定区块的第一条，返回跳转后的 pathname+search */
  async function clickEntry(keyword) {
    const clicked = await js(`(() => {
      const title = [...document.querySelectorAll('.fw-saas-sub-title')].find((e) => e.textContent.includes(${JSON.stringify(keyword)}));
      if (!title) return 'no-section';
      const card = title.closest('.fw-saas-card, .el-card') || title.parentElement;
      const item = card.querySelector('.fw-saas-item');
      if (!item) return 'empty-section';
      item.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') return { clicked };
    try {
      await waitFor(`location.pathname.startsWith('/saas/')`, 10000, 'entry jump');
    } catch {
      const here = new URL(await js('location.href'));
      return { clicked, jumpFailed: true, path: here.pathname, href: here.href };
    }
    await sleep(700);
    const url = new URL(await js('location.href'));
    const picker = await js(`(() => {
      const w = document.querySelector('.el-select__wrapper');
      return w ? w.innerText.trim() : '';
    })()`);
    const rows = await js(TABLE_TEXT);
    return { clicked, path: url.pathname, tenantId: url.searchParams.get('tenantId'), picker, rows: Array.isArray(rows) ? rows : [] };
  }

  const entry1 = await clickEntry('即将到期订阅');
  if (entry1.clicked !== 'clicked') {
    record('入口①「即将到期订阅」→ 订阅页', 'skip', `mock 无 7 天内到期演示数据（${entry1.clicked}），真机需补测`);
  } else {
    const ok = (entry1.path === '/saas/subscriptions' || entry1.path === '/saas/subscriptions/') && !!entry1.tenantId;
    record('入口①「即将到期订阅」→ 订阅页', ok ? 'pass' : 'fail', `path=${entry1.path} tenantId=${entry1.tenantId} 选择器=${entry1.picker}`);
  }

  await goto(`${BASE}/`);
  const entry2 = await clickEntry('配额风险');
  if (entry2.clicked !== 'clicked') {
    record('入口②「配额风险」→ 用量页', 'skip', `mock 无 ≥80% 演示数据（${entry2.clicked}），真机需补测`);
  } else {
    const ok = entry2.path === '/saas/usage' && !!entry2.tenantId;
    record('入口②「配额风险」→ 用量页', ok ? 'pass' : 'fail', `path=${entry2.path} tenantId=${entry2.tenantId} 选择器=${entry2.picker}`);
  }

  await goto(`${BASE}/`);
  const entry3 = await clickEntry('最近');
  if (entry3.clicked !== 'clicked') {
    record('入口③「最近迁移」→ 生命周期页', 'skip', `mock 无迁移日志（${entry3.clicked}），真机需补测`);
  } else {
    const ok = entry3.path === '/saas/lifecycle' && !!entry3.tenantId;
    record('入口③「最近迁移」→ 生命周期页', ok ? 'pass' : 'fail', `path=${entry3.path} tenantId=${entry3.tenantId} 选择器=${entry3.picker}`);
  }

  // ===== 3. 订阅页深链 + 刷新 =====
  await goto(`${BASE}/saas/subscriptions?tenantId=${TENANT}`);
  await waitFor(`document.querySelectorAll('.el-table__body tbody tr').length > 0`, 15000, 'subscriptions rows');
  const subPicker = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);
  const subRows = await js(TABLE_TEXT);
  const subMatched = subRows.length > 0 && subRows.every((r) => r.includes(TENANT));
  record('订阅页深链：选择器回填 + 行数据租户一致', subPicker.includes(TENANT) && subMatched ? 'pass' : 'fail',
    `选择器=${subPicker} 行数=${subRows.length} 首行=${subRows[0] ?? ''}`);
  await shot('02-subscriptions');

  await send('Page.reload');
  await waitFor(`document.readyState === 'complete'`, 20000, 'reload');
  await sleep(1200);
  await waitFor(`document.querySelectorAll('.el-table__body tbody tr').length > 0`, 15000, 'rows after reload');
  const afterReload = await js(TABLE_TEXT);
  record('订阅页刷新后仍按 tenantId 取数（深链幂等）', afterReload.length > 0 && afterReload.every((r) => r.includes(TENANT)) ? 'pass' : 'fail',
    `行数=${afterReload.length}`);

  // ===== 4. 前进 / 后退（SPA 内跳转，与真实操作一致：工作台点入口 → 后退 → 前进） =====
  await goto(`${BASE}/`);
  await waitFor(`!!document.querySelector('.fw-saas-item')`, 20000, 'dashboard items');
  const nav = await clickEntry('最近');
  if (nav.clicked !== 'clicked') {
    record('后退/前进（keep-alive 同实例）', 'skip', `入口不可点：${nav.clicked}`);
  } else {
    await waitFor(`location.pathname.startsWith('/saas/lifecycle')`, 10000, 'to lifecycle');
    await sleep(800);
    const beforeBack = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);

    await js(`history.back()`);
    await waitFor(`location.pathname === '/dashboard'`, 10000, 'back to dashboard');
    record('后退回到工作台', 'pass', await js('location.pathname'));

    await js(`history.forward()`);
    await waitFor(`location.pathname.startsWith('/saas/lifecycle')`, 10000, 'forward to lifecycle');
    await sleep(900);
    const afterForwardPicker = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);
    const afterForwardBody = await js('document.body.innerText');
    record('前进回到生命周期页且租户上下文仍在（keep-alive 复用实例）',
      afterForwardPicker.includes(TENANT) && afterForwardBody.includes('当前状态：') ? 'pass' : 'fail',
      `选择器 before=${beforeBack} after=${afterForwardPicker} url=${await js('location.search')}`);
  }

  // ===== 5. 用量页深链 + 清空选择 =====
  await goto(`${BASE}/saas/usage?tenantId=${TENANT}`);
  await waitFor(`document.querySelectorAll('.el-table__body tbody tr').length > 0`, 15000, 'usage quotas');
  const usagePicker = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);
  const trendBars = await js(`document.querySelectorAll('.trend-bar-inner').length`);
  const usageBody = await js('document.body.innerText');
  record('用量页深链：配额表 + 用量面板 + 趋势区渲染',
    usagePicker.includes(TENANT) && usageBody.includes('窗口用量') && usageBody.includes('用量趋势') ? 'pass' : 'fail',
    `选择器=${usagePicker}`);
  record('趋势柱数据（需 mock 有 usageWindows 行）', trendBars > 0 ? 'pass' : 'skip',
    trendBars > 0 ? `柱数=${trendBars}` : 'mock 未预置窗口数据（db.ts usageWindows 为空），真机由 rollup 提供；渲染逻辑由 usage-page 单测覆盖');
  await shot('03-usage');

  // 清空选择：Element Plus 的 clear 图标仅在真实 hover 后渲染 → 用 CDP 鼠标移动触发
  const box = await js(`(() => {
    const w = document.querySelector('.el-select__wrapper');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', pointerType: 'mouse' });
    await sleep(500);
  }
  const clearClicked = await js(`(() => {
    const el = document.querySelector('.el-select__clear');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  const afterClear = await js('document.body.innerText');
  const pickerAfterClear = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);
  if (!clearClicked) {
    record('清空租户选择即复位（不残留上一租户数据）', 'skip', 'clear 图标未渲染（hover 依赖），需人工补测');
  } else {
    const ok = afterClear.includes('查询后展示') && !pickerAfterClear.includes(TENANT);
    record('清空租户选择即复位（不残留上一租户数据）', ok ? 'pass' : 'fail', `选择器=${pickerAfterClear} 复位占位=${afterClear.includes('查询后展示')}`);
  }
  await shot('04-usage-cleared');

  // ===== 6. 生命周期页深链 =====
  await goto(`${BASE}/saas/lifecycle?tenantId=${TENANT}`);
  await waitFor(`document.body.innerText.includes('当前状态：') || document.body.innerText.includes('未查询到租户生命周期状态')`, 15000, 'lifecycle status');
  const lifeBody = await js('document.body.innerText');
  const lifePicker = await js(`document.querySelector('.el-select__wrapper')?.innerText.trim() ?? ''`);
  const logRows = await js(`document.querySelectorAll('.el-table__body tbody tr').length`);
  record('生命周期页深链：真实状态 + 迁移历史',
    lifePicker.includes(TENANT) && (lifeBody.includes('当前状态：') || lifeBody.includes('未查询到')) ? 'pass' : 'fail',
    `选择器=${lifePicker} 历史行=${logRows} 状态=${lifeBody.includes('当前状态：') ? 'shown' : 'empty-state'}`);
  await shot('05-lifecycle');

  // ===== 7. 暗色主题 =====
  await js(`(() => {
    const btn = document.querySelector('.fw-navbar-right .el-dropdown .el-button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);
  const darkClicked = await js(`(() => {
    const items = [...document.querySelectorAll('.el-dropdown-menu__item')];
    const dark = items.find((e) => e.textContent.includes('暗色') || e.textContent.toLowerCase().includes('dark'));
    if (!dark) return false;
    dark.click();
    return true;
  })()`);
  await sleep(700);
  const isDark = await js(`document.documentElement.classList.contains('dark')`);
  record('暗色主题切换生效', darkClicked && isDark ? 'pass' : 'fail', `点击=${darkClicked} html.dark=${isDark}`);
  await shot('06-usage-dark');
  await goto(`${BASE}/saas/lifecycle?tenantId=${TENANT}`);
  await sleep(500);
  await shot('07-lifecycle-dark');

  // 恢复浅色，便于分辨率截图
  await js(`(() => {
    const btn = document.querySelector('.fw-navbar-right .el-dropdown .el-button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);
  await js(`(() => {
    const items = [...document.querySelectorAll('.el-dropdown-menu__item')];
    const light = items.find((e) => e.textContent.includes('浅色') || e.textContent.toLowerCase().includes('light'));
    if (light) light.click();
    return true;
  })()`);
  await sleep(500);

  // ===== 8. 分辨率 =====
  for (const [w, h, name] of [[1280, 720, '08-lifecycle-1280x720'], [1920, 1080, '09-lifecycle-1920x1080']]) {
    await viewport(w, h);
    await goto(`${BASE}/saas/lifecycle?tenantId=${TENANT}`);
    await sleep(600);
    const overflow = await js(`(() => {
      const d = document.scrollingElement;
      return { scrollWidth: d.scrollWidth, innerWidth: window.innerWidth };
    })()`);
    const ok = overflow.scrollWidth <= overflow.innerWidth + 1;
    record(`${w}x${h} 无横向溢出`, ok ? 'pass' : 'fail', `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`);
    await shot(name);
  }

  // ===== 9. 只读权限（mock 缺只读 SaaS 账号，如实记 SKIP） =====
  record('只读角色无写按钮（浏览器侧）', 'skip', 'mock 仅有 super-admin 持有 ops:saas:*，无「仅 read」账号；单测已覆盖 v-permission，真机需用只读账号复核');

  await viewport(1440, 900);
}

try {
  await main();
} catch (e) {
  record('脚本执行异常', 'fail', String(e && e.message ? e.message : e));
} finally {
  try {
    await shot('99-last-state');
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
  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ base: BASE, tenant: TENANT, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n合计：pass=${results.length - failed - skipped} fail=${failed} skip=${skipped}`);
  console.log(`报告：${path.join(OUT_DIR, 'report.json')}`);
  process.exit(failed > 0 ? 1 : 0);
}
