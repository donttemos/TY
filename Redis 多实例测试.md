# donttemos/TY 双节点实机验证方案

目标：不修改仓库、不引入 Kubernetes，利用现有 Windows 物理机和 Linux 云服务器，验证 TY 的 Redis Cache、分布式锁，以及 Refresh Token 轮换在两个独立 Node.js 进程、跨机器运行时的行为。

方案以目前查看到的 `main` 分支提交 `9a05a20a71038374b68d941db06c4065d9f740ff` 为代码基线。实测时应先固定两台机器的提交 SHA，避免 A、B 运行不同版本。

- [TY 仓库](https://github.com/donttemos/TY?utm_source=chatgpt.com)
- [真实 Redis 集成测试](https://github.com/donttemos/TY/blob/main/packages/cache/src/__tests__/redis-integration.test.ts?utm_source=chatgpt.com)
- [Redis 驱动](https://github.com/donttemos/TY/blob/main/packages/cache/src/drivers/redis.driver.ts?utm_source=chatgpt.com)
- [分布式锁实现](https://github.com/donttemos/TY/blob/main/packages/cache/src/lock.ts?utm_source=chatgpt.com)
- [Refresh Token 轮换服务](https://github.com/donttemos/TY/blob/main/packages/auth/src/refresh-token.service.ts?utm_source=chatgpt.com)
- [双实例 Refresh Token CAS 验证脚本](https://github.com/donttemos/TY/blob/main/apps/example-api/scripts/dual-instance-rotation.mjs?utm_source=chatgpt.com)
- [CI 工作流](https://github.com/donttemos/TY/blob/main/.github/workflows/ci.yml?utm_source=chatgpt.com)

## 1. 先明确三个架构事实

Cache 和分布式锁：共享同一个 Redis

两个实例必须使用同一个 Redis 实例、同一个逻辑环境和相同的 `CACHE_PREFIX`。否则两边可能各自读写独立的键，导致测试出现假阳性。

Refresh Token：共享同一个数据库，而不只是 Redis

当前轮换 CAS 的权威状态在 `AuthStore` / Prisma 数据库中。Redis 共享不能代替数据库共享。如果 A、B 分别使用各自的 SQLite 文件，即使 Redis 相同，也不能证明 Refresh Token 的跨节点 CAS 正确。

Windows 没有公网 IP 不影响测试

Windows 可以主动通过 SSH 隧道访问云服务器上的 Redis 和数据库。无需将 Windows 暴露到公网，也无需把 Redis 的 `6379` 端口开放给整个互联网。

这里有一个重要的测试边界：Refresh Token 的跨节点测试必须让两个实例访问同一数据库。建议使用现有 CI 已覆盖的 MySQL 或 PostgreSQL 方言，并在专用测试库上验证。

## 2. 网络拓扑与安全配置

节点 A：Windows 物理机

Node.js 进程 A · HTTP 端口 3000

Redis 连接 `127.0.0.1:16379`（SSH 本地转发）

数据库连接同一共享测试库

Windows 主动发起 SSH 连接

节点 B：Linux 云服务器

Node.js 进程 B · HTTP 端口 3000 或独立端口

Redis 连接 `127.0.0.1:6379`

共享测试数据库 · Redis 单实例

### 2.1 云服务器：Redis 只允许本机访问

优先让 Redis 监听回环地址，应用 B 直接访问，Windows A 通过 SSH 隧道访问。

在 Linux 云服务器上先检查：

```
sudo systemctl status redis-server
redis-cli -h 127.0.0.1 -p 6379 PING
sudo ss -lntp | grep 6379
```

预期：

- Redis 返回 `PONG`。
- Redis 监听 `127.0.0.1:6379`，而不是无保护地监听所有公网接口。
- 云服务器防火墙和云厂商安全组均不向公网开放 `6379`。

如果你的 Redis 是通过其他方式安装的，服务名称可能不是 `redis-server`；以实际安装方式为准。不要为了测试直接覆盖现有 Redis 配置。

认证建议： 为测试应用配置独立 Redis ACL 用户，限制在测试所需的命令和键前缀范围内。不要把密码写进 Git、命令截图或公开日志。如果使用带密码的 URI，注意密码中的特殊字符需要 URL 编码。

### 2.2 Windows：建立 SSH 隧道

以下假设 Redis 与共享测试数据库都在云服务器上，且数据库监听云服务器本机。数据库端口按实际方言选择：MySQL 为 `3306`，PostgreSQL 为 `5432`。

在 Windows PowerShell 中运行：

```
ssh -N `
  -L 127.0.0.1:16379:127.0.0.1:6379 `
  -L 127.0.0.1:13306:127.0.0.1:3306 `
  user@YOUR_CLOUD_IP
```

如果使用 PostgreSQL，将第二个转发改为：

```
-L 127.0.0.1:15432:127.0.0.1:5432
```

这里的 `YOUR_CLOUD_IP` 是云服务器公网 IP，`user` 是允许 SSH 登录的账户。保持这个终端运行；终止 SSH 进程即代表网络中断测试。

在另一个 PowerShell 窗口检查 Redis 转发：

```
Test-NetConnection 127.0.0.1 -Port 16379
```

也可以用安装好的 `redis-cli` 验证：

```
redis-cli -h 127.0.0.1 -p 16379 PING
```

预期连接成功并返回 `PONG`。

> 如果数据库不在云服务器上，不要照抄数据库转发目标；需要将数据库转发到真实的数据库主机。两个 TY 实例必须使用同一数据库，不要求数据库一定和 Redis 部署在同一台机器。

## 3. 固定版本与准备测试环境

两台机器都在仓库根目录执行：

```
git clone https://github.com/donttemos/TY.git
cd TY
git fetch origin
git checkout 9a05a20a71038374b68d941db06c4065d9f740ff
git rev-parse HEAD
pnpm install --frozen-lockfile
```

如果已经 clone，使用 `git fetch origin` 和 `git checkout <SHA>` 固定版本即可。两台机器的 `git rev-parse HEAD` 必须完全一致。

构建 example API 及其依赖：

```
pnpm --filter "example-api..." run build
```

在使用 MySQL 或 PostgreSQL 时，还必须生成与目标数据库方言匹配的 Prisma Client，并部署该方言的迁移。仓库 CI 已经按 `prisma/mysql/schema.prisma` 和 `prisma/pg/schema.prisma` 分别处理这两类数据库，实机也应保持同一规则。

### 3.1 配置两台机器的 Redis 与数据库

TY 的配置入口可参考 [`apps/example-api/.env.example`](https://github.com/donttemos/TY/blob/main/apps/example-api/.env.example?utm_source=chatgpt.com)。

两台实例的关键配置原则如下：

| 配置                     | Windows A                | 云服务器 B                  |
| ---------------------- | ------------------------ | ----------------------- |
| `APP_ENV`              | `test` 或相同测试环境           | 与 A 一致                  |
| `APP_PORT`             | `3000`                   | `3000`，或不同端口            |
| `CACHE_DRIVER`         | `redis`                  | `redis`                 |
| `CACHE_URL`            | `127.0.0.1:16379` 对应的连接串 | `127.0.0.1:6379` 对应的连接串 |
| `CACHE_PREFIX`         | 相同、独立于其他环境的测试前缀          | 与 A 完全一致                |
| `CACHE_FAIL_OPEN`      | 首轮建议 `false`             | 首轮建议 `false`            |
| `CACHE_LOCK_TTL`       | 相同                       | 相同                      |
| `DB_DRIVER` / `DB_URL` | 同一共享测试数据库                | 同一共享测试数据库               |
| JWT / replacement 密钥   | 同一组测试密钥                  | 同一组测试密钥                 |

如果 Redis 需要认证，将用户名和密码加入各自的 `CACHE_URL`。表中地址只是连接目标，完整 URI 需要符合实际 Redis ACL 配置。

特别注意：

- 不要让两台机器使用不同的 `CACHE_PREFIX`，否则相同的逻辑锁名可能对应不同的 Redis 键。
- 不要将 A、B 的 Refresh Token 密钥配置成不同值；否则即使数据库共享，也可能因为无法解密或验证而失败。
- `CACHE_FAIL_OPEN=false` 用于第一轮严格验收，避免 Redis 连接失败被缓存层静默降级掩盖。
- `APP_ENV=test` 只是示例。应使用框架支持的环境值，并确保两台机器的运行配置一致。
- 不要把生产数据库、生产 Redis 或真实用户令牌用作这次测试的目标。

## 4. 启动两个独立的 TY 实例

为了既测试 Redis，又避免直接向公网开放 API，建议让云服务器的 B 实例监听 `3001`，但通过防火墙禁止公网访问该端口；Windows 通过 SSH 隧道访问 B。

将前面的 SSH 命令扩展为：

```
ssh -N `
  -L 127.0.0.1:16379:127.0.0.1:6379 `
  -L 127.0.0.1:13306:127.0.0.1:3306 `
  -L 127.0.0.1:13001:127.0.0.1:3001 `
  user@YOUR_CLOUD_IP
```

如果使用 PostgreSQL，继续把数据库转发改为 `15432:127.0.0.1:5432`。这样：

- Windows A 的 API 地址为 `http://127.0.0.1:3000`。
- 云服务器 B 的 API 在云服务器本机为 `http://127.0.0.1:3001`。
- Windows 可以通过 `http://127.0.0.1:13001` 访问 B。
- Redis 和数据库都不需要开放给任意公网来源。

### 4.1 Windows 节点 A

在仓库根目录构建完成后，打开新的 PowerShell 窗口，设置本次测试的环境变量。下面是 MySQL 示例：

```
$env:APP_ENV = "test"
$env:APP_PORT = "3000"

$env:CACHE_DRIVER = "redis"
$env:CACHE_URL = "redis://127.0.0.1:16379"
$env:CACHE_PREFIX = "fw:dual-node-it"
$env:CACHE_FAIL_OPEN = "false"
$env:CACHE_LOCK_TTL = "30"

$env:DB_DRIVER = "mysql"
$env:DB_URL = "mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:13306/fw_dual_test"

$env:DEMO_ENDPOINTS_ENABLED = "true"

pnpm --filter example-api start
```

把数据库账号、密码和数据库名替换成专用测试环境的实际值。如果 Redis 使用 ACL，也要在 `CACHE_URL` 中填入对应认证信息。

### 4.2 Linux 云服务器节点 B

在云服务器的仓库目录中运行，以下同样以 MySQL 为例：

```
export APP_ENV=test
export APP_PORT=3001

export CACHE_DRIVER=redis
export CACHE_URL='redis://127.0.0.1:6379'
export CACHE_PREFIX='fw:dual-node-it'
export CACHE_FAIL_OPEN=false
export CACHE_LOCK_TTL=30

export DB_DRIVER=mysql
export DB_URL='mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:3306/fw_dual_test'

export DEMO_ENDPOINTS_ENABLED=true

pnpm --filter example-api start
```

若使用 PostgreSQL，替换为相应数据库 URI、`DB_DRIVER` 和已生成的 PostgreSQL Prisma Client。

密钥配置也必须一致： 两台实例应使用相同的测试用 JWT 密钥、Refresh Token replacement 密钥环及其版本标识。不要把仓库中的开发默认密钥直接当作正式环境密钥。

`DEMO_ENDPOINTS_ENABLED=true` 仅用于隔离的验收环境；演示接口不应暴露给公网。若当前部署方式无法限制端口访问，先完成防火墙限制再启动。

### 4.3 检查两端就绪

Windows：

```
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3000/ready
Invoke-RestMethod http://127.0.0.1:13001/health
Invoke-RestMethod http://127.0.0.1:13001/ready
```

预期是两个实例都能健康启动，且在 `CACHE_FAIL_OPEN=false` 时，`/ready` 报告缓存依赖正常。具体响应结构以实际版本为准。

如果 API 启动成功但缓存依赖未就绪，不应继续做分布式锁验收：先检查 `CACHE_URL`、Redis ACL、SSH 隧道以及两端前缀配置。

## 5. 实机测试清单

下面按从低风险到高风险的顺序执行。建议每一项都记录：提交 SHA、开始时间、A/B 日志、请求结果、Redis/数据库观察结果。

### T1：证明两台机器连接的是同一个 Redis

在 Windows 通过转发端口写入测试键：

```
redis-cli -h 127.0.0.1 -p 16379 SET ty:dual:probe "from-A" EX 120
redis-cli -h 127.0.0.1 -p 16379 GET ty:dual:probe
```

再在云服务器本机读取：

```
redis-cli -h 127.0.0.1 -p 6379 GET ty:dual:probe
```

预期：云服务器读取到 `from-A`。测试结束后删除该探针键：

```
redis-cli -h 127.0.0.1 -p 6379 DEL ty:dual:probe
```

这一步只验证网络与 Redis 共享关系，不足以证明 TY 的缓存封装正确。

### T2：Cache 跨节点读写与标签失效

仓库的 [`smoke-cache.mjs`](https://github.com/donttemos/TY/blob/main/apps/example-api/scripts/smoke-cache.mjs?utm_source=chatgpt.com) 已提供真实 Redis 冒烟接口，主要包括 `find-user`、`invalidate`、`lock-hold`、`lock-try`。该脚本自身会启动并管理本机进程，因此不能直接把它当作跨机器测试；实机测试需要分别调用已经启动的 A、B。

下面使用 PowerShell 的 `Invoke-RestMethod`。请求路径来自现有缓存冒烟脚本。

1\. 在 A 写入一个独立测试用户缓存：

```
Invoke-RestMethod "http://127.0.0.1:3000/api/v1/demo-cache/find-user?id=81731"
```

2\. 在 B 请求同一个逻辑缓存键：

```
Invoke-RestMethod "http://127.0.0.1:13001/api/v1/demo-cache/find-user?id=81731"
```

预期：B 能取得与 A 相同的缓存数据，不应因为换了 Node.js 进程而必然回源。`loads` 等演示统计可能是进程内状态，不能简单要求 A、B 的统计数字完全相同；应重点观察返回数据和是否发生额外回源。

3\. 在 B 执行标签失效：

```
Invoke-RestMethod -Method Post `
  "http://127.0.0.1:13001/api/v1/demo-cache/invalidate?tag=demo:user:81731"
```

4\. 再次在 A 请求原键：

```
Invoke-RestMethod "http://127.0.0.1:3000/api/v1/demo-cache/find-user?id=81731"
```

预期：

- B 的标签失效操作成功。
- A 再次请求时，不应继续命中已经失效的缓存；应回源并重建缓存。
- Redis 中标签索引与对应缓存键应保持一致，不出现孤儿缓存或幽灵索引。

注意：演示接口可能维护本地回源计数器；若需要严格证明“回源次数增加”，应结合 A/B 日志或独立观察计数，而不是仅比较两个进程的 `loads` 数值。

### T3：跨节点分布式锁竞争

这是本次实机验收最重要的 Cache 项目之一。

1\. 在 A 发起持锁请求：

```
$key = "dual-lock-$(Get-Date -Format 'yyyyMMddHHmmss')"

Invoke-RestMethod -Method Post `
  "http://127.0.0.1:3000/api/v1/demo-cache/lock-hold?key=$key&ms=5000"
```

2\. 在锁仍被持有的 5 秒内，立即在 B 尝试同一把锁：

```
Invoke-RestMethod `
  "http://127.0.0.1:13001/api/v1/demo-cache/lock-try?key=$key"
```

3\. 等待 A 释放锁后，再从 B 尝试获取。

预期结果：

| 场景                                        | 预期                             |
| ----------------------------------------- | ------------------------------ |
| A 已持锁，B 同时尝试                              | B 获取失败，不能同时持有                  |
| A 正常释放锁后，B 再尝试                            | B 可以取得锁                        |
| B 获取锁时 Redis 不可用且 `CACHE_FAIL_OPEN=false` | 应按 fail-closed 契约拒绝，而非静默宣称获取成功 |

这里要特别注意请求时序：持锁请求必须在锁仍有效期间与 B 的请求重叠。如果 `lock-hold` 接口在返回前就已释放锁，或执行时间超过 TTL，这个测试会失去证明力。可以先用现有冒烟脚本的行为确认接口语义，再进行跨节点请求。

### T4：锁的 TTL、续期和旧令牌保护

前面的测试验证了基本互斥；接下来验证更危险的情况。

1. A 获取短 TTL 锁，例如 2 秒。
2. 等待锁过期。
3. B 获取同一锁，确认其令牌与 A 不同。
4. 让 A 的旧句柄尝试 `release()` 或 `renew()`。
5. 检查 Redis 中仍然是 B 的令牌。

预期：

- A 的旧令牌不得删除 B 的锁。
- A 的续期不得覆盖 B 的持有状态。
- 自动续期打开时，应记录续期成功/失锁回调；不能只根据本地计时器判断锁仍有效。

此项最好通过现有 `LockManager` 测试或一个外部测试脚本调用框架 API 来完成。不要直接把业务 API 的正常释放结果当作旧令牌保护已经通过的证据。

### T5：Refresh Token 双实例 CAS

先执行现有的双进程验证脚本。它使用独立 Node.js 子进程、各自的 PrismaClient 和 `RefreshTokenService`，共享同一数据库。这是跨节点 HTTP 测试前的基线检查。

在 Windows PowerShell 中：

```
cd apps/example-api

$env:ROTATION_TEST_DB_URL = "mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:13306/fw_dual_test"
$env:PROCESSES = "2"
$env:CONCURRENCY = "50"

node scripts/dual-instance-rotation.mjs
```

前置条件：已经生成 MySQL 对应的 Prisma Client、部署该数据库的迁移，并且 `fw_dual_test` 是专用测试库。

预期输出包含类似：

```
PASS：进程数=2 每进程并发=50 总请求=100 unique replacement=1
```

这证明的是同一主机上的多进程共享数据库 CAS，还不是 Windows 与云服务器之间的 HTTP 实测。

#### T5.1：通过 A、B 两个 API 实例并发刷新同一个旧令牌

先在 A 使用测试账号登录，获取 `data.refreshToken`。也可以使用已准备好的隔离测试账号，不要使用生产账号。

```
$loginBody = @{
    account = "YOUR_TEST_ACCOUNT"
    password = "YOUR_TEST_PASSWORD"
} | ConvertTo-Json -Compress

$login = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:3000/api/v1/auth/login" `
    -ContentType "application/json" `
    -Body $loginBody

$oldRefresh = $login.data.refreshToken
if (-not $oldRefresh) { throw "登录未返回 refreshToken，停止测试" }
```

接着，将同一旧令牌同时发送给 A、B。下面的脚本不会打印令牌本身，而是统计 HTTP 成功数和 replacement 的唯一数量。

```
$env:OLD_REFRESH_TOKEN = $oldRefresh
$env:API_A = "http://127.0.0.1:3000"
$env:API_B = "http://127.0.0.1:13001"

@'
const oldToken = process.env.OLD_REFRESH_TOKEN;
const urls = [process.env.API_A, process.env.API_B];
const concurrency = 20;

const results = await Promise.all(
  Array.from({ length: concurrency }, async (_, i) => {
    const response = await fetch(
      `${urls[i % urls.length]}/api/v1/auth/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TY-Dual-Node-Refresh-Test"
        },
        body: JSON.stringify({ refreshToken: oldToken })
      }
    );

    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      code: body.code,
      replacement: body.data?.refreshToken ?? null
    };
  })
);

const successful = results.filter(
  r => r.status >= 200 && r.status < 300 && r.code === 0 && r.replacement
);
const unique = new Set(successful.map(r => r.replacement));

console.log(JSON.stringify({
  requests: results.length,
  successful: successful.length,
  failed: results.length - successful.length,
  uniqueReplacementCount: unique.size
}, null, 2));

if (successful.length !== concurrency || unique.size !== 1) {
  console.error("FAIL: 未满足同一旧令牌仅产生一个 replacement 的预期");
  process.exitCode = 1;
}
'@ | node --input-type=module
```

这里刻意给所有请求设置相同的 `User-Agent`。TY 的 Refresh Token grace 重试会绑定轮换赢家的客户端指纹；IP 不参与该指纹计算。若各请求指纹不同，系统可能将其判定为重放，而不是正常的并发刷新。

预期：

- 20 个请求全部在 grace 窗口内成功。
- 所有成功响应都返回同一个 replacement。
- `uniqueReplacementCount` 为 `1`。
- 不应因 A、B 两个实例分别处理请求而生成 B、C、D 等多个 replacement。

如果请求跨越默认 10 秒 grace 窗口、密钥不一致或数据库不是同一个，测试失败不能直接归因于 CAS 缺陷，应先检查这些前置条件。

#### T5.2：过期 replay 与 family revoke

这项测试使用另一组独立的测试令牌族，不要复用上一项的测试令牌。

1. 获取旧 Refresh Token A。
2. 正常轮换得到 replacement B。
3. 等待超过 `AUTH_REFRESH_GRACE_SECONDS`，例如 11 秒。
4. 再把旧令牌 A 发送到另一个实例。
5. 验证请求被拒绝，并检查同一轮换族中的 replacement B 也不能继续刷新。

预期：过期的旧令牌重放被识别，系统按既有契约撤销该轮换族，并留下对应的安全审计事件。

注意检查审计中事件类别、原因、`familyId`、`jti` 等字段是否按当前实现落位；不要只凭 HTTP 401 判断审计链路正确。

这项测试有意触发安全撤销，只能对专用测试账号和测试数据库执行。

## 6. 故障注入与恢复验收

完成正常路径后，再测试以下场景。

| 编号 | 操作                                  | 预期结果                            | 验收重点           |
| -- | ----------------------------------- | ------------------------------- | -------------- |
| F1 | 暂停 Windows 的 SSH 隧道                 | A 的 Redis 请求失败或按配置降级；B 不应受该隧道影响 | 故障范围是否符合预期     |
| F2 | 在 A 的 `CACHE_FAIL_OPEN=false` 下访问缓存 | 依赖故障被显式暴露，不应静默假成功               | fail-closed 契约 |
| F3 | 恢复 SSH 隧道                           | A 能重新连接 Redis，读写恢复              | 重连与恢复路径        |
| F4 | 停止 A 进程                             | B 仍可读写共享 Redis，并能正常获取未被占用的锁     | 单节点退出          |
| F5 | A 持锁期间停止 A                          | 锁最终在 TTL 后过期，B 可重新获取            | 锁的崩溃恢复         |
| F6 | 让旧持有者的锁令牌晚于 TTL 执行释放                | 旧令牌不能删除 B 已取得的新锁                | CAS 令牌隔离       |

对于 F5，不要把“进程退出”直接等同于“锁立即释放”。Redis 中的锁应由服务端 TTL 控制；只有等待过期后，另一实例才应能重新取得锁。

对于 F1，先用 `CACHE_FAIL_OPEN=false` 做严格故障验收，再单独测试 `CACHE_FAIL_OPEN=true`。后一种配置可能让缓存读写降级，不能用“HTTP 返回 200”作为 Redis 正常的证据。应结合 `/ready`、缓存指标与日志确认实际运行状态。

### 6.1 真实 Redis 集成测试的使用边界

仓库现有测试文件：

[`packages/cache/src/__tests__/redis-integration.test.ts`](https://github.com/donttemos/TY/blob/main/packages/cache/src/__tests__/redis-integration.test.ts?utm_source=chatgpt.com)

可以在专用测试 Redis 上运行。PowerShell 示例：

```
$env:CACHE_REDIS_INTEGRATION_URL = "redis://127.0.0.1:16379/15"

pnpm --filter @fw/cache exec vitest run `
  --no-file-parallelism `
  src/__tests__/redis-integration.test.ts
```

建议使用独立、可销毁的 Redis 实例；若使用现有 Redis，至少使用隔离的测试数据库编号、独立凭据与测试键空间，并确认 ACL 允许测试需要的命令。

不要在共享 Redis 上设置 `CACHE_REDIS_INTEGRATION_ALLOW_SHUTDOWN=true`。 该开关会执行 `SHUTDOWN NOSAVE`，可能关闭目标 Redis 实例。这个破坏性用例应只在一次性测试实例中运行。

此外，这份集成测试主要验证 Redis 单实例上的 Lua、TTL、锁 CAS 和故障路径。它本身不替代前述跨机器 HTTP 测试。

## 7. CI 与实机验收边界

| 能力                           | GitHub CI                | 双节点实机        | 本次是否能宣称完成           |
| ---------------------------- | ------------------------ | ------------ | ------------------- |
| Cache 单元测试、Fake Redis 契约     | 适合                       | 可辅助排查        | CI 通过后可确认           |
| 真实 Redis 单实例 Lua、TTL、锁 CAS   | `redis:7-alpine` service | 可重复验证        | 需检查实际运行结果           |
| Windows 与云服务器共享 Redis        | 不覆盖真实网络路径                | 必须验证         | 两端实测通过后确认           |
| 两个 Node.js 进程竞争同一分布式锁        | 单进程/多进程测试可部分覆盖           | 可验证跨机器互斥     | 需完成 T3、T4           |
| Refresh Token 多进程 CAS        | 已有双实例脚本与数据库矩阵            | 可进一步 HTTP 联调 | 脚本通过不等于跨机器 HTTP 已通过 |
| Refresh Token 同一数据库的跨节点轮换    | CI 数据库矩阵可验证存储语义          | 必须确认两实例共用数据库 | 需完成 T5              |
| 网络中断与重连                      | 不能完整代表真实网络故障             | 可验证          | 需完成 F1–F3           |
| Redis Cluster 跨 slot 的多键 Lua | 单实例不能验证                  | 当前拓扑也不能验证    | 明确标记未验证             |

当前仓库的 CI 配置已加入 Redis 单实例集成步骤，并有 MySQL/PostgreSQL 的 Refresh Token CAS 测试与双实例脚本。我没有在本轮确认该提交的 GitHub Actions 最新运行状态，因此不能把 CI 写成已通过。 实施前应检查对应提交的 Actions 结果和日志。

另外，当前 Redis 驱动已明确记录 Redis Cluster 多键 Lua 跨 slot 的 `CROSSSLOT` 限制。不要把这次单实例测试的成功扩展为 Cluster 兼容已经完成。

## 8. 最终验收标准与交付记录

建议把本次实机验收定义为以下全部通过才算完成：

- A、B 固定在同一个提交 SHA，Node.js 依赖安装与构建成功。
- Redis 仅通过安全的本机访问或受控隧道访问；没有开放无保护的公网 Redis 端口。
- A、B 使用同一 Redis、相同 `CACHE_PREFIX`，且缓存依赖健康。
- A 写缓存后 B 可读取，B 标签失效后 A 不再命中失效缓存。
- A 持锁时 B 获取失败；锁释放或 TTL 过期后 B 可取得。
- 旧锁令牌不能删除新持有者的锁。
- Refresh Token 的 A、B 使用同一数据库、相同测试密钥与一致的客户端指纹策略。
- 双进程 CAS 基线通过，跨机器 HTTP 并发刷新返回唯一 replacement。
- 过期 replay、family revoke 与安全审计符合预期。
- SSH 中断、恢复和单节点退出的结果符合 fail-open / fail-closed 与锁 TTL 契约。
- CI 结果、实机日志和未验证项已归档。

建议记录以下元数据，便于之后回归：

```
TY commit SHA:
Windows Node.js version:
Cloud Node.js version:
Redis server version:
Database dialect / version:
CACHE_PREFIX:
CACHE_FAIL_OPEN:
Refresh grace seconds:
CI workflow run URL:
Dual-node test start / end time:
Pass / Fail / Skip:
Known limitations:
```

实施顺序建议： 先完成 T1–T4，再确认同一数据库后做 T5，最后进行 F1–F6。整个过程不需要修改仓库；如果测试失败，先保留日志与最小复现步骤，再决定是否需要新的回归测试或代码修复。
---

## 9. 本机拓扑执行记录（2026-10-17，非跨机器，先证协议再上真机）

> 在真正走 Windows ↔ 云服务器之前，先在本机用「两个 example-api 实例共享同一 Redis + 同一测试库」复现方案的协议层断言。本机执行不改仓库：harness 以点号文件名放在 `apps/example-api/scripts/.dual-node-harness.mjs` 并写入 `.git/info/exclude`（本地排除，不进版本库）。

### 9.1 本机环境与元数据

```
TY commit SHA:        9a05a20a71038374b68d941db06c4065d9f740ff（HEAD，CI 已全绿）
Node.js version:      22.22.2（单一节点，双实例同版本）
Redis server version: 8.4.0（H:/redis，127.0.0.1:6379，无密码）
Database dialect:     SQLite（专用测试库 apps/example-api/prisma/prisma/dual-local.db，已 migrate+seed）
CACHE_PREFIX:         fw:dual-node-it（两实例一致）
CACHE_FAIL_OPEN:      false（两实例一致，严格模式）
Refresh grace seconds: 10（默认）
实例 A: APP_PORT=3200；实例 B: APP_PORT=3201（同机双进程，共享 Redis/DB/前缀）
Dual-node test window: 2026-10-17 21:20~21:40
Result:               T2/T3/T4/T5/T5.1/T5.2 全 PASS（见下表）；跨机器段（T1 网络/F1-F3 隧道）未执行
```

### 9.2 执行结果

| 项 | 本机结果 | 证据 |
|---|---|---|
| T5 双进程 CAS 基线 | **PASS**（2 进程 × 5 并发 = 10 请求，unique replacement=1） | `dual-instance-rotation.mjs`；注：SQLite 在 2×20 并发写下撞锁（socket timeout）——**这正是 CI 对 sqlite 排除该用例的原因**，CI 的 2×50 由 mysql/pg 矩阵背书 |
| T2 缓存跨实例读写与标签失效 | **PASS 6/6** | A 写 → Redis 出现 `fw:dual-node-it:CacheDemoService:findUser:<sha256>` 值键且被 `__tag__:demo:user:81731` 索引追踪；B 读命中（B 侧 loads=0）；B 失效 removed=1 → A 再请求回源 loads+1；重建后「值键存在 ⟺ 被索引追踪」 |
| T3 跨实例锁互斥 | **PASS 3/3** | A lock-hold(ms=5000) 期间 B lock-try → acquired=false；A 释放后 B → true |
| T4 TTL 过期与旧令牌保护 | **PASS 8/8** | A 短 TTL(1.5s) 锁过期 → B 取得且令牌不同；A 旧句柄 renew=false、release 不删 B 锁（CAS 令牌隔离）；B 正常释放后锁消失 |
| T5.1 双实例并发刷新 | **PASS 3/3** | 20 请求交替打 A/B（同 UA），429ms 内全部成功，**unique replacement=1** |
| T5.2 过期 replay → family revoke | **PASS 3/3** | 过 grace(11s) 后旧令牌重放 → 3001「刷新令牌已被使用…已终止全部会话」；同族 replacement B 亦被撤销 |

### 9.3 本机执行发现的三个事实（对方案有修正价值）

1. **`@Cacheable` 缓存键不是标签名**：值键形态为 `{prefix}:{Service}:{method}:{sha256}`，标签索引键才是 `{prefix}:__tag__:{tag}`。方案 T2 若直接按 `demo:user:*` 找缓存键会落空——按 `CacheDemoService:findUser:*` 或直接查 `__tag__:*`。
2. **配置键名是 `DB_URL` 不是 `DATABASE_URL`**：本仓 Prisma schema 的 datasource 用 `env("DB_URL")`；只设 `DATABASE_URL` 时 migrate/seed 会静默落到 `.env` 里的 `dev.db`（本次已踩并纠正）。
3. **SQLite 不适合做并发 CAS 压测**：2 进程 × 20 并发即 socket timeout；双进程基线用 2×5 通过。跨机器段若也要跑 T5，务必按方案 §1 用 MySQL/PG 共享库。

### 9.4 CI 状态确认（回应方案 §7 的未决项）

- 基线提交 `9a05a20` 的 GitHub Actions：**base（构建/单测/静态检查/Redis 单实例集成 9/9）+ 集成矩阵 sqlite/postgres/mysql 四腿全绿**。
- Redis 单实例集成步骤真实执行（非 skip）：CI 日志 `Tests 9 passed (9)`，步骤结论 success。
- 方案 §7 表格中「真实 Redis 单实例」一行可更新为：CI `redis:7-alpine` service 已验证；「Windows 与云服务器共享 Redis」「两 Node 进程跨机器锁」「Refresh 跨机器 HTTP」三项仍需真机双节点执行（本机拓扑已证协议层）。

### 9.5 剩余真机动作（按优先级）

1. **T1 + F1/F2/F3（SSH 隧道段）**：本机拓扑无法模拟网络切断，需真机：建隧道 → 探针键互见 → 暂停隧道验证 A fail-closed（`CACHE_FAIL_OPEN=false`）且 B 不受影响 → 恢复。
2. **T5 跨机器版**：两端指向同一 MySQL/PG 测试库（勿用 SQLite），重跑 T5.1/T5.2；指纹策略（同 UA）与 grace 窗口前提不变。
3. **F4/F5/F6**：F5（A 持锁进程被杀）在本机由 T4 的 TTL 过期路径等效覆盖，真机仍建议按方案走一遍实体进程 kill。

---

## 10. 真机双节点执行记录（2026-10-18 00:00~00:40，Windows ↔ 云服务器）

> 拓扑按方案 §2/§4 落地：A = Windows 本机（:3000，经 SSH 隧道）；B = 云服务器 `106.55.32.251`（:3001，仅 127.0.0.1 或经隧道）。
> 生产 fw-api（:3000）与生产库 `fw`、生产 Redis db0 **全程未触碰**（实测前后 uptime/health 校验）。

### 10.1 环境与元数据

```
TY commit SHA:        9a05a20a71038374b68d941db06c4065d9f740ff（两端严格一致）
Node.js version:      v22.22.2（两端一致）
Redis server version: 8.10.2（1Panel-redis-9VaI 容器，requirepass；测试用 DB 15，生产用 DB 0）
Database:             PostgreSQL 18.6（1Panel-postgresql-MXHt）；测试库 fw_dual_test（新建，owner=fw），生产库 fw 未触碰
CACHE_PREFIX:         fw:dual-node-it（两端一致）
CACHE_FAIL_OPEN:      false（两端一致）
Refresh grace:        10s（默认）
隧道:                 127.0.0.1:16379→redis:6379 / 15432→pg:5432 / 13001→B:3001（仅 SSH 本地转发，无公网放行）
测试窗口:             2026-10-18 00:00~00:40 GMT+8
```

### 10.2 结果总览

| 项 | 结果 | 证据 |
|---|---|---|
| **T1** 两节点同一 Redis | **PASS** | A 经隧道 `SET ty:dual:probe=from-A-windows` → 云服务器容器内 `GET` 读到同值（随后 DEL） |
| **T2** 缓存跨节点读写与标签失效 | **PASS 6/6** | A 写 → 值键+`__tag__:demo:user:81731` 索引齐；B 命中（loads=0）；B 失效 removed=1 → A 回源 loads 1→2；重建后键↔索引一致 |
| **T3** 跨节点分布式锁 | **PASS 3/3** | A lock-hold(5s) 期间 B lock-try=false；释放后 B=true |
| **T4** TTL 过期与旧令牌保护 | **PASS 8/8** | A 1.5s 锁过期 → B 取得且令牌不同；A 旧句柄 renew=false、release 不删 B 锁；B 释放后锁消失 |
| **T5.1** 跨机器并发刷新同一旧令牌 | **PASS 3/3** | 20 请求交替打 A(Windows)/B(云)（同 UA），**715ms 内全部成功，unique replacement=1** |
| **T5.2** 过期 replay → family revoke | **PASS 3/3** | 过 grace(11s) 重放 → 3001「刷新令牌已被使用…已终止全部会话」；同族 replacement 亦撤销 |
| **F1/F2** 隧道中断（fail-closed） | **PASS** | 断隧道后 A：`find-user` → **9002 显式失败**、`/ready` cache=fail；B 同刻 200 正常 |
| **F3** 恢复 | **PASS** | 隧道恢复 ~12s 内 A 自愈（ioredis 自动重连）；`find-user` 返回 `loads=0`——**命中了 B 在断链期间写入的缓存**（跨机器共享再证） |
| **F4** 单节点退出 | **PASS** | A 进程被杀后 B 读写正常（loads=1 自回源） |
| **F5** 持锁进程崩溃 | **PASS** | A 持 35s TTL 锁中被杀：T+18s B 不可得（false）→ T+49s（TTL 过期后）B 取得（true）——锁由服务端 TTL 回收，不依赖进程存活 |

**合计：真机 11 项（含 5 组断言集）全部 PASS；累计断言 30/30。**

### 10.3 真机执行暴露的两个语义发现（建议登记为改进项）

1. **`/ready` 的 db 探针是「启动期一次性标志」，不是实时探测**（`packages/db/src/observability.ts` 的 `createDbReadinessProbe` → `markConnected()` 仅在模块连接成功时置位，`check()` 直接返回该布尔）。实测：A 在隧道断开时启动 → db 连接失败 → **此后即使隧道恢复、SQL 实际可用，`/ready` 仍永久 `db:fail`**（必须重启进程）；反之运行期 DB 断连，`/ready` 仍报 `db:ok`（陈旧）。同场景下 cache 探针（实时 `ping`）正确反映了 `cache:fail`。**建议**：db 探针改为带超时的实时探测（或至少周期刷新标志），与 cache/queue/transport 探针语义对齐。
2. **Redis 与 PG 均监听 `0.0.0.0` 且公网 6379 可 TCP 连通**（Redis 有 `requirepass`，PG 有口令，故未直接可利用；云安全组/iptables 未拦截该端口）。方案 §2.1 的「回环监听 + 隧道」目标当前**未满足**，测试服务器可接受但应在生产化前收敛（1Panel 容器端口映射改为 `127.0.0.1:6379:6379`）。

### 10.4 执行中踩到的三个环境坑（对复现有用）

1. **Prisma 运行期直读 `process.env.DB_URL`**，`.env` 只被 `@fw/config` 读取 —— 非 systemd 启动（裸 `node dist/main.js`）必须 `set -a; . ./.env; set +a` 或显式注入，否则 `PrismaClientInitializationError: Environment variable not found: DB_URL`。（生产靠 systemd `EnvironmentFile` 天然规避。）
2. **`.env` 重复键的加载歧义**：追加同名 `DB_URL` 时 @fw/config 取**首行**、Prisma CLI 取**末行**，出现「migrate 成功但 seed 打到另一个库」的分裂。覆写请原地替换，不要追加。
3. **数据库口令含特殊字符**：用 `sed`/shell 截取拼接 URL 会把 `@`/`/` 截坏（症状是 host 变成库名）；应走 `urlparse` 重建。
4. 服务器侧后台启动必须 `setsid nohup ... < /dev/null &`，否则 SSH 通道被挂住（本次两次 SIGTERM）；杀进程要用 **PID（按端口查找）**，`pkill -f "dist/main.js"` 会误杀生产 fw-api（同 cwd 同命令行）。

### 10.5 清理与回滚

- B 进程已停；测试 Redis **DB 15 已 FLUSHDB**；隧道已关闭；本地临时凭据文件已删除。
- 测试库 `fw_dual_test` 与服务器 `~/fw-dual` 检出**保留**（便于复跑；不想要可 `DROP DATABASE fw_dual_test` 与 `rm -rf ~/fw-dual`）。
- 生产 fw-api 全程未重启（实测前后 `uptime` 连续、health=ok）。

---

## 11. 仓库化收口（2026-10-18）：双进程一致性冒烟进 CI

§9/§10 用的本地 harness（`scripts/.dual-node-harness.mjs`，点号文件名 + `.git/info/exclude`）已**退役并删除**，能力以正式脚本收编：

- **`apps/example-api/scripts/smoke-dual-node.mjs`** —— CI base 作业新增步骤「双进程缓存与令牌一致性冒烟（真实 Redis）」，与 `redis:7-alpine` service 同作业。
  - 默认**自起**两个实例（3120/3121，`DUAL_PORT_A/B` 可改），共享同一 Redis / 同一库 / 同一 `CACHE_PREFIX`，跑 T0/T2/T3/T4/T5.1/T5.1c（20 断言：17 条原断言 + T0 前缀核对 + T0 清场结果 + T5.1c）；`DUAL_INCLUDE_REPLAY=1` 追加 T5.2（+11s）。
  - **`DUAL_A`/`DUAL_B` 复用模式**：指向已在运行的两个实例即不再自起——真机跨机器复跑用同一脚本（`DUAL_A=http://127.0.0.1:3000 DUAL_B=http://127.0.0.1:13001 DUAL_REDIS=redis://:密码@127.0.0.1:16379/15`）。
  - 门控：未设 `DUAL_REDIS_URL` 整脚本 SKIP（本地默认形态）。
- **前缀与清场的安全边界（2026-10-18 复核加固）**：清场按前缀删除，因此
  - 复用模式**强制显式** `DUAL_PREFIX`（禁止回落随机串）；前缀只允许 `[A-Za-z0-9._:-]`，且需带测试语义段（`smoke`/`test`/`it`/`tmp`/`temp`，按 `[.:_-]` 分词），否则必须 `DUAL_PREFIX_ACK=1` 显式确认；
  - 启动后向两个实例读 `/api/v1/demo-cache/stats` 的**实际前缀**并与 `DUAL_PREFIX` 核对，不一致立即中止（不再盲信环境变量）；演示端点需 `DEMO_ENDPOINTS_ENABLED=true`；
  - 清场只删本脚本命名空间（`CacheDemoService:` / `__tag__:demo:` / `lock:demo:` / `t4-lock`），并校验目标键范围与数量上限（`DUAL_CLEANUP_MAX_KEYS`，默认 5000）；
  - 全程**不用 `KEYS`**：断言与清场都走 SCAN 游标（`DUAL_SCAN_COUNT`，默认 500），删除按 `DUAL_CLEANUP_BATCH_SIZE`（默认 500）**分批 DEL**；键范围/数量校验提前到收集阶段，超限即中止且**不删除任何键**；
  - 清场失败记为 **FAIL → 脚本非 0 退出**；清场/关闭连接/回收子进程三级嵌套 finally，Redis 断连不会跳过子进程回收。
- 依赖解析改为零硬编码：`@fw/cache` 走 `import.meta.resolve` + 动态 import（其 `exports` 只有 `import` 条件，CJS `require.resolve` 不可用），`ioredis` 以其入口为基准 `createRequire`。
- 本机验证：17/17 通过（20 并发刷新 394ms、唯一 replacement）；加固后断言为 20 条（+T0 前缀核对、+T0 清场结果、+T5.1c 异 UA 拒绝）。

---

## 12. 按当前脚本重跑真机（2026-10-18 18:40，SHA `c192885`，20/20 PASS）

> 不沿用旧 SHA 记录：两端固定到 **`c192885`**（含 `smoke-dual-node.mjs` 的复用模式与 `DUAL_PREFIX` 修复），
> 由同一脚本以**复用既有实例模式**驱动（`DUAL_A/DUAL_B/DUAL_REDIS_URL/DUAL_PREFIX`），非自起模式。

### 12.1 环境

```
TY commit SHA:        c192885545c9279f009ef0a9ffd2566570fae87b（两端一致）
Redis:                8.10.2 容器 DB15（生产 DB0 未碰）；PG 18.6 fw_dual_test（生产 fw 未碰）
CACHE_PREFIX:         fw:dual-node-it；CACHE_FAIL_OPEN=false
模式:                 DUAL_A=http://127.0.0.1:3000 DUAL_B=http://127.0.0.1:13001（经隧道）
脚本:                 apps/example-api/scripts/smoke-dual-node.mjs（DUAL_INCLUDE_REPLAY=1 含 T5.2）
```

### 12.2 结果

| 项 | 结果 |
|---|---|
| T1 两节点同一 Redis | **PASS**（A 经隧道写 `ty:dual:probe=from-A-c192885` → 云端本机读到同值） |
| T2 缓存跨实例 + 标签失效 | **PASS 5/5** |
| T3 跨实例锁互斥 | **PASS 3/3** |
| T4 TTL 与旧令牌保护 | **PASS 6/6** |
| T5.1 并发刷新唯一 replacement | **PASS 2/2**（20 并发 **727ms**，unique=1） |
| T5.2 过期 replay → family revoke | **PASS 3/3** |
| **合计** | **20/20 全 PASS**（同脚本同断言，真机拓扑） |

### 12.3 脚本侧修正（本轮）

- 复用模式（`DUAL_A/DUAL_B`）原先用随机 `CACHE_PREFIX` 做键断言与清场，与既有实例真实前缀不匹配 → 新增 `DUAL_PREFIX` 显式指定（提交 `c192885`）。
- 2026-10-18 复核加固（P1）：前缀安全校验 + 双实例实际前缀核对 + 清场收窄至测试命名空间 + 清场失败显式非 0；新增 T5.1c 异 UA grace 重试拒绝（兼作两节点 `AUTH_FINGERPRINT` 漂移探针）。`fw:dual-node-it` 含 `it` 语义段，无需额外 ACK；换成不含测试语义段的前缀时需 `DUAL_PREFIX_ACK=1`。
- 2026-10-19 复核二轮（P1 续）：脚本内残留的 `KEYS` 全部换成 SCAN 游标，清场改分批 DEL；T2 的 id 默认带本次运行唯一后缀（`DUAL_FIND_USER_ID` 可覆盖），复用模式下同命名空间的历史遗留键不再让「键↔索引一致」断言误判。本机临时 Redis 5.0 实测：20/20、1200 个同命名空间键分 3 批删净（`removed=1202`）、同前缀业务键保留、`INFO commandstats` 中 `keys` 调用为 0、`DUAL_CLEANUP_MAX_KEYS=1` 时清场 FAIL + 脚本 exit 1 且中止时零删除。
- 复跑命令模板（真机）：
  ```bash
  DUAL_A=http://127.0.0.1:3000 DUAL_B=http://127.0.0.1:13001 \
  DUAL_REDIS_URL='redis://:<密码>@127.0.0.1:16379/15' \
  DUAL_PREFIX=fw:dual-node-it DUAL_INCLUDE_REPLAY=1 \
  node scripts/smoke-dual-node.mjs
  ```

### 12.4 顺带登记（独立项，不混入本验收）

`/ready` 的 db 探针为启动期一次性标志（非实时探测）——本轮实测再次复现两个方向的失真。已作为**单独修复项**登记：`docs/96-db-readiness-probe-issue.md`（P2，含证据/根因/修法/验收标准），与本 Redis 双节点验收解耦。
