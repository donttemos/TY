/**
 * @file M9 配置中心冒烟验证脚本（PRD-009 §7 AC）
 * @description 自带服务生命周期（端口 3450）+ 临时事实源文件，分阶段验证：
 *   A. 启动加载（含白名单初值 fail-fast 通过）与越权面（无 system:config:read/write 双 3002）；
 *   B. API 入口生效：PUT log.level → demo-queue 入队的 DEBUG 日志按新级别输出（不重启生效的直接证据）；
 *   C. 三类拒绝：boot 键 400/5001、未知键 404/5003、非法值 400/5002（旧值保持 + 失败审计含原因）；
 *   D. 同值写 = 无变更（版本号不递增、不产生审计）；
 *   E. 文件入口生效：改事实源 → 一个轮询周期内生效，审计 source=file operator=system；
 *   F. fail-keep：事实源损坏 → 进程不崩、快照保持、ERROR 日志；修复后自动追上；
 *   G. 覆盖移除恢复 env 默认值（事实源删除键 → 回退 env 快照并审计）；
 *   H. 未启用形态（CONFIG_CENTER_ENABLED=false）：GET 仍可用（env 视图），PUT 一律 400/1004。
 *   前置：dev.db 已迁移并播种（CI 在 M3 步骤完成；本地运行前先 `pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 3000/3100/3200/3300/3400/3500/3600/3610/3611/3700 的既有冒烟实例） */
const PORT = 3450;
const BASE = `http://127.0.0.1:${PORT}`;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const results = [];

/** 成功状态码（登录等控制器按 POST 语义返回 201） */
const isOk = (status) => status >= 200 && status < 300;

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text } */
async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
}

/** 登录并返回 access token */
async function login(account, password) {
  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return res.body?.data?.accessToken ?? null;
}

/** 启动服务并等待就绪，输出写入内存以便断言与失败定位 */
async function startServer(env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call('/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 30s 内未就绪（端口 ${PORT}）：\n${output.slice(-2000)}`);
}

/** 停止服务并等待退出 */
async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 阶段 A~G：启用形态（事实源 + 轮询 1s） */
async function phaseEnabled(runtimeFile) {
  fs.writeFileSync(runtimeFile, JSON.stringify({ 'log.level': 'debug' }));
  const server = await startServer({
    CONFIG_CENTER_ENABLED: 'true',
    CONFIG_CENTER_POLL_SECONDS: '1',
    CONFIG_CENTER_FILE: runtimeFile,
  });

  const admin = await login('admin', 'Admin@123456');
  const alice = await login('alice', 'Alice@123456');
  const auth = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

  // ---------- A. 启动加载与越权面 ----------
  console.log('\n—— 阶段 A：启动加载与越权面 ——');
  const list = await call('/api/v1/configs', { headers: auth(admin) });
  const configs = list.body?.data?.configs ?? [];
  check('GET /configs（admin）返回白名单 11 键',
    list.status === 200 && configs.length === 11 && configs.every((c) => c.hot === true),
    `http=${list.status} count=${configs.length}`);
  const logEntry = configs.find((c) => c.key === 'log.level');
  check('事实源初值已加载：log.level=debug 且 source=runtime（启动覆盖，未逐键通知）',
    logEntry?.value === 'debug' && logEntry?.source === 'runtime',
    `value=${logEntry?.value} source=${logEntry?.source}`);
  const ttlEntry = configs.find((c) => c.key === 'cache.ttl');
  check('未覆盖键回退 env：cache.ttl=300 且 source=env',
    ttlEntry?.value === 300 && ttlEntry?.source === 'env',
    `value=${ttlEntry?.value} source=${ttlEntry?.source}`);
  check('meta 快照版本=1（启动加载计一次应用）', list.body?.data?.meta?.snapshotVersion === 1, `v=${list.body?.data?.meta?.snapshotVersion}`);

  const aliceList = await call('/api/v1/configs', { headers: auth(alice) });
  check('alice 无 system:config:read → 403/3002', aliceList.status === 403 && aliceList.body?.code === 3002, `http=${aliceList.status} code=${aliceList.body?.code}`);
  const alicePut = await call('/api/v1/configs/cache.ttl', { method: 'PUT', headers: auth(alice), body: JSON.stringify({ value: 1 }) });
  check('alice 无 system:config:write → 403/3002', alicePut.status === 403 && alicePut.body?.code === 3002, `http=${alicePut.status} code=${alicePut.body?.code}`);

  // ---------- B. API 入口生效（log.level 热更 → 新级别日志输出） ----------
  console.log('\n—— 阶段 B：API 入口生效 ——');
  const before = server.output().split('\n').length;
  const putLevel = await call('/api/v1/configs/log.level', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 'trace' }) });
  check('PUT log.level=trace 生效', putLevel.status === 200 && putLevel.body?.data?.newValue === 'trace', `http=${putLevel.status}`);
  check('旧值为启动覆盖值 debug（old/new 成对）', putLevel.body?.data?.oldValue === 'debug');
  // demo-queue/echo 入队走 QueueService 的 DEBUG 日志「任务入队」：默认 info 下不可见，trace 阈值下输出
  //（行内 level 字段是日志自身级别 "debug"——热更生效的证据是这条日志「出现在输出里」而非 level 字面值）
  const echo = await call('/api/v1/demo-queue/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'fw' }) });
  check('demo-queue/echo 入队成功（日志探针前置条件）', isOk(echo.status), `http=${echo.status}`);
  await sleep(800);
  const lines = server.output().split('\n').slice(before);
  check('热更后新级别日志输出（任务入队 DEBUG 行可见，进程未重启）',
    lines.some((line) => line.includes('"level":"debug"') && line.includes('任务入队')),
    `debugLines=${lines.filter((l) => l.includes('任务入队')).length}`);

  const putTtl = await call('/api/v1/configs/cache.ttl', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 900 }) });
  check('PUT cache.ttl=900 生效（旧值 300）', putTtl.status === 200 && putTtl.body?.data?.oldValue === 300 && putTtl.body?.data?.newValue === 900);

  // ---------- C. 三类拒绝 ----------
  console.log('\n—— 阶段 C：三类拒绝 ——');
  const putBoot = await call('/api/v1/configs/db.driver', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 'mysql' }) });
  check('boot 键 → 400/5001，值不变', putBoot.status === 400 && putBoot.body?.code === 5001, `http=${putBoot.status} code=${putBoot.body?.code}`);
  const putUnknown = await call('/api/v1/configs/nope.nope', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 1 }) });
  check('未知键 → 404/5003', putUnknown.status === 404 && putUnknown.body?.code === 5003, `http=${putUnknown.status} code=${putUnknown.body?.code}`);
  const putInvalid = await call('/api/v1/configs/log.level', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 'verbose' }) });
  check('非法值 → 400/5002（details 带原因）',
    putInvalid.status === 400 && putInvalid.body?.code === 5002 && (putInvalid.body?.details?.[0]?.message ?? '').length > 0,
    `http=${putInvalid.status} code=${putInvalid.body?.code}`);
  const listAfterInvalid = await call('/api/v1/configs', { headers: auth(admin) });
  check('非法值被拒后旧值保持（log.level 仍 trace）',
    (listAfterInvalid.body?.data?.configs ?? []).find((c) => c.key === 'log.level')?.value === 'trace');

  // 审计可见：成功与失败变更都在 module=config 下
  const audit = await call('/api/v1/audit-logs?module=config&page=1&pageSize=50', { headers: auth(admin) });
  const auditItems = audit.body?.data?.items ?? [];
  const okRecord = auditItems.find((a) => a.targetId === 'log.level' && a.afterValue?.ok === true);
  const failRecord = auditItems.find((a) => a.targetId === 'db.driver' && a.afterValue?.ok === false);
  check('成功变更审计可查（key/old/new/source/operator/traceId）',
    !!okRecord && okRecord.beforeValue?.value === 'debug' && okRecord.afterValue?.value === 'trace'
    && okRecord.afterValue?.source === 'api' && okRecord.afterValue?.operator === 'admin' && !!okRecord.traceId,
    `found=${!!okRecord}`);
  check('失败变更审计可查（含被拒原因）',
    !!failRecord && (failRecord.afterValue?.reason ?? '').includes('不可热更'),
    `found=${!!failRecord}`);

  // ---------- D. 同值写 = 无变更 ----------
  console.log('\n—— 阶段 D：同值写 ——');
  const auditCountBefore = (await call('/api/v1/audit-logs?module=config&page=1&pageSize=1', { headers: auth(admin) })).body?.data?.total ?? 0;
  const putSame = await call('/api/v1/configs/cache.ttl', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 900 }) });
  check('同值写入返回当前版本号（不递增）',
    putSame.status === 200 && putSame.body?.data?.snapshotVersion === putTtl.body?.data?.snapshotVersion,
    `v=${putSame.body?.data?.snapshotVersion}`);
  const auditCountAfter = (await call('/api/v1/audit-logs?module=config&page=1&pageSize=1', { headers: auth(admin) })).body?.data?.total ?? 0;
  check('同值写入不产生审计', auditCountAfter === auditCountBefore, `before=${auditCountBefore} after=${auditCountAfter}`);

  // ---------- E. 文件入口生效 ----------
  console.log('\n—— 阶段 E：文件入口生效 ——');
  fs.writeFileSync(runtimeFile, JSON.stringify({ 'log.level': 'warn', 'cache.ttl': 600 }));
  await sleep(2200);
  const listAfterFile = await call('/api/v1/configs', { headers: auth(admin) });
  const fileTtl = (listAfterFile.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl');
  const fileLevel = (listAfterFile.body?.data?.configs ?? []).find((c) => c.key === 'log.level');
  check('事实源修改在一个轮询周期内生效（cache.ttl=600 / log.level=warn）',
    fileTtl?.value === 600 && fileLevel?.value === 'warn',
    `ttl=${fileTtl?.value} level=${fileLevel?.value}`);
  const fileAudit = await call('/api/v1/audit-logs?module=config&page=1&pageSize=50', { headers: auth(admin) });
  const fileRecord = (fileAudit.body?.data?.items ?? []).find((a) => a.targetId === 'cache.ttl' && a.afterValue?.source === 'file');
  check('文件入口审计：source=file operator=system',
    !!fileRecord && fileRecord.afterValue?.operator === 'system' && fileRecord.afterValue?.value === 600,
    `found=${!!fileRecord}`);

  // ---------- F. fail-keep 与自动恢复 ----------
  console.log('\n—— 阶段 F：fail-keep ——');
  const outputBeforeCorrupt = server.output().length;
  fs.writeFileSync(runtimeFile, '{ corrupted json');
  await sleep(2200);
  const healthAfterCorrupt = await call('/health');
  const listAfterCorrupt = await call('/api/v1/configs', { headers: auth(admin) });
  check('事实源损坏：进程不崩、快照保持（cache.ttl 仍 600）',
    healthAfterCorrupt.status === 200
    && (listAfterCorrupt.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl')?.value === 600);
  check('事实源损坏：ERROR 日志落盘（fail-keep 提示）',
    server.output().slice(outputBeforeCorrupt).includes('保持最后一份有效快照'));
  fs.writeFileSync(runtimeFile, JSON.stringify({ 'log.level': 'warn', 'cache.ttl': 1200 }));
  await sleep(2200);
  const listAfterFix = await call('/api/v1/configs', { headers: auth(admin) });
  check('事实源修复后自动追上（cache.ttl=1200）',
    (listAfterFix.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl')?.value === 1200);

  // ---------- G. 覆盖移除恢复 env ----------
  console.log('\n—— 阶段 G：覆盖移除恢复 env ——');
  fs.writeFileSync(runtimeFile, JSON.stringify({}));
  await sleep(2200);
  const listAfterRestore = await call('/api/v1/configs', { headers: auth(admin) });
  const restoredTtl = (listAfterRestore.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl');
  check('事实源删除键 → 恢复 env 默认值（cache.ttl=300 且 source=env）',
    restoredTtl?.value === 300 && restoredTtl?.source === 'env',
    `value=${restoredTtl?.value} source=${restoredTtl?.source}`);

  // ---------- G2. 一键回滚（M9 Backlog）----------
  console.log('\n—— 阶段 G2：一键回滚 ——');
  const rbPut1 = await call('/api/v1/configs/log.level', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 'debug' }) });
  const rbPut2 = await call('/api/v1/configs/cache.ttl', { method: 'PUT', headers: auth(admin), body: JSON.stringify({ value: 900 }) });
  const vA = rbPut1.body?.data?.snapshotVersion;
  const vB = rbPut2.body?.data?.snapshotVersion;
  check('回滚前置：两次 PUT 成功（v_a/v_b 版本号单调）', isOk(rbPut1.status) && isOk(rbPut2.status) && vB > vA, `vA=${vA} vB=${vB}`);

  const aliceRb = await call('/api/v1/configs/rollback', { method: 'POST', headers: auth(alice), body: JSON.stringify({}) });
  check('alice 无 system:config:write → 403/3002', aliceRb.status === 403 && aliceRb.body?.code === 3002, `http=${aliceRb.status} code=${aliceRb.body?.code}`);
  const rbBad = await call('/api/v1/configs/rollback', { method: 'POST', headers: auth(admin), body: JSON.stringify({ version: 99999 }) });
  check('回滚到不存在版本 → 404/5003', rbBad.status === 404 && rbBad.body?.code === 5003, `http=${rbBad.status} code=${rbBad.body?.code}`);

  const rb1 = await call('/api/v1/configs/rollback', { method: 'POST', headers: auth(admin), body: JSON.stringify({ version: vA }) });
  const rb1Changed = rb1.body?.data?.changed ?? [];
  check(`回滚到 v${vA}：cache.ttl 恢复 env 默认（900→300），log.level 同值不动`,
    isOk(rb1.status) && rb1.body?.data?.toVersion === vA
    && rb1Changed.some((c) => c.key === 'cache.ttl' && c.oldValue === 900 && c.newValue === 300)
    && !rb1Changed.some((c) => c.key === 'log.level'),
    `http=${rb1.status} changed=${rb1Changed.map((c) => c.key).join(',')}`);
  const listAfterRb1 = await call('/api/v1/configs', { headers: auth(admin) });
  const rbTtl = (listAfterRb1.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl');
  const rbLevel = (listAfterRb1.body?.data?.configs ?? []).find((c) => c.key === 'log.level');
  check('回滚已生效：cache.ttl=300(env) / log.level=debug(runtime)',
    rbTtl?.value === 300 && rbTtl?.source === 'env' && rbLevel?.value === 'debug' && rbLevel?.source === 'runtime',
    `ttl=${rbTtl?.value}/${rbTtl?.source} level=${rbLevel?.value}/${rbLevel?.source}`);

  const rb2 = await call('/api/v1/configs/rollback', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{}' });
  check('缺省回滚 = 撤销上一次回滚（cache.ttl 回到 900）',
    isOk(rb2.status) && (rb2.body?.data?.changed ?? []).some((c) => c.key === 'cache.ttl' && c.newValue === 900),
    `http=${rb2.status} toVersion=${rb2.body?.data?.toVersion}`);
  const rbAudit = await call('/api/v1/audit-logs?module=config&page=1&pageSize=50', { headers: auth(admin) });
  check('回滚逐键审计可查（cache.ttl 回滚链 ok=true）',
    (rbAudit.body?.data?.items ?? []).some((a) => a.targetId === 'cache.ttl' && a.afterValue?.ok === true && a.afterValue?.value === 300));

  await stopServer(server);
  return { admin };
}

/** 阶段 H：未启用形态（零开销：不读文件不起轮询） */
async function phaseDisabled() {
  console.log('\n—— 阶段 H：未启用形态 ——');
  const server = await startServer({ CONFIG_CENTER_ENABLED: 'false', CONFIG_CENTER_FILE: path.join(os.tmpdir(), 'fw-config-smoke-disabled.json') });
  const admin = await login('admin', 'Admin@123456');
  const list = await call('/api/v1/configs', { headers: { authorization: `Bearer ${admin}` } });
  check('未启用：GET /configs 仍提供 env 视图（11 键，source=env）',
    list.status === 200
    && (list.body?.data?.configs ?? []).length === 11
    && (list.body?.data?.configs ?? []).every((c) => c.source === 'env'),
    `count=${(list.body?.data?.configs ?? []).length}`);
  const put = await call('/api/v1/configs/cache.ttl', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ value: 1 }),
  });
  check('未启用：PUT 一律 400/1004（无事实源，在线修改不可用）',
    put.status === 400 && put.body?.code === 1004, `http=${put.status} code=${put.body?.code}`);
  const rollbackDisabled = await call('/api/v1/configs/rollback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: '{}',
  });
  check('未启用：回滚一律 400/1004', rollbackDisabled.status === 400 && rollbackDisabled.body?.code === 1004, `http=${rollbackDisabled.status} code=${rollbackDisabled.body?.code}`);
  await stopServer(server);
}

async function main() {
  const runtimeFile = path.join(os.tmpdir(), `fw-config-smoke-${Date.now()}.json`);
  try {
    await phaseEnabled(runtimeFile);
    await phaseDisabled();
  } finally {
    fs.rmSync(runtimeFile, { force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error('失败项：');
    for (const item of failed) console.error(` - ${item.name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('冒烟执行失败：', error);
  process.exit(1);
});
