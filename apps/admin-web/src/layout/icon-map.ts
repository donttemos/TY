/*
 * @file 菜单图标映射
 * @description 后端菜单树下发的是图标名字符串（如 'user'），前端映射到 @element-plus/icons-vue 组件；
 *   未登记的图标回退为默认图标，避免后端加菜单时前端白块。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/layout
 */

import {
  Avatar,
  Collection,
  Files,
  HomeFilled,
  List,
  Menu as MenuIcon,
  Money,
  Setting,
  ShoppingCart,
  ShoppingTrolley,
  UserFilled,
  View,
} from '@element-plus/icons-vue';
import type { Component } from 'vue';

const ICON_MAP: Record<string, Component> = {
  home: HomeFilled,
  setting: Setting,
  user: UserFilled,
  avatar: Avatar,
  shield: View,
  menu: MenuIcon,
  collection: Collection,
  'file-text': Files,
  shopping: ShoppingCart,
  trolley: ShoppingTrolley,
  money: Money,
  list: List,
};

/** 按名字取图标组件；未登记回退列表图标 */
export function resolveIcon(name: string | null): Component {
  if (!name) return List;
  return ICON_MAP[name] ?? List;
}
