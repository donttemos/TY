/*
 * @file 审计事件注册表（mock 侧，**自动生成，勿手改**）
 * @description 由 scripts/gen-audit-events-mock.mjs 从 packages/auth/src/audit-events.ts 生成。
 *   mock 是独立进程，无法 import 后端运行时；手抄必然漂移（B3 首版只抄 12 条，
 *   页面上大半事件显示「未登记」）。改动注册表后运行 `pnpm run gen:audit-events-mock`，
 *   `check:audit-events` 会校验本文件是否最新。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/mock
 */

/** 事件定义（仅演示所需字段；完整定义以服务端下发为准） */
export const MOCK_AUDIT_EVENTS = [
  { code: "refresh.replay_detected", name: "检测到刷新令牌重复使用", category: "security", risk: "critical", summaryTemplate: "检测到刷新令牌重复使用，已撤销该令牌族全部会话（原因：{reason}）", reviewRequired: true },
  { code: "saas.plan.create", name: "创建套餐", category: "admin", risk: "notice", summaryTemplate: "创建套餐「{targetLabel}」", reviewRequired: false },
  { code: "saas.plan.publish", name: "发布套餐版本", category: "admin", risk: "high", summaryTemplate: "发布套餐「{targetLabel}」的新版本 v{version}（配额项 {quotaCount} 项）", reviewRequired: false },
  { code: "saas.subscription.create", name: "开通订阅", category: "admin", risk: "notice", summaryTemplate: "为租户开通订阅（套餐 {planCode}，版本 {planVersion}）", reviewRequired: false },
  { code: "saas.subscription.cancel", name: "取消订阅", category: "admin", risk: "high", summaryTemplate: "取消租户订阅（原因：{reason}）", reviewRequired: true },
  { code: "saas.quota.exceeded", name: "配额超限被拒绝", category: "admin", risk: "notice", summaryTemplate: "租户配额超限，请求被拒绝（指标：{quotaKey}）", reviewRequired: false },
  { code: "saas.lifecycle.activate", name: "开通租户", category: "tenant", risk: "notice", summaryTemplate: "将租户「{targetLabel}」由{from}变更为{to}", reviewRequired: false },
  { code: "saas.lifecycle.freeze", name: "冻结租户", category: "tenant", risk: "high", summaryTemplate: "将租户「{targetLabel}」由{from}变更为{to}（原因：{reason}）", reviewRequired: true },
  { code: "saas.lifecycle.resume", name: "恢复租户", category: "tenant", risk: "notice", summaryTemplate: "将租户「{targetLabel}」由{from}变更为{to}", reviewRequired: false },
  { code: "saas.lifecycle.terminate", name: "终止租户", category: "tenant", risk: "critical", summaryTemplate: "将租户「{targetLabel}」由{from}变更为{to}（原因：{reason}）", reviewRequired: true },
  { code: "saas.lifecycle.expire", name: "租户进入宽限期", category: "tenant", risk: "low", summaryTemplate: "租户「{targetLabel}」由{from}变更为{to}", reviewRequired: false },
  { code: "saas.lifecycle.dispose", name: "处置租户数据", category: "tenant", risk: "critical", summaryTemplate: "处置租户「{targetLabel}」的数据（{from} → {to}）", reviewRequired: true },
  { code: "auth.login", name: "登录成功", category: "auth", risk: "low", summaryTemplate: "用户「{targetLabel}」登录成功（方式：{via}）", reviewRequired: false },
  { code: "auth.login_failed", name: "登录失败", category: "security", risk: "notice", summaryTemplate: "用户「{targetLabel}」登录失败（原因：{reason}）", reviewRequired: false },
  { code: "auth.logout", name: "退出登录", category: "auth", risk: "low", summaryTemplate: "用户「{targetLabel}」退出登录", reviewRequired: false },
  { code: "auth.password_change", name: "修改密码", category: "auth", risk: "notice", summaryTemplate: "用户「{targetLabel}」修改密码（其余设备已下线）", reviewRequired: false },
  { code: "auth.session_revoke", name: "强制下线", category: "auth", risk: "high", summaryTemplate: "强制目标用户下线（撤销其全部登录会话）", reviewRequired: false },
  { code: "auth.register", name: "注册账号", category: "auth", risk: "notice", summaryTemplate: "注册账号「{targetLabel}」", reviewRequired: false },
  { code: "auth.role_assign", name: "调整用户角色", category: "auth", risk: "high", summaryTemplate: "调整用户「{targetLabel}」的角色集合", reviewRequired: true },
  { code: "auth.permission_grant", name: "调整角色权限", category: "auth", risk: "critical", summaryTemplate: "调整角色权限（角色 {targetLabel}）", reviewRequired: true },
  { code: "auth.profile_update", name: "更新本人资料", category: "auth", risk: "low", summaryTemplate: "用户「{targetLabel}」更新本人资料", reviewRequired: false },
  { code: "authz.denied", name: "权限不足被拒绝", category: "security", risk: "notice", summaryTemplate: "访问「{targetLabel}」被拒绝（缺少权限：{reason}）", reviewRequired: false },
  { code: "user.create", name: "创建用户", category: "admin", risk: "notice", summaryTemplate: "创建用户「{targetLabel}」", reviewRequired: false },
  { code: "user.update", name: "更新用户", category: "admin", risk: "notice", summaryTemplate: "更新用户「{targetLabel}」的资料", reviewRequired: false },
  { code: "user.status_change", name: "启用/禁用账号", category: "admin", risk: "high", summaryTemplate: "将用户「{targetLabel}」状态改为{status}", reviewRequired: false },
  { code: "user.delete", name: "删除用户", category: "admin", risk: "high", summaryTemplate: "删除用户「{targetLabel}」", reviewRequired: true },
  { code: "role.create", name: "创建角色", category: "admin", risk: "notice", summaryTemplate: "创建角色「{targetLabel}」", reviewRequired: false },
  { code: "role.update", name: "更新角色", category: "admin", risk: "notice", summaryTemplate: "更新角色「{targetLabel}」", reviewRequired: false },
  { code: "role.delete", name: "删除角色", category: "admin", risk: "high", summaryTemplate: "删除角色「{targetLabel}」", reviewRequired: true },
  { code: "config.change", name: "修改配置", category: "config", risk: "high", summaryTemplate: "修改配置项 {targetLabel}", reviewRequired: false },
  { code: "audit.export", name: "导出审计日志", category: "system", risk: "notice", summaryTemplate: "导出审计日志（{targetLabel}）", reviewRequired: false },
  { code: "saas.lifecycle.invalid", name: "生命周期迁移被拒绝", category: "tenant", risk: "notice", summaryTemplate: "租户「{targetLabel}」的迁移动作 {action} 被拒绝（当前状态不允许）", reviewRequired: false },
] as const;
