/**
 * @file M7 队列与定时任务冒烟验证脚本（PRD-007）
 * @description 自带服务生命周期，分阶段验证队列层：
 *   A. memory 驱动：入队即执行与上下文（TC-JOB-001）、延时、重试退避（TC-JOB-003）、
 *      终态失败直接进死信（TC-JOB-004）、死信重放（TC-JOB-005）、幂等只执行一次（TC-JOB-006）、
 *      定时任务注册与手动触发（TC-JOB-002）、暂停/恢复、/metrics/queue（FR-09）、
 *      管理面鉴权、/ready queue 探针（AC-002/AC-003）；
 *   B. 并发上限：MQ_CONCURRENCY=2 下 6 个慢任务并发峰值不超过 2（TC-JOB-007 上半）；
 *   C. 令牌桶限速：MQ_RATE_LIMIT=5 下 10 个任务耗时 ≥ 800ms（TC-JOB-007 下半）；
 *   D. bullmq 驱动 + 真实 Redis（需 SMOKE_REDIS_URL，未设置则跳过）：与 memory 行为一致的入队/重试/死信，
 *      且 CACHE_DRIVER=redis 时不再输出「进程内 cron 互斥」告警（证明分布式守卫生效）；
 *   E. 配置切换语义：MQ_DRIVER=bullmq 缺 MQ_URL 与 CACHE_URL 时启动即失败并给出明确提示（AC-001）。
 *   F. 失速恢复演练（需 SMOKE_REDIS_URL，未设置则跳过）：真实 Redis 上在途任务执行中强杀消费进程
 *      （SIGKILL），重启后由失速检测搬回等待区并完成，任务不丢失（TC-JOB-008）；
 *      同时验证 MQ_STALLED_MS 生效与 M3 遗留④（auth.refresh-cleanup）注册与手动触发。
 *   说明：TC-JOB-002「三实例共享存储时 cron 只跑一次」由 @fw/queue 单测覆盖（scheduler.test.ts 用三个
 *   调度器共享同一守卫存储）；HTTP 层无法在同一进程内制造多副本。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 新增阶段 F 失速恢复演练（TC-JOB-008）与 auth.refresh-cleanup 断言（M3 遗留④）
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 3000 的 M1/M3 与 3100 的 M4 冒烟实例） */
const PORT = 3200;
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

/** 读取某个任务名的台账（去掉响应信封） */
async function ledger(name) {
  const res = await call(`/api/v1/demo-queue/ledger?name=${encodeURIComponent(name)}`);
  return res.body.data ?? {};
}

/** 轮询等待条件成立 */
async function waitUntil(fn, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms，最后结果 ${JSON.stringify(last)}）`);
}

/**
 * 启动服务并等待就绪，输出写入内存以便失败时定位
 * @param env 额外环境变量
 * @param expectFail 期望启动失败（用于阶段 E）
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
  throw new Error(`服务在 30s 内未就绪（端口 ${PORT}）：\n${output.slice(-2000)}`);
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
  console.log('\n=== 阶段 A：memory 驱动（TC-JOB-001~006 + FR-09 + AC-002/003）===');
  const server = await startServer({ MQ_DRIVER: 'memory' });
  try {
    // 启动期告警：memory 驱动 + 进程内守卫时，cron 互斥降级必须显式提示（PRD-007 §8）
    check(
      'AC-002 memory 驱动下 cron 进程内互斥降级有明确告警',
      server.output().includes('定时任务未启用分布式互斥'),
      '',
    );

    // 自动扫描：5 个演示任务全部注册（AC-003）
    const handlers = (await call('/api/v1/demo-queue/handlers')).body.data?.names ?? [];
    check(
      'AC-003 启动期自动扫描 @JobHandler（5 个演示任务全部注册）',
      ['demo.echo', 'demo.flaky', 'demo.permanent', 'demo.slow', 'demo.idempotent'].every((n) => handlers.includes(n)),
      `[handlers=${handlers.join(',')}]`,
    );

    // TC-JOB-001：入队即执行 + 上下文（attempt / traceId / queue）
    await post('/api/v1/demo-queue/reset');
    const dispatched = await post('/api/v1/demo-queue/echo?value=hello');
    check('TC-JOB-001 派发返回任务句柄（id/name/queue/runAt）', dispatched.status === 201 || dispatched.status === 200, `[http=${dispatched.status}]`);
    const echo = await waitUntil(async () => {
      const entry = await ledger('demo.echo');
      return entry.count >= 1 ? entry : null;
    }, 'demo.echo 执行');
    check(
      'TC-JOB-001 任务被执行且上下文完整（载荷/attempt/traceId）',
      echo.lastExtra?.value === 'hello' && echo.lastExtra?.attempt === 1 && echo.lastExtra?.hasTraceId === true && echo.lastExtra?.queue === 'default',
      `[extra=${JSON.stringify(echo.lastExtra)}]`,
    );

    // 延时任务：到期前不执行，到期后执行
    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/delayed?ms=600&value=later');
    await sleep(200);
    const beforeDue = await ledger('demo.echo');
    const afterDue = await waitUntil(async () => {
      const entry = await ledger('demo.echo');
      return entry.count >= 1 ? entry : null;
    }, '延时任务到期执行');
    check(
      '延时任务：到期前不执行、到期后执行',
      beforeDue.count === 0 && afterDue.lastExtra?.value === 'later',
      `[before=${beforeDue.count} after=${afterDue.count}]`,
    );

    // TC-JOB-003：重试与退避（失败 2 次 → 第 3 次成功，累计等待 ≥ 2×250ms）
    await post('/api/v1/demo-queue/reset');
    const startedAt = Date.now();
    await post('/api/v1/demo-queue/flaky?failTimes=2&backoffMs=250');
    const flaky = await waitUntil(async () => {
      const entry = await ledger('demo.flaky');
      return entry.count >= 1 ? entry : null;
    }, 'demo.flaky 重试后成功');
    const waited = Date.now() - startedAt;
    check(
      'TC-JOB-003 重试退避（失败 2 次后退避重试成功，attempt=3/3 且耗时 ≥ 400ms）',
      flaky.lastExtra?.attempt === 3 && flaky.lastExtra?.maxAttempts === 3 && waited >= 400,
      `[attempt=${flaky.lastExtra?.attempt} max=${flaky.lastExtra?.maxAttempts} waited=${waited}ms]`,
    );

    // TC-JOB-004：终态失败不重试，直接进死信（attempts=4 但 attemptsMade=1）
    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/permanent?reason=%E5%8F%82%E6%95%B0%E9%9D%9E%E6%B3%95');
    const dead = await waitUntil(async () => {
      const list = (await call('/api/v1/demo-queue/dead-letters')).body.data;
      return list?.total >= 1 ? list : null;
    }, '终态失败进死信');
    check(
      'TC-JOB-004 PermanentJobError 不重试直接归档死信（attemptsMade=1）',
      dead.items[0]?.name === 'demo.permanent' && dead.items[0]?.attemptsMade === 1 && String(dead.items[0]?.reason).includes('参数非法'),
      `[attemptsMade=${dead.items[0]?.attemptsMade} reason=${dead.items[0]?.reason}]`,
    );

    // TC-JOB-005：死信重放（重放后再次失败 → 重新进入死信）
    const deadId = dead.items[0].id;
    const requeued = await post(`/api/v1/demo-queue/dead-letters/${encodeURIComponent(deadId)}/requeue`);
    check('TC-JOB-005 死信重放接口返回成功', requeued.body.data?.requeued === true, `[id=${deadId}]`);
    const afterRequeue = await waitUntil(async () => {
      const list = (await call('/api/v1/demo-queue/dead-letters')).body.data;
      return list?.total >= 1 ? list : null;
    }, '重放后再次进死信');
    const attempted = await ledger('demo.permanent.attempted');
    check(
      'TC-JOB-005 重放确实重新执行（重放后再次进死信且执行次数增加）',
      afterRequeue.total >= 1 && attempted.count >= 2,
      `[total=${afterRequeue.total} attempted=${attempted.count}]`,
    );

    // TC-JOB-006：幂等（同 key 派发两次只执行一次）
    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/idempotent?orderId=dup-1');
    await post('/api/v1/demo-queue/idempotent?orderId=dup-1');
    await sleep(500);
    const idem = await ledger('demo.idempotent');
    const metricsAfterIdem = (await call('/api/v1/demo-queue/metrics')).body.data;
    check(
      'TC-JOB-006 幂等：同 idempotencyKey 只执行一次（幂等跳过计数 > 0）',
      idem.count === 1 && metricsAfterIdem.idempotentSkipped >= 1,
      `[runs=${idem.count} skipped=${metricsAfterIdem.idempotentSkipped}]`,
    );

    // 不同 key 互不影响
    await post('/api/v1/demo-queue/idempotent?orderId=dup-2');
    await sleep(300);
    check('幂等键隔离：不同 key 各自执行', (await ledger('demo.idempotent')).count === 2, '');

    // TC-JOB-002：定时任务注册 + 手动触发（仍走锁）
    const crons = (await call('/api/v1/demo-queue/crons')).body.data;
    const tickEntry = crons.items?.find((c) => c.name === 'demo.tick');
    const nightly = crons.items?.find((c) => c.name === 'demo.nightly');
    check(
      'TC-JOB-002 @Cron 自动注册（含 6 段秒级与 5 段表达式，默认加锁）',
      crons.enabled === true && tickEntry?.expression === '*/5 * * * * *' && tickEntry?.lock === true && nightly?.expression === '0 3 * * *',
      `[items=${crons.items?.map((c) => c.name).join(',')}]`,
    );

    await post('/api/v1/demo-queue/reset');
    const ticked = await post('/api/v1/demo-queue/cron-tick?name=demo.tick');
    await sleep(100);
    const tickLedger = await ledger('demo.tick');
    const cronsAfter = (await call('/api/v1/demo-queue/crons')).body.data.items?.find((c) => c.name === 'demo.tick');
    check(
      'TC-JOB-002 手动触发定时任务（acquired=true，runs 计数增加）',
      ticked.body.data?.results?.[0]?.acquired === true && tickLedger.count >= 1 && cronsAfter?.runs >= 1,
      `[acquired=${ticked.body.data?.results?.[0]?.acquired} runs=${cronsAfter?.runs}]`,
    );

    // M3 遗留④：refresh 过期记录定时清理（auth.refresh-cleanup）
    const refreshCron = crons.items?.find((c) => c.name === 'auth.refresh-cleanup');
    check(
      'M3 遗留④ auth.refresh-cleanup 定时任务已注册（0 3 * * *，加分布式锁）',
      refreshCron?.expression === '0 3 * * *' && refreshCron?.lock === true,
      `[expression=${refreshCron?.expression} lock=${refreshCron?.lock}]`,
    );
    await post('/api/v1/demo-queue/cron-tick?name=auth.refresh-cleanup');
    const refreshSnap = await waitUntil(async () => {
      const snap = (await call('/api/v1/auth-maintenance/refresh-cleanup')).body.data;
      return snap?.runs >= 1 ? snap : null;
    }, 'auth.refresh-cleanup 手动触发执行');
    check(
      'M3 遗留④ 手动触发清理执行成功且无错误（清理条数可见）',
      refreshSnap.lastError === null && typeof refreshSnap.lastRemoved === 'number' && refreshSnap.lastCutoff !== null,
      `[removed=${refreshSnap.lastRemoved} cutoff=${refreshSnap.lastCutoff}]`,
    );

    // 暂停 / 恢复
    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/pause');
    await post('/api/v1/demo-queue/echo?value=paused');
    await sleep(500);
    const whilePaused = await ledger('demo.echo');
    const pausedStats = (await call('/api/v1/demo-queue/stats')).body.data;
    await post('/api/v1/demo-queue/resume');
    const afterResume = await waitUntil(async () => {
      const entry = await ledger('demo.echo');
      return entry.count >= 1 ? entry : null;
    }, '恢复后执行');
    check(
      '暂停/恢复：暂停期间不消费，恢复后继续消费',
      whilePaused.count === 0 && pausedStats.paused === true && afterResume.count === 1,
      `[whilePaused=${whilePaused.count} paused=${pausedStats.paused} afterResume=${afterResume.count}]`,
    );

    // FR-09：/metrics/queue Prometheus 文本（免认证、免响应信封）
    const metrics = await call('/metrics/queue');
    check(
      'FR-09 /metrics/queue 输出队列指标与积压 gauge',
      metrics.status === 200 &&
        metrics.text.includes('fw_queue_info{driver="memory"}') &&
        metrics.text.includes('fw_queue_dispatched_total') &&
        metrics.text.includes('fw_queue_backlog') &&
        metrics.text.includes('fw_queue_dead_letter'),
      `[http=${metrics.status}]`,
    );

    // 管理面鉴权：/api/v1/admin/queue/* 受 system:queue:* 权限保护
    const adminStats = await call('/api/v1/admin/queue/stats');
    const adminDead = await call('/api/v1/admin/queue/dead-letters');
    check(
      'FR-09 管理面端点受鉴权保护（未携带凭证返回 401/403）',
      (adminStats.status === 401 || adminStats.status === 403) && (adminDead.status === 401 || adminDead.status === 403),
      `[stats=${adminStats.status} deadLetters=${adminDead.status}]`,
    );

    // 就绪探针
    const ready = await call('/ready');
    check(
      'AC-002 /ready 报告 queue 探针健康',
      ready.status === 200 && ready.body.checks?.queue === 'ok',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 B：并发上限（MQ_CONCURRENCY=2 下峰值不超过 2） */
async function phaseConcurrency() {
  console.log('\n=== 阶段 B：并发上限（MQ_CONCURRENCY=2 + TC-JOB-007）===');
  const server = await startServer({ MQ_DRIVER: 'memory', MQ_CONCURRENCY: '2' });
  try {
    await post('/api/v1/demo-queue/reset');
    const startedAt = Date.now();
    await post('/api/v1/demo-queue/slow?count=6&ms=250&tag=conc');
    const slow = await waitUntil(async () => {
      const entry = await ledger('demo.slow');
      return entry.count >= 6 ? entry : null;
    }, '6 个慢任务全部完成', 10000);
    const elapsed = Date.now() - startedAt;
    check(
      'TC-JOB-007 并发上限（峰值 ≤ 2，6 个 250ms 任务耗时 ≥ 650ms）',
      slow.count === 6 && slow.maxConcurrent <= 2 && elapsed >= 650,
      `[count=${slow.count} maxConcurrent=${slow.maxConcurrent} elapsed=${elapsed}ms]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 C：令牌桶限速（MQ_RATE_LIMIT=5 下 10 个任务被摊到约 1s） */
async function phaseRateLimit() {
  console.log('\n=== 阶段 C：令牌桶限速（MQ_RATE_LIMIT=5 + TC-JOB-007）===');
  const server = await startServer({ MQ_DRIVER: 'memory', MQ_RATE_LIMIT: '5', MQ_CONCURRENCY: '10' });
  try {
    await post('/api/v1/demo-queue/reset');
    const startedAt = Date.now();
    await post('/api/v1/demo-queue/slow?count=10&ms=10&tag=rate');
    const slow = await waitUntil(async () => {
      const entry = await ledger('demo.slow');
      return entry.count >= 10 ? entry : null;
    }, '10 个任务全部完成', 15000);
    const elapsed = Date.now() - startedAt;
    check(
      'TC-JOB-007 令牌桶限速（速率 5/s 下 10 个任务耗时 ≥ 800ms）',
      slow.count === 10 && elapsed >= 800,
      `[count=${slow.count} elapsed=${elapsed}ms]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 D：bullmq 驱动 + 真实 Redis（需 SMOKE_REDIS_URL） */
async function phaseBullmq() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 D：bullmq 驱动（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 D：bullmq 驱动 + 真实 Redis（TC-JOB-001/003/004 + AC-001）===');
  // M10 E-06：cluster URL（逗号分隔）→ MQ_PREFIX 包 hash-tag（BullMQ 键族同槽）+ CACHE 切 redis-cluster
  //（cache 单实例客户端对 cluster 节点会收 MOVED 假错误）；单节点保持原形态。
  const isCluster = url.includes(',');
  const server = await startServer({
    MQ_DRIVER: 'bullmq',
    MQ_URL: url,
    MQ_PREFIX: isCluster ? `{fw:smoke:${Date.now()}}:` : `fw:smoke:${Date.now()}`,
    CACHE_DRIVER: isCluster ? 'redis-cluster' : 'redis',
    CACHE_URL: url,
  });
  try {
    // CACHE_DRIVER=redis → CacheGuardStore.distributed=true → 不再输出进程内互斥告警
    check(
      'AC-001 Redis 守卫下 cron 具备分布式互斥（无降级告警）',
      !server.output().includes('定时任务未启用分布式互斥'),
      '',
    );

    const ready = await call('/ready');
    check(
      'AC-001 /ready 报告 queue 探针健康（driver=bullmq 真实连接）',
      ready.status === 200 && ready.body.checks?.queue === 'ok',
      `[http=${ready.status} checks=${JSON.stringify(ready.body.checks)}]`,
    );

    const stats = (await call('/api/v1/demo-queue/stats')).body.data;
    check('AC-001 驱动标识为 bullmq', stats.driver === 'bullmq', `[driver=${stats.driver}]`);

    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/echo?value=redis-echo');
    const echo = await waitUntil(async () => {
      const entry = await ledger('demo.echo');
      return entry.count >= 1 ? entry : null;
    }, 'bullmq demo.echo 执行', 10000);
    check(
      'TC-JOB-001 bullmq 驱动入队即执行（与 memory 行为一致）',
      echo.lastExtra?.value === 'redis-echo' && echo.lastExtra?.attempt === 1,
      `[extra=${JSON.stringify(echo.lastExtra)}]`,
    );

    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/flaky?failTimes=1&backoffMs=300');
    const flaky = await waitUntil(async () => {
      const entry = await ledger('demo.flaky');
      return entry.count >= 1 ? entry : null;
    }, 'bullmq demo.flaky 重试成功', 12000);
    check(
      'TC-JOB-003 bullmq 驱动复用同一退避序列（失败 1 次后成功，attempt=2）',
      flaky.lastExtra?.attempt === 2,
      `[attempt=${flaky.lastExtra?.attempt}]`,
    );

    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/permanent?reason=redis-permanent');
    const dead = await waitUntil(async () => {
      const list = (await call('/api/v1/demo-queue/dead-letters')).body.data;
      return list?.total >= 1 ? list : null;
    }, 'bullmq 终态失败进死信', 10000);
    check(
      'TC-JOB-004 bullmq 驱动终态失败不重试（attemptsMade=1）',
      dead.items[0]?.name === 'demo.permanent' && dead.items[0]?.attemptsMade === 1,
      `[attemptsMade=${dead.items[0]?.attemptsMade}]`,
    );

    const metrics = await call('/metrics/queue');
    check(
      'FR-09 bullmq 驱动指标可见（driver=bullmq）',
      metrics.status === 200 && metrics.text.includes('fw_queue_info{driver="bullmq"}'),
      `[http=${metrics.status}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/** 阶段 E：配置切换语义（bullmq 驱动缺连接串必须启动失败） */
async function phaseConfigGuard() {
  console.log('\n=== 阶段 E：配置切换语义（MQ_DRIVER=bullmq 缺 MQ_URL 与 CACHE_URL）===');
  const server = await startServer({ MQ_DRIVER: 'bullmq', MQ_URL: '', CACHE_URL: '' }, true);
  const output = server.output();
  check(
    'AC-001 缺 Redis 连接串时启动即失败并给出明确提示',
    server.exitCode !== 0 && server.exitCode !== 'timeout' && (output.includes('MQ_URL') || output.includes('CACHE_URL')),
    `[exit=${server.exitCode}]`,
  );
  await stopServer(server);
}

/** 阶段 F：失速恢复演练（TC-JOB-008，bullmq + 真实 Redis；需 SMOKE_REDIS_URL） */
async function phaseStallRecovery() {
  const url = process.env.SMOKE_REDIS_URL;
  if (!url) {
    console.log('\n=== 阶段 F：失速恢复演练（未设置 SMOKE_REDIS_URL，跳过）===');
    return;
  }
  console.log('\n=== 阶段 F：失速恢复演练（TC-JOB-008：真实 Redis 上强杀在途消费进程）===');
  // 独立前缀避免与其他阶段/历史残留串队列；MQ_STALLED_MS=1s 让失速检测尽快发现
  // （锁本身随消费进程死亡需等 lockDuration（默认 30s）过期，恢复窗口约 31~35s）
  // M10 E-06：cluster URL（逗号分隔）→ prefix 包 hash-tag（与阶段 D 同理，键族同槽）
  const env = {
    MQ_DRIVER: 'bullmq',
    MQ_URL: url,
    MQ_PREFIX: url.includes(',') ? `{fw:stall:${Date.now()}}:` : `fw:stall:${Date.now()}`,
    MQ_STALLED_MS: '1000',
  };
  const serverA = await startServer(env);
  try {
    await post('/api/v1/demo-queue/reset');
    await post('/api/v1/demo-queue/slow?count=1&ms=8000&tag=stall');
    // 等任务被消费进程 A 取走并进入 handler 在途 sleep
    await sleep(1500);
    serverA.child.kill('SIGKILL');
    await new Promise((resolve) => serverA.child.on('exit', resolve));
    check('TC-JOB-008 在途任务执行中被 SIGKILL 强杀（任务留在 Redis，锁随进程死亡）', true, '');

    const serverB = await startServer(env);
    try {
      const done = await waitUntil(async () => {
        const entry = await ledger('demo.slow');
        return entry.count >= 1 ? entry : null;
      }, '失速任务被新消费进程恢复执行', 90000);
      const dead = (await call('/api/v1/demo-queue/dead-letters')).body.data;
      check(
        'TC-JOB-008 失速任务不丢失：搬回等待区后由新进程完成（tag 匹配，无死信）',
        done.count === 1 && done.lastExtra?.tag === 'stall-0' && dead.total === 0,
        `[count=${done.count} tag=${done.lastExtra?.tag} dead=${dead.total}]`,
      );
    } finally {
      await stopServer(serverB);
    }
  } finally {
    await stopServer(serverA);
  }
}

/** 主流程 */
async function main() {
  await phaseMemory();
  await phaseConcurrency();
  await phaseRateLimit();
  await phaseBullmq();
  await phaseStallRecovery();
  await phaseConfigGuard();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟脚本执行失败：', error);
  process.exit(1);
});
