/**
 * @file M10 E-13 站内信 / 通知中心冒烟验证脚本
 * @description 单实例（TRANSPORT_DRIVER=in-process）形态下逐条验证通知中心：
 *   A. 未登录访问消息中心 → 401 / 3001；
 *   B. 初始消息面为空（total=0 / unread=0）；
 *   C. 建流主题按权限裁剪：admin = ['job','notification','queue']，alice = ['job','notification']；
 *   D. 派发任务 → 事件流收到 `notification` 事件（站内信由**事件订阅**产生，非业务直调）；
 *   E. 未读数 / 列表：任务成功产生 1 条（kind=job.finished / level=success），刷新后 unread=1；
 *   F. 标记已读幂等：read → unread=0，重复标记仍 200；
 *   G. 归属人隔离反向验证：alice 读 / 删 admin 的消息一律 404；alice 流收不到 admin 的通知事件；
 *   H. 权限裁剪反向验证：无 notification:read 的探针账号 → 消息面 3002，且票据主题不含 notification；
 *   I. 失败任务产生 job.failed / level=error；read-all 清零；
 *   J. 幂等：两条终态任务恰好两条消息（进度事件不产生消息，重复投递不重复建）；
 *   K. 删除本人消息后总数回落。
 *   前置：dist 已构建；dev.db 已迁移并播种（`pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开既有冒烟实例） */
const PORT = 3770;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text, headers } */
async function call(base, url, options) {
  const res = await fetch(base + url, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** 登录并返回 access token */
async function login(base, account, password) {
  const res = await call(base, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return res.body?.data?.accessToken ?? null;
}

/** 取票 */
async function ticket(base, token) {
  return call(base, '/api/v1/events/ticket', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
}

/** 解析一帧 SSE 文本 */
function parseFrame(chunk) {
  const event = { name: null, data: null };
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event.name = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const raw = line.slice(5).trim();
      try {
        event.data = JSON.parse(raw);
      } catch {
        event.data = raw;
      }
    }
  }
  return event.name ? event : null;
}

/** 打开 SSE 流并持续累积事件 */
async function openStream(base, ticketValue) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/events/stream?ticket=${encodeURIComponent(ticketValue)}`, {
    signal: controller.signal,
  });
  const frames = [];
  if (res.status !== 200) return { res, frames, close: () => controller.abort() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame = parseFrame(chunk);
          if (frame) frames.push(frame);
        }
      }
    } catch {
      // 客户端 abort：正常路径
    }
  })();
  return {
    res,
    frames,
    close: async () => {
      controller.abort();
      await Promise.race([pump, sleep(500)]);
    },
  };
}

/** 等待断言条件成立（支持异步断言） */
async function waitFor(predicate, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/** 启动应用实例 */
async function startInstance(port = PORT) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(port), DB_URL, DB_DRIVER: 'sqlite', TRANSPORT_DRIVER: 'in-process' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(`http://127.0.0.1:${port}`, '/ready');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例在 30s 内未就绪：\n${output.slice(-2000)}`);
}

async function main() {
  console.log('—— M10 E-13 站内信 / 通知中心冒烟（事件订阅 → 落库 → SSE 实时未读） ——\n');
  const base = `http://127.0.0.1:${PORT}`;
  const instance = await startInstance();
  const stamp = Date.now().toString(36);
  let adminStream = null;
  let aliceStream = null;
  let probeUserId = null;
  let probeRoleId = null;
  try {
    const admin = await login(base, 'admin', 'Admin@123456');
    const alice = await login(base, 'alice', 'Alice@123456');
    const auth = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

    // ---------- A. 未登录 ----------
    console.log('\n—— 阶段 A：未登录访问消息中心 ——');
    const anon = await call(base, '/api/v1/notifications');
    check('未登录 GET /notifications → 401 / 3001', anon.status === 401 && anon.body?.code === 3001, `http=${anon.status} code=${anon.body?.code}`);

    // ---------- B. 前置清场 + 初始为空 ----------
    console.log('\n—— 阶段 B：前置清场与初始消息面 ——');
    // 消息面是「按人累积」的：上一次冒烟留下的消息会让绝对计数断言失真，故先清空 admin 的消息
    // （与 smoke-config 的「持久历史前置清场」同规：冒烟对自身前置状态负责，不依赖库是干净的）
    const existing = await call(base, '/api/v1/notifications?pageSize=200', { headers: auth(admin) });
    let cleared = 0;
    for (const item of existing.body?.data?.items ?? []) {
      const del = await call(base, `/api/v1/notifications/${item.id}`, { method: 'DELETE', headers: auth(admin) });
      if (del.status === 200) cleared += 1;
    }
    console.log(`   （前置清场：删除既有消息 ${cleared} 条）`);
    const initial = await call(base, '/api/v1/notifications', { headers: auth(admin) });
    check('admin 初始列表 total=0 / unread=0',
      initial.status === 200 && initial.body?.data?.total === 0 && initial.body?.data?.unread === 0,
      `http=${initial.status} total=${initial.body?.data?.total} unread=${initial.body?.data?.unread}`);
    check('列表响应对齐 api-spec §1.5（含 page / pageSize）',
      initial.body?.data?.page === 1 && initial.body?.data?.pageSize === 20,
      `page=${initial.body?.data?.page} pageSize=${initial.body?.data?.pageSize}`);

    // ---------- C. 建流主题裁剪 ----------
    console.log('\n—— 阶段 C：SSE 主题按权限裁剪 ——');
    const adminTicket = await ticket(base, admin);
    check('admin 取票 → topics = [job, notification, queue]',
      JSON.stringify(adminTicket.body?.data?.topics ?? []) === JSON.stringify(['job', 'notification', 'queue']),
      `topics=${JSON.stringify(adminTicket.body?.data?.topics)}`);
    const aliceTicket = await ticket(base, alice);
    check('alice（有 notification:read、无 system:queue:list）→ topics = [job, notification]',
      JSON.stringify(aliceTicket.body?.data?.topics ?? []) === JSON.stringify(['job', 'notification']),
      `topics=${JSON.stringify(aliceTicket.body?.data?.topics)}`);

    adminStream = await openStream(base, adminTicket.body.data.ticket);
    await waitFor(() => adminStream.frames.some((f) => f.name === 'ready'), 'admin 收到 ready');
    aliceStream = await openStream(base, aliceTicket.body.data.ticket);
    await waitFor(() => aliceStream.frames.some((f) => f.name === 'ready'), 'alice 收到 ready');

    // ---------- D/E. 任务成功 → 站内信 + 未读 ----------
    console.log('\n—— 阶段 D/E：任务终态经事件订阅落成站内信 ——');
    const dispatched = await call(base, '/api/v1/audit-logs/export', { headers: auth(admin) });
    const jobId = dispatched.body?.data?.id;
    check('派发审计导出 → 200 且返回 jobId', dispatched.status === 200 && typeof jobId === 'string', `http=${dispatched.status}`);

    await waitFor(
      () => adminStream.frames.some((f) => f.name === 'notification' && f.data?.notification?.refId === jobId),
      'admin 流收到该任务的 notification 事件',
    );
    const ntfFrame = adminStream.frames.find((f) => f.name === 'notification' && f.data?.notification?.refId === jobId);
    check('notification 事件载荷含 ownerId 与完整通知视图',
      ntfFrame.data?.ownerId?.length > 0 && ntfFrame.data?.notification?.id?.startsWith('ntf-'),
      `id=${ntfFrame.data?.notification?.id} kind=${ntfFrame.data?.notification?.kind}`);
    check('成功任务 → kind=job.finished / level=success',
      ntfFrame.data?.notification?.kind === 'job.finished' && ntfFrame.data?.notification?.level === 'success',
      `kind=${ntfFrame.data?.notification?.kind} level=${ntfFrame.data?.notification?.level}`);
    check('通知标题带任务名、内容提示可下载',
      String(ntfFrame.data?.notification?.title ?? '').includes('任务完成') &&
        String(ntfFrame.data?.notification?.content ?? '').includes('已可下载'),
      `title=${ntfFrame.data?.notification?.title}`);

    const afterExport = await call(base, '/api/v1/notifications', { headers: auth(admin) });
    const firstNtf = afterExport.body?.data?.items?.[0];
    check('列表 total=1 / unread=1（消息由事件订阅产生，非业务直调）',
      afterExport.body?.data?.total === 1 && afterExport.body?.data?.unread === 1,
      `total=${afterExport.body?.data?.total} unread=${afterExport.body?.data?.unread}`);
    check('列表项不含内部字段（userId / dedupeKey）',
      firstNtf !== undefined && firstNtf.userId === undefined && firstNtf.dedupeKey === undefined,
      `keys=${Object.keys(firstNtf ?? {}).join(',')}`);

    const count1 = await call(base, '/api/v1/notifications/unread-count', { headers: auth(admin) });
    check('GET /notifications/unread-count → 1', count1.status === 200 && count1.body?.data?.unread === 1, `unread=${count1.body?.data?.unread}`);

    // ---------- F. 标记已读幂等 ----------
    console.log('\n—— 阶段 F：标记已读（幂等） ——');
    const read1 = await call(base, `/api/v1/notifications/${firstNtf.id}/read`, { method: 'POST', headers: auth(admin) });
    // POST 默认 201（与 /jobs/:id/retry、队列 pause/resume 等同惯例），断言取「2xx 且语义正确」
    check('POST /notifications/:id/read → read=true',
      (read1.status === 200 || read1.status === 201) && read1.body?.data?.read === true,
      `http=${read1.status} read=${read1.body?.data?.read}`);
    const read2 = await call(base, `/api/v1/notifications/${firstNtf.id}/read`, { method: 'POST', headers: auth(admin) });
    check('重复标记已读仍 2xx 且 read=true（幂等）',
      (read2.status === 200 || read2.status === 201) && read2.body?.data?.read === true, `http=${read2.status}`);
    const count2 = await call(base, '/api/v1/notifications/unread-count', { headers: auth(admin) });
    check('已读后未读数回落为 0', count2.body?.data?.unread === 0, `unread=${count2.body?.data?.unread}`);

    // ---------- G. 归属人隔离 ----------
    console.log('\n—— 阶段 G：归属人隔离（反向验证） ——');
    const aliceRead = await call(base, `/api/v1/notifications/${firstNtf.id}/read`, { method: 'POST', headers: auth(alice) });
    check('alice 标记 admin 的消息已读 → 404（不泄露存在性）', aliceRead.status === 404, `http=${aliceRead.status}`);
    const aliceDelete = await call(base, `/api/v1/notifications/${firstNtf.id}`, { method: 'DELETE', headers: auth(alice) });
    check('alice 删除 admin 的消息 → 404', aliceDelete.status === 404, `http=${aliceDelete.status}`);
    await sleep(300);
    check('alice 的事件流收不到 admin 的 notification（服务端按归属人过滤）',
      aliceStream.frames.filter((f) => f.name === 'notification').length === 0,
      `alice notification frames=${aliceStream.frames.filter((f) => f.name === 'notification').length}`);
    const aliceList = await call(base, '/api/v1/notifications', { headers: auth(alice) });
    check('alice 的消息面与 admin 完全隔离（total=0）', aliceList.body?.data?.total === 0, `total=${aliceList.body?.data?.total}`);

    // ---------- H. 权限裁剪反向验证（无 notification:read 的探针账号） ----------
    console.log('\n—— 阶段 H：无 notification:read 的账号（反向验证） ——');
    const probeRole = await call(base, '/api/v1/roles', {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify({ code: `smoke_ntf_role_${stamp}`, name: 'E-13 探针角色（无权限）', dataScope: 'self' }),
    });
    probeRoleId = probeRole.body?.data?.id ?? null;
    const probeUser = await call(base, '/api/v1/users', {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify({
        username: `smoke_ntf_${stamp}`,
        password: 'Probe@123456',
        nickname: 'E-13 探针账号',
        roleIds: probeRoleId ? [probeRoleId] : [],
      }),
    });
    probeUserId = probeUser.body?.data?.id ?? null;
    check('探针角色与账号创建成功（空权限角色）',
      probeRole.status === 201 && probeUser.status === 201 && !!probeRoleId && !!probeUserId,
      `role=${probeRole.status} user=${probeUser.status}`);
    const probeToken = await login(base, `smoke_ntf_${stamp}`, 'Probe@123456');
    const probeList = await call(base, '/api/v1/notifications', { headers: auth(probeToken) });
    check('无 notification:read → GET /notifications 3002（权限码真实生效）',
      probeList.status === 403 && probeList.body?.code === 3002, `http=${probeList.status} code=${probeList.body?.code}`);
    const probeTicket = await ticket(base, probeToken);
    check('探针账号票据 topics 不含 notification',
      JSON.stringify(probeTicket.body?.data?.topics ?? []) === JSON.stringify(['job']),
      `topics=${JSON.stringify(probeTicket.body?.data?.topics)}`);

    // ---------- I/J. 失败任务 → job.failed；read-all；幂等 ----------
    console.log('\n—— 阶段 I/J：失败消息 / 全部已读 / 幂等 ——');
    const failed = await call(base, '/api/v1/tenants/1/migrate', {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify({ isolation: 'dedicated', dbUrl: 'not-a-valid-url' }),
    });
    const failedJobId = failed.body?.data?.id;
    check('派发非法迁移任务（终态将失败）', failed.status === 201 && typeof failedJobId === 'string', `http=${failed.status}`);
    await waitFor(
      () => adminStream.frames.some((f) => f.name === 'notification' && f.data?.notification?.refId === failedJobId),
      '失败任务的 notification 事件',
    );
    const failedFrame = adminStream.frames.find((f) => f.name === 'notification' && f.data?.notification?.refId === failedJobId);
    check('失败任务 → kind=job.failed / level=error',
      failedFrame.data?.notification?.kind === 'job.failed' && failedFrame.data?.notification?.level === 'error',
      `kind=${failedFrame.data?.notification?.kind} level=${failedFrame.data?.notification?.level}`);

    const beforeAll = await call(base, '/api/v1/notifications', { headers: auth(admin) });
    check('两条终态任务恰好两条消息（进度事件不产生消息）',
      beforeAll.body?.data?.total === 2,
      `total=${beforeAll.body?.data?.total}`);
    const readAll = await call(base, '/api/v1/notifications/read-all', { method: 'POST', headers: auth(admin) });
    check('POST /notifications/read-all → updated=1（仅未读那条）',
      readAll.body?.data?.updated === 1, `updated=${readAll.body?.data?.updated}`);
    const countAll = await call(base, '/api/v1/notifications/unread-count', { headers: auth(admin) });
    check('全部已读后未读数 0', countAll.body?.data?.unread === 0, `unread=${countAll.body?.data?.unread}`);

    // ---------- K. 删除 ----------
    console.log('\n—— 阶段 K：删除本人消息 ——');
    const removed = await call(base, `/api/v1/notifications/${failedFrame.data.notification.id}`, {
      method: 'DELETE',
      headers: auth(admin),
    });
    check('DELETE /notifications/:id → removed=true',
      removed.status === 200 && removed.body?.data?.removed === true, `http=${removed.status}`);
    const afterRemove = await call(base, '/api/v1/notifications', { headers: auth(admin) });
    check('删除后总数回落为 1', afterRemove.body?.data?.total === 1, `total=${afterRemove.body?.data?.total}`);

    // 清理探针账号与角色（避免污染开发库）
    if (probeRoleId) await call(base, `/api/v1/roles/${probeRoleId}`, { method: 'DELETE', headers: auth(admin) });
    if (probeUserId) await call(base, `/api/v1/users/${probeUserId}`, { method: 'DELETE', headers: auth(admin) });
  } finally {
    await adminStream?.close();
    await aliceStream?.close();
    instance.child.kill();
    await sleep(500);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
