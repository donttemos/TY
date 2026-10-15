<!--
 * @file 角色与权限页
 * @description PRD-005 FR-06：角色 CRUD、权限树勾选（菜单 / 按钮 / 接口三层）、数据范围四档、复制角色。
 *   保存授权为全量覆盖（PUT /roles/:id/permissions），提交前提示覆盖语义；内置管理员角色不可授权 / 删除（服务端强约束）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo BUG-15 增量：名称/编码/数据范围/备注 4 列开启 sortable
 *   （权限数为聚合计算字段、类型为布尔旗标，均不可排序）
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import StatusTag from '@/components/StatusTag/index.vue';
import * as roleApi from '@/api/role';
import { flattenPermissionTree } from '@/api/role';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn } from '@/components/CrudTable/types';
import type { DataScope, PermissionGroup, PermissionItem, RoleListItem } from '@/api/types';

const columns: CrudColumn[] = [
  { prop: 'name', label: '角色名称', minWidth: 140, sortable: true },
  { prop: 'code', label: '编码', minWidth: 120, sortable: true },
  { prop: 'dataScope', label: '数据范围', width: 130, align: 'center', slot: 'dataScope', sortable: true },
  { prop: 'permissionCount', label: '权限数', width: 90, align: 'center' },
  { prop: 'remark', label: '备注', minWidth: 160, showOverflowTooltip: true, sortable: true },
  { prop: 'isSystem', label: '类型', width: 90, align: 'center', slot: 'isSystem' },
];

const crudRef = ref<InstanceType<typeof CrudTable>>();

function refresh(): void {
  crudRef.value?.refresh();
}

/** ---------- 新建 / 编辑角色 ---------- */
const editVisible = ref(false);
const editSaving = ref(false);
const editing = ref<RoleListItem | null>(null);
const editForm = ref({ name: '', remark: '', dataScope: 'self' as DataScope });

function openCreate(): void {
  editing.value = null;
  editForm.value = { name: '', remark: '', dataScope: 'self' };
  editVisible.value = true;
}

function openEdit(row: RoleListItem): void {
  editing.value = row;
  editForm.value = { name: row.name, remark: row.remark ?? '', dataScope: row.dataScope };
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  if (!editForm.value.name.trim()) {
    ElMessage.warning('请输入角色名称');
    return;
  }
  editSaving.value = true;
  try {
    if (editing.value) {
      await roleApi.updateRole(editing.value.id, editForm.value);
      ElMessage.success('角色已更新');
    } else {
      await roleApi.createRole(editForm.value);
      ElMessage.success('角色已创建');
    }
    editVisible.value = false;
    refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败');
  } finally {
    editSaving.value = false;
  }
}

/** ---------- 授权弹窗（权限树三层勾选） ---------- */
const grantVisible = ref(false);
const grantRole = ref<RoleListItem | null>(null);
const groups = ref<PermissionGroup[]>([]);
const selected = ref<string[]>([]);
const grantSaving = ref(false);

/** 三层分组：菜单 / 按钮 / 接口 */
const TYPE_TABS = [
  { key: 'menu', label: '菜单' },
  { key: 'button', label: '按钮' },
  { key: 'api', label: '接口' },
] as const;
const activeType = ref<'menu' | 'button' | 'api'>('menu');

/** 当前类型按 module 聚合 */
const filteredGroups = computed(() => {
  const result = new Map<string, PermissionItem[]>();
  for (const group of groups.value) {
    const items = group.items.filter((item) => item.type === activeType.value);
    if (items.length > 0) result.set(group.module, items);
  }
  return [...result.entries()].map(([module, items]) => ({ module, items }));
});

/** 模块全选状态 */
function moduleAllChecked(items: PermissionItem[]): boolean {
  return items.every((item) => selected.value.includes(item.id));
}

function moduleIndeterminate(items: PermissionItem[]): boolean {
  const checked = items.filter((item) => selected.value.includes(item.id)).length;
  return checked > 0 && checked < items.length;
}

function toggleModule(items: PermissionItem[], checked: boolean): void {
  const ids = items.map((item) => item.id);
  selected.value = checked ? [...new Set([...selected.value, ...ids])] : selected.value.filter((id) => !ids.includes(id));
}

async function openGrant(row: RoleListItem): Promise<void> {
  grantRole.value = row;
  grantVisible.value = true;
  selected.value = [];
  groups.value = [];
  try {
    // M10 E-04：授权数据源换接权限树（/permissions/tree）——拍平为分组结构，勾选/提交行为不变
    const [tree, granted] = await Promise.all([roleApi.fetchPermissionTree(), roleApi.fetchRolePermissions(row.id)]);
    groups.value = flattenPermissionTree(tree);
    selected.value = granted.permissions.map((p) => p.id);
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '权限数据加载失败');
  }
}

async function submitGrant(): Promise<void> {
  if (!grantRole.value) return;
  grantSaving.value = true;
  try {
    await roleApi.grantRolePermissions(grantRole.value.id, selected.value);
    ElMessage.success('授权已保存，相关用户重新登录后生效');
    grantVisible.value = false;
    refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败');
  } finally {
    grantSaving.value = false;
  }
}

/** ---------- 复制角色 / 删除 ---------- */
async function handleCopy(row: RoleListItem): Promise<void> {
  try {
    await roleApi.copyRole(row.id);
    ElMessage.success('角色已复制');
    refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '复制失败');
  }
}

async function handleDelete(row: RoleListItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除角色「${row.name}」？关联用户将失去该角色。`, '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await roleApi.deleteRole(row.id);
    ElMessage.success('已删除');
    refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '删除失败');
  }
}
</script>

<template>
  <div class="fw-page">
    <CrudTable
      ref="crudRef"
      api="/roles"
      :columns="columns"
      :pagination="false"
      permission="role"
    >
      <template #toolbar>
        <el-button type="primary" @click="openCreate">+ 新建角色</el-button>
      </template>
      <template #cell-dataScope="{ row }">
        <status-tag :value="row.dataScope" dict-code="data_scope" />
      </template>
      <template #cell-isSystem="{ row }">
        <el-tag :type="row.isSystem ? 'info' : 'success'" size="small">{{ row.isSystem ? '内置' : '自定义' }}</el-tag>
      </template>
      <template #actions-extra="{ row }">
        <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
        <el-button link type="primary" @click="openGrant(row)">授权</el-button>
        <el-button link type="primary" @click="handleCopy(row)">复制</el-button>
        <el-button v-if="!row.isSystem" link type="danger" @click="handleDelete(row)">删除</el-button>
      </template>
    </CrudTable>

    <!-- 新建 / 编辑角色 -->
    <el-dialog v-model="editVisible" :title="editing ? '编辑角色' : '新建角色'" width="440px">
      <el-form :model="editForm" label-width="96px">
        <el-form-item label="角色名称" required>
          <el-input v-model="editForm.name" maxlength="32" />
        </el-form-item>
        <el-form-item label="数据范围">
          <el-radio-group v-model="editForm.dataScope">
            <el-radio value="all">全部数据</el-radio>
            <el-radio value="org_below">本组织及下级</el-radio>
            <el-radio value="org">本组织</el-radio>
            <el-radio value="self">仅本人</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" type="textarea" :rows="2" maxlength="128" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 授权弹窗：权限树三层勾选 -->
    <el-dialog v-model="grantVisible" title="角色授权" width="640px" top="8vh">
      <template #header>
        <span>角色授权：{{ grantRole?.name }}</span>
        <el-button link type="primary" style="margin-left: 12px" @click="handleCopy(grantRole!)">复制角色</el-button>
      </template>
      <el-alert type="info" :closable="false" show-icon title="保存后将覆盖原有授权；相关用户重新登录后生效" style="margin-bottom: 12px" />
      <el-tabs v-model="activeType">
        <el-tab-pane v-for="tab in TYPE_TABS" :key="tab.key" :label="tab.label" :name="tab.key">
          <div class="fw-grant-body">
            <div v-for="group in filteredGroups" :key="group.module" class="fw-grant-group">
              <div class="fw-grant-group-title">
                <el-checkbox
                  :model-value="moduleAllChecked(group.items)"
                  :indeterminate="moduleIndeterminate(group.items)"
                  @change="(checked: boolean) => toggleModule(group.items, checked)"
                >
                  {{ group.module }}
                </el-checkbox>
              </div>
              <el-checkbox-group v-model="selected" class="fw-grant-items">
                <el-checkbox v-for="item in group.items" :key="item.id" :value="item.id">
                  {{ item.name }}
                  <span class="fw-text-weak">({{ item.code }})</span>
                </el-checkbox>
              </el-checkbox-group>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <span class="fw-text-weak" style="margin-right: 12px">已选 {{ selected.length }} 项</span>
        <el-button @click="grantVisible = false">取消</el-button>
        <el-button type="primary" :loading="grantSaving" @click="submitGrant">保存授权</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fw-grant-body {
  max-height: 360px;
  overflow-y: auto;
}

.fw-grant-group {
  margin-bottom: 16px;
}

.fw-grant-group-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.fw-grant-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding-left: 20px;
}
</style>
