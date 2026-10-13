/*
 * @file fw new 命令
 * @description 从 templates/<name> 复制项目模板并替换 __APP_NAME__ 占位符；admin/cms 模板分别在 M5/M6 交付，当前明确报错而不是静默降级。
 * @author donttemo
 * @created 2026-10-09
 * @module cli
 * @since v0.1.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 支持的模板及其交付状态 */
const TEMPLATES: Record<string, string> = {
  api: '',
  // admin / cms 尚未交付：给出明确的里程碑提示，避免生成半成品
  admin: 'admin 模板在 M5（管理后台）交付',
  cms: 'cms 模板在 M5 后按需规划',
};

/**
 * 执行 fw new：复制模板并替换占位符
 * @param name 项目名（kebab-case）
 * @param template 模板名（api | admin | cms）
 */
export async function runNew(name: string, template: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`项目名不合法：${name}（要求 kebab-case，如 my-system）`);
  }
  if (!(template in TEMPLATES)) {
    throw new Error(`未知模板：${template}（可选：${Object.keys(TEMPLATES).join(' / ')}）`);
  }
  const pendingReason = TEMPLATES[template];
  if (pendingReason) {
    throw new Error(`模板尚未交付：${pendingReason}`);
  }

  const cwd = process.cwd();
  const target = path.resolve(cwd, name);
  if (fs.existsSync(target)) {
    throw new Error(`目录已存在：${target}`);
  }

  const source = path.join(findTemplatesRoot(), template);
  if (!fs.existsSync(source)) {
    throw new Error(`模板目录缺失：${source}（请确认仓库完整性）`);
  }

  copyDir(source, target);
  replacePlaceholders(target, name);
  // 复制隐藏的 env 示例文件（copyDir 已覆盖，这里显式生成 .env 便于直接启动）
  const envExample = path.join(target, '.env.example');
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, path.join(target, '.env'));
  }

  console.log(`项目已创建：${target}`);
  console.log('\n后续步骤：');
  console.log(`  cd ${name}`);
  console.log('  pnpm i && pnpm build && pnpm dev   # http://localhost:3000/health');
}

/** 从 CLI 包位置向上查找仓库根（以 pnpm-workspace.yaml 为标志） */
function findTemplatesRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, 'templates');
    dir = path.dirname(dir);
  }
  throw new Error('未找到框架仓库根（pnpm-workspace.yaml）；请在框架 monorepo 内运行 fw new');
}

/** 递归复制目录 */
function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** 替换文本文件中的 __APP_NAME__ 占位符 */
function replacePlaceholders(dir: string, name: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replacePlaceholders(full, name);
      continue;
    }
    if (/\.(json|md|ts|js|yml|yaml|env|example)$/.test(entry.name) || entry.name.startsWith('.env')) {
      const content = fs.readFileSync(full, 'utf8');
      if (content.includes('__APP_NAME__')) {
        fs.writeFileSync(full, content.replaceAll('__APP_NAME__', name), 'utf8');
      }
    }
  }
}
