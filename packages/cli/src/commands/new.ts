/*
 * @file fw new 命令
 * @description 从 templates/<name> 复制项目模板并替换 __APP_NAME__ 占位符。
 *   admin 模板（M10 E-08）为全栈形态（server + admin-web 两个工作区成员），生成后自动把两个成员
 *   注册进框架仓库根的 pnpm-workspace.yaml（带标记注释，幂等可重入）；cms 模板按需规划，明确报错不静默降级。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-15 donttemo E-08：admin 模板交付——全栈工作区成员注册 + 定制后续步骤提示
 * @modified 2026-10-22 donttemo PRD-016 S3：工作区成员注册改用「相对仓库根的路径」而非项目名——
 *   在 apps/ 等子目录执行 fw new 时用项目名会注册出 apps 无关的 glob，生成的项目不会被 pnpm 链接
 * @module cli
 * @since v0.1.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** admin 模板的两个工作区成员子目录（生成后注册进根 pnpm-workspace.yaml） */
const ADMIN_WORKSPACE_MEMBERS = ['server', 'admin-web'] as const;

/** 支持的模板及其交付状态（空串 = 已交付；非空 = 未交付原因） */
const TEMPLATES: Record<string, string> = {
  api: '',
  admin: '',
  // cms 尚未交付：给出明确的规划提示，避免生成半成品
  cms: 'cms 模板按需规划（见 docs/81 A-8）',
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

  const templatesRoot = findTemplatesRoot();
  const source = path.join(templatesRoot, template);
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
  // admin 模板：服务端 .env 一并就位（JWT_SECRET 占位值仅供本地开发，README 已提示必改）
  const serverEnvExample = path.join(target, 'server', '.env.example');
  if (fs.existsSync(serverEnvExample)) {
    fs.copyFileSync(serverEnvExample, path.join(target, 'server', '.env'));
  }

  // admin 模板是全栈形态：两个子包作为工作区成员注册进框架仓库根（E-08）
  const registered = template === 'admin' ? registerWorkspaceMembers(templatesRoot, target, name) : [];

  console.log(`项目已创建：${target}`);
  if (template === 'admin') {
    console.log('\n已自动注册工作区成员：' + (registered.join('、') || '（见下方说明）'));
    if (registered.length === 0) {
      console.log('⚠️  生成目录不在框架仓库内，未自动注册：请把以下两项加入框架仓库根 pnpm-workspace.yaml 的 packages 列表后，在仓库根执行 pnpm i');
      for (const member of ADMIN_WORKSPACE_MEMBERS) console.log(`  - "${name}/${member}"`);
    }
    console.log('\n后续步骤（在框架仓库根执行 pnpm i 之后）：');
    console.log(`  cd ${name}/server`);
    console.log('  cp .env.example .env                    # 必改 JWT_SECRET（占位值仅供本地开发）');
    console.log('  pnpm prisma:generate');
    console.log('  pnpm db:migrate && pnpm db:seed         # RBAC 基线：admin / Admin@123456');
    console.log('  pnpm build && pnpm dev                  # http://localhost:3000/health');
    console.log(`  cd ../admin-web && pnpm dev             # http://localhost:5173（dev 代理到 3000）`);
  } else {
    console.log('\n后续步骤：');
    console.log(`  cd ${name}`);
    console.log('  pnpm i && pnpm build && pnpm dev   # http://localhost:3000/health');
  }
}

/**
 * 把 admin 模板的两个子包注册为框架工作区成员（幂等）。
 * 仅当生成目录位于框架仓库内时执行——workspace globs 相对仓库根解析，仓库外注册无意义。
 * @param templatesRoot 模板根（框架仓库下）
 * @param target 生成目录绝对路径
 * @param name 项目名
 * @returns 成功注册的成员 glob 列表；空数组 = 未注册（目录在仓库外）
 */
function registerWorkspaceMembers(templatesRoot: string, target: string, name: string): string[] {
  const repoRoot = path.dirname(templatesRoot);
  const relative = path.relative(repoRoot, target);
  // 目录在仓库外（relative 以 .. 开头或为绝对路径）→ 不注册，由输出提示手工处理
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];

  // 必须用「相对仓库根的实际路径」而不是项目名：在 apps/ 子目录里执行 fw new 时，
  // 项目名是 auto-verify、实际路径是 apps/auto-verify，用项目名会注册出匹配不到任何目录的 glob
  const relativePosix = relative.split(path.sep).join('/');
  const globs = ADMIN_WORKSPACE_MEMBERS.map((member) => `${relativePosix}/${member}`);
  const workspaceFile = path.join(repoRoot, 'pnpm-workspace.yaml');
  const content = fs.readFileSync(workspaceFile, 'utf8');
  const missing = globs.filter((glob) => !new RegExp(`^\\s*-\\s*"${glob}"\\s*$`, 'm').test(content));
  if (missing.length === 0) return globs;

  // 在 packages: 列表末尾追加（保持既有缩进两空格 + 标记注释，便于识别与手工清理）
  const lines = content.split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^packages:\s*$/.test(lines[i])) {
      insertAt = i + 1;
      while (insertAt < lines.length && /^\s*-\s/.test(lines[insertAt])) insertAt += 1;
      break;
    }
  }
  if (insertAt === -1) {
    throw new Error('pnpm-workspace.yaml 缺少 packages: 段，无法注册工作区成员（请手工添加）');
  }
  const block = [`  # ↓ 由 fw new ${name} --template=admin 注册（${new Date().toISOString().slice(0, 10)}）；弃用项目时删除目录并移除这两行`, ...missing.map((glob) => `  - "${glob}"`)];
  lines.splice(insertAt, 0, ...block);
  fs.writeFileSync(workspaceFile, lines.join('\n'), 'utf8');
  return globs;
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
