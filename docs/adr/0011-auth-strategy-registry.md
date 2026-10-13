# ADR-0011 · 鉴权策略自实现注册表，不引入 passport 包

- 状态：已采纳
- 日期：2026-10-13
- 关联：PRD-003、ADR-0005

## 背景

- ADR-0005 定下「Passport 策略 + 自研 RBAC，不引 Casbin」，但未回答**是否引入 `passport` / `@nestjs/passport` 依赖**。
- M3 实现到 FR-06（策略可插拔）时暴露出三处硬约束：
  1. **契约必须可冻结**：`docs/85-parallel-workstreams.md` 的 C-05 要求鉴权对外只暴露固定的 `RequestUser` 形状；而 `@nestjs/passport` 的 `PassportStrategy` 把身份对象交给 `validate()` 返回值决定，形状随策略漂移。
  2. **失败语义必须精确**：PRD-003 要求未登录 `3001`、过期 `3003`、锁定 `3004`、越权 `3002` 四个码可区分；`passport` 的 `AuthenticateOptions` 只区分成功/失败，过期与无效会被合并成一次 401，需要额外包装层才能还原。
  3. **运行时可切换**：`AUTH_STRATEGY` 是配置项，同一路由在部署期可换成 `apikey`；`passport` 的策略注册是启动期全局的，按「配置 + 路由元数据」动态挑选需要自建注册表。
- 四种策略的实际需求都很薄：JWT 验签（`jose`）、API Key 常数时间比对、Session Cookie 查表、OAuth2 换码。没有一个需要 `passport` 提供的生态适配器。

## 决策

不引入 `passport` / `@nestjs/passport`；在 `@fw/auth` 内以 `StrategyRegistry` 实现同一套**语义**（策略名注册、`authenticate(request) → StrategyIdentity | null`、按 `AUTH_STRATEGY` 或 `@AuthStrategy()` 路由元数据选择），身份解析结果统一映射为 C-05 的 `RequestUser`。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| `@nestjs/passport` + `passport-jwt` 等 | 生态成熟、文档多 | 身份对象形状不可控；过期/无效被合并；策略注册是启动期全局，与「配置驱动切换」冲突；多 3 个运行时依赖 | 与 C-05 契约冻结和 3001/3003 区分要求正面冲突 |
| 直接用 `passport`（不套 Nest 封装） | 依赖少一层 | 仍需自写 `Strategy` 适配与错误映射，收益只剩「名字熟悉」 | 收益不足 |
| **自实现 `StrategyRegistry` + 各策略类（采纳）** | 契约精确、失败码精确、运行时可切、零额外依赖、单测可覆盖 | 生态适配器需自己写（微信/GitHub 换码等） | — |

## 后果

**正面**：

- C-05 契约可冻结：`StrategyIdentity → RequestUser` 的映射在守卫内单点完成，策略只负责「解析身份」。
- 3001 / 3003 / 3004 可区分：`TokenVerifyError.reason`（`missing` / `expired` / `invalid`）直接映射到错误码。
- 运行时切换：`AUTH_STRATEGY` 改配置即换默认策略；`@AuthStrategy('apikey')` 可让单条路由脱离默认策略（开放接口与后台管理共存）。
- 依赖更少，安装体积与供应链面收窄。

**负面 / 代价**：

- 第三方提供方适配要自己写：OAuth2 的换码/取用户信息逻辑需按 `OAuth2Handler` 接口逐个实现（微信 / 企业微信 / GitHub）。
- 无 `passport` 生态的现成策略（如 SAML、LDAP）可**直接**复用；将来若真需要，仍需适配成 `OAuth2Handler` 同级的处理器接口。

**缓解措施**：

- `oauth2Handlers` 作为注入点（`AuthModule.forRoot({ oauth2Handlers })`）：新增提供方 = 加一个 handler，不改守卫与契约。
- 未注册的 provider 调用时**明确报错**而非静默降级，避免「配了没生效」的隐性问题。
- API Key 与 OAuth2 的换码/比对均有单测覆盖（定长时间比较、非法条目跳过、未注册 provider 报错）。

## 影响

- `@fw/auth` 对外导出 `StrategyRegistry` 与 `AUTH_STRATEGY_REGISTRY` 令牌；守卫注入该令牌（非类令牌）。
- 新增提供方或新策略类型时，需同步 `docs/contracts/auth.ts`（C-05）的 `AuthStrategyName` 联合类型。
- ADR-0005 仍然有效且未被取代：本决策是它在依赖层面的具体化，不是推翻。
