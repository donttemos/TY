/*
 * @file 组织树纯函数（供 DataScopeOrgPort 实现方计算部门子树）
 * @description PRD-008 FR-05：org_below 数据范围需要「本部门及全部下级」的闭包。
 *   框架不感知部门表结构，这里只提供通用的父子图闭包算法：输入扁平节点与根集合，
 *   输出根集合自身 + 全部后代（去重、防环、容忍悬空父节点）。
 *   约定与 menus 一致：parentId='0' 表示顶级；根节点自身计入结果。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/auth
 */

/** 组织树节点最小结构（部门 / 菜单等父子图通用） */
export interface OrgTreeNode {
  /** 节点 ID */
  id: string;
  /** 父节点 ID；'0' 表示顶级 */
  parentId: string;
}

/**
 * 计算根集合的向下闭包（根自身 + 全部后代）
 * @param nodes 全量节点（业务侧传入未删除的部门行）
 * @param roots 根节点 ID 集合（用户所属部门）
 * @returns 闭包 ID 集合（顺序不稳定，调用方按集合语义使用）
 */
export function collectDescendantIds(nodes: OrgTreeNode[], roots: readonly string[]): string[] {
  // 父 → 子 索引（一次遍历建桶，避免 O(n²) 反复扫描）
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    const bucket = childrenByParent.get(node.parentId);
    if (bucket) bucket.push(node.id);
    else childrenByParent.set(node.parentId, [node.id]);
  }

  const collected = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    // 已收集即跳过：同一节点多父路径（数据冗余）或环（parent 指错）都不会重复入队
    if (collected.has(current)) continue;
    collected.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!collected.has(child)) queue.push(child);
    }
  }
  return [...collected];
}
