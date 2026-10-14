#!/usr/bin/env bash
# @file 云服务器裸机部署脚本（无 Docker）
# @description 以「release 目录 + 软链原子切换」方式发版，替代 docker compose up 的等价动作：
#   取代码 → 装依赖 → prisma generate → 构建（框架包拓扑序 + 应用 + 前端）→ 迁移 → 切 current 软链
#   → 重启 systemd → 健康检查；健康检查失败自动切回上一 release 并重启。
#   设计取舍：不做蓝绿双活（裸机起步档无必要），而是「迁移先行 + 健康检查兜底 + 软链秒级回滚」。
#   用法见 docs/61-bare-metal-deploy.md §8 与 docs/62-1panel-real-deploy.md §5；常用：
#     sudo REPO_URL=git@github.com:donttemos/TY.git ./deploy/scripts/bare-metal-deploy.sh
#     sudo ./deploy/scripts/bare-metal-deploy.sh --ref v0.2.0
#     sudo ./deploy/scripts/bare-metal-deploy.sh --rollback
#   1Panel 场景（PostgreSQL + 前端落站点目录）：
#     sudo PRISMA_SCHEMA=prisma/pg/schema.prisma \
#          WEB_SYNC_DIR=/opt/1panel/www/sites/<域名>/index \
#          REPO_URL=<git地址> ./deploy/scripts/bare-metal-deploy.sh
# @author donttemo
# @created 2026-10-14
# @module deploy

set -euo pipefail

# ---------- 可覆盖配置（环境变量注入，勿在文件里写死环境相关值）----------
APP_ROOT="${APP_ROOT:-/opt/fw}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
REF=""
SERVICE_API="${SERVICE_API:-fw-api}"
SERVICE_WORKER="${SERVICE_WORKER:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_MIGRATE="${SKIP_MIGRATE:-0}"
DO_ROLLBACK=0

RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
SHARED_DIR="$APP_ROOT/shared"
ENV_FILE="$SHARED_DIR/.env"
REPO_DIR="$SHARED_DIR/repo"
DEPLOY_LOG="$SHARED_DIR/deploy.log"
APP_DIR_REL="apps/example-api"
WEB_DIR_REL="apps/admin-web"

# Prisma schema 路径（相对应用目录）：默认 sqlite 那套；真机接 PostgreSQL 时置为 prisma/pg/schema.prisma。
# 两套 schema 的 provider 与迁移目录不同，必须与 DB_DRIVER 匹配，详见 deploy/systemd/fw.env.example
PRISMA_SCHEMA="${PRISMA_SCHEMA:-prisma/schema.prisma}"
# 可选：把前端构建产物同步到 1Panel 静态站点目录。
# 必需性说明：1Panel 的 OpenResty 跑在容器里，**容器内看不到 /opt/fw**，所以前端不能像宿主 nginx
# 那样直接 root 到 release 软链，必须落到 1Panel 站点目录（宿主机路径，如
# /opt/1panel/www/sites/fw.example.com/index）。留空则跳过同步（前端由别处托管时使用）。
WEB_SYNC_DIR="${WEB_SYNC_DIR:-}"

# corepack 缓存目录：与 server-bootstrap.sh 保持一致，复用其预热的 pnpm，避免重复下载
export COREPACK_HOME="${COREPACK_HOME:-/usr/local/corepack}"

# ---------- 输出 ----------
log() {
  local line="[$(date '+%F %T')] $*"
  echo "$line"
  [ -d "$SHARED_DIR" ] && echo "$line" >>"$DEPLOY_LOG" 2>/dev/null || true
}
die() { log "FAIL: $*"; exit 1; }

# 轮询健康端点，成功返回 0；用于发布后验收与回滚后确认
wait_healthy() {
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

usage() {
  cat <<'EOF'
云服务器裸机部署脚本

用法：
  sudo [REPO_URL=<git地址>] ./deploy/scripts/bare-metal-deploy.sh [选项]

选项：
  --ref <ref>       指定要发布的 git ref（分支/标签/提交），默认 BRANCH（main）
  --rollback        回滚：把 current 切回上一个 release 并重启（不动代码与迁移）
  --skip-build      跳过构建（仅用于依赖与产物已在 release 内的场景）
  --skip-migrate    跳过数据库迁移（结构未变时可用，谨慎）
  -h, --help        显示本帮助

可覆盖环境变量：
  APP_ROOT=/opt/fw          部署根目录（releases/ current/ shared/ 均在其下）
  BRANCH=main               默认分支
  SERVICE_API=fw-api        API 服务单元名
  SERVICE_WORKER=           worker 单元名（如 fw-worker@01）；留空则不动 worker
  HEALTH_URL=...            健康检查地址
  HEALTH_RETRIES=30         健康检查重试次数（每次间隔 2s）
  KEEP_RELEASES=5           保留的历史 release 数量
  PRISMA_SCHEMA=...         Prisma schema 相对应用目录的路径（默认 prisma/schema.prisma；
                            接 PostgreSQL 时须置为 prisma/pg/schema.prisma，与 DB_DRIVER 配套）
  WEB_SYNC_DIR=...          前端产物同步目标（1Panel 静态站点根目录）；留空则跳过同步
  COREPACK_HOME=...         corepack 缓存目录（默认 /usr/local/corepack，与 server-bootstrap.sh 一致）

示例：在 1Panel 服务器上接 PostgreSQL 发版
  sudo PRISMA_SCHEMA=prisma/pg/schema.prisma \\
       WEB_SYNC_DIR=/opt/1panel/www/sites/fw.example.com/index \\
       REPO_URL=<git地址> ./deploy/scripts/bare-metal-deploy.sh
EOF
}

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --rollback) DO_ROLLBACK=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 前置检查 ----------
[ "$(id -u)" = "0" ] || die "需要 root 权限（重启 systemd 服务与切换 /opt 下软链）：请用 sudo 运行"
command -v node >/dev/null 2>&1 || die "未找到 node：请先安装 Node.js（>= 20.19，推荐 22 LTS）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm：请执行 corepack enable && corepack prepare pnpm@11.6.0 --activate"
command -v git  >/dev/null 2>&1 || die "未找到 git"
command -v curl >/dev/null 2>&1 || die "未找到 curl（健康检查必需；Debian/Ubuntu: apt install -y curl）"
[ -f "$ENV_FILE" ] || die "缺少环境变量文件 $ENV_FILE（从 deploy/systemd/fw.env.example 复制并填写）"

# 应用目录必须是 cwd：Prisma schema 与 .env 均按 cwd 解析（与 fw-api.service 的 WorkingDirectory 保持一致）
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)）：NestJS 11 要求 >= 20"

# 加载环境变量供 prisma generate 与迁移使用。
# 注意：systemd 的 EnvironmentFile 不支持 shell 语法，此处 . 加载仅为「取变量」，值内出现 $ 会被 bash 展开——
# 密钥含特殊字符时请在 env 文件中用单引号包裹整值（systemd 与 bash 两处都安全）。
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

mkdir -p "$RELEASES_DIR" "$SHARED_DIR"
chown -R fw:fw "$SHARED_DIR" 2>/dev/null || true

# ---------- 回滚分支 ----------
if [ "$DO_ROLLBACK" = "1" ]; then
  CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  PREV="$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's#/$##' | grep -v "^${CURRENT_TARGET}$" | head -1)"
  [ -n "$PREV" ] || die "没有可回滚的历史 release"
  log "回滚：current → $PREV"
  ln -sfn "$PREV" "$CURRENT_LINK.tmp" && mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
  systemctl restart "$SERVICE_API"
  [ -n "$SERVICE_WORKER" ] && systemctl restart "$SERVICE_WORKER"
  sleep 2
  if wait_healthy; then
    log "回滚完成，服务健康：$HEALTH_URL"
  else
    die "回滚后健康检查仍失败，请查 journalctl -u $SERVICE_API -n 200"
  fi
  exit 0
fi

# ---------- 取代码（常驻 clone + 导出，避免每版重复全量 clone）----------
if [ ! -d "$REPO_DIR/.git" ]; then
  [ -n "$REPO_URL" ] || die "首次部署必须提供 REPO_URL（如 git@github.com:donttemos/TY.git 或 https://<PAT>@github.com/donttemos/TY.git）"
  log "首次克隆仓库到 $REPO_DIR"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
  chown -R fw:fw "$REPO_DIR"
fi
log "拉取最新引用"
git -C "$REPO_DIR" fetch --quiet --prune origin

# 解析目标 ref：先按本地引用（标签/提交/分支），再回退到 origin/<ref>
TARGET_REF="${REF:-$BRANCH}"
if git -C "$REPO_DIR" rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  RESOLVED_REF="$TARGET_REF"
elif git -C "$REPO_DIR" rev-parse --verify --quiet "origin/${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  RESOLVED_REF="origin/${TARGET_REF}"
else
  die "git ref 不存在：$TARGET_REF"
fi
COMMIT="$(git -C "$REPO_DIR" rev-parse --short "$RESOLVED_REF")"

RELEASE_NAME="$(date '+%Y%m%d%H%M%S')-$COMMIT"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_NAME"
log "创建 release：$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
# git archive 只导出被跟踪文件：天然排除 dist/、dev.db、node_modules 等不该上服务器的东西
git -C "$REPO_DIR" archive "$RESOLVED_REF" | tar -x -C "$RELEASE_DIR"
chown -R fw:fw "$RELEASE_DIR"

# ---------- 装依赖与构建 ----------
if [ "$SKIP_BUILD" = "0" ]; then
  log "安装依赖（frozen-lockfile，含 devDependencies —— 构建与迁移都需要 tsc / prisma CLI / tsx）"
  ( cd "$RELEASE_DIR" && pnpm install --frozen-lockfile )

  log "生成 Prisma Client（schema=$PRISMA_SCHEMA；provider 必须与目标数据库一致）"
  ( cd "$RELEASE_DIR/$APP_DIR_REL" && pnpm exec prisma generate --schema "$PRISMA_SCHEMA" )

  log "构建框架包与应用"
  ( cd "$RELEASE_DIR" && pnpm --filter "example-api..." run build )
  log "构建管理后台前端静态产物"
  ( cd "$RELEASE_DIR" && pnpm --filter admin-web run build )

  # 补齐 workspace bin 链接（真机部署修复）。
  # pnpm 在 install 阶段创建 workspace 包的 bin 链接，而那一刻 packages/cli/dist/index.js 尚未构建，
  # 于是 apps/example-api/node_modules/.bin/fw 被静默跳过（仅留一条 WARN）；此后无论 install 还是
  # install --force 都会判「Already up to date」不再补建 —— 结果是 pnpm run db:migrate（内部调 fw）
  # 直接报 `fw: not found`，迁移与种子全部不可用。
  # 修法：构建后删掉应用自身的 node_modules 再装一次。工作区内该目录只是一组软链，重建约 2 秒。
  log "补齐 workspace bin 链接（fw CLI 首次 install 时尚无 dist，需重建）"
  rm -rf "$RELEASE_DIR/$APP_DIR_REL/node_modules"
  ( cd "$RELEASE_DIR" && pnpm install --frozen-lockfile )
  [ -x "$RELEASE_DIR/$APP_DIR_REL/node_modules/.bin/fw" ] \
    || die "fw CLI 未就位（$APP_DIR_REL/node_modules/.bin/fw）：db:migrate / db:seed 将不可用"

  # 前端产物同步到 1Panel 站点目录：OpenResty 在容器内看不到 /opt/fw，无法 root 到 release 软链
  if [ -n "$WEB_SYNC_DIR" ]; then
    [ -d "$WEB_SYNC_DIR" ] || die "WEB_SYNC_DIR 不存在：$WEB_SYNC_DIR（请先在 1Panel 创建静态站点，再填其站点根目录）"
    command -v rsync >/dev/null 2>&1 || die "缺少 rsync（apt install -y rsync）；它用于带 --delete 的增量同步"
    log "同步前端产物 → $WEB_SYNC_DIR"
    rsync -a --delete "$RELEASE_DIR/$WEB_DIR_REL/dist/" "$WEB_SYNC_DIR/"
    # 1Panel 的 OpenResty 以 root 读取，放开其他用户读位即可；不改变目录属主以免干扰面板
    chmod -R a+rX "$WEB_SYNC_DIR"
  else
    log "未指定 WEB_SYNC_DIR，跳过前端产物同步（前端由别处托管）"
  fi
else
  log "已指定 --skip-build，跳过依赖安装与构建"
fi

# ---------- 迁移（先于切换：迁移失败则不动线上代码）----------
if [ "$SKIP_MIGRATE" = "0" ]; then
  log "执行数据库迁移：fw db:migrate --schema=$PRISMA_SCHEMA（= prisma migrate deploy，幂等）"
  ( cd "$RELEASE_DIR/$APP_DIR_REL" && pnpm run db:migrate -- --schema="$PRISMA_SCHEMA" ) \
    || die "迁移失败：已中止发布，线上仍运行旧版本（请检查 DB_URL 与 PRISMA_SCHEMA 方言是否匹配）"
else
  log "已指定 --skip-migrate，跳过迁移"
fi

# ---------- 原子切换软链 ----------
PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
log "切换 current 软链：${PREVIOUS_TARGET:-<无>} → $RELEASE_DIR"
# 先建临时软链再 mv -T 覆盖：rename(2) 原子，避免切换瞬间出现断链
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
# 软链属主同应用用户（nginx 与 systemd 都在此路径下读取；用户不存在时不影响流程）
chown -h fw:fw "$CURRENT_LINK" 2>/dev/null || true

# ---------- 重启与健康检查 ----------
log "重启服务：$SERVICE_API${SERVICE_WORKER:+ 与 $SERVICE_WORKER}"
systemctl restart "$SERVICE_API"
[ -n "$SERVICE_WORKER" ] && systemctl restart "$SERVICE_WORKER"
sleep 2

if wait_healthy; then
  log "发布成功：release=$RELEASE_NAME commit=$COMMIT"
  log "已回滚的迁移不会被自动撤销：若本次迁移不向后兼容，回滚时需手工执行 fw db:rollback"
else
  log "健康检查失败：$HEALTH_URL（重试 $HEALTH_RETRIES 次未通过）"
  log "最近日志：journalctl -u $SERVICE_API -n 100 --no-pager"
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "自动回滚到上一版本：$PREVIOUS_TARGET"
    ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK.tmp" && mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
    systemctl restart "$SERVICE_API"
    [ -n "$SERVICE_WORKER" ] && systemctl restart "$SERVICE_WORKER"
    sleep 2
    if wait_healthy; then
      die "发布失败已回滚，服务已恢复旧版本（请修复后重发）"
    fi
    die "发布失败且回滚后仍不健康：请立即人工介入（journalctl -u $SERVICE_API -n 200）"
  fi
  die "发布失败且无可回滚版本"
fi

# ---------- 清理旧 release（仅保留最近 KEEP_RELEASES 个）----------
mapfile -t OLD_RELEASES < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's#/$##' | tail -n +$((KEEP_RELEASES + 1)))
for d in "${OLD_RELEASES[@]:-}"; do
  [ -n "$d" ] || continue
  # 严格限定在 $APP_ROOT/releases 下，避免路径异常时误删
  case "$d" in
    "$RELEASES_DIR"/*) log "清理旧 release：$(basename "$d")"; rm -rf -- "$d" ;;
    *) log "跳过非预期路径：$d" ;;
  esac
done

log "部署流程结束"
