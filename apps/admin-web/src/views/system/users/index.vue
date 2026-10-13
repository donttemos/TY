<!--
 * @file 用户管理页
 * @description PRD-005 FR-05：列表 / 新增 / 编辑 / 启用禁用 / 重置密码 / 分配角色；
 *   关键词与状态筛选；密码仅新建可填（编辑隐藏）。启用禁用走二次确认（NFR：危险操作）。
 *   角色分配弹窗为全量覆盖语义（PUT /users/:id/roles）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 导出提示从模板内联表达式改为具名 handleExport：vue-tsc 3 下
 *   模板内直接调用 ElMessage 会被解析为组件实例类型（TS2339），具名方法同时更易测试
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import StatusTag from '@/components/StatusTag/index.vue';
import * as userApi from '@/api/user';
import * as roleApi from '@/api/role';
import { useDictStore } from '@/store/dict';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, FormField, SearchField, SearchModel } from '@/components/CrudTable/types';
import type { RoleListItem, UserListItem } from '@/api/types';

const dictStore = useDictStore();

const columns: CrudColumn[] = [
  { prop: 'username', label: '账号', minWidth: 120 },
  { prop: 'nickname', label: '昵称', minWidth: 100 },
  { prop: 'phone', label: '手机', minWidth: 120 },
  { prop: 'email', label: '邮箱', minWidth: 160 },
  { prop: 'roleIds', label: '角色', minWidth: 140, slot: 'roles' },
  { prop: 'status', label: '状态', width: 90, align: 'center', slot: 'status' },
  { prop: 'lastLoginAt', label: '最近登录', width: 180, slot: 'lastLoginAt' },
  { prop: 'createdAt', label: '创建时间', width: 180, slot: 'createdAt' },
];

const searchForm: SearchField[] = [
  { prop: 'keyword', label: '关键词', type: 'input', placeholder: '账号 / 昵称 / 邮箱' },
  { prop: 'status', label: '状态', type: 'select', dictCode: 'user_status' },
  { prop: 'role_id', label: '角色', type: 'select', options: [] },
];

const formFields: FormField[] = [
  { prop: 'username', label: '账号', type: 'input', rules: [{ required: true, message: '请输入账号', trigger: 'blur' }, { min: 3, max: 32, message: '长度 3-32', trigger: 'blur' }], disabledOnEdit: true },
  { prop: 'password', label: '密码', type: 'password', hiddenOnEdit: true, rules: [{ required: true, message: '请输入初始密码', trigger: 'blur' }, { min: 8, message: '至少 8 位', trigger: 'blur' }] },
  { prop: 'nickname', label: '昵称', type: 'input' },
  { prop: 'phone', label: '手机', type: 'input' },
  { prop: 'email', label: '邮箱', type: 'input' },
  { prop: 'status', label: '状态', type: 'dict-select', dictCode: 'user_status', span: 12 },
  { prop: 'roleIds', label: '角色', type: 'select', options: [], span: 12 },
];

const crudRef = ref<InstanceType<typeof CrudTable>>();
const roles = ref<RoleListItem[]>([]);

onMounted(async () => {
  // 角色选项（筛选与表单共用）
  try {
    roles.value = await roleApi.fetchRoles();
    const options = roles.value.map((role) => ({ label: role.name, value: role.id }));
    const roleField = searchForm.find((field) => field.prop === 'role_id');
    if (roleField) roleField.options = options;
    const formRoleField = formFields.find((field) => field.prop === 'roleIds');
    if (formRoleField) formRoleField.options = options;
  } catch {
    // 角色拉取失败时下拉为空，不阻塞列表
  }
});

/** 时间格式化 */
function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

/** 角色名回显 */
function roleNames(row: UserListItem): string {
  return row.roleIds.map((id) => roles.value.find((r) => r.id === id)?.name ?? id).join('、') || '—';
}

/** 分配角色弹窗 */
const assignVisible = ref(false);
const assignUser = ref<UserListItem | null>(null);
const assignSelected = ref<string[]>([]);

function openAssign(row: UserListItem): void {
  assignUser.value = row;
  assignSelected.value = [...row.roleIds];
  assignVisible.value = true;
}

async function submitAssign(): Promise<void> {
  if (!assignUser.value) return;
  try {
    await userApi.assignRoles(assignUser.value.id, assignSelected.value);
    ElMessage.success('角色已更新');
    assignVisible.value = false;
    crudRef.value?.refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '操作失败');
  }
}

/** 重置密码：返回一次性密码 */
async function handleResetPassword(row: UserListItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认重置「${row.username}」的密码？`, '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  try {
    const result = await userApi.resetPassword(row.id);
    await ElMessageBox.alert(`新密码：${result.oneTimePassword}\n请复制并妥善移交，关闭后不再显示。`, '重置成功', {
      type: 'success',
      confirmButtonText: '我已保存',
    });
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '操作失败');
  }
}

/** 启用 / 禁用（二次确认） */
async function toggleStatus(row: UserListItem): Promise<void> {
  const next = row.status === 1 ? 0 : 1;
  const actionText = next === 0 ? '禁用' : '启用';
  try {
    await ElMessageBox.confirm(`确认${actionText}「${row.username}」？${next === 0 ? '禁用后该用户将被强制下线。' : ''}`, '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await userApi.setUserStatus(row.id, next);
    ElMessage.success(`已${actionText}`);
    crudRef.value?.refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '操作失败');
  }
}

/** 新建后刷新角色选项（不影响现有行） */
function handleRefresh(): void {
  crudRef.value?.refresh();
  void dictStore.invalidate();
}

/** 导出：演示环境仅提示已发起（真实实现走 C-06 契约的导出端点） */
function handleExport(payload: { search: SearchModel; sort: string | null }): void {
  ElMessage.info(`导出已发起（演示环境）：${JSON.stringify(payload.search)}`);
}
</script>

<template>
  <div class="fw-page">
    <CrudTable
      ref="crudRef"
      api="/users"
      :columns="columns"
      :search-form="searchForm"
      :form-fields="formFields"
      permission="user"
      create-title="新建用户"
      edit-title="编辑用户 #{id}"
      selection
      exportable
      @export="handleExport"
      @refresh="handleRefresh"
    >
      <template #cell-roles="{ row }">
        {{ roleNames(row) }}
      </template>
      <template #cell-status="{ row }">
        <status-tag :value="row.status" dict-code="user_status" />
      </template>
      <template #cell-lastLoginAt="{ row }">
        {{ formatTime(row.lastLoginAt) }}
      </template>
      <template #cell-createdAt="{ row }">
        {{ formatTime(row.createdAt) }}
      </template>
      <template #actions-extra="{ row }">
        <el-button link type="primary" @click="openAssign(row)">分配角色</el-button>
        <el-button link type="warning" @click="handleResetPassword(row)">重置密码</el-button>
        <el-button link :type="row.status === 1 ? 'danger' : 'success'" @click="toggleStatus(row)">
          {{ row.status === 1 ? '禁用' : '启用' }}
        </el-button>
      </template>
    </CrudTable>

    <!-- 分配角色弹窗（全量覆盖） -->
    <el-dialog v-model="assignVisible" title="分配角色" width="420px">
      <el-checkbox-group v-model="assignSelected">
        <el-checkbox v-for="role in roles" :key="role.id" :value="role.id" style="display: block; margin: 0 0 8px">
          {{ role.name }}
          <span class="fw-text-weak">（{{ role.dataScope === 'all' ? '全部数据' : role.dataScope === 'self' ? '仅本人' : role.dataScope }}）</span>
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAssign">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
