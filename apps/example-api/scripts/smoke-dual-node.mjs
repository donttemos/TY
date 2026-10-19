/**
 * @file 双进程（双节点）缓存与令牌冒烟验证脚本（M12 收尾 · 回归测试设计 §9.4 / 双节点实测方案 §9~§10 的仓库化）
 * @author donttemo
 * @created 2026-10-18
 * @description 单机起两个 example-api 实例（3120/3121），共享同一 Redis 与同一数据库、同一 CACHE_PREFIX，
 *   复现「跨节点」拓扑并在 HTTP 层锁定以下契约（真机 Windows↔云服务器已按同一用例跑过 30/30）：
 *   T0 清场前置：实例前缀核对（两节点实际 CACHE_PREFIX 必须等于 DUAL_PREFIX）后，只清本测试命名空间；
 *   T2 缓存跨实例读写与标签失效（B 命中 A 写入的缓存；B 标签失效后 A 回源；键↔索引无孤儿）；
 *   T3 跨实例分布式锁互斥；T4 锁 TTL 过期与旧令牌保护；
 *   T5.1 同一旧 refresh token 经 A/B 并发刷新 ⇒ 唯一的 replacement（grace + 同 UA 指纹）；
 *   T5.1c 异 UA 的 grace 重试必须被拒绝（指纹绑定，兼作 AUTH_FINGERPRINT 配置漂移探针）；
 *   T5.2 过期 replay → family revoke（需 DUAL_INCLUDE_REPLAY=1，内含 11s grace 等待）。
 *   门控：未设置 DUAL_REDIS_URL 时整脚本 SKIP（本地无 Redis 的默认形态）；CI base 作业以 redis service 提供。
 *   与 smoke-cache 的区别：本脚本**预置两个长期存活的实例**并发打交叉请求；smoke-cache 是单实例分阶段起停。
 *
 *   安全边界（2026-10-18/19 复核加固）：
 *   ① 前缀是清场删除的唯一判据：复用模式强制显式 DUAL_PREFIX；只允许 [A-Za-z0-9._:-]（禁 glob 元字符/空白）；
 *      需带测试语义段（smoke/test/it/tmp/temp），否则须 DUAL_PREFIX_ACK=1；
 *   ② 清场前读两实例实际 CACHE_PREFIX（/api/v1/demo-cache/stats）核对，不一致立即中止；
 *   ③ 只删本脚本命名空间（CacheDemoService: / __tag__:demo: / lock:demo: / t4-lock），绝不全前缀删；
 *   ④ 全程不用 KEYS：断言与清场走 SCAN 游标，删除按 DUAL_CLEANUP_BATCH_SIZE 分批；键范围/数量在收集阶段
 *      校验，超限即中止且零删除；
 *   ⑤ 清场失败记为 FAIL 并让脚本非 0 退出；嵌套 try/finally 保证断连也回收子进程；
 *   ⑥ 数据库副作用保护：T5.1c/T5.2 会在数据库层撤销该账号**全部** refresh 会话（handleReplay →
 *      revokeUserRefreshTokens），默认跳过；开启需 DUAL_ALLOW_SESSION_REVOKE=1 + 专用账号（默认 alice，
 *      在 admin 上执行需再显式 DUAL_ALLOW_ADMIN_REVOKE=1）。
 * @modified 2026-10-18 donttemo 复核修复（P1）：前缀安全校验 + 双实例前缀核对 + 限定范围清场 + 清理失败
 *   显式报错 + 嵌套 try/finally；新增 T5.1c。复核二轮：KEYS 全换 SCAN 游标 + 分批 DEL + 安全开关正整数解析。
 * @modified 2026-10-19 donttemo 复核三轮（P1 数据库副作用）：T5.1c / T5.2 默认跳过 + 专用账号与环境保护。
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
const CONCURRENCY = Number(process.env.DUAL_CONCURRENCY ?? 20);
const INCLUDE_REPLAY = process.env.DUAL_INCLUDE_REPLAY === '1';
/**
 * 认证破坏性用例开关（2026-10-19 复核）：T5.1c（异 UA replay）与 T5.2（过期 replay）会进入
 * refresh-token.service 的 handleReplay → revokeUserRefreshTokens，在**数据库层**撤销该账号的
 * 全部 refresh 会话（与 Redis 清场无关）。默认关闭，避免复用共享实例时踢掉操作者/真实用户。
 */
const ALLOW_SESSION_REVOKE = process.env.DUAL_ALLOW_SESSION_REVOKE === '1';
/** 二次例外：明确允许在 admin 账号上执行破坏性用例（默认要求改用专用测试账号） */
const ALLOW_ADMIN_REVOKE = process.env.DUAL_ALLOW_ADMIN_REVOKE === '1';
/** 种子账号的默认口令（演示数据，非生产凭据；仅用于本地/CI 已 seed 的库） */
const SEEDED_PASSWORDS = { admin: 'Admin@123456', alice: 'Alice@123456' };
/** 同 UA：轮换 grace 重试绑定赢家指纹，异 UA 会被判 replay（ADR-0022） */
const UA = 'TY-Dual-Node-Smoke';

/**
 * 本脚本独占的键命名空间（相对 `${PREFIX}:`）：值键 / 标签索引 / 演示锁 / T4 直连锁。
 * 清场只允许删除这些范围——复用既有实例时同前缀下可能有业务键，绝不按 `${PREFIX}:*` 全量删。
 */
const OWNED_NAMESPACES = ['CacheDemoService:', '__tag__:demo:', 'lock:demo:', 't4-lock'];

/** 前缀合法字符集：禁止空白与 glob 元字符（* ? [ ]），防止 MATCH 通配扩大范围 */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/;
/** 测试语义段（按 [.:_-] 分词后必须命中其一，否则要求 DUAL_PREFIX_ACK=1 显式确认） */
const TEST_MARKER_TOKENS = new Set(['smoke', 'test', 'tests', 'it', 'tmp', 'temp']);
/** 单次清场允许删除的键数上限（前缀配错时的熔断，防「一次删掉一大片」）；main 入口处解析校验 */
let CLEANUP_MAX_KEYS = 5000;
/** SCAN 单次 COUNT（提示值，Redis 不保证每次返回数量）——断言与清场都走 SCAN，不用阻塞式 KEYS */
let SCAN_COUNT = 500;
/** 清场每批 DEL 的键数：分批删除，避免单条命令参数过多拖住服务端 */
let CLEANUP_DELETE_BATCH = 500;

/** 本次运行的前缀（由 resolvePrefix 在 main 中赋值；SKIP 路径不需要前缀） */
let PREFIX = '';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * 读取正整数环境变量：安全开关非法时 fail-fast，不静默回落默认值（否则「以为收紧、实际放宽」）。
 * @param name 变量名
 * @param fallback 未设置时的缺省值
 * @returns 正整数
 */
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须为正整数：收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * 解析清场/扫描相关安全开关（在 main 入口调用，非法值走统一错误输出而不是模块加载期堆栈）。
 */
function initCleanupLimits() {
  CLEANUP_MAX_KEYS = positiveIntEnv('DUAL_CLEANUP_MAX_KEYS', 5000);
  SCAN_COUNT = positiveIntEnv('DUAL_SCAN_COUNT', 500);
  CLEANUP_DELETE_BATCH = positiveIntEnv('DUAL_CLEANUP_BATCH_SIZE', 500);
}

/**
 * 计算并校验本次运行使用的 CACHE_PREFIX（安全边界见文件头 ①②）。
 * @returns 已校验的前缀
 */
function resolvePrefix() {
  const explicit = process.env.DUAL_PREFIX?.trim() ?? '';
  if (REUSE_MODE && explicit === '') {
    throw new Error(
      '复用模式（DUAL_A/DUAL_B）必须显式设置 DUAL_PREFIX=<目标实例真实 CACHE_PREFIX>：' +
        '脚本按键断言并清场，随机前缀会让断言全部打空、清场打错范围',
    );
  }
  const prefix = explicit || `smoke-dual-${Date.now().toString(36)}`;
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `DUAL_PREFIX 非法（${JSON.stringify(prefix)}）：只允许 [A-Za-z0-9._:-]，不得含空白或 glob 元字符（* ? [ ]），长度 3~96`,
    );
  }
  const tokens = prefix.toLowerCase().split(/[.:_-]+/);
  const testScoped = tokens.some((token) => TEST_MARKER_TOKENS.has(token));
  if (!testScoped && process.env.DUAL_PREFIX_ACK !== '1') {
    throw new Error(
      `DUAL_PREFIX=${prefix} 不含测试语义段（smoke/test/it/tmp/temp）：清场会删除该前缀下的测试键；` +
        '若确认它是可丢弃的测试命名空间，请显式设置 DUAL_PREFIX_ACK=1',
    );
  }
  return prefix;
}

/**
 * 解析 T5 使用的认证账号（环境保护，2026-10-19）：
 * - 未开启破坏性用例：默认 admin（仅做登录 + 轮换，不影响其它会话）；
 * - 开启破坏性用例：默认专用种子账号 alice；若解析结果仍是 admin，必须显式 DUAL_ALLOW_ADMIN_REVOKE=1；
 * - 非内置种子账号必须显式提供 DUAL_AUTH_PASSWORD。
 * @returns 账号与口令
 */
function resolveAuthAccount() {
  const account = process.env.DUAL_AUTH_ACCOUNT?.trim() || (ALLOW_SESSION_REVOKE ? 'alice' : 'admin');
  const password = process.env.DUAL_AUTH_PASSWORD ?? SEEDED_PASSWORDS[account] ?? '';
  if (ALLOW_SESSION_REVOKE && account === 'admin' && !ALLOW_ADMIN_REVOKE) {
    throw new Error(
      'DUAL_ALLOW_SESSION_REVOKE=1 会在数据库层撤销该账号的全部 refresh 会话：请改用专用测试账号' +
        '（DUAL_AUTH_ACCOUNT，默认种子账号 alice）；确需在 admin 上执行时再显式设置 DUAL_ALLOW_ADMIN_REVOKE=1',
    );
  }
  if (password === '') {
    throw new Error(`缺少账号口令：账号 ${account} 不是内置种子账号，请设置 DUAL_AUTH_PASSWORD`);
  }
  return { account, password };
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
      // 指纹绑定显式开启：双节点验收比对「异 UA grace 重试被拒」，不依赖环境默认值
      AUTH_FINGERPRINT: 'on',
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

/**
 * 核对实例实际使用的缓存前缀（安全边界②）：两节点必须与 DUAL_PREFIX 一致，否则键断言与清场都会打错范围。
 * @param base 实例基地址
 * @param label 断言用标签
 */
async function assertInstancePrefix(base, label) {
  const stats = await call(base, '/api/v1/demo-cache/stats');
  if (stats.status !== 200) {
    throw new Error(
      `${label}（${base}）的演示端点不可用（GET /api/v1/demo-cache/stats → HTTP ${stats.status}）：` +
        '冒烟依赖 demo-cache 自检面，请为目标实例设置 DEMO_ENDPOINTS_ENABLED=true',
    );
  }
  const data = stats.body?.data ?? {};
  if (data.driver !== 'redis') {
    throw new Error(`${label}（${base}）缓存驱动为 ${data.driver}，双节点冒烟要求 CACHE_DRIVER=redis`);
  }
  if (data.prefix !== PREFIX) {
    throw new Error(
      `${label}（${base}）实际 CACHE_PREFIX=${JSON.stringify(data.prefix)} 与 DUAL_PREFIX=${JSON.stringify(PREFIX)} 不一致：` +
        '键断言会打空、清场会打错范围，已中止',
    );
  }
}

/** 键是否属于本脚本独占的命名空间 */
function isOwnedKey(key) {
  if (!key.startsWith(`${PREFIX}:`)) return false;
  const rest = key.slice(PREFIX.length + 1);
  return OWNED_NAMESPACES.some((owned) => rest.startsWith(owned));
}

/**
 * 用 SCAN 游标列出匹配键（**禁止 KEYS**：KEYS 是 O(N) 全库扫描且阻塞服务端，共享实例上不可接受）。
 * 语义提示：SCAN 非快照语义——可能返回重复键（已去重），且不保证包含扫描期间新增的键；
 * 本脚本只用于「自己写入后立即断言」与「按命名空间清场」，该语义足够。cluster 模式下 SCAN
 * 只覆盖单节点（本脚本要求单实例 Redis）。
 * @param redis ioredis 客户端
 * @param pattern MATCH 模式
 * @returns 去重后的键数组
 */
async function scanKeys(redis, pattern) {
  const keys = new Set();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = String(next);
    for (const key of batch) keys.add(key);
  } while (cursor !== '0');
  return [...keys];
}

/**
 * 收集待清场的键：逐个命名空间 SCAN，并在收集过程中做范围与数量校验（安全边界③④）。
 * 任一校验失败立即抛错——宁可留键也不越界删除。
 * @param redis ioredis 客户端
 * @returns 去重后的键集合
 */
async function collectOwnedKeys(redis) {
  const keys = new Set();
  for (const owned of OWNED_NAMESPACES) {
    for (const key of await scanKeys(redis, `${PREFIX}:${owned}*`)) {
      // MATCH 已限定范围；这里再按「前缀 + 命名空间」二次校验，防实现漂移导致越界删除
      if (!isOwnedKey(key)) {
        throw new Error(`清场中止：SCAN 命中不属于测试命名空间的键（${key}），拒绝删除`);
      }
      keys.add(key);
      if (keys.size > CLEANUP_MAX_KEYS) {
        throw new Error(
          `清场中止：命中键数已超过上限 ${CLEANUP_MAX_KEYS}（DUAL_CLEANUP_MAX_KEYS）——前缀疑似配置错误`,
        );
      }
    }
  }
  return keys;
}

/**
 * 分批删除（每批 CLEANUP_DELETE_BATCH 个），返回 Redis 实际删除数。
 * @param redis ioredis 客户端
 * @param keys 待删除键
 */
async function deleteKeysInBatches(redis, keys) {
  const list = [...keys];
  let removed = 0;
  for (let offset = 0; offset < list.length; offset += CLEANUP_DELETE_BATCH) {
    removed += await redis.del(...list.slice(offset, offset + CLEANUP_DELETE_BATCH));
  }
  return removed;
}

/**
 * 清场：只删除本测试自身命名空间下的键（安全边界③），SCAN 收集 + 分批 DEL，删除前校验键范围（边界④）。
 * 失败一律上抛——由调用方记为 FAIL 并让脚本以非 0 退出，不再「静默当作正常完成」。
 * @param redis ioredis 客户端
 * @returns Redis 实际删除的键数量
 */
async function cleanupRedis(redis) {
  const keys = await collectOwnedKeys(redis);
  if (keys.size === 0) return 0;
  return deleteKeysInBatches(redis, keys);
}

/**
 * 登录并返回响应 data（accessToken + refreshToken）
 * @param base 实例基地址
 * @param account 账号
 * @param password 口令
 * @returns data 对象（失败时为空对象）
 */
async function login(base, account, password) {
  const res = await call(base, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return res.body?.data ?? {};
}

async function main() {
  if (!REDIS_URL) {
    console.log('SKIP  未设置 DUAL_REDIS_URL（双进程冒烟需要真实 Redis；CI base 作业由 redis service 提供）');
    return;
  }

  PREFIX = resolvePrefix();
  initCleanupLimits();
  // 认证账号与破坏性用例的环境保护：配置非法时在起服务/连 Redis 之前就失败（2026-10-19 复核）
  const auth = resolveAuthAccount();

  // @fw/cache 与 ioredis 经 example-api 的依赖图解析：
  // ① cache 包的 exports 只声明了 import 条件（无 require），故走 import.meta.resolve + 动态 import；
  // ② ioredis 是 cache 包的依赖（example-api 不直接依赖），以 cache 入口为基准用 createRequire 解析。
  // 全程不硬编码仓库绝对路径，CI/任意检出位置均可用。
  const cacheEntryUrl = import.meta.resolve('@fw/cache');
  const { RedisCacheStore, LockManager } = await import('@fw/cache');
  const Redis = createRequire(cacheEntryUrl)('ioredis');

  const redis = new Redis(REDIS_URL);
  let a = null;
  let b = null;
  /** 只有两个实例都确认了同一前缀才允许清场：前缀未校验时宁可留键，也不误删 */
  let prefixVerified = false;
  try {
    a = REUSE_MODE ? null : await startServer(PORT_A);
    b = REUSE_MODE ? null : await startServer(PORT_B);
    console.log(`\n=== 拓扑：A=${BASE_A} B=${BASE_B}（${REUSE_MODE ? '复用既有实例' : '脚本自起'}）共享 Redis + DB + CACHE_PREFIX=${PREFIX} ===`);
    console.log(
      ALLOW_SESSION_REVOKE
        ? `认证破坏性用例：开启（账号 ${auth.account}；T5.1c/T5.2 会在数据库层撤销该账号的全部 refresh 会话）`
        : '认证破坏性用例：关闭（跳过 T5.1c/T5.2；需要时设 DUAL_ALLOW_SESSION_REVOKE=1 并使用专用测试账号）',
    );

    // ---------- T0 前缀核对（清场安全的前置条件） ----------
    for (const [base, label] of [
      [BASE_A, 'A 实例'],
      [BASE_B, 'B 实例'],
    ]) {
      await assertInstancePrefix(base, label);
    }
    prefixVerified = true;
    check('T0 两节点实际 CACHE_PREFIX 与 DUAL_PREFIX 一致', true, `prefix=${PREFIX}`);

    // ---------- T2 缓存跨实例读写与标签失效 ----------
    console.log('\n—— T2 缓存跨实例读写与标签失效 ——');
    // id 默认带本次运行唯一后缀（2026-10-19 加固）：复用既有实例时，固定 id 会与历史遗留的
    // 同 id 键/标签索引混在一起，让「键↔索引一致」断言失去区分力（无法判断是不是本次写的）。
    const id = process.env.DUAL_FIND_USER_ID ?? `81731-${Date.now().toString(36)}`;
    const valuePattern = `${PREFIX}:CacheDemoService:findUser:*`;
    const tagKey = `${PREFIX}:__tag__:demo:user:${id}`;
    // 先记录既有键（复用模式下可能是历史遗留），断言只针对「本次运行新增的键」
    const beforeKeys = new Set(await scanKeys(redis, valuePattern));
    const a1 = await call(BASE_A, `/api/v1/demo-cache/find-user?id=${id}`);
    const valueKeys = await scanKeys(redis, valuePattern);
    const runKeys = valueKeys.filter((key) => !beforeKeys.has(key));
    const members = await redis.smembers(tagKey);
    check(
      'T2.1 A 写入后 Redis 出现共享键且被标签索引追踪',
      runKeys.length === 1 && members.length >= 1 && runKeys.every((key) => members.includes(key)),
      `newKeys=${runKeys.length} members=${members.length}`,
    );

    const b1 = await call(BASE_B, `/api/v1/demo-cache/find-user?id=${id}`);
    check('T2.2 B 命中 A 写入的缓存（B 侧 loads=0 未回源）', b1.body?.code === 0 && b1.body?.data?.loads === 0, `B loads=${b1.body?.data?.loads}`);

    const inv = await call(BASE_B, `/api/v1/demo-cache/invalidate?tag=demo:user:${id}`, { method: 'POST' });
    check('T2.3 B 标签失效成功（跨实例可见）', inv.body?.code === 0 && (inv.body?.data?.removed ?? 0) >= 1, `removed=${inv.body?.data?.removed}`);

    const a2 = await call(BASE_A, `/api/v1/demo-cache/find-user?id=${id}`);
    check('T2.4 A 再请求不再命中（回源 loads+1）', a2.body?.data?.loads === (a1.body?.data?.loads ?? 0) + 1, `A loads ${a1.body?.data?.loads}→${a2.body?.data?.loads}`);

    const keysAfter = await scanKeys(redis, valuePattern);
    const membersAfter = await redis.smembers(tagKey);
    // 双向一致性只针对本次运行写入的键 + 本次标签索引的成员：
    // 成员必须都存在（无幽灵索引），本次写入的键必须被登记（无孤儿缓存）；
    // 复用模式下同命名空间里的历史遗留键不参与判定（不误杀）。
    check(
      'T2.5 重建后键↔索引一致（本次键无孤儿、索引无幽灵成员）',
      membersAfter.length >= 1 &&
        membersAfter.every((member) => keysAfter.includes(member)) &&
        runKeys.every((key) => membersAfter.includes(key)),
      `newKeys=${runKeys.length} members=${membersAfter.length}`,
    );

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
    const loginData = await login(BASE_A, auth.account, auth.password);
    check(`T5.0 ${auth.account} 登录成功（数据库已种子）`, !!loginData.accessToken && !!loginData.refreshToken);
    const oldRefresh = loginData.refreshToken;
    if (oldRefresh) {
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

      if (ALLOW_SESSION_REVOKE) {
        // T5.1c：异 UA 的 grace 重试必须判 replay（ADR-0022 指纹绑定）。
        // 该断言同时是「两节点 AUTH_FINGERPRINT 配置一致性」探针：任一对端把指纹关掉且赢家未写指纹，
        // 这里会拿到 0（放行）而不是 3001 —— 配置漂移不再静默改变 grace 语义。
        // 注意：replay 会在数据库层撤销该账号的全部 refresh 会话（临时账号 alice，专用账号由环境校验）。
        const attacker = await call(BASE_B, '/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': `${UA}-other-client` },
          body: JSON.stringify({ refreshToken: oldRefresh }),
        });
        check('T5.1c 异 UA 的 grace 重试被拒绝（指纹绑定跨节点生效）', attacker.body?.code !== 0, `code=${attacker.body?.code}`);
      } else {
        console.log(
          `SKIP  T5.1c 异 UA grace 重试（默认关闭：会在数据库层撤销 ${auth.account} 的全部 refresh 会话；` +
            '需 DUAL_ALLOW_SESSION_REVOKE=1 并使用专用测试账号）',
        );
      }
    }

    // ---------- T5.2 过期 replay → family revoke（可选：含 11s 等待） ----------
    if (INCLUDE_REPLAY && ALLOW_SESSION_REVOKE) {
      console.log('\n—— T5.2 过期 replay → family revoke ——');
      const replayData = await login(BASE_A, auth.account, auth.password);
      const tokenA = replayData.refreshToken;
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
    } else if (INCLUDE_REPLAY) {
      console.log(
        `SKIP  T5.2 过期 replay（DUAL_INCLUDE_REPLAY=1 但未开启 DUAL_ALLOW_SESSION_REVOKE：` +
          `该用例会在数据库层撤销 ${auth.account} 的全部 refresh 会话）`,
      );
    }
  } finally {
    // 清场 → 关闭连接 → 回收子进程：三段各自兜底，任何一段失败都不得跳过后续回收
    try {
      if (!prefixVerified) {
        console.log('  （跳过清场：两节点前缀未校验通过，为避免误删保持 Redis 原样）');
      } else {
        const removed = await cleanupRedis(redis);
        check('T0 清场：测试命名空间下的键已删除', true, `removed=${removed}`);
      }
    } catch (error) {
      check('T0 清场：测试命名空间下的键已删除', false, `error=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await redis.quit();
      } catch (error) {
        console.error(`  关闭 Redis 连接失败：${error instanceof Error ? error.message : String(error)}`);
      }
      await stopServer(b);
      await stopServer(a);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\n冒烟脚本执行失败： ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
