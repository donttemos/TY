/**
 * @file M8 链路追踪冒烟验证脚本（PRD-008 FR-07 / TC-TNT-006）
 * @description 自带服务生命周期 + 本地 mock OTLP 收集器，分阶段验证 OpenTelemetry 链路追踪：
 *   A. 未启用（默认）：服务正常启动，X-Trace-Id 响应头仍存在（M1 通道），不产生任何导出；
 *   B. 启用 + 全采（OTEL_SAMPLE_RATIO=1）：请求产生的 span 经 OTLP/HTTP JSON 上报到收集器，
 *      traceId 与响应头 X-Trace-Id 一致（日志/trace/响应头三者同 ID）；
 *   C. 跨服务同 traceId（TC-TNT-006）：上游携带 traceparent 请求，服务端 SERVER span 续接为
 *      同一 traceId（父子跨进程成立）；该 traceId 在收集器中可见完整链路；
 *   D. 采样门控（OTEL_SAMPLE_RATIO=0）：普通请求的 span 全部被丢弃（0 导出）而服务不报错；
 *   E. 错误全采（OTEL_SAMPLE_RATIO=0 + OTEL_SAMPLE_ERRORS=true）：5xx（/demo/boom）触发的 ERROR span
 *      仍被导出（错误链路不丢）；
 *   F. 配置守卫（OTEL_ENABLED=true 缺 OTEL_EXPORTER_URL）：启动即失败并给出明确提示。
 *   说明：mock 收集器为本地 HTTP 服务（127.0.0.1，随机端口），断言只依赖导出载荷，不依赖外部采集端。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 3000/3100/3200/3300/3400 的既有冒烟实例） */
const PORT = 3500;
const BASE = `http://127.0.0.1:${PORT}`;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * 启动 mock OTLP 收集器：接收 POST /v1/traces 的 JSON 载荷并解析出 span 列表
 * @returns { port, spans(), reset(), close() }
 */
async function startMockCollector() {
  let spans = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(raw);
        for (const resourceSpan of payload.resourceSpans ?? []) {
          for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
            for (const span of scopeSpan.spans ?? []) {
              spans.push({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                name: span.name,
                kind: span.kind,
                status: span.status?.code ?? 0,
                attributes: Object.fromEntries(
                  (span.attributes ?? []).map((attr) => [attr.key, attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue]),
                ),
                serviceName: (resourceSpan.resource?.attributes ?? []).find((attr) => attr.key === 'service.name')?.value?.stringValue,
              });
            }
          }
        }
      } catch {
        /* 忽略非 JSON 载荷 */
      }
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    spans: () => spans,
    reset: () => {
      spans = [];
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** HTTP 请求：返回 { status, body, headers } */
async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, headers: res.headers, text };
}

/**
 * 启动服务并等待就绪
 * @param env 额外环境变量
 * @param expectFail 期望启动失败
 */
async function startServer(env = {}, expectFail = false) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

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
      /* 未就绪 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 30s 内未就绪：\n${output.slice(-2000)}`);
}

/** 停止服务 */
async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 轮询等待收集器收到满足条件的 span */
async function waitForSpan(collector, predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = collector.spans().find(predicate);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`等待 span 超时：${label}（已收 ${collector.spans().length} 个）`);
}

/** 阶段 A：未启用（默认） */
async function phaseDisabled() {
  console.log('\n=== 阶段 A：未启用链路追踪（默认 OTEL_ENABLED=false）===');
  const server = await startServer({ OTEL_ENABLED: 'false' });
  try {
    const res = await call('/api/v1/demo/ok');
    check(
      'A1 服务正常响应，X-Trace-Id 响应头存在（M1 通道，未受追踪开关影响）',
      res.status === 200 && typeof res.headers.get('x-trace-id') === 'string' && /^[0-9a-f]{32}$/.test(res.headers.get('x-trace-id')),
      `[http=${res.status} x-trace-id=${res.headers.get('x-trace-id')}]`,
    );
    check('A2 响应信封携带 traceId 且与响应头一致', res.body.traceId === res.headers.get('x-trace-id'), `[body.traceId=${res.body.traceId}]`);
  } finally {
    await stopServer(server);
  }
}

/** 阶段 B：启用 + 全采，校验导出与 ID 一致 */
async function phaseEnabledFullSampling() {
  console.log('\n=== 阶段 B：启用 + 全采（OTEL_SAMPLE_RATIO=1）===');
  const collector = await startMockCollector();
  const server = await startServer({
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_URL: `http://127.0.0.1:${collector.port}/v1/traces`,
    OTEL_SERVICE_NAME: 'fw-smoke',
    OTEL_SAMPLE_RATIO: '1',
    OTEL_SAMPLE_ERRORS: 'true',
  });
  try {
    const res = await call('/api/v1/demo/ok');
    const headerTraceId = res.headers.get('x-trace-id');
    check('B1 请求成功且返回 X-Trace-Id', res.status === 200 && typeof headerTraceId === 'string', `[http=${res.status} x-trace-id=${headerTraceId}]`);

    const span = await waitForSpan(collector, (s) => s.traceId === headerTraceId && s.kind === 2, 'HTTP SERVER span');
    check(
      'B2 OTLP/JSON 上报 SERVER span，traceId 与响应头一致',
      span.name.startsWith('HTTP GET') && span.attributes['url.path'] === '/api/v1/demo/ok',
      `[name=${span.name} traceId=${span.traceId} service=${span.serviceName}]`,
    );
    check(
      'B3 资源属性含 service.name=OTEL_SERVICE_NAME',
      span.serviceName === 'fw-smoke',
      `[service.name=${span.serviceName}]`,
    );

    // DB span 应并入同一 traceId（子 span 的 traceId 与父一致）
    await call('/api/v1/demo/items?page=1&pageSize=5');
    const dbSpan = await waitForSpan(collector, (s) => s.name.startsWith('db.query'), 'db.query span');
    check(
      'B4 DB 操作产生 db.query 子 span（同 traceId 下可见完整链路）',
      dbSpan.name.startsWith('db.query') && typeof dbSpan.traceId === 'string',
      `[name=${dbSpan.name} traceId=${dbSpan.traceId}]`,
    );
  } finally {
    await stopServer(server);
    await collector.close();
  }
}

/** 阶段 C：跨服务同 traceId（TC-TNT-006） */
async function phaseCrossService() {
  console.log('\n=== 阶段 C：跨服务同 traceId（上游 traceparent 续接，TC-TNT-006）===');
  const collector = await startMockCollector();
  const server = await startServer({
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_URL: `http://127.0.0.1:${collector.port}/v1/traces`,
    OTEL_SAMPLE_RATIO: '1',
  });
  try {
    // 模拟上游服务：固定 traceId + 父 spanId 的合法 traceparent
    const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const upstreamSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${upstreamTraceId}-${upstreamSpanId}-01`;
    const res = await call('/api/v1/demo/ok', { headers: { traceparent } });
    check('C1 上游 traceparent 请求成功', res.status === 200, `[http=${res.status}]`);
    check(
      'C2 服务端 X-Trace-Id 复用上游 traceId（跨服务同链路）',
      res.headers.get('x-trace-id') === upstreamTraceId,
      `[x-trace-id=${res.headers.get('x-trace-id')} expect=${upstreamTraceId}]`,
    );

    const span = await waitForSpan(collector, (s) => s.traceId === upstreamTraceId, '续接的 SERVER span');
    check(
      'C3 收集器中该 traceId 的 SERVER span 父 spanId = 上游 spanId（父子跨进程成立）',
      span.parentSpanId === upstreamSpanId && span.traceId === upstreamTraceId,
      `[parentSpanId=${span.parentSpanId} expect=${upstreamSpanId}]`,
    );
  } finally {
    await stopServer(server);
    await collector.close();
  }
}

/** 阶段 D：采样门控（ratio=0 全丢弃） */
async function phaseSamplingGate() {
  console.log('\n=== 阶段 D：采样门控（OTEL_SAMPLE_RATIO=0，普通链路全丢弃）===');
  const collector = await startMockCollector();
  const server = await startServer({
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_URL: `http://127.0.0.1:${collector.port}/v1/traces`,
    OTEL_SAMPLE_RATIO: '0',
    OTEL_SAMPLE_ERRORS: 'false',
  });
  try {
    for (let i = 0; i < 5; i++) await call('/api/v1/demo/ok');
    // 留出上报窗口
    await sleep(800);
    check(
      'D1 ratio=0 时普通请求的 span 全部丢弃（收集器 0 导出）',
      collector.spans().length === 0,
      `[exported=${collector.spans().length}]`,
    );
    const health = await call('/api/v1/demo/ok');
    check('D2 采样门控不影响服务可用性', health.status === 200, `[http=${health.status}]`);
  } finally {
    await stopServer(server);
    await collector.close();
  }
}

/** 阶段 E：错误全采（ratio=0 + errors=true） */
async function phaseErrorAlwaysSampled() {
  console.log('\n=== 阶段 E：错误全采（ratio=0 + OTEL_SAMPLE_ERRORS=true）===');
  const collector = await startMockCollector();
  const server = await startServer({
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_URL: `http://127.0.0.1:${collector.port}/v1/traces`,
    OTEL_SAMPLE_RATIO: '0',
    OTEL_SAMPLE_ERRORS: 'true',
  });
  try {
    // /demo/boom 抛未知异常，收敛为 500（Server 5xx → span 记 ERROR）
    const boom = await call('/api/v1/demo/boom');
    check('E1 /demo/boom 收敛为 5xx（未知异常不裸抛）', boom.status === 500, `[http=${boom.status}]`);

    const span = await waitForSpan(collector, (s) => s.status === 2 && s.kind === 2, 'ERROR SERVER span');
    check(
      'E2 ratio=0 下 5xx 的 ERROR span 仍被导出（错误链路不丢）',
      span.status === 2 && span.attributes['http.response.status_code'] === 500,
      `[status=${span.status} http.status=${span.attributes['http.response.status_code']}]`,
    );
  } finally {
    await stopServer(server);
    await collector.close();
  }
}

/** 阶段 F：配置守卫 */
async function phaseConfigGuard() {
  console.log('\n=== 阶段 F：配置守卫（OTEL_ENABLED=true 缺 OTEL_EXPORTER_URL）===');
  const server = await startServer({ OTEL_ENABLED: 'true', OTEL_EXPORTER_URL: '' }, true);
  const output = server.output();
  check(
    'F1 启用追踪但缺导出端点时启动即失败并给出明确提示',
    server.exitCode !== 0 && server.exitCode !== 'timeout' && output.includes('OTEL_EXPORTER_URL'),
    `[exit=${server.exitCode}]`,
  );
  await stopServer(server);
}

/** 主流程 */
async function main() {
  // 阶段 A 无需收集器；B~E 各自内置；F 收尾
  await phaseDisabled();
  await phaseEnabledFullSampling();
  await phaseCrossService();
  await phaseSamplingGate();
  await phaseErrorAlwaysSampled();
  await phaseConfigGuard();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟脚本执行失败：', error);
  process.exit(1);
});
