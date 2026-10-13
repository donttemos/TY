/**
 * @file M4 缓存层冒烟验证脚本（PRD-004）
 * @description 自带服务生命周期，分三阶段验证缓存层：
 *   A. memory 驱动：统一接口/命中回源（TC-CACHE-002）、标签失效（003）、单飞（004）、
 *      空值占位（005）、分布式锁只跑一次（009）、/metrics 命中率（AC-008）；
 *   B. redis 驱动且不可达 + CACHE_FAIL_OPEN=true：业务照常返回、指标体现降级、
 *      /ready 报告依赖不可用（TC-CACHE-007）；
 *   C. redis 驱动缺 CACHE_URL：启动即失败并给出明确提示（AC-002 配置切换语义）。
 *   D. redis 驱动 + 真实远端实例（需 SMOKE_REDIS_URL，未设置则跳过）：真实读写/命中/标签失效/
 *      分布式锁，并以「零降级 + /ready cache=ok」证明连接真实建立而非静默降级。
 *   说明：TC-CACHE-001「memory→redis 行为一致」由 @fw/cache 单测覆盖（同一套用例跑 memory 与 Fake Redis 客户端）；
 *   TC-CACHE-006（TTL 抖动）与 TC-CACHE-010（大 key）为单测覆盖；TC-CACHE-008（恢复回切）为单测覆盖
 *   （HTTP 层无法制造「Redis 先坏后好」的时序）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 新增阶段 D：真实远端 Redis 实例联调（SMOKE_REDIS_URL 门控）
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 CI 中 3000 端口的 M3 冒烟实例） */
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const results = [];

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

/** POST 空体请求 */
const post = (path) => call(path, { method: 'POST' });

/**
 * 启动服务并等待就绪，输出写入内存以便失败时定位
 * @param env 额外环境变量
 * @param expectFail 期望启动失败（用于阶段 C）
 */
async function startServer(env, expectFail = false) {
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
      const { status } = await call('/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 20s 内未就绪（端口 ${PORT}）：\n${output.slice(-2000)}`);
}

/** 停止服务并等待退出 */
async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 阶段 A：memory 驱动全量能力 */
async function phaseMemory() {
  console.log('\n=== 阶段 A：memory 驱动（TC-CACHE-002/003/004/005/009 + AC-008）===');
  const server = await startServer({ CACHE_DRIVER: 'memory' });
  try {
    // 统一接口 + 驱动标识
    const putPick = await call('/api/v1/demo-cache/put-and-pick?key=k1&value=v1');
    check(
      'TC-CACHE-002 统一接口（写入后读回 + 驱动为 memory）',
      putPick.status === 200 && putPick.body.data?.value === 'v1' && putPick.body.data?.driver === 'memory',
      `[http=${putPick.status} value=${putPick.body.data?.value}]`,
    );

    // 命中与回源：同 id 第二次不回源
    await post('/api/v1/demo-cache/reset');
    const first = await call('/api/v1/demo-cache/find-user?id=77');
    const second = await call('/api/v1/demo-cache/find-user?id=77');
    check(
      'TC-CACHE-002 @Cacheable 命中（第二次不回源）',
      first.body.data?.loads === 1 && second.body.data?.loads === 1 && second.body.data?.user?.id === '77',
      `[loads=${first.body.data?.loads}→${second.body.data?.loads}]`,
    );

    // 防击穿：100 并发同一热点 key，回源 1 次
    await post('/api/v1/demo-cache/reset');
    const hotKey = `hot-${Date.now()}`;
    const parallel = await Promise.all(
      Array.from({ length: 100 }, () => call(`/api/v1/demo-cache/wrap?key=${hotKey}&delayMs=250`)),
    );
    const hotLoads = (await call(`/api/v1/demo-cache/loads?key=item:${hotKey}`)).body.data?.loads;
    const merged = (await call('/api/v1/demo-cache/stats')).body.data?.singleFlightMerged ?? 0;
    check(
      'TC-CACHE-004 防击穿（100 并发回源 1 次）',
      parallel.every((r) => r.status === 200) && hotLoads === 1 && merged >= 50,
      `[loads=${hotLoads} 单飞合并=${merged}]`,
    );

    // 防穿透：不存在的 key 10 并发只回源 1 次，且写入空值占位
    await post('/api/v1/demo-cache/reset');
    const ghostKey = `ghost-${Date.now()}`;
    const ghosts = await Promise.all(
      Array.from({ length: 10 }, () => call(`/api/v1/demo-cache/wrap-miss?key=${ghostKey}&delayMs=120`)),
    );
    const afterGhost = await call(`/api/v1/demo-cache/wrap-miss?key=${ghostKey}`);
    const ghostLoads = (await call(`/api/v1/demo-cache/loads?key=item:${ghostKey}`)).body.data?.loads;
    check(
      'TC-CACHE-005 防穿透（空值占位 + 10 并发回源 1 次）',
      ghosts.every((r) => r.status === 200 && r.body.data?.value === undefined) && afterGhost.body.data?.value === undefined && ghostLoads === 1,
      `[loads=${ghostLoads}]`,
    );

    // 标签失效：改数据后按标签失效，重新回源
    await post('/api/v1/demo-cache/reset');
    await call('/api/v1/demo-cache/find-user?id=88');
    const invalidated = await post('/api/v1/demo-cache/invalidate?tag=demo:user:88');
    const afterInvalidate = await call('/api/v1/demo-cache/find-user?id=88');
    check(
      'TC-CACHE-003 标签失效（失效后重新回源）',
      invalidated.body.data?.removed >= 1 && afterInvalidate.body.data?.loads === 2,
      `[removed=${invalidated.body.data?.removed} loads=${afterInvalidate.body.data?.loads}]`,
    );

    // 分布式锁：持锁期间第二个请求拿不到，释放后可获取
    const lockKey = `job-${Date.now()}`;
    const held = await post(`/api/v1/demo-cache/lock-hold?key=${lockKey}&ms=1200`);
    const blocked = await call(`/api/v1/demo-cache/lock-try?key=${lockKey}`);
    await sleep(1400);
    const freed = await call(`/api/v1/demo-cache/lock-try?key=${lockKey}`);
    check(
      'TC-CACHE-009 分布式锁（持锁期间互斥，释放后可获取）',
      held.body.data?.acquired === true && blocked.body.data?.acquired === false && freed.body.data?.acquired === true,
      `[hold=${held.body.data?.acquired} blocked=${blocked.body.data?.acquired} after=${freed.body.data?.acquired}]`,
    );

    // 指标：命中率与 Prometheus 文本
    const stats = (await call('/api/v1/demo-cache/stats')).body.data;
    const metrics = await call('/metrics');
    check(
      'AC-008 /metrics 可见命中率（hitRate > 0）',
      stats.hitRate > 0 && metrics.status === 200 && metrics.text.includes('fw_cache_hit_rate') && metrics.text.includes('fw_cache_info{driver="memory"}'),
      `[hitRate=${stats.hitRate} hits=${stats.hits} misses=${stats.misses}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 B：redis 驱动不可达 + fail-open 降级 */
async function phaseDegrade() {
  console.log('\n=== 阶段 B：redis 不可达 + CACHE_FAIL_OPEN=true（TC-CACHE-007）===');
  const server = await startServer({
    CACHE_DRIVER: 'redis',
    CACHE_URL: 'redis://127.0.0.1:6399',
    CACHE_FAIL_OPEN: 'true',
  });
  try {
    const biz = await call('/api/v1/demo-cache/find-user?id=99');
    check(
      'TC-CACHE-007 缓存依赖故障时业务仍正确返回（降级直查）',
      biz.status === 200 && biz.body.data?.user?.id === '99' && biz.body.data?.loads === 1,
      `[http=${biz.status} user=${biz.body.data?.user?.id}]`,
    );

    const stats = (await call('/api/v1/demo-cache/stats')).body.data;
    check(
      'TC-CACHE-007 降级可见：driver=redis 且 degradations > 0',
      stats.driver === 'redis' && stats.degradations > 0,
      `[driver=${stats.driver} degradations=${stats.degradations}]`,
    );

    const metrics = await call('/metrics');
    check(
      '降级指标暴露到 /metrics（degradations_total / errors_total）',
      metrics.text.includes('fw_cache_info{driver="redis"}') && metrics.text.includes('fw_cache_degradations_total'),
      `[http=${metrics.status}]`,
    );

    const ready = await call('/ready');
    check(
      '运维语义：/ready 报告 cache 依赖不可用（503），业务接口不受影响',
      ready.status === 503 && ready.body.checks?.cache === 'fail',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 C：配置切换语义（redis 驱动缺连接串必须启动失败） */
async function phaseConfigGuard() {
  console.log('\n=== 阶段 C：配置切换语义（CACHE_DRIVER=redis 缺 CACHE_URL）===');
  const server = await startServer({ CACHE_DRIVER: 'redis', CACHE_URL: '' }, true);
  const output = server.output();
  check(
    'AC-002 缺 CACHE_URL 时启动即失败并给出明确提示',
    server.exitCode !== 0 && server.exitCode !== 'timeout' && output.includes('CACHE_URL'),
    `[exit=${server.exitCode}]`,
  );
  await stopServer(server);
}

/** 阶段 D：真实 Redis 驱动（需 SMOKE_REDIS_URL，未设置则跳过） */
async function phaseRealRedis() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 D：真实 Redis（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 D：真实 Redis 驱动（TC-CACHE-001/002/003/009 + 连通性）===');
  // CACHE_FAIL_OPEN=true：若连接失败会静默降级，故 D1/D2/D6 断言「无降级」以证明连接真实建立
  const server = await startServer({ CACHE_DRIVER: 'redis', CACHE_URL: url, CACHE_FAIL_OPEN: 'true' });
  try {
    const putPick = await call('/api/v1/demo-cache/put-and-pick?key=redis-k1&value=redis-v1');
    check(
      'D1 redis 驱动真实读写（driver=redis）',
      putPick.status === 200 && putPick.body.data?.value === 'redis-v1' && putPick.body.data?.driver === 'redis',
      `[http=${putPick.status} value=${putPick.body.data?.value}]`,
    );

    const ready = await call('/ready');
    check(
      'D2 /ready 报告 cache 依赖健康（200 / cache=ok）——证明连接真实可用而非降级',
      ready.status === 200 && ready.body.checks?.cache === 'ok',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );

    await post('/api/v1/demo-cache/reset');
    const first = await call('/api/v1/demo-cache/find-user?id=177');
    const second = await call('/api/v1/demo-cache/find-user?id=177');
    check(
      'D3 @Cacheable 命中（redis 第二次不回源，与 memory 行为一致）',
      first.body.data?.loads === 1 && second.body.data?.loads === 1 && second.body.data?.user?.id === '177',
      `[loads=${first.body.data?.loads}→${second.body.data?.loads}]`,
    );

    await post('/api/v1/demo-cache/reset');
    await call('/api/v1/demo-cache/find-user?id=188');
    const invalidated = await post('/api/v1/demo-cache/invalidate?tag=demo:user:188');
    const afterInvalidate = await call('/api/v1/demo-cache/find-user?id=188');
    check(
      'D4 标签失效（redis 侧真实删除键并重新回源）',
      invalidated.body.data?.removed >= 1 && afterInvalidate.body.data?.loads === 2,
      `[removed=${invalidated.body.data?.removed} loads=${afterInvalidate.body.data?.loads}]`,
    );

    const lockKey = `redis-job-${Date.now()}`;
    const held = await post(`/api/v1/demo-cache/lock-hold?key=${lockKey}&ms=1200`);
    const blocked = await call(`/api/v1/demo-cache/lock-try?key=${lockKey}`);
    await sleep(1400);
    const freed = await call(`/api/v1/demo-cache/lock-try?key=${lockKey}`);
    check(
      'D5 分布式锁（redis SET NX PX 互斥 + TTL 到期自动释放）',
      held.body.data?.acquired === true && blocked.body.data?.acquired === false && freed.body.data?.acquired === true,
      `[hold=${held.body.data?.acquired} blocked=${blocked.body.data?.acquired} after=${freed.body.data?.acquired}]`,
    );

    const stats = (await call('/api/v1/demo-cache/stats')).body.data;
    const metrics = await call('/metrics');
    check(
      'D6 全程零降级 + /metrics 暴露 driver=redis',
      stats.degradations === 0 && stats.hitRate > 0 && metrics.text.includes('fw_cache_info{driver="redis"}'),
      `[degradations=${stats.degradations} hitRate=${stats.hitRate}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 主流程 */
async function main() {
  await phaseMemory();
  await phaseDegrade();
  await phaseConfigGuard();
  await phaseRealRedis();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟脚本执行失败：', error);
  process.exit(1);
});
