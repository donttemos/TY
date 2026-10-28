/*
 * @file 黄金链路浏览器用例：登录 → 增 → 改 → 删（PRD-016 FR-16-17）
 * @description 只断言「用户能看见的行为」，不碰内部状态：
 *   登录成功进入工作台 → 打开生成模块的路由 → 新建一条 → 列表出现 → 编辑改名 → 列表更新 → 删除 → 列表消失。
 *   路由、账号、中文标签都来自环境变量或生成器约定（Product → 名称/数量），因此同一份用例可对
 *   本地 dev server 与真机实例复用。
 *   选择器策略：优先用可见文案（Element Plus 的按钮与表单项标签稳定），避免依赖 class 名。
 * @author donttemo
 * @created 2026-10-22
 * @module admin-web/e2e
 */

import { expect, test } from '@playwright/test';

/** 被测模块路由（fw verify 传入，默认 /products） */
const ROUTE = process.env.E2E_ROUTE ?? '/products';
/** 登录账号（与模板 seed 一致） */
const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? 'Admin@123456';

test.describe('生成模块的增删改查', () => {
  test('登录后完成新建 → 编辑 → 删除', async ({ page }) => {
    // 1. 登录（登录页是未认证时的默认落点）
    await page.goto('/');
    await page.locator('input[placeholder="账号"]').fill(USER);
    await page.locator('input[placeholder="密码"]').fill(PASS);
    await page.locator('.fw-login-submit').click();
    // 登录成功标志：离开登录页（进入工作台或 redirect 目标）
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    // 2. 打开生成模块（动态路由由菜单下发，刷新后由前端路由表接管）
    await page.goto(ROUTE);
    const createButton = page.locator('button', { hasText: '新建' }).first();
    await expect(createButton).toBeVisible({ timeout: 20_000 });

    // 3. 新建
    const stamp = Date.now().toString().slice(-6);
    const name = `E2E-${stamp}`;
    await createButton.click();
    const dialog = page.locator('.el-dialog').last();
    await expect(dialog).toBeVisible();
    await dialog.locator('.el-form-item', { hasText: '名称' }).locator('input').first().fill(name);
    await dialog.locator('button', { hasText: '保存' }).click();
    // 保存成功：弹窗关闭且列表出现该行
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    const row = page.locator('.el-table__row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // 4. 编辑（同一行点「编辑」，改名为带 -edited 后缀）
    const edited = `${name}-edited`;
    await row.locator('button', { hasText: '编辑' }).first().click();
    const editDialog = page.locator('.el-dialog').last();
    await expect(editDialog).toBeVisible();
    const nameInput = editDialog.locator('.el-form-item', { hasText: '名称' }).locator('input').first();
    await nameInput.fill(edited);
    await editDialog.locator('button', { hasText: '保存' }).click();
    await expect(editDialog).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('.el-table__row', { hasText: edited }).first()).toBeVisible({ timeout: 20_000 });

    // 5. 删除（确认框按钮文案是「确认删除」）
    const editedRow = page.locator('.el-table__row', { hasText: edited }).first();
    await editedRow.locator('button', { hasText: '删除' }).first().click();
    await page.locator('.el-message-box button', { hasText: '确认删除' }).click();
    await expect(page.locator('.el-table__row', { hasText: edited })).toHaveCount(0, { timeout: 20_000 });
  });
});
