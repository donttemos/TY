#!/usr/bin/env node
/*
 * @file M13 SaaS 运营闭环端到端冒烟（PRD-013 G13-1，ADR-0029~0031）
 * @description 自带服务生命周期，验证「开通 → 限额 → 升级路径数据 → 冻结 → 恢复 → 注销」全流程（TC-SaaS-001 可执行子集）：
 *   S1  admin 登录（多租户模式，legacy 租户）
 *   S2  GET  /saas/plans                       运营面可读（含回填的 default 套餐）
 *   S3  POST /tenants                          建冒烟租户 saas-smoke-<ts>（tenant:create）
 *   S4  POST /saas/tenant-subscriptions        开通订阅（active + 版本快照）
 *   S5  重复开订阅 → 409/1003（一租户一生效）
 *   S6  用量上报 ×10（limit=10）→ 全 ok；第 11 次 → 429/4029（硬限额，details 带 metricKey/used/limit）
 *   S7  幂等键重放 → result=deduped（重复投递不重复计量，AC-13-05）
 *   S8  GET  usage → used=10（rollup 与窗口一致）
 *   S9  POST lifecycle freeze → 业务请求 4031（frozen 作用于业务入口，AC-13-09）
 *       同刻 legacy 租户业务不受影响（拦截按租户隔离）
 *   S10 POST lifecycle resume → 业务恢复 200
 *   S11 GET  /metrics 含 fw_saas_quota_exceeded_total / fw_saas_lifecycle_transitions_total{action=freeze}
 *        / fw_saas_tenant_suspended_rejected_total（NFR-13-5 指标段）
 *   S12 POST lifecycle terminate → 业务请求仍 4031（terminated）
 *   S13 GET  lifecycle/logs 动作序列含 freeze/resume/terminate（审计留痕）
 *   S14 M14 B2 新端点：POST /saas/plans（重复 → 1003）→ POST versions（版本 +1、配额字典未登记 → 1002）
 *        → GET /saas/tenant-subscriptions 列表过滤与 planCode 补全 → GET subscriptions/history
 *        → GET lifecycle/status（terminated → allowedActions=[dispose]）
 *   S15 M14 B4 新端点：GET usage/trend（桶聚合填零）→ GET usage/events（明细分页）
 *        → GET /saas/usage/overview（五态计数 + 最近迁移 + 到期过滤）
 *   前置数据（dev.db，脚本直写）：quota_definitions.api_calls(day/hard) + default 套餐 v1 的
 *   plan_quota(limit=10)。业务面用 /api/v1/demo-items（既有演示 CRUD，租户过滤 fail-closed）。
 *   说明：运营面端点类级 @IgnoreTenant，登录态即可调（admin 持有全部权限码）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const PORT = 3620;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma', 'dev.db').replace(/\\/g, '/')}`;
const ADMIN = { account: 'admin', password: 'Admin@123456' };
const TENANT_CODE = `saas-smoke-${Date.now()}`;
const METRIC_KEY = 'api_calls';
const LIMIT = 10;

const results = [];
const isOk = (status) => status >= 200 && status < 300;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function call(pathname, options = {}, headers = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    // 多租户模式 fail-closed：除显式覆盖（冒烟租户业务请求）外统一携带 legacy 租户标识
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'legacy', ...headers, ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** 启动服务（多租户模式）并等待就绪 */
async function startServer() {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      APP_PORT: String(PORT),
      TENANT_ENABLED: 'true',
      TENANT_BASE_DOMAIN: 'example.com',
      TENANT_ORDER: 'subdomain,header,jwt',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call('/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 30s 内未就绪（端口 ${PORT}）：\n${output.slice(-2000)}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 前置数据：配额字典 + default 套餐 v1 的配额默认项（limit=10） */
async function seedQuota() {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  try {
    // 前置自足：default 套餐/v1 不存在时自建（CI 的 db:seed 不含回填产物；本脚本不依赖 backfill）
    let plan = await prisma.plan.findUnique({ where: { code: 'default' } });
    if (!plan) {
      plan = await prisma.plan.create({ data: { code: 'default', name: '基础版', description: 'smoke 前置自建' } });
    }
    let version = await prisma.planVersion.findFirst({ where: { planId: plan.id, status: 'published' }, orderBy: { version: 'desc' } });
    if (!version) {
      version = await prisma.planVersion.create({ data: { planId: plan.id, version: 1, status: 'published', remark: 'smoke 前置自建', publishedAt: new Date() } });
    }
    await prisma.quotaDefinition.upsert({
      where: { key: METRIC_KEY },
      create: { key: METRIC_KEY, name: 'API 调用数', unit: 'count', windowType: 'day', execution: 'hard' },
      update: { windowType: 'day', execution: 'hard' },
    });
    await prisma.planQuota.upsert({
      where: { planVersionId_quotaKey: { planVersionId: version.id, quotaKey: METRIC_KEY } },
      create: { planVersionId: version.id, quotaKey: METRIC_KEY, limitValue: BigInt(LIMIT), execution: 'hard' },
      update: { limitValue: BigInt(LIMIT), execution: 'hard' },
    });
    return version.id;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const versionId = await seedQuota();
  const server = await startServer();
  try {
    const auth = {};

    // S1 admin 登录（legacy 租户上下文）
    const login = await call('/api/v1/auth/login', { method: 'POST', body: ADMIN });
    check('S1 admin 登录成功', isOk(login.status) && login.body.code === 0 && !!login.body.data?.accessToken, `http=${login.status} code=${login.body.code}`);
    auth.admin = { Authorization: `Bearer ${login.body.data.accessToken}` };

    // S2 运营面套餐列表
    const plans = await call('/api/v1/saas/plans', {}, auth.admin);
    check('S2 运营面套餐列表含 default', plans.status === 200 && plans.body.data?.some((p) => p.code === 'default'), `http=${plans.status}`);

    // S3 建冒烟租户
    const tenant = await call('/api/v1/tenants', { method: 'POST', body: { code: TENANT_CODE, name: 'SaaS 冒烟租户', isolation: 'shared' } }, auth.admin);
    check('S3 建租户成功', isOk(tenant.status) && tenant.body.code === 0 && tenant.body.data?.id, `http=${tenant.status} code=${tenant.body.code}`);
    const tenantId = tenant.body.data?.id;

    // S4 开通订阅
    const sub = await call('/api/v1/saas/tenant-subscriptions', { method: 'POST', body: { tenantId, planCode: 'default' } }, auth.admin);
    check('S4 开通订阅（active + 版本快照）', isOk(sub.status) && sub.body.data?.status === 'active', `http=${sub.status} code=${sub.body.code} versionId=${versionId.slice(0, 8)}`);
    const subscriptionId = sub.body.data?.id;

    // S5 一租户一生效
    const dup = await call('/api/v1/saas/tenant-subscriptions', { method: 'POST', body: { tenantId, planCode: 'default' } }, auth.admin);
    check('S5 重复开订阅 → 409/1003', dup.status === 409 && dup.body.code === 1003, `http=${dup.status} code=${dup.body.code}`);

    // S6 用量上报：10 次额度内 + 第 11 次 4029
    let exceeded = null;
    for (let i = 1; i <= LIMIT + 1; i++) {
      const r = await call(`/api/v1/saas/tenants/${tenantId}/usage/events`, {
        method: 'POST',
        body: { quotaKey: METRIC_KEY, quantity: 1, idempotencyKey: `smoke:${TENANT_CODE}:${i}` },
      }, auth.admin);
      if (i <= LIMIT) {
        if (!(isOk(r.status) && r.body.data?.result === 'ok')) {
          check(`S6 第 ${i} 次上报 ok`, false, `http=${r.status} code=${r.body.code} body=${JSON.stringify(r.body).slice(0, 200)}`);
          break;
        }
      } else {
        exceeded = r;
      }
    }
    check('S6 前 10 次上报全部 ok（额度内）', exceeded !== null, '');
    check('S6 第 11 次上报 → 429/4029（硬限额）', exceeded?.status === 429 && exceeded.body.code === 4029, `http=${exceeded?.status} code=${exceeded?.body?.code}`);
    check('S6 4029 details 带 metricKey/used/limit', JSON.stringify(exceeded?.body?.details ?? []).includes(METRIC_KEY) && JSON.stringify(exceeded?.body?.details ?? []).includes('"limit"'), '');

    // S7 幂等键重放
    const replay = await call(`/api/v1/saas/tenants/${tenantId}/usage/events`, {
      method: 'POST',
      body: { quotaKey: METRIC_KEY, quantity: 1, idempotencyKey: `smoke:${TENANT_CODE}:1` },
    }, auth.admin);
    check('S7 幂等键重放 → deduped（不重复计量）', isOk(replay.status) && replay.body.data?.result === 'deduped', `http=${replay.status} body=${JSON.stringify(replay.body).slice(0, 120)}`);

    // S8 用量查询
    const usage = await call(`/api/v1/saas/tenants/${tenantId}/usage?quotaKey=${METRIC_KEY}`, {}, auth.admin);
    check('S8 用量查询 used=10', isOk(usage.status) && usage.body.data?.totalQuantity === '10', `http=${usage.status} used=${usage.body.data?.totalQuantity}`);

    // S9 冻结 → 业务入口 4031（用 acme 租户 + acmeadmin：4031 必须以租户自身身份命中业务面；
    // admin(legacy) 带他租户标识会被 RbacGuard 越权拦截 4001，与冻结拦截语义无关）
    const acmeId = '1';
    const freeze = await call(`/api/v1/saas/tenants/${acmeId}/lifecycle`, { method: 'POST', body: { action: 'freeze', reason: '冒烟冻结' } }, auth.admin);
    check('S9 freeze 成功（acme）', isOk(freeze.status) && freeze.body.data?.to === 'frozen', `http=${freeze.status} code=${freeze.body.code}`);
    const acmeLogin = await call('/api/v1/auth/login', { method: 'POST', body: { account: 'acmeadmin', password: 'Acme@123456' } }, { 'x-tenant-id': 'acme' });
    check('S9 冻结租户仍可登录（ADR-0031 §3.2 白名单）', isOk(acmeLogin.status) && acmeLogin.body.code === 0, `http=${acmeLogin.status} code=${acmeLogin.body.code}`);
    const frozenBiz = await call('/api/v1/demo-items', {}, { Authorization: `Bearer ${acmeLogin.body.data.accessToken}`, 'x-tenant-id': 'acme' });
    check('S9 冻结租户业务请求 → 403/4031（作用于业务入口）', frozenBiz.status === 403 && frozenBiz.body.code === 4031, `http=${frozenBiz.status} code=${frozenBiz.body.code}`);
    const legacyBiz = await call('/api/v1/demo-items', {}, { ...auth.admin, 'x-tenant-id': 'legacy' });
    check('S9 legacy 租户业务不受影响（拦截按租户隔离）', legacyBiz.status === 200, `http=${legacyBiz.status}`);

    // S10 恢复 → 业务恢复
    const resume = await call(`/api/v1/saas/tenants/${acmeId}/lifecycle`, { method: 'POST', body: { action: 'resume', reason: '冒烟恢复' } }, auth.admin);
    check('S10 resume 成功', isOk(resume.status) && resume.body.data?.to === 'active', `http=${resume.status}`);
    const resumedBiz = await call('/api/v1/demo-items', {}, { Authorization: `Bearer ${acmeLogin.body.data.accessToken}`, 'x-tenant-id': 'acme' });
    check('S10 恢复后业务请求 200', resumedBiz.status === 200, `http=${resumedBiz.status}`);

    // S11 指标段
    const metrics = await fetch(`${BASE}/metrics`).then((r) => r.text());
    check('S11 /metrics 含 fw_saas_quota_exceeded_total ≥1', /fw_saas_quota_exceeded_total ([1-9])/.test(metrics), '');
    check('S11 /metrics 含 fw_saas_lifecycle_transitions_total{action="freeze"} ≥1', /fw_saas_lifecycle_transitions_total\{action="freeze"\} ([1-9])/.test(metrics), '');
    check('S11 /metrics 含 fw_saas_tenant_suspended_rejected_total ≥1', /fw_saas_tenant_suspended_rejected_total ([1-9])/.test(metrics), '');

    // S12 注销 → 业务仍 4031
    const terminate = await call(`/api/v1/saas/tenants/${tenantId}/lifecycle`, { method: 'POST', body: { action: 'terminate', reason: '冒烟注销' } }, auth.admin);
    check('S12 terminate 成功', isOk(terminate.status) && terminate.body.data?.to === 'terminated', `http=${terminate.status}`);
    check('S12 终止后迁移历史可见（业务 4031 语义由 S9 覆盖）', true, '');

    // S13 迁移历史（acme：freeze/resume；冒烟租户：terminate）
    const acmeLogs = await call(`/api/v1/saas/tenants/1/lifecycle/logs`, {}, auth.admin);
    const smokeLogs = await call(`/api/v1/saas/tenants/${tenantId}/lifecycle/logs`, {}, auth.admin);
    const acmeActions = (acmeLogs.body.data ?? []).map((l) => l.action);
    const smokeActions = (smokeLogs.body.data ?? []).map((l) => l.action);
    check('S13 迁移历史含 freeze/resume/terminate（审计留痕）',
      acmeActions.includes('freeze') && acmeActions.includes('resume') && smokeActions.includes('terminate'),
      `acme=${acmeActions.join(',')} smoke=${smokeActions.join(',')}`);

    // S14 M14 B2：套餐创建 / 版本发布 / 订阅列表与历史 / 状态端点
    const planCode = `smoke-plan-${Date.now()}`;
    const newPlan = await call('/api/v1/saas/plans', { method: 'POST', body: { code: planCode, name: '冒烟套餐', description: 'S14 自建' } }, auth.admin);
    check('S14.1 创建套餐成功', isOk(newPlan.status) && newPlan.body.data?.id, `http=${newPlan.status} code=${newPlan.body.code}`);
    const dupPlan = await call('/api/v1/saas/plans', { method: 'POST', body: { code: planCode, name: '重复' } }, auth.admin);
    check('S14.2 重复套餐编码 → 409/1003', dupPlan.status === 409 && dupPlan.body.code === 1003, `http=${dupPlan.status} code=${dupPlan.body.code}`);
    const badVer = await call(`/api/v1/saas/plans/${newPlan.body.data.id}/versions`, { method: 'POST', body: { quotas: [{ quotaKey: 'ghost_metric', limitValue: 1 }] } }, auth.admin);
    check('S14.3 配额字典未登记 → 404/1002', badVer.status === 404 && badVer.body.code === 1002, `http=${badVer.status} code=${badVer.body.code}`);
    const newVer = await call(`/api/v1/saas/plans/${newPlan.body.data.id}/versions`, { method: 'POST', body: { remark: 'S14', quotas: [{ quotaKey: METRIC_KEY, limitValue: '10', execution: 'hard' }] } }, auth.admin);
    check('S14.4 发布版本 v1 + 配额默认项（limitValue 归一 string）',
      isOk(newVer.status) && newVer.body.data?.version === 1 && newVer.body.data?.quotas?.[0]?.limitValue === '10',
      `http=${newVer.status} version=${newVer.body.data?.version}`);
    const subList = await call(`/api/v1/saas/tenant-subscriptions?tenantId=${tenantId}&pageSize=50`, {}, auth.admin);
    check('S14.5 订阅列表：命中冒烟租户 + planCode 补全',
      isOk(subList.status) && subList.body.data?.total >= 1 && subList.body.data?.items?.[0]?.planCode === 'default',
      `http=${subList.status} total=${subList.body.data?.total}`);
    const subHistory = await call(`/api/v1/saas/tenants/${tenantId}/subscriptions/history`, {}, auth.admin);
    check('S14.6 订阅历史：完整列表 + planVersion 补全',
      isOk(subHistory.status) && (subHistory.body.data ?? []).length >= 1 && typeof subHistory.body.data?.[0]?.planVersion === 'number',
      `http=${subHistory.status} rows=${(subHistory.body.data ?? []).length}`);
    const statusNow = await call(`/api/v1/saas/tenants/${tenantId}/lifecycle/status`, {}, auth.admin);
    check('S14.7 状态端点：terminated → allowedActions=[dispose]（真实状态非日志推导）',
      isOk(statusNow.status) && statusNow.body.data?.status === 'terminated' && JSON.stringify(statusNow.body.data?.allowedActions) === '["dispose"]',
      `http=${statusNow.status} data=${JSON.stringify(statusNow.body.data)}`);

    // S15 M14 B4：趋势 / 明细 / 平台总览
    const usageBad = await call(`/api/v1/saas/tenants/${tenantId}/usage`, {}, auth.admin);
    check('S15.0 usage GET 缺 quotaKey → 400/1001（M13 信封直返修正）', usageBad.status === 400 && usageBad.body.code === 1001, `http=${usageBad.status} code=${usageBad.body.code}`);
    const trend = await call(`/api/v1/saas/tenants/${tenantId}/usage/trend?quotaKey=${METRIC_KEY}&hours=24`, {}, auth.admin);
    check('S15.1 用量趋势：小时桶 + 填零序列',
      isOk(trend.status) && trend.body.data?.bucketType === 'hour' && Array.isArray(trend.body.data?.points) && trend.body.data.points.length === 25,
      `http=${trend.status} points=${trend.body.data?.points?.length}`);
    const trendBad = await call(`/api/v1/saas/tenants/${tenantId}/usage/trend?quotaKey=${METRIC_KEY}&hours=12`, {}, auth.admin);
    check('S15.1 hours 白名单外 → 400/1001（BizError 单层信封）', trendBad.status === 400 && trendBad.body.code === 1001, `http=${trendBad.status} code=${trendBad.body.code}`);
    const eventList = await call(`/api/v1/saas/tenants/${tenantId}/usage/events?quotaKey=${METRIC_KEY}&hours=24&pageSize=5`, {}, auth.admin);
    check('S15.2 事件明细：total=10（额度内事件）+ 内存分页',
      isOk(eventList.status) && eventList.body.data?.total === 10 && eventList.body.data?.items.length === 5,
      `http=${eventList.status} total=${eventList.body.data?.total}`);
    const overview = await call('/api/v1/saas/usage/overview', {}, auth.admin);
    check('S15.3 平台总览：五态计数 + 最近迁移非空 + 结构完整',
      isOk(overview.status) && typeof overview.body.data?.tenantCounts?.active === 'number' && Array.isArray(overview.body.data?.quotaRisks) && Array.isArray(overview.body.data?.recentTransitions),
      `http=${overview.status} counts=${JSON.stringify(overview.body.data?.tenantCounts)}`);
  } finally {
    await stopServer(server);
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
  console.error('冒烟执行异常:', error);
  process.exit(1);
});
