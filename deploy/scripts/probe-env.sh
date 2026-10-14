#!/usr/bin/env bash
# @file 部署前环境勘察脚本（只读，不做任何修改）
# @description 对应 docs/62-1panel-real-deploy.md 第 2 步。一次性摸清目标服务器的真实拓扑，
#   重点回答「1Panel 的 OpenResty 怎么反代到宿主进程」「MySQL/PG/Redis 的宿主端口是多少」
#   「构建资源够不够」三个问题。输出可直接回贴用于排障。
#   不输出任何密码/密钥（Prisma 连接串中的口令一律脱敏）。
#   用法：sudo bash deploy/scripts/probe-env.sh
# @author donttemo
# @created 2026-10-14
# @module deploy

set -uo pipefail   # 刻意不加 -e：单项探测失败不应中断整体勘察

SEC=""; hdr() { echo ""; echo "=================== $* ==================="; }
ok()  { echo -e "  \033[32m[OK]\033[0m   $*"; }
no()  { echo -e "  \033[31m[NO]\033[0m   $*"; }
note(){ echo -e "  \033[33m[NOTE]\033[0m $*"; }

# 探测 TCP 端口是否有服务监听（优先用 ss，回退 bash /dev/tcp）
port_open() {
  local host="$1" port="$2"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$" && return 0
  fi
  timeout 2 bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null
}

# ============ 1. 系统与资源 ============
hdr "1. 系统与资源"
. /etc/os-release 2>/dev/null && echo "  发行版    : $PRETTY_NAME"
echo "  内核      : $(uname -r)"
echo "  CPU       : $(nproc) 核  ($(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo | sed 's/^ *//'))"
free -h | awk '/^(Mem|Swap):/{printf "  %-10s: %s\n", $1, $2}'
echo "  磁盘 /    : $(df -h / | awk 'NR==2{print $4" 可用 / "$2" 总"}')"
echo "  磁盘 /opt : $(df -h /opt 2>/dev/null | awk 'NR==2{print $4" 可用 / "$2" 总"}' || echo '同 /')"
# 构建可行性判定：2G 内存 + swap 总量是硬指标
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
echo "  ---- 构建可行性 ----"
if [ $((MEM_MB + SWAP_MB)) -ge 3000 ]; then
  ok "内存+swap = $((MEM_MB + SWAP_MB))MB，满足全量构建（峰值约 1.2~1.6G）"
else
  no "内存+swap = $((MEM_MB + SWAP_MB))MB，偏低；建议跑 server-bootstrap.sh 补 swap，或改用 CI 构建后上传"
fi

# ============ 2. 1Panel ============
hdr "2. 1Panel 面板"
if command -v 1panel >/dev/null 2>&1; then
  ok "1panel CLI 存在"
  note "版本：$(1panel version 2>/dev/null | head -3 | tr '\n' ' ')"
else
  no "未找到 1panel CLI（可能装在非默认路径）"
fi
for d in /opt/1panel /usr/local/bin/1panel /www/server/1panel; do
  [ -d "$d" ] && echo "  安装目录  : $d"
done
[ -d /opt/1panel/apps ] && echo "  应用目录  : /opt/1panel/apps（1Panel 应用商店部署的容器数据）"
ss -ltnp 2>/dev/null | grep -E ':(1[0-9]{4}|9999|2[0-9]{4})\b' | head -5 | sed 's/^/  面板监听  : /'

# ============ 3. 容器与网络拓扑（本次勘察的核心）============
hdr "3. 容器与网络拓扑"
if command -v docker >/dev/null 2>&1; then
  echo "  --- 运行中的容器（名称 / 镜像 / 网络模式 / 端口映射）---"
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | while IFS=$'\t' read -r name image ports; do
    netmode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$name" 2>/dev/null || echo '?')
    printf '  %-28s %-34s %-12s %s\n' "$name" "$image" "$netmode" "$ports"
  done
  echo ""
  echo "  --- 网络清单 ---"
  docker network ls 2>/dev/null | sed 's/^/  /'

  # OpenResty 的网络模式决定反代地址怎么写
  OR_NAME=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'openresty|nginx' | head -1)
  if [ -n "$OR_NAME" ]; then
    OR_NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$OR_NAME" 2>/dev/null)
    if [ "$OR_NET" = "host" ]; then
      ok "OpenResty 容器 [$OR_NAME] 使用 host 网络 → 反代地址可直接写 http://127.0.0.1:3000"
    else
      note "OpenResty 容器 [$OR_NAME] 网络模式为 [$OR_NET]（非 host）"
      note "→ 反代宿主进程需改用宿主机内网 IP（如 http://172.17.0.1:3000），不能写 127.0.0.1"
      echo "  宿主机内网 IP：$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | head -3 | tr '\n' ' ')"
    fi
  else
    no "未发现 openresty/nginx 容器（可能以宿主进程安装，检查 /usr/local/openresty 或 nginx）"
    ls -d /usr/local/openresty /etc/nginx /www/server/nginx 2>/dev/null | sed 's/^/  发现目录  : /'
  fi
else
  no "未安装 docker（若 OpenResty/数据库以宿主进程运行，请直接看第 4、5 节）"
fi

# ============ 4. 反向代理与端口占用 ============
hdr "4. 反向代理与端口占用"
echo "  --- 80/443/3000 监听情况 ---"
ss -ltnp 2>/dev/null | grep -E ':(80|443|3000)\b' | sed 's/^/  /' || echo "  （无）"
echo ""
echo "  --- OpenResty/Nginx 站点配置位置（1Panel 常见路径）---"
for p in /opt/1panel/apps/openresty/openresty/conf/conf.d \
         /opt/1panel/www/sites /www/sites /etc/nginx/conf.d; do
  [ -d "$p" ] && echo "  $p" && ls "$p" 2>/dev/null | head -6 | sed 's/^/      /'
done
echo ""
echo "  --- 防火墙 ---"
if command -v ufw >/dev/null 2>&1; then echo "  ufw: $(ufw status 2>/dev/null | head -1)"; fi
if command -v firewall-cmd >/dev/null 2>&1; then echo "  firewalld: $(firewall-cmd --state 2>/dev/null)"; fi

# ============ 5. 数据库与缓存可用性 ============
hdr "5. 数据库与缓存（宿主可达性）"
probe_db() {
  local label="$1" port="$2" hint="$3"
  if port_open 127.0.0.1 "$port"; then
    ok "$label 在 127.0.0.1:$port 可达  → DB_URL 用 127.0.0.1:$port $hint"
  else
    no "$label 在 127.0.0.1:$port 不可达（端口被改或未启动，从容器映射信息确认实际端口）"
  fi
}
probe_db "MySQL"      3306 ""
probe_db "PostgreSQL" 5432 ""
probe_db "Redis"      6379 ""
echo ""
note "若上面显示不可达，请从第 3 节的容器端口映射里取实际宿主端口；"
note "连接串中的口令在 1Panel「数据库」页面可查看，勿贴到聊天中。"
echo ""
echo "  --- 客户端工具 ---"
for c in mysql psql redis-cli; do
  command -v "$c" >/dev/null 2>&1 && ok "$c 已安装（可用于连通性验证）" || note "$c 未安装（可在 1Panel 面板内验证）"
done

# ============ 6. 运行时与部署前置 ============
hdr "6. 运行时与部署前置"
for c in node pnpm git curl; do
  if command -v "$c" >/dev/null 2>&1; then
    case "$c" in
      node) ok "$c $(node -v)  @ $(command -v node)" ;;
      pnpm) ok "$c $(pnpm --version 2>/dev/null || echo '?')" ;;
      git)  ok "$c $(git --version | awk '{print $3}')" ;;
      curl) ok "$c $(curl --version | head -1 | awk '{print $2}')" ;;
    esac
  else
    no "$c 未安装（node/pnpm 由 server-bootstrap.sh 负责，git/curl 必需）"
  fi
done
echo ""
echo "  --- 是否已存在部署目录 ---"
for d in /opt/fw /opt/fw/current /opt/fw/releases /opt/fw/shared/.env; do
  [ -e "$d" ] && echo "  已存在: $d" || echo "  未创建: $d"
done
echo ""
id fw >/dev/null 2>&1 && ok "运行用户 fw 已存在" || note "运行用户 fw 未创建（server-bootstrap.sh 会创建）"

# ============ 7. 外网可达性（决定 git clone 走哪条路）============
hdr "7. 外网可达性"
for url in https://github.com https://registry.npmjs.org https://registry.npmmirror.com; do
  code=$(curl -o /dev/null -s -w '%{http_code}' --connect-timeout 6 --max-time 10 "$url" 2>/dev/null || echo '000')
  if [ "$code" = "000" ]; then no "$url 不可达（超时/被墙）"; else ok "$url → HTTP $code"; fi
done

echo ""
echo "=================== 勘察结束 ==================="
echo "把以上完整输出回贴即可定位部署方式。"
