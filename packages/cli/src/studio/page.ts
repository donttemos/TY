/*
 * @file Studio 内置页面（TY Studio S1）
 * @description 单文件 HTML：不引前端框架、不需要构建步骤，服务启动即可用。
 *   取舍说明：S1 的价值是验证「本地服务边界 + 真实项目识别」，页面只做只读展示；
 *   数据模型设计器需要表格、弹窗、diff 等复杂交互，届时再引入 Vue 包（PRD-017 §5），
 *   现在先搭前端工程属于在 API 契约未稳之前预支复杂度。
 *   页面不写业务判断：所有状态（正常/告警/错误）都由 /api/project 给出，JS 只负责渲染。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

/**
 * 生成页面 HTML
 * @param productName 产品名（标题用）
 */
export function renderStudioPage(productName = 'TY Studio'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${productName}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #FAF9F6; color: #2C2C2A; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 0.5px solid #D3D1C7; }
  header h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .path { font-size: 12px; color: #5F5E5A; font-family: ui-monospace, monospace; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #E6F1FB; color: #185FA5; }
  main { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; padding: 20px 24px 32px; }
  section { background: #fff; border: 0.5px solid #D3D1C7; border-radius: 12px; padding: 14px 16px; }
  h2 { font-size: 13px; font-weight: 500; margin: 0 0 10px; color: #5F5E5A; }
  .row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
  .ok { background: #639922; } .warn { background: #BA7517; } .error { background: #E24B4A; }
  .detail { color: #5F5E5A; font-size: 12px; }
  .model { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; font-size: 13px; border-bottom: 0.5px solid #F1EFE8; }
  .model:last-child { border-bottom: none; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #EAF3DE; color: #27500A; }
  .empty { font-size: 12px; color: #888780; padding: 6px 0; }
  .issue { font-size: 12px; padding: 4px 0; color: #5F5E5A; }
  .issue b { font-weight: 500; color: #A32D2D; }
  .stack > section + section { margin-top: 16px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  footer { padding: 0 24px 24px; font-size: 12px; color: #888780; }
</style>
</head>
<body>
<header>
  <h1>${productName}</h1>
  <span class="path" id="root">加载中…</span>
  <span class="badge" id="shape"></span>
</header>
<main>
  <div class="stack">
    <section>
      <h2>环境</h2>
      <div id="env"></div>
    </section>
    <section>
      <h2>项目</h2>
      <div id="layout"></div>
    </section>
  </div>
  <div class="stack">
    <section>
      <h2>数据模型</h2>
      <div id="models"></div>
    </section>
    <section>
      <h2>检查结果</h2>
      <div id="issues"></div>
    </section>
  </div>
</main>
<footer>只读视图 · 本页不修改任何文件 · 关闭终端即停止服务</footer>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function row(status, name, detail) {
    return '<div class="row"><span class="dot ' + status + '"></span><span>' + esc(name) +
      '</span><span class="detail">' + esc(detail) + '</span></div>';
  }

  async function load() {
    const response = await fetch('/api/project', { headers: { 'x-studio-token': token } });
    if (!response.ok) {
      el('root').textContent = '读取失败：HTTP ' + response.status + '（token 可能已失效，请重新执行 fw studio）';
      return;
    }
    const data = await response.json();
    el('root').textContent = data.root;
    el('shape').textContent = { monorepo: 'monorepo', 'admin-template': 'admin 模板', single: '单项目' }[data.shape] || data.shape;

    el('env').innerHTML = data.environment.map((item) => row(item.status, item.name, item.detail)).join('');
    el('layout').innerHTML = [
      row('ok', '后端', data.layout.backendRoot),
      row('ok', '前端', data.layout.webRoot),
      row(data.layout.schemaExists ? 'ok' : 'error', 'Schema', data.layout.schemaFile),
      row(data.migrations.baseline && data.migrations.pending === 0 ? 'ok' : 'warn', '迁移',
        data.migrations.baseline
          ? (data.migrations.pending + ' 待执行 / 共 ' + data.migrations.total)
          : ('无部署基线 / 共 ' + data.migrations.total + ' 个')),
      row('ok', '生成清单', data.manifest.exists ? data.manifest.models.length + ' 个模型' : '尚未生成')
    ].join('');

    el('models').innerHTML = data.schema.models.length === 0
      ? '<div class="empty">schema 中没有模型</div>'
      : data.schema.models.map((model) =>
          '<div class="model"><span>' + esc(model.name) + '</span><span class="detail">' + model.fieldCount + ' 字段' +
          (model.generated ? ' <span class="tag">已生成</span>' : '') + '</span></div>').join('');

    el('issues').innerHTML = data.schema.issues.length === 0
      ? '<div class="empty">无问题</div>'
      : data.schema.issues.map((issue) =>
          '<div class="issue"><b>' + (issue.level === 'error' ? '错误' : '告警') + '</b>　' + esc(issue.message) + '</div>').join('');
  }

  load().catch((error) => { el('root').textContent = '读取失败：' + error.message; });
</script>
</body>
</html>`;
}
