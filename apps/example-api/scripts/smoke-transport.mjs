/**
 * @file M8 传输层切换冒烟验证脚本（PRD-008 FR-06 / TC-TNT-005）
 * @description 自带服务生命周期，分阶段验证 transport 切换（in-process → redis 不改调用方代码）：
 *   A. in-process 驱动：本进程直连往返（handledBy === callerId）、统计快照、/ready transport 探针、
 *      空消息经处理器 BizError 原样传播（1001）、连续 5 次调用稳定；
 *   B. redis 驱动单进程往返（需 SMOKE_REDIS_URL，未设置则跳过）：连续 5 次往返、
 *      空消息跨进程序列化→重建后错误码仍为 1001（错误传播对等）；
 *   C. redis 驱动双进程（需 SMOKE_REDIS_URL）：A=caller / B=handler 同前缀，
 *      A 调用时 handledBy ≠ callerId 证明由另一进程处理；B 主动调用自证 handler 角色往返；
 *      A 的 handled 计数为 0（caller 按设计不处理请求）；
 *   D. 超时 fail-fast（需 SMOKE_REDIS_URL）：仅 caller 进程 + TRANSPORT_TIMEOUT_MS=1500、
 *      无处理方消费，调用在超时窗口内明确失败（503/9002）而非挂死；
 *   E. 配置守卫：TRANSPORT_DRIVER=redis 但缺 TRANSPORT_URL 与 CACHE_URL 时启动即失败。
 *   说明：redis 阶段与 M7 一致由 SMOKE_REDIS_URL 门控（CI 未设置则跳过）；本地可用
 *   `SMOKE_REDIS_URL=redis://:redis1234@106.55.32.251:6379 node scripts/smoke-transport.mjs` 实跑。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 3000 的 M1/M3、3100 的 M4、3200 的 M7、3300 的 M8 租户冒烟） */
const PORT_A = 3400;
const PORT_B = 3401;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text } */
async function call(port, path, options) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
}

/** POST JSON 请求 */
const postJson = (port, path, payload) =>
  call(port, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** 创建类请求成功状态（Nest @Post 默认 201，个别路径 200） */
const isOk = (status) => status === 200 || status === 201;

/** 回显调用 */
const echo = (port, message) => postJson(port, '/api/v1/demo-transport/echo', { message });

/** 传输统计 */
const stats = async (port) => (await call(port, '/api/v1/demo-transport/stats')).body.data ?? {};

/**
 * 启动服务并等待就绪，输出写入内存以便失败时定位
 * @param env 额外环境变量
 * @param port 监听端口
 * @param expectFail 期望启动失败（用于阶段 E）
 */
async function startServer(env, port = PORT_A, expectFail = false) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });

  if (expectFail) {
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 25000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    return { child, output: () => output, exitCode };
  }

  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(port, '/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 30s 内未就绪（端口 ${port}）：\n${output.slice(-2000)}`);
}

/** 停止服务并等待退出 */
async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 阶段 A：in-process 驱动（TC-TNT-005 单体形态） */
async function phaseInProcess() {
  console.log('\n=== 阶段 A：in-process 驱动（本进程直连，零外部依赖）===');
  const server = await startServer({ TRANSPORT_DRIVER: 'in-process' });
  try {
    // 连续 5 次往返：调用方代码与驱动无关，结果稳定
    let allOk = true;
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = await echo(PORT_A, `hello-inprocess-${i}`);
      if (!isOk(last.status) || last.body.data?.message !== `hello-inprocess-${i}`) allOk = false;
    }
    check(
      'A1 in-process 连续 5 次往返全部成功',
      allOk,
      `[http=${last?.status} message=${last?.body.data?.message}]`,
    );
    check(
      'A2 in-process 本进程处理（driver=in-process 且 handledBy === callerId）',
      last?.body.data?.driver === 'in-process' &&
        typeof last?.body.data?.handledBy === 'string' &&
        last?.body.data.handledBy === last?.body.data.callerId &&
        typeof last?.body.data.receivedAt === 'number',
      `[driver=${last?.body.data?.driver} handledBy=${last?.body.data?.handledBy} callerId=${last?.body.data?.callerId}]`,
    );

    const snap = await stats(PORT_A);
    check(
      'A3 统计快照：driver=in-process / role=both / 地址已注册 / 调用与处理计数',
      snap.driver === 'in-process' &&
        snap.role === 'both' &&
        snap.addressList?.includes('demo-transport.echo') === true &&
        snap.started === true &&
        snap.calls >= 5 &&
        snap.successes >= 5 &&
        snap.handled >= 5 &&
        snap.failures === 0,
      `[driver=${snap.driver} role=${snap.role} calls=${snap.calls} handled=${snap.handled}]`,
    );

    const ready = await call(PORT_A, '/ready');
    check(
      'A4 /ready 报告 transport 探针健康',
      ready.status === 200 && ready.body.checks?.transport === 'ok',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );

    // 处理器 BizError 原样传播（in-process 不过线）
    const empty = await echo(PORT_A, '');
    check(
      'A5 空消息错误传播：400 + code 1001（BizError 原样回传）',
      empty.status === 400 && empty.body.code === 1001,
      `[http=${empty.status} code=${empty.body.code}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 B：redis 驱动单进程往返（需 SMOKE_REDIS_URL） */
async function phaseRedisSingle() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 B：redis 驱动单进程（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 B：redis 驱动单进程往返（跨进程序列化协议）===');
  const server = await startServer({
    TRANSPORT_DRIVER: 'redis',
    TRANSPORT_URL: url,
    TRANSPORT_PREFIX: `fw:smoke-tnt:${Date.now()}`,
  });
  try {
    const ready = await call(PORT_A, '/ready');
    check(
      'B1 /ready 报告 transport 探针健康（driver=redis 真实连接）',
      ready.status === 200 && ready.body.checks?.transport === 'ok',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );

    let allOk = true;
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = await echo(PORT_A, `hello-redis-${i}`);
      if (!isOk(last.status) || last.body.data?.message !== `hello-redis-${i}`) allOk = false;
    }
    check('B2 redis 驱动连续 5 次往返全部成功', allOk, `[http=${last?.status} message=${last?.body.data?.message}]`);
    check(
      'B3 redis 驱动标识生效（driver=redis，同进程处理）',
      last?.body.data?.driver === 'redis' && last?.body.data.handledBy === last?.body.data.callerId,
      `[driver=${last?.body.data?.driver}]`,
    );

    const snap = await stats(PORT_A);
    check(
      'B4 统计快照：driver=redis 且调用/处理计数齐平',
      snap.driver === 'redis' && snap.calls >= 5 && snap.successes >= 5 && snap.handled >= 5,
      `[driver=${snap.driver} calls=${snap.calls} handled=${snap.handled}]`,
    );

    // 错误传播对等：BizError 过线后按错误码重建，HTTP 语义与 in-process 一致
    const empty = await echo(PORT_A, '');
    check(
      'B5 空消息跨进程错误传播：400 + code 1001（序列化→重建 BizError）',
      empty.status === 400 && empty.body.code === 1001,
      `[http=${empty.status} code=${empty.body.code}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 C：redis 驱动双进程（caller 进程 A + handler 进程 B，需 SMOKE_REDIS_URL） */
async function phaseRedisDual() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 C：redis 驱动双进程（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 C：redis 驱动双进程（A=caller / B=handler，证明跨进程调用）===');
  // 两进程共用同一前缀才能互相发现；实例标识缺省 host-<pid> 天然区分
  const prefix = `fw:smoke-tnt-dual:${Date.now()}`;
  const common = { TRANSPORT_DRIVER: 'redis', TRANSPORT_URL: url, TRANSPORT_PREFIX: prefix };
  const serverA = await startServer({ ...common, TRANSPORT_ROLE: 'caller' }, PORT_A);
  const serverB = await startServer({ ...common, TRANSPORT_ROLE: 'handler' }, PORT_B);
  try {
    // A（caller）发起调用，由 B（handler）的消费循环处理
    const fromA = await echo(PORT_A, 'cross-process');
    check(
      'C1 caller 进程调用由另一进程处理（handledBy ≠ callerId 且 driver=redis）',
      isOk(fromA.status) &&
        fromA.body.data?.driver === 'redis' &&
        typeof fromA.body.data?.handledBy === 'string' &&
        fromA.body.data.handledBy !== fromA.body.data.callerId,
      `[http=${fromA.status} handledBy=${fromA.body.data?.handledBy} callerId=${fromA.body.data?.callerId}]`,
    );

    // B（handler）主动调用：同进程投递→自消费→应答，自证往返
    const fromB = await echo(PORT_B, 'handler-self');
    check(
      'C2 handler 进程主动调用自证往返（handledBy === callerId）',
      isOk(fromB.status) && fromB.body.data?.message === 'handler-self' && fromB.body.data.handledBy === fromB.body.data.callerId,
      `[http=${fromB.status} message=${fromB.body.data?.message}]`,
    );

    // caller 角色按设计不处理请求：A 的 handled 计数为 0
    const snapA = await stats(PORT_A);
    const snapB = await stats(PORT_B);
    check(
      'C3 角色语义：caller 进程 handled=0，handler 进程 handled>0',
      snapA.role === 'caller' && snapA.handled === 0 && snapB.role === 'handler' && snapB.handled >= 2,
      `[A.role=${snapA.role} A.handled=${snapA.handled} B.role=${snapB.role} B.handled=${snapB.handled}]`,
    );
  } finally {
    await stopServer(serverA);
    await stopServer(serverB);
  }
}

/** 阶段 D：超时 fail-fast（仅 caller 进程，无处理方；需 SMOKE_REDIS_URL） */
async function phaseTimeoutFailFast() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 D：超时 fail-fast（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 D：超时 fail-fast（无处理方，1500ms 窗口内明确失败）===');
  const server = await startServer({
    TRANSPORT_DRIVER: 'redis',
    TRANSPORT_URL: url,
    TRANSPORT_PREFIX: `fw:smoke-tnt-timeout:${Date.now()}`,
    TRANSPORT_ROLE: 'caller',
    TRANSPORT_TIMEOUT_MS: '1500',
  });
  try {
    const startedAt = Date.now();
    const timedOut = await echo(PORT_A, 'nobody-handles');
    const elapsed = Date.now() - startedAt;
    check(
      'D1 无处理方时调用超时失败（503/9002）而非挂死',
      timedOut.status === 503 && timedOut.body.code === 9002,
      `[http=${timedOut.status} code=${timedOut.body.code}]`,
    );
    check(
      'D2 fail-fast：耗时落在超时窗口内（≥1200ms 且 <6000ms）',
      elapsed >= 1200 && elapsed < 6000,
      `[elapsed=${elapsed}ms]`,
    );

    const snap = await stats(PORT_A);
    check(
      'D3 统计快照：timeouts 与 failures 计数',
      snap.timeouts >= 1 && snap.failures >= 1 && snap.successes === 0,
      `[timeouts=${snap.timeouts} failures=${snap.failures} successes=${snap.successes}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 E：配置守卫（redis 驱动缺连接串必须启动失败） */
async function phaseConfigGuard() {
  console.log('\n=== 阶段 E：配置守卫（TRANSPORT_DRIVER=redis 缺 TRANSPORT_URL 与 CACHE_URL）===');
  const server = await startServer({ TRANSPORT_DRIVER: 'redis', TRANSPORT_URL: '', CACHE_URL: '' }, PORT_A, true);
  const output = server.output();
  check(
    'E1 缺 Redis 连接串时启动即失败并给出明确提示',
    server.exitCode !== 0 && server.exitCode !== 'timeout' && output.includes('TRANSPORT_URL'),
    `[exit=${server.exitCode}]`,
  );
  await stopServer(server);
}

/** 主流程 */
async function main() {
  await phaseInProcess();
  await phaseRedisSingle();
  await phaseRedisDual();
  await phaseTimeoutFailFast();
  await phaseConfigGuard();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟脚本执行失败：', error);
  process.exit(1);
});
