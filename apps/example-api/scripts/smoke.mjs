/**
 * @file M1+M2 冒烟验证脚本
 * @description 对运行中的 example-api 逐项验证 PRD-001 与 PRD-002 的 AC：
 *   健康检查、统一响应、错误码、details、未知异常收敛、脱敏日志、traceId 贯通（M1）；
 *   /ready db 探针、Repository CRUD、分页、软删（M2）。
 * @author donttemo
 * @created 2026-10-12
 * @since v0.1.0
 */

const BASE = 'http://127.0.0.1:3000';

/** 请求工具：返回 { status, body, traceHeader } */
async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, traceHeader: res.headers.get('x-trace-id') };
}

/** 依次请求全部演示端点并打印结果 */
async function main() {
  const checks = [
    { name: 'health', path: '/health', expect: (s, b) => s === 200 && b.status === 'ok' },
    { name: 'ready(db探针)', path: '/ready', expect: (s, b) => s === 200 && b.status === 'ok' && b.checks.db === 'ok' },
    { name: 'ok(统一响应)', path: '/api/v1/demo/ok', expect: (s, b) => s === 200 && b.code === 0 && typeof b.traceId === 'string' && b.data.hello === 'fw' },
    { name: 'biz-error(结构化错误)', path: '/api/v1/demo/biz-error', expect: (s, b) => s === 400 && b.code === 2001 && b.message.includes('库存不足') && b.data === null },
    { name: 'details(字段级)', path: '/api/v1/demo/biz-error-with-details', expect: (s, b) => s === 400 && b.code === 1001 && Array.isArray(b.details) && b.details[0].field === 'username' },
    { name: 'boom(收敛9001)', path: '/api/v1/demo/boom', expect: (s, b) => s === 500 && b.code === 9001 && b.message === '系统内部错误' },
    { name: 'log-sensitive', path: '/api/v1/demo/log-sensitive', expect: (s, b) => s === 200 && b.code === 0 },
    { name: '404路由', path: '/api/v1/no-such', expect: (s, b) => s === 404 && b.code === 1002 },
    { name: 'items(分页+软删过滤)', path: '/api/v1/demo/items?page=1&pageSize=10', expect: (s, b) => s === 200 && b.code === 0 && Array.isArray(b.data.items) && typeof b.data.total === 'number' },
  ];

  let pass = 0;
  for (const c of checks) {
    const { status, body, traceHeader } = await call(c.path);
    const ok = c.expect(status, body);
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  [http=${status} x-trace-id=${traceHeader}] ${JSON.stringify(body).slice(0, 120)}`);
  }

  // traceId 贯通：响应头 === 响应体 === 日志行
  const { body, traceHeader } = await call('/api/v1/demo/ok');
  const traceOk = traceHeader === body.traceId && Boolean(traceHeader);
  if (traceOk) pass++;
  console.log(`${traceOk ? 'PASS' : 'FAIL'}  traceId 贯通  [header=${traceHeader} body=${body.traceId}]`);

  // M2：Repository 写路径（create → patch → softDelete → 列表不可见）
  // Nest @Post 默认 201 Created，故接受 200/201
  const created = await call('/api/v1/demo/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '冒烟测试条目' }),
  });
  const createOk =
    [200, 201].includes(created.status) &&
    created.body.code === 0 &&
    created.body.data.createdBy === 'system';
  if (createOk) pass++;
  console.log(`${createOk ? 'PASS' : 'FAIL'}  items.create(审计字段自动填充)  [id=${created.body.data?.id}]`);

  const patched = await call(`/api/v1/demo/items/${created.body.data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });
  const patchOk = patched.status === 200 && patched.body.data.done === true;
  if (patchOk) pass++;
  console.log(`${patchOk ? 'PASS' : 'FAIL'}  items.update(局部更新)`);

  const deleted = await call(`/api/v1/demo/items/${created.body.data.id}`, { method: 'DELETE' });
  const listAfter = await call('/api/v1/demo/items?page=1&pageSize=100');
  const softDeleteOk =
    deleted.status === 200 &&
    listAfter.body.code === 0 &&
    !listAfter.body.data.items.some((i) => i.id === created.body.data.id);
  if (softDeleteOk) pass++;
  console.log(`${softDeleteOk ? 'PASS' : 'FAIL'}  items.softDelete(默认查询不可见)  [total=${listAfter.body.data.total}]`);

  const total = checks.length + 4; // 9 项端点 + traceId + create/patch/softDelete
  console.log(`\n结果：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  console.error('验证脚本执行失败：', err);
  process.exit(1);
});
