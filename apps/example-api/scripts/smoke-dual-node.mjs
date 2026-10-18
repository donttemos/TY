/**
 * @file 双进程（双节点）缓存与令牌冒烟验证脚本（M12 收尾 · 回归测试设计 §9.4 / 双节点实测方案 §9~§10 的仓库化）
 * @description 单机起两个 example-api 实例（3100/3101），共享同一 Redis 与同一数据库、同一 CACHE_PREFIX，
 *   复现「跨节点」拓扑并在 HTTP 层锁定以下契约（真机 Windows↔云服务器已按同一用例跑过 30/30）：
 *   T2 缓存跨实例读写与标签失效（B 命中 A 写入的缓存；B 标签失效后 A 回源；键↔索引无孤儿）；
 *   T3 跨实例分布式锁互斥（A 持锁期间 B 不可得，A 释放后 B 可得）；
 *   T4 锁 TTL 过期与旧令牌保护（过期后 B 取得且令牌不同；A 旧句柄 renew/release 不伤害 B 的锁）；
 *   T5.1 同一旧 refresh token 经 A/B 并发刷新 ⇒ 唯一的 replacement（grace + 同 UA 指纹）；
 *   T5.2 过期 replay → family revoke（需 DUAL_INCLUDE_REPLAY=1，内含 11s grace 等待）。
 *   门控：未设置 DUAL_REDIS_URL 时整脚本 SKIP（本地无 Redis 的默认形态）；CI base 作业以 redis service 提供。
 *   与 smoke-cache 的区别：本脚本**预置两个长期存活的实例**并发打交叉请求；smoke-cache 是单实例分阶段起停。
 * @author donttemo
 * @created 2026-10-18
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 两个实例的端口（避开 3000 的 M3 冒烟、3100 的 smoke-cache、3200 的 smoke-queue） */
const PORT_A = Number(process.env.DUAL_PORT_A ?? 3120);
const PORT_B = Number(process.env.DUAL_PORT_B ?? 3121);
/** 复用模式：DUAL_A/DUAL_B 指向已在运行的两个实例（真机跨机器场景），本脚本不再自起服务 */
const REUSE_MODE = !!(process.env.DUAL_A && process.env.DUAL_B);
const BASE_A = process.env.DUAL_A ?? `http://127.0.0.1:${PORT_A}`;
const BASE_B = process.env.DUAL_B ?? `http://127.0.0.1:${PORT_B}`;
const REDIS_URL = process.env.DUAL_REDIS_URL;
/**
 * CACHE_PREFIX：自起模式下用随机前缀（避免与既有键混）；复用模式（DUAL_A/DUAL_B）下
 * 两实例的 CACHE_PREFIX 由启动方决定，必须用 DUAL_PREFIX 指认真实前缀，否则键断言与清场都会打空。
 */
const PREFIX = process.env.DUAL_PREFIX ?? `smoke-dual-${Date.now().toString(36)}`;
const CONCURRENCY = Number(process.env.DUAL_CONCURRENCY ?? 20);
const INCLUDE_REPLAY = process.env.DUAL_INCLUDE_REPLAY === '1';
/** 同 UA：轮换 grace 重试绑定赢家指纹，异 UA 会被判 replay（ADR-0022） */
const UA = 'TY-Dual-Node-Smoke';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** 单实例 HTTP 请求 */
async function call(base, path, options) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
}

/**
 * 启动一个实例并等待就绪
 * @param port 监听端口
 * @param env 额外环境变量
 */
async function startServer(port, env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_ENV: 'test',
      CACHE_DRIVER: 'redis',
      CACHE_URL: REDIS_URL,
      CACHE_PREFIX: PREFIX,
      CACHE_FAIL_OPEN: 'false',
      CACHE_LOCK_TTL: '30',
      DEMO_ENDPOINTS_ENABLED: 'true',
      // 放宽 grace 至 30s：CI 慢盘上 20 并发轮换实测 ~10s，会撞默认 10s 窗口边界；
      // 本脚本考的是「并发下唯一 replacement」，不是窗口边界本身（边界由 auth 包单测锁）
      AUTH_REFRESH_GRACE_SECONDS: '30',
      MQ_DRIVER: 'memory',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  for (let i = 0; i < 40; i++) {
    try {
      const { status } = await call(`http://127.0.0.1:${port}`, '/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例 :${port} 20s 内未就绪：\n${output.slice(-1500)}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 管理员令牌（maintenance 类端点与业务端点共用） */
async function loginAdmin(base) {
  const res = await call(base, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'Admin@123456' }),
  });
  return res.body?.data?.accessToken ?? null;
}

/** 清场：删掉本前缀下的所有键（值键 + 标签索引），不触碰其他业务键 */
async function cleanupRedis(redis) {
  try {
    const keys = await redis.keys(`${PREFIX}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* 清场失败不影响断言结论 */
  }
}

async function main() {
  if (!REDIS_URL) {
    console.log('SKIP  未设置 DUAL_REDIS_URL（双进程冒烟需要真实 Redis；CI base 作业由 redis service 提供）');
    return;
  }

  // @fw/cache 与 ioredis 经 example-api 的依赖图解析：
  // ① cache 包的 exports 只声明了 import 条件（无 require），故走 import.meta.resolve + 动态 import；
  // ② ioredis 是 cache 包的依赖（example-api 不直接依赖），以 cache 入口为基准用 createRequire 解析。
  // 全程不硬编码仓库绝对路径，CI/任意检出位置均可用。
  const cacheEntryUrl = import.meta.resolve('@fw/cache');
  const { RedisCacheStore, LockManager } = await import('@fw/cache');
  const Redis = createRequire(cacheEntryUrl)('ioredis');

  const a = REUSE_MODE ? null : await startServer(PORT_A);
  const b = REUSE_MODE ? null : await startServer(PORT_B);
  const redis = new Redis(REDIS_URL);
  try {
    console.log(`\n=== 拓扑：A=${BASE_A} B=${BASE_B}（${REUSE_MODE ? '复用既有实例' : '脚本自起'}）共享 Redis + DB + CACHE_PREFIX=${PREFIX} ===`);

    // ---------- T2 缓存跨实例读写与标签失效 ----------
    console.log('\n—— T2 缓存跨实例读写与标签失效 ——');
    const id = '81731';
    const valuePattern = `${PREFIX}:CacheDemoService:findUser:*`;
    const tagKey = `${PREFIX}:__tag__:demo:user:${id}`;
    const a1 = await call(BASE_A, `/api/v1/demo-cache/find-user?id=${id}`);
    const valueKeys = await redis.keys(valuePattern);
    const members = await redis.smembers(tagKey);
    check('T2.1 A 写入后 Redis 出现共享键且被标签索引追踪', valueKeys.length >= 1 && members.length >= 1, `keys=${valueKeys.length} members=${members.length}`);

    const b1 = await call(BASE_B, `/api/v1/demo-cache/find-user?id=${id}`);
    check('T2.2 B 命中 A 写入的缓存（B 侧 loads=0 未回源）', b1.body?.code === 0 && b1.body?.data?.loads === 0, `B loads=${b1.body?.data?.loads}`);

    const inv = await call(BASE_B, `/api/v1/demo-cache/invalidate?tag=demo:user:${id}`, { method: 'POST' });
    check('T2.3 B 标签失效成功（跨实例可见）', inv.body?.code === 0 && (inv.body?.data?.removed ?? 0) >= 1, `removed=${inv.body?.data?.removed}`);

    const a2 = await call(BASE_A, `/api/v1/demo-cache/find-user?id=${id}`);
    check('T2.4 A 再请求不再命中（回源 loads+1）', a2.body?.data?.loads === (a1.body?.data?.loads ?? 0) + 1, `A loads ${a1.body?.data?.loads}→${a2.body?.data?.loads}`);

    const keysAfter = await redis.keys(valuePattern);
    const membersAfter = await redis.smembers(tagKey);
    check('T2.5 重建后键↔索引一致（无孤儿缓存/幽灵索引）', keysAfter.length >= 1 && membersAfter.length >= 1 && keysAfter.every((k) => membersAfter.includes(k)), `keys=${keysAfter.length} members=${membersAfter.length}`);

    // ---------- T3 跨实例锁互斥 ----------
    console.log('\n—— T3 跨实例分布式锁互斥 ——');
    const lockKey = `t3-${Date.now().toString(36)}`;
    const hold = await call(BASE_A, `/api/v1/demo-cache/lock-hold?key=${lockKey}&ms=4000`, { method: 'POST' });
    check('T3.1 A 持锁成功', hold.body?.code === 0 && hold.body?.data?.acquired === true);
    const busy = await call(BASE_B, `/api/v1/demo-cache/lock-try?key=${lockKey}`);
    check('T3.2 A 持锁期间 B 获取失败', busy.body?.code === 0 && busy.body?.data?.acquired === false, `B=${busy.body?.data?.acquired}`);
    await sleep(4600);
    const after = await call(BASE_B, `/api/v1/demo-cache/lock-try?key=${lockKey}`);
    check('T3.3 A 释放后 B 可取得', after.body?.code === 0 && after.body?.data?.acquired === true);

    // ---------- T4 锁 TTL 与旧令牌保护（直连 LockManager，等价两个进程） ----------
    console.log('\n—— T4 TTL 过期与旧令牌保护 ——');
    const store = new RedisCacheStore(redis);
    const mgrA = new LockManager(store, 30_000);
    const mgrB = new LockManager(store, 30_000);
    const t4Key = `${PREFIX}:t4-lock`;
    const hA = await mgrA.acquire(t4Key, 1200);
    check('T4.1 A 取得短 TTL 锁', hA !== null);
    await sleep(1500);
    const hB = await mgrB.acquire(t4Key, 5000);
    check('T4.2 过期后 B 取得且令牌不同', hB !== null && hB.token !== hA.token);
    check('T4.3 Redis 中是 B 的令牌', (await store.get(t4Key)) === hB.token);
    check('T4.4 A 旧句柄 renew 失败（CAS 不匹配）', (await hA.renew()) === false);
    check('T4.5 A 旧句柄 release 不删 B 的锁', (await store.compareAndDelete(t4Key, hA.token)) === false && (await store.get(t4Key)) === hB.token);
    await hB.release();
    check('T4.6 B 释放后锁消失', (await store.get(t4Key)) === undefined);

    // ---------- T5.1 双实例并发刷新同一旧令牌 ----------
    console.log('\n—— T5.1 跨实例并发刷新（grace + 同 UA） ——');
    const token = await loginAdmin(BASE_A);
    check('T5.0 admin 登录成功（数据库已种子）', !!token);
    if (token) {
      const login = await call(BASE_A, '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'admin', password: 'Admin@123456' }),
      });
      const oldRefresh = login.body?.data?.refreshToken;
      const started = Date.now();
      const res = await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, i) => {
          const base = i % 2 === 0 ? BASE_A : BASE_B;
          const r = await call(base, '/api/v1/auth/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ refreshToken: oldRefresh }),
          });
          return { status: r.status, code: r.body?.code, replacement: r.body?.data?.refreshToken ?? null };
        }),
      );
      const ok = res.filter((r) => r.status >= 200 && r.status < 300 && r.code === 0 && r.replacement);
      const unique = new Set(ok.map((r) => r.replacement));
      // 失败样例打印 http/code：CI 慢盘下 SQLite 串行写可能令部分请求超时（非契约失败），便于区分
      const sample = res.filter((r) => !(r.status >= 200 && r.status < 300 && r.code === 0)).slice(0, 3);
      check('T5.1a 并发刷新全部成功（grace 窗口内）', ok.length === CONCURRENCY, `ok=${ok.length}/${CONCURRENCY} elapsed=${Date.now() - started}ms${sample.length ? ` ${JSON.stringify(sample)}` : ''}`);
      check('T5.1b 唯一 replacement（不产生多个 B）', unique.size === 1, `unique=${unique.size}`);
    }

    // ---------- T5.2 过期 replay → family revoke（可选：含 11s 等待） ----------
    if (INCLUDE_REPLAY) {
      console.log('\n—— T5.2 过期 replay → family revoke ——');
      const login = await call(BASE_A, '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'admin', password: 'Admin@123456' }),
      });
      const tokenA = login.body?.data?.refreshToken;
      const rotate = await call(BASE_B, '/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ refreshToken: tokenA }),
      });
      const tokenB = rotate.body?.data?.refreshToken;
      check('T5.2a 正常轮换得到 replacement', rotate.body?.code === 0 && !!tokenB);
      console.log('  …等待 11s 越过 grace 窗口');
      await sleep(11_000);
      const replay = await call(BASE_A, '/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ refreshToken: tokenA }),
      });
      check('T5.2b 过期旧令牌重放被拒绝', replay.body?.code !== 0, `code=${replay.body?.code}`);
      const revoked = await call(BASE_B, '/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ refreshToken: tokenB }),
      });
      check('T5.2c 同族 replacement 被撤销（family revoke）', revoked.body?.code !== 0, `code=${revoked.body?.code}`);
    }
  } finally {
    await cleanupRedis(redis);
    await redis.quit();
    await stopServer(b);
    await stopServer(a);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error(`\n冒烟脚本执行失败： ${error.message}`);
  process.exitCode = 1;
});
