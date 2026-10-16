# ADR-0014 · i18n 骨架：错误码文案前端接管，locale 运行时自研不引 vue-i18n

- 状态：已采纳
- 日期：2026-10-15
- 关联：PRD-010（E-14 / OQ-4）、[api-spec §2](../40-api-spec.md)、[docs/99](../99-admin-web-enhancement-and-fixes.md)、ADR-0006（前端选型）

## 背景

1. E-14（NG6 到期项）要求补 i18n 骨架：错误码的用户可读文案目前散在两处——后端 `@fw/core ERROR_CODE_META`（zh-CN 权威）与前端 `describeBizError` 内联字面量，均无法按语言切换。
2. 错误文案本地化的归属（后端 Accept-Language 协商 vs 前端接管）在 PRD-010 §9 OQ-4 悬置，开工前已由用户拍板：**前端接管**——错误码 → 文案映射随前端构建分发，后端只回码不回文案。
3. 管理后台前端按需引入 Element Plus（无全量 `app.use`），组件库内置文案（分页 / 日期选择器 / 弹窗按钮）目前固定跟随浏览器默认。
4. 骨架约束（PRD-010 FR E-14）：仅骨架不追求全覆盖——页面级文案迁移不在本项范围。

## 决策

1. **错误码文案前端接管**：admin-web 新增 `src/locales/{zh-CN,en-US}.ts` 双文案表，键集与 `BIZ_CODE` 数值全集**编译期同构**（`ErrorMessages` 强类型，新增错误码不同步两表即 `vue-tsc` 报错，承接 api-spec §2「新增错误码必须同步」的前端侧义务）。zh-CN 表值收敛自 `describeBizError` 既有字面量（逐条一致，行为零回归）。
2. **双语取词语义**：zh-CN（缺省）沿用「后端 `message` 优先、缺省回落表」——业务上下文文案（如登录锁定倒计时）比表文案更具体，既有断言零改动；**非 zh-CN 表优先**（后端 `message` 是中文，直出会串味），未知码回落后端 `message` 再落 `fallback`。9001（traceId 变体）/ 5002（details 拼接变体）走 `{var}` 占位模板。
3. **locale 运行时自研**（约 60 行）：模块级响应式 `currentLocale` + 点路径 `translate()` + `{var}` 插值 + localStorage 持久化（`fw_admin_locale`）+ `<html lang>` 同步。**不引 vue-i18n**：骨架阶段仅 2 门语言、无复数/日期本地化诉求，引依赖与编译管线（`@intlify/unplugin-vue-i18n`）成本大于收益；运行时放模块级而非 Pinia store——`request`/`biz-error` 等纯 util 无组件与 Pinia 上下文也要读。缺省 zh-CN，**不做浏览器语言嗅探**（行为可预测，嗅探留待后续增强）。
4. **Element Plus locale 经 `ElConfigProvider` 接线**（App.vue 包裹路由视图，`useLocale().elLocale` 响应式切换），与既有按需引入模式一致；语言切换器挂 Navbar 右侧动作区，选项 label 用语言原生名（简体中文 / English）。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| **前端接管 + 自研运行时（本决策）** | 零新依赖；文案随构建分发无请求往返；键集编译期强制与错误码全集同步 | 自研 `t()` 无复数 / 日期本地化；后端动态文案（如锁定剩余秒数）无法翻译 | — |
| 后端 Accept-Language 协商（`ERROR_CODE_META` 多语言化） | 单一文案权威；服务端日志可读 | 违背 OQ-4 决策；文案改动要发后端；响应体膨胀；`@fw/core` 引语言协商面 | OQ-4 已拍板前端接管 |
| vue-i18n + `@intlify/unplugin-vue-i18n` | 生态标准：复数 / 日期 / 懒加载分包齐全 | 2 门语言的骨架用不上这些能力；新增构建插件与 d.ts 生成面（触发文件头校验规避成本） | 骨架先行，语言数与文案面扩大后再迁移（届时 `t()` 键路径可直接对齐 vue-i18n） |
| 只接 Element Plus locale、不做错误码表 | 工作量最小 | 错误提示仍硬编码中文，E-14 核心诉求（错误码文案表）未兑现 | 不满足 FR |

## 后果

**正面**：
- 错误码 → 文案的唯一前端权威落位，zh-CN 与 en-US 双表键集受编译期 + 单测双重护栏（新增错误码漏同步即红）。
- zh-CN 显示行为零回归（既有 121 条单测含全部文案断言零改动通过），en-US 下后端中文 message 不再串味。
- 切换语言全端即时生效（业务文案 + Element Plus 内置文案 + `<html lang>`），无刷新。

**负面 / 代价**：
- 后端动态拼进 `message` 的中文内容（如「登录过于频繁，请 N 秒后再试」、zod 校验 details）在 en-US 下不翻译——骨架边界内接受，页面文案与动态文案翻译列为非目标。
- zh-CN 存在「后端 message 优先、表兜底」与 en-US「表优先」的双语义，新贡献者需读 `describeBizError` 注释理解。

**缓解措施**：
- 双语义规则集中在 `describeBizError` 一处并注释；文案表键集护栏单测（`locale 文案表护栏`）随全量门禁执行。
- `t()` 键路径与 MessageSchema 结构刻意与 vue-i18n 兼容，后续引入迁移成本最低。
