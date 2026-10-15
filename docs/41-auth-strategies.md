# 认证策略端到端指南（OAuth2 授权码 / API Key 签名约定）

> 版本：v1.0 ｜ 状态：**已交付（M10 E-07，PRD-010 AC6）** ｜ 负责人：donttemo ｜ 更新：2026-10-15
>
> 背景：`AUTH_STRATEGY` 枚举含 `jwt / session / oauth2 / apikey`，但 M3–M9 仅 `jwt` 有端到端路由，
> 其余为「枚举有、路径无」。本指南随 E-07 交付 OAuth2 授权码端到端链路与 API Key 签名约定，
> 四种策略的名实相符状态见 [api-spec §1.2](./40-api-spec.md)。

## 1. 策略名实相符状态（E-07 交付后）

| 策略 | 端到端状态 | 载体 | 说明 |
|---|---|---|---|
| `jwt` | ✅ M3 起 | `/auth/login` → Bearer | 默认策略，双 token 轮换 |
| `oauth2` | ✅ E-07 | `/auth/oauth2/*` 三端点 + admin-web 登录页入口 | 授权码流程，见 §2 |
| `apikey` | ✅ E-07 | `/api/v1/open/ping` 示例路由（`@AuthStrategy('apikey')`） | 签名约定见 §3 |
| `session` | 策略可用 | `SessionStore` 端口 | 业务侧注入会话存储后可用；未注入明确拒绝（不静默降级） |

> `AUTH_STRATEGY` 是**默认策略**；单条路由可用 `@AuthStrategy('apikey')` 脱离默认值
> （ADR-0011 策略注册表语义，守卫代码不变）。

## 2. OAuth2 授权码端到端（企业 SSO 登录）

### 2.1 配置

```bash
# 提供方注册（JSON 对象串；provider 名须匹配 ^[a-z][a-z0-9_-]{0,31}$）
AUTH_OAUTH2_PROVIDERS={"demo":{"clientId":"<id>","clientSecret":"<secret>","authorizeUrl":"https://idp/authorize","tokenUrl":"https://idp/token","userInfoUrl":"https://idp/userinfo","scope":"openid email"}}
# 回调地址白名单（逗号分隔 URL 前缀；空 = 全拒，默认安全）
AUTH_OAUTH2_REDIRECT_WHITELIST=https://cs.example.com/login
```

- 提供方标准 RFC 6749 授权码端点；`token` 端点走 `client_secret_post`（form 表单提交凭据）。
- `clientSecret` 仅服务端持有；日志与审计一律不落令牌与密钥（`SENSITIVE_FIELDS` 脱敏同源）。

### 2.2 流程（跳转 → 回调 → 换 token → 登录会话）

1. **入口渲染**：前端 `GET /auth/oauth2/providers`（公开）；返回空列表 = 未启用，登录页不渲染 OAuth2 入口（mock 同形返回空）。
2. **发起授权**：浏览器整页跳转 `GET /auth/oauth2/{provider}/authorize?redirect_uri=<本站登录页绝对地址>`。
   后端校验：provider 已注册、`redirect_uri` 前缀命中白名单（边界完整，`http://ok.com.evil.com` 不命中 `http://ok.com`）；
   生成一次性 `state`（UUID，经 AuthCachePort 存取，TTL 300s）后 302 到 IdP。
3. **IdP 回跳**：IdP 携带 `code` 与 `state` 回调 `GET /auth/oauth2/{provider}/callback`。
   后端一次性消费 `state`（取后即删；重放、伪造、跨提供方一律 `401/3001`）→ 以 `code` + client 凭据换
   `access_token` → 以 Bearer 拉用户信息。
4. **身份映射（应用层职责）**：本地账号 = 用户信息的 `email` 优先，其次 `username` / `preferred_username`；
   **不自动建号**——外部身份必须先在本地建号并绑定同名字段，否则 `401/3001`（防外部身份自动提权）。
   命中后经 `AuthService.loginByOAuth2` 签发与口令登录**同源**的会话（refresh 轮换族 / 权限加载 / 审计 `after.provider`）。
5. **令牌回传**：`response_mode=json` 直接返回 TokenPair（冒烟与客户端集成用）；
   缺省 302 回 `redirect_uri` 并把令牌放 **URL fragment**（`#access_token=..&refresh_token=..`，不进服务器日志与 Referer）；
   登录页解析后立即 `history.replaceState` 清除 hash，防令牌留在历史记录。

### 2.3 反向验证清单（冒烟 `smoke-oauth2.mjs` 15/15）

| 攻击面 | 预期 |
|---|---|
| `redirect_uri` 不在白名单 / 缺失 | `400/1001`（白名单未配置 = 全拒） |
| 提供方未注册 | `401/3001`（不静默放行） |
| 同一 `state` 二次回调 | `401/3001`（一次性消费防重放） |
| A 提供方签发的 `state` 用于 B 回调 | `401/3001`（跨提供方重放） |
| 伪造授权码（IdP 拒绝） | `401/3001` |
| IdP 用户信息无可绑定字段 / 账号未建 | `401/3001` |
| 回调地址兄弟域名前缀绕过（`ok.com.evil.com`） | `400/1001`（边界完整校验） |

## 3. API Key 签名约定（开放接口）

### 3.1 何时需要签名

- `AUTH_API_KEYS` 里的条目凭 `X-Api-Key: <key>` 即可通过认证（**向后兼容**，内网可信环境可用）。
- 配置 `AUTH_API_KEY_SIGN_SECRET` 后，全部 apikey 请求**强制验签**——防密钥被截获后重放。

### 3.2 签名算法

```
stringToSign = `<X-Api-Key>\n<X-Api-Timestamp>\n<METHOD>\n<path>`
X-Api-Sign   = hex( HMAC-SHA256( AUTH_API_KEY_SIGN_SECRET, stringToSign ) )   # 小写 hex
```

- `METHOD`：大写（`GET` / `POST` / ...）；校验方对大小写不敏感（服务端统一转大写）。
- `path`：请求路径，**不含查询串与协议域名**（如 `/api/v1/open/ping`）。
- `X-Api-Timestamp`：Unix 秒级时间戳；与服务器时差超过 **300 秒**即拒绝（防重放窗口，常量
  `DEFAULT_API_KEY_SIGN_SKEW_SECONDS`）。
- 比对使用常量时间比较（防时序侧信道）；失败一律 `401/3001`，不区分具体原因（防探测）。
- 框架导出 `apiKeySignature(secret, key, timestamp, method, path)` 供业务方按同一算法生成，
  避免约定漂移。

### 3.3 示例（Node.js）

```js
import { createHmac } from 'node:crypto';

const KEY = 'k-openapi-001';
const SECRET = process.env.CLIENT_SIGN_SECRET;      // 与服务端 AUTH_API_KEY_SIGN_SECRET 同值
const path = '/api/v1/open/ping';
const timestamp = String(Math.floor(Date.now() / 1000));
const sign = createHmac('sha256', SECRET)
  .update(`${KEY}\n${timestamp}\nGET\n${path}`)
  .digest('hex');

await fetch(`https://api.example.com${path}`, {
  headers: { 'x-api-key': KEY, 'x-api-timestamp': timestamp, 'x-api-sign': sign },
});
```

### 3.4 路由声明（业务侧）

```ts
@Controller('/api/v1/open')
export class OpenController {
  @AuthStrategyDecorator('apikey')   // 脱离默认 jwt 策略
  @Get('ping')
  ping(@CurrentUser() user: RequestUser) { /* user.username = 主体名；user.permissions = scope */ }
}
```

- 权限来自 `AUTH_API_KEYS` 条目第三段声明的 scope（如 `k:svc:dict:read,user:read`）；
  **空 scope = 无任何权限（默认拒绝）**，避免配置疏漏导致全量放行。
- apikey 不走登录流程、不进登录限流；审计按主体名（`apikey:<主体名>`）记录。

## 4. 验证证据（E-07）

- 框架层：`@fw/auth` **129/129**（新增 18 条：state 一次性/白名单边界/未注册拒绝/fetch 桩交换/签名正反向/loginByOAuth2）。
- 冒烟：`smoke-oauth2.mjs` **15/15**（本机 stub IdP 全链路 + §2.3 反向验证清单 + apikey 签名段）。
- 前端：admin-web **94/94** + `vue-tsc` 0 错误（fragment 解析 / providers 驱动入口）。
- 回归：example-api **52/52**、`@fw/config` **16/16**（80 键护栏）、`smoke-mock` **119/119**、静态门禁 4 项全绿。
