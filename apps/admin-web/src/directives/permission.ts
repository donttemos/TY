/*
 * @file v-permission 指令
 * @description 按钮级权限控制（PRD-005 FR-04 / TC-WEB-002）：v-permission="'order:refund'"，无权限时移除 DOM。
 *   注意：这只是体验优化——服务端仍必须校验权限码（docs/70 §1.5 反模式：前端隐藏 ≠ 安全）。
 *   传入数组为「与」关系（全部命中才显示）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/directives
 */

import type { Directive } from 'vue';
import { useUserStore } from '@/store/user';
import type { PermissionCode } from '@/api/types';

export const permission: Directive<HTMLElement, PermissionCode | PermissionCode[]> = {
  mounted(el, binding) {
    const user = useUserStore();
    if (!user.hasPermission(binding.value)) {
      el.remove();
    }
  },
};

export default permission;
