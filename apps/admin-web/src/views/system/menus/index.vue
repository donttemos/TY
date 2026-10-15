<!--
 * @file 菜单管理页
 * @description 菜单树维护（PRD-005 FR-06 配套）：扁平接口数据前端组装为树表格；
 *   新建 / 编辑（父级、路径、组件、图标、权限码、显示、排序）、删除（有子菜单时服务端拒绝）。
 *   注意：菜单变更影响动态路由，保存后需重新登录生效（权限同源，见 store/permission）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 补按钮级权限：新建/新增子级 = menu:create，编辑 = menu:update，
 *   删除 = menu:delete（此前仅页面级可见性由菜单树控制，只读角色仍能点到写操作并吃 3002）
 * @modified 2026-10-15 donttemo E-06：图标改 IconPicker 选择器（icon-map 登记表点选，防手打未登记名
 *   静默回退）、权限码改从权限点列表点选（防手打出不存在的码，登录时快照校验会 403）、图标列可视化
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as menuApi from '@/api/menu';
import * as roleApi from '@/api/role';
import { resolveIcon } from '@/layout/icon-map';
import IconPicker from '@/components/IconPicker/index.vue';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { MenuManageItem, MenuUpsertInput, PermissionCode, PermissionGroup } from '@/api/types';

interface TreeNode extends MenuManageItem {
  children: TreeNode[];
}

/** 表单模型（输入控件均为字符串，提交时再收敛为可空） */
interface MenuForm {
  parentId: string;
  name: string;
  path: string;
  component: string;
  icon: string;
  permissionCode: string;
  visible: boolean;
  sort: number;
}

const loading = ref(false);
const flatMenus = ref<MenuManageItem[]>([]);

/** 扁平 → 树（parentId 组装） */
const treeData = computed<TreeNode[]>(() => {
  const map = new Map<string, TreeNode>();
  for (const item of flatMenus.value) map.set(item.id, { ...item, children: [] });
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    const parent = map.get(node.parentId);
    if (parent && node.parentId !== '0') parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: TreeNode[]): void => {
    list.sort((a, b) => a.sort - b.sort);
    for (const node of list) sortRec(node.children);
  };
  sortRec(roots);
  return roots;
});

/** 父级选项（树形选择，排除自身与后代，防环） */
const parentOptions = computed(() => {
  const options: { value: string; label: string; children?: { value: string; label: string }[] }[] = [
    { value: '0', label: '顶级菜单' },
  ];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (editing.value && isSelfOrDescendant(node.id)) continue;
      options.push({ value: node.id, label: `${'　'.repeat(depth)}${node.name}` });
      if (node.children.length) walk(node.children, depth + 1);
    }
  };
  walk(treeData.value, 0);
  return options;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    flatMenus.value = await menuApi.fetchMenuTree();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '菜单加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** ---------- 新建 / 编辑 ---------- */
const dialogVisible = ref(false);
const saving = ref(false);
const editing = ref<MenuManageItem | null>(null);
const form = reactive<MenuForm>({
  parentId: '0',
  name: '',
  path: '',
  component: '',
  icon: '',
  permissionCode: '',
  visible: true,
  sort: 1,
});

/** 判断节点是否为当前编辑节点自身或后代（父级选择需排除，防止成环） */
function isSelfOrDescendant(id: string): boolean {
  if (!editing.value) return false;
  if (id === editing.value.id) return true;
  const childrenOf = (parentId: string): boolean =>
    flatMenus.value.some((m) => m.parentId === parentId && (m.id === id || childrenOf(m.id)));
  return childrenOf(editing.value.id);
}

function openCreate(parentId = '0'): void {
  editing.value = null;
  Object.assign(form, { parentId, name: '', path: '', component: '', icon: '', permissionCode: '', visible: true, sort: flatMenus.value.length + 1 });
  void ensurePermissionCodes();
  dialogVisible.value = true;
}

function openEdit(row: MenuManageItem): void {
  editing.value = row;
  Object.assign(form, {
    parentId: row.parentId,
    name: row.name,
    path: row.path ?? '',
    component: row.component ?? '',
    icon: row.icon ?? '',
    permissionCode: row.permissionCode ?? '',
    visible: row.visible,
    sort: row.sort,
  });
  void ensurePermissionCodes();
  dialogVisible.value = true;
}

/** ---------- E-06：权限码选择器选项（首次打开弹窗时懒加载，失败不阻塞表单） ---------- */
const permissionCodeOptions = ref<string[]>([]);

async function ensurePermissionCodes(): Promise<void> {
  if (permissionCodeOptions.value.length > 0) return;
  try {
    const groups: PermissionGroup[] = await roleApi.fetchPermissionGroups();
    permissionCodeOptions.value = groups.flatMap((group) => group.items.map((item) => item.code));
  } catch {
    // 加载失败不阻塞表单，但要让用户知道权限码选不了（而非静默的空下拉）
    ElMessage.warning('权限点列表加载失败，暂只能维护其他字段');
    permissionCodeOptions.value = [];
  }
}

async function submit(): Promise<void> {
  if (!form.name?.trim()) {
    ElMessage.warning('请输入菜单名称');
    return;
  }
  saving.value = true;
  try {
    // 空串收敛为 undefined（JSON 中丢弃该键 = 不设置 / 新建时置空），权限码需断言为契约模板类型
    const payload: MenuUpsertInput = {
      parentId: form.parentId,
      name: form.name,
      path: form.path || undefined,
      component: form.component || undefined,
      icon: form.icon || undefined,
      permissionCode: form.permissionCode ? (form.permissionCode as PermissionCode) : undefined,
      visible: form.visible,
      sort: form.sort,
    };
    if (editing.value) {
      await menuApi.updateMenu(editing.value.id, payload);
      ElMessage.success('菜单已更新（重新登录后路由生效）');
    } else {
      await menuApi.createMenu(payload);
      ElMessage.success('菜单已创建（重新登录后路由生效）');
    }
    dialogVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function handleDelete(row: MenuManageItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除菜单「${row.name}」？`, '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await menuApi.deleteMenu(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '删除失败');
  }
}
</script>

<template>
  <div class="fw-page">
    <div class="fw-card">
      <div class="fw-flex-between" style="margin-bottom: 12px">
        <span class="fw-text-secondary">菜单树（动态路由数据源，/auth/menus 按权限下发）</span>
        <el-button v-permission="'menu:create'" type="primary" @click="openCreate()">+ 新建菜单</el-button>
      </div>
      <el-table v-loading="loading" :data="treeData" row-key="id" border default-expand-all :tree-props="{ children: 'children' }">
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="path" label="路径" min-width="160" />
        <el-table-column prop="component" label="组件" min-width="160" />
        <el-table-column prop="icon" label="图标" width="110">
          <template #default="{ row }">
            <span v-if="row.icon" class="fw-menu-icon-cell">
              <el-icon><component :is="resolveIcon(row.icon)" /></el-icon>
              <span>{{ row.icon }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="permissionCode" label="权限码" min-width="140" />
        <el-table-column label="显示" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.visible ? 'success' : 'info'" size="small">{{ row.visible ? '显示' : '隐藏' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sort" label="排序" width="70" align="center" />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <div class="fw-table-actions">
              <el-button v-permission="'menu:create'" link type="primary" @click="openCreate(row.id)">新增子级</el-button>
              <el-button v-permission="'menu:update'" link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button v-permission="'menu:delete'" link type="danger" @click="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑菜单' : '新建菜单'" width="520px">
      <el-form :model="form" label-width="88px">
        <el-form-item label="父级菜单">
          <el-tree-select v-model="form.parentId" :data="parentOptions" check-strictly clearable style="width: 100%" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" maxlength="32" />
        </el-form-item>
        <el-form-item label="路径">
          <el-input v-model="form.path" placeholder="/system/users" maxlength="128" />
        </el-form-item>
        <el-form-item label="组件">
          <el-input v-model="form.component" placeholder="system/users（views 下相对路径）" maxlength="128" />
        </el-form-item>
        <el-form-item label="图标">
          <IconPicker v-model="form.icon" style="width: 100%" />
        </el-form-item>
        <el-form-item label="权限码">
          <el-select
            v-model="form.permissionCode"
            filterable
            clearable
            placeholder="从权限点中选择（留空=登录即可见）"
            style="width: 100%"
            data-test="menu-permission-select"
          >
            <el-option v-for="code in permissionCodeOptions" :key="code" :label="code" :value="code" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="1" controls-position="right" />
        </el-form-item>
        <el-form-item label="是否显示">
          <el-switch v-model="form.visible" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fw-menu-icon-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-regular);
}

.fw-menu-icon-cell .el-icon {
  color: var(--el-color-primary);
}
</style>
