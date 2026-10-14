#!/usr/bin/env bash
# @file 云服务器初始化脚本（裸机部署前置，幂等，可反复执行）
# @description 对应 docs/62-1panel-real-deploy.md 第 3 步。完成四件事：
#   1) 安装 Node 22 LTS（用 npmmirror 二进制包直解，不走 NodeSource 仓库——国内 4M 带宽下最稳）
#   2) 启用 corepack 并激活仓库锁定版本 pnpm（packageManager 字段）
#   3) 创建 fw 运行用户与 /opt/fw/{releases,shared} 目录骨架
#   4) 配置 swap 与内核参数——2C2G 上跑 pnpm install + tsc 全量构建，无 swap 必然 OOM
#
#   设计取舍：不装 build-essential / python3。Prisma 的 query engine 与 esbuild 均为预编译二进制，
#   本项目全量依赖无需本地编译；少装 200MB 工具链对 2C2G 磁盘与内存都更友好。
#
#   用法：
#     sudo bash deploy/scripts/server-bootstrap.sh
#     sudo NODE_VERSION=22.22.2 SWAP_SIZE=2G bash deploy/scripts/server-bootstrap.sh
#     sudo SKIP_SWAP=1 bash deploy/scripts/server-bootstrap.sh    # 云厂商已自带 swap 时
#
# @author donttemo
# @created 2026-10-14
# @module deploy

set -euo pipefail

# ---------- 可覆盖配置 ----------
FW_USER="${FW_USER:-fw}"
APP_ROOT="${APP_ROOT:-/opt/fw}"
SWAP_SIZE="${SWAP_SIZE:-2G}"          # 2C2G 建议 2G；构建峰值内存约 1.2~1.6G
SWAP_FILE="${SWAP_FILE:-/swapfile}"
NODE_VERSION="${NODE_VERSION:-22.22.2}"   # 与本地开发运行时同版本；不要依赖镜像的 latest-v22.x
                                          # 目录（实测该索引陈旧，仍指向 22.0.0，而 pnpm 11 要求 >= 22.13）
PNPM_VERSION="${PNPM_VERSION:-11.6.0}"
NODE_MIRROR="${NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}"
NPM_MIRROR="${NPM_MIRROR:-https://registry.npmmirror.com}"
COREPACK_HOME_DIR="${COREPACK_HOME_DIR:-/usr/local/corepack}"
SKIP_SWAP="${SKIP_SWAP:-0}"

# ---------- 输出 ----------
info() { echo -e "\033[32m[INFO]\033[0m $*"; }
warn() { echo -e "\033[33m[WARN]\033[0m $*"; }
die()  { echo -e "\033[31m[FAIL]\033[0m $*" >&2; exit 1; }

# ---------- 前置检查 ----------
[ "$(id -u)" = "0" ] || die "需要 root：请用 sudo 运行"
command -v curl >/dev/null 2>&1 || die "缺少 curl：apt update && apt install -y curl"

NODE_ARCH="x64"
case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "不支持的架构 $(uname -m)：请手动安装 Node 22" ;;
esac

# 发行版探测（仅用于给出正确的包管理器提示）
if command -v apt-get >/dev/null 2>&1; then
  PKG_INSTALL="apt-get install -y"
  $PKG_INSTALL -qq curl xz-utils ca-certificates git rsync >/dev/null 2>&1 || \
    { apt-get update -qq && $PKG_INSTALL -qq curl xz-utils ca-certificates git rsync; }
elif command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="dnf install -y"
  $PKG_INSTALL -q curl xz ca-certificates git rsync || true
elif command -v yum >/dev/null 2>&1; then
  PKG_INSTALL="yum install -y"
  $PKG_INSTALL -q curl xz ca-certificates git rsync || true
else
  warn "未识别的包管理器，跳过基础工具安装（请自行确认 curl/xz/git 存在）"
fi

info "系统：$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s) | 架构：$NODE_ARCH | 内存：$(free -h | awk '/^Mem:/{print $2}')"

# ============ 1. 安装 Node 22 ============
NODE_PREFIX="/usr/local/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
if [ -x "$NODE_PREFIX/bin/node" ]; then
  info "Node 已安装：$("$NODE_PREFIX/bin/node" -v)（跳过下载）"
else
  TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  info "下载 Node $NODE_VERSION（$NODE_ARCH，约 45MB）…"
  curl -fL --retry 3 --connect-timeout 15 -o "/tmp/$TARBALL" "$NODE_MIRROR/v${NODE_VERSION}/${TARBALL}" \
    || die "下载失败：$NODE_MIRROR/v${NODE_VERSION}/${TARBALL}
  可换源重试：sudo NODE_MIRROR=https://nodejs.org/dist bash $0"
  info "解压到 $NODE_PREFIX"
  mkdir -p "$NODE_PREFIX"
  tar -xJf "/tmp/$TARBALL" -C /usr/local
  rm -f "/tmp/$TARBALL"
fi
# 符号链接进 /usr/local/bin（默认在 PATH 中）；systemd 单元直接引用该绝对路径
for bin in node npm npx corepack; do
  ln -sfn "$NODE_PREFIX/bin/$bin" "/usr/local/bin/$bin"
done
info "node -> $(node -v) | npm -> $(npm -v)"

# ============ 2. 启用 pnpm（corepack，锁定仓库声明的版本）============
mkdir -p "$COREPACK_HOME_DIR"
# 全局共享 corepack 缓存：root 预热一次，fw 用户可直接读取（部署脚本以 root 运行，这是兜底）
echo "export COREPACK_HOME=$COREPACK_HOME_DIR" > /etc/profile.d/node-corepack.sh
chmod 644 /etc/profile.d/node-corepack.sh
export COREPACK_HOME="$COREPACK_HOME_DIR"
# corepack 自身也从 npm 源拉 pnpm：指向镜像，否则大陆机器上这一步会长时间卡住
export COREPACK_NPM_REGISTRY="$NPM_MIRROR"

corepack enable --install-directory /usr/local/bin || die "corepack enable 失败"
# 非交互环境禁用下载确认提示（corepack 默认会 prompt，导致脚本挂起）
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack prepare "pnpm@${PNPM_VERSION}" --activate || die "corepack prepare pnpm@${PNPM_VERSION} 失败"
info "pnpm -> $(COREPACK_HOME="$COREPACK_HOME_DIR" PNPM_HOME=/usr/local pnpm --version 2>/dev/null || echo '需在登录 shell 中确认')"
chmod -R a+rX "$COREPACK_HOME_DIR"

# ============ 2.5 npm/pnpm 走镜像（大陆服务器实测差异 20 倍）============
# 实测（腾讯云 2C2G4M，2026-10-14）：registry.npmjs.org 约 0.86 MB/s（单包元数据 18s），
# registry.npmmirror.com 约 18.7 MB/s。不换源时 `pnpm install` 会从分钟级变成小时级。
# 写三处：Node 自身前缀（全局默认）+ root 与 fw 的 HOME（部署脚本与手工排障各会用到一个）。
for rc in "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/etc/npmrc" \
          /root/.npmrc "$APP_ROOT/.npmrc"; do
  mkdir -p "$(dirname "$rc")" 2>/dev/null || true
  echo "registry=$NPM_MIRROR" > "$rc" 2>/dev/null || true
done
info "npm registry -> $(npm config get registry)"

# ============ 3. 运行用户与目录骨架 ============
if id "$FW_USER" >/dev/null 2>&1; then
  info "用户 $FW_USER 已存在"
else
  useradd --system --create-home --home-dir "$APP_ROOT" --shell /bin/bash "$FW_USER"
  info "已创建系统用户 $FW_USER（home=$APP_ROOT，禁止交互登录以外无特殊权限）"
fi

# 目录骨架：releases/ 存历史版本，current 指向当前版本，shared/ 存跨版本共享数据
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/shared/data" "$APP_ROOT/shared/logs"
chown -R "$FW_USER:$FW_USER" "$APP_ROOT"
chmod 750 "$APP_ROOT"
# shared/data 承载 SQLite 与上传文件（若改用 PG/对象存储则可留空），仅属主可读写
chmod 750 "$APP_ROOT/shared/data"
info "目录骨架就绪：$APP_ROOT/{releases,current,shared/{data,logs}}"

# ============ 4. swap 与内核参数（2C2G 构建的关键）============
CURRENT_SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
if [ "$SKIP_SWAP" = "1" ]; then
  warn "已指定 SKIP_SWAP=1，跳过 swap 配置（当前 swap：${CURRENT_SWAP_MB}MB）"
elif [ "$CURRENT_SWAP_MB" -ge 1024 ]; then
  info "已存在 ${CURRENT_SWAP_MB}MB swap，跳过创建"
else
  info "创建 ${SWAP_SIZE} swap（当前仅 ${CURRENT_SWAP_MB}MB）…"
  if [ -f "$SWAP_FILE" ]; then
    warn "$SWAP_FILE 已存在，先 swapoff 复用"
    swapoff "$SWAP_FILE" 2>/dev/null || true
    rm -f "$SWAP_FILE"
  fi
  # 归一为 MB，供 dd 回退路径使用（fallocate 在部分文件系统如旧版 xfs / overlayfs 不可用）
  case "$SWAP_SIZE" in
    *[Gg]) SWAP_MB=$(( ${SWAP_SIZE%[Gg]} * 1024 )) ;;
    *[Mm]) SWAP_MB=${SWAP_SIZE%[Mm]} ;;
    *)     SWAP_MB=$SWAP_SIZE ;;
  esac
  fallocate -l "${SWAP_MB}M" "$SWAP_FILE" 2>/dev/null || \
    dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_MB" status=none
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  swapon "$SWAP_FILE"
  # 持久化：重启后自动挂载
  grep -q "^$SWAP_FILE " /etc/fstab 2>/dev/null || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
  info "swap 已启用：$(free -h | awk '/^Swap:/{print $2}')"
fi

# 内核参数（幂等写入 /etc/sysctl.d，不直接改 /etc/sysctl.conf）
cat > /etc/sysctl.d/99-fw.conf <<'EOF'
# 由 deploy/scripts/server-bootstrap.sh 生成
# 降低无谓换出：只在真正内存压力下才用 swap（构建阶段仍会正常使用）
vm.swappiness = 10
# 内存超售：Prisma / Node 的 V8 会预留较大虚拟地址空间，禁止检查可避免偶发分配失败
vm.overcommit_memory = 1
# 增大本地端口范围与连接队列，配合 NODE 高并发（与 1Panel OpenResty 共存）
net.core.somaxconn = 1024
EOF
sysctl -p /etc/sysctl.d/99-fw.conf >/dev/null 2>&1 || warn "sysctl 应用失败（不影响后续步骤）"
info "内核参数已写入 /etc/sysctl.d/99-fw.conf"

# ============ 5. 结果汇总 ============
echo ""
info "============ 初始化完成 ============"
printf '  %-16s %s\n' "Node"    "$(node -v)"
printf '  %-16s %s\n' "pnpm"    "$(COREPACK_HOME=$COREPACK_HOME_DIR pnpm --version 2>/dev/null || echo '见下方提示')"
printf '  %-16s %s\n' "内存"    "$(free -h | awk '/^Mem:/{print $2}')"
printf '  %-16s %s\n' "swap"    "$(free -h | awk '/^Swap:/{print $2}')"
printf '  %-16s %s\n' "磁盘可用" "$(df -h "$APP_ROOT" | awk 'NR==2{print $4}')"
printf '  %-16s %s\n' "运行用户" "$FW_USER"
printf '  %-16s %s\n' "部署根目录" "$APP_ROOT"
echo ""
echo "下一步："
echo "  1) 运行环境勘察，确认 1Panel 与数据库的实际端口/网络："
echo "       sudo bash deploy/scripts/probe-env.sh"
echo "  2) 配置 $APP_ROOT/shared/.env（从 deploy/systemd/fw.env.example 复制）"
echo "  3) 执行首次部署："
echo "       sudo REPO_URL=<git地址> BRANCH=main bash deploy/scripts/bare-metal-deploy.sh"
echo ""
if [ "$CURRENT_SWAP_MB" -lt 1024 ] && [ "$SKIP_SWAP" = "0" ]; then
  warn "提醒：swap 用于兜底构建峰值，日常运行应尽量避免依赖 swap（否则响应延迟显著上升）"
fi
