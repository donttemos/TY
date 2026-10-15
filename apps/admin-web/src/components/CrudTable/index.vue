<!--
 * @file 标准 CRUD 列表组件（PRD-005 FR-09 / 原型 §5.2）
 * @description 配置四要素 columns / searchForm / api / permission 即可获得完整列表页：
 *   查询区（含字典下拉与展开收起）、工具栏（新建 / 批量删除 / 列设置 / 导出钩子）、
 *   表格（排序 / 多选 / 自定义列插槽 / 行操作）、分页、加载 / 空 / 错误 / 无权限四态、
 *   内置表单弹窗（formFields 提供时）。新业务列表页 ≤ 80 行（PRD-005 AC）。
 *   权限：新建 = <permission>:create，编辑 = <permission>:update，删除 = <permission>:delete，
 *   导出 = <permission>:export；无权限按钮不渲染（v-permission），服务端仍独立校验。
 *   可用 permissionActions 显式覆盖动作码（后端权限码不是「前缀 + 标准动作」时必填）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复 4 项缺陷：① 操作列只在 formFields/canDelete 命中时渲染，
 *   使只挂 actions-extra 插槽的页面（审计日志「详情」）整列消失、字段级 diff 不可达 → 增加插槽探测；
 *   ② 权限码无法覆盖，字典页推导出不存在的 dict:create/update/delete → 新增 permissionActions；
 *   ③ number / 多选字段初值写成空串（el-input-number 告警、数组字段回显为空）→ 按类型初始化并保数组；
 *   ④ 查询条件未按原型 §7 本地持久化 → 与列设置同策略落 localStorage
 * @modified 2026-10-14 donttemo BUG-15：排序参数对齐 api-spec §1.5 —— 原先直接发 `${prop}:${order}`
 *   （camelCase，如 `createdAt:asc`），与后端约定的 snake_case 不符；改为经 resolveSortField()
 *   转 snake_case（列配置可用 sortField 显式覆盖，用于展示字段 ≠ 排序字段的场景）
 * @modified 2026-10-15 donttemo 新增 hideDelete：端点语义不是「物理删除」的页面（如租户的
 *   DELETE 实为「停用」）需要自定义确认文案与提示，内置删除按钮的「删除后不可恢复」会造成误导
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useSlots } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Search, Setting } from '@element-plus/icons-vue';
import DictSelect from '@/components/DictSelect/index.vue';
import FormDialog from '@/components/FormDialog/index.vue';
import { request, BizError, describeBizError } from '@/utils/request';
import { useUserStore } from '@/store/user';
import type { PermissionCode } from '@/api/types';
import type { CrudColumn, FormField, FormModel, PagePayload, SearchField, SearchModel } from './types';
import { buildSortParam, type TableSortOrder } from './sort';

const props = withDefaults(
  defineProps<{
    /** 列表接口路径，如 '/users' */
    api: string;
    columns: CrudColumn[];
    /** 查询区字段 */
    searchForm?: SearchField[];
    /** 权限前缀，如 'user' → user:create / user:update / user:delete */
    permission?: string;
    /**
     * 显式覆盖动作权限码（优先于 permission 推导）。
     * 后端权限码不等于「前端前缀 + create/update/delete」时必须指定，否则按钮永不渲染。
     */
    permissionActions?: Partial<Record<'create' | 'update' | 'delete' | 'export', string>>;
    /** 表单字段（提供则启用内置新增 / 编辑弹窗） */
    formFields?: FormField[];
    /** 弹窗标题（新建） */
    createTitle?: string;
    /** 弹窗标题（编辑，{label} 占位符替换为行标识） */
    editTitle?: string;
    /** 行主键字段 */
    rowKey?: string;
    /** 每页条数 */
    pageSize?: number;
    /** 是否分页（false 时接口返回数组） */
    pagination?: boolean;
    /** 多选 */
    selection?: boolean;
    /** 序号列 */
    index?: boolean;
    /** 行操作列（编辑 / 删除） */
    actions?: boolean;
    /** 导出按钮（emit export 事件，页面自行实现导出） */
    exportable?: boolean;
    /**
     * 隐藏内置删除按钮：端点语义并非物理删除时必开（如租户 DELETE = 停用），
     * 页面改用 actions-extra 插槽自定义按钮与确认文案
     */
    hideDelete?: boolean;
    /** 弹窗宽度 */
    dialogWidth?: string | number;
    /** 新建时预置到表单的固定值（如从属 id：字典项的 categoryId），不出现在表单配置中 */
    formDefaults?: FormModel;
    /** 固定查询条件（不出现在查询区，如字典项按分类过滤） */
    filters?: SearchModel;
  }>(),
  {
    rowKey: 'id',
    pageSize: 20,
    pagination: true,
    selection: false,
    index: false,
    actions: true,
    exportable: false,
    hideDelete: false,
  },
);

const emit = defineEmits<{
  (event: 'refresh'): void;
  (event: 'selection-change', rows: Record<string, unknown>[]): void;
  (event: 'export', payload: { search: SearchModel; sort: string | null }): void;
}>();

const route = useRoute();
const user = useUserStore();
const slots = useSlots();

/** 页面是否挂了行操作扩展插槽（审计「详情」等无新增/删除权限的只读页依赖它渲染操作列） */
const hasActionsSlot = computed(() => Boolean(slots['actions-extra']));

/** 列表数据与状态 */
const list = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const page = ref(1);
const size = ref(props.pageSize);
const loading = ref(false);
const error = ref<{ message: string; traceId: string | null } | null>(null);
const sort = ref<string | null>(null);
const selectedRows = ref<Record<string, unknown>[]>([]);

/** 查询模型（默认值来自 searchForm 配置） */
const search = reactive<SearchModel>({});
const expanded = ref(false);
for (const field of props.searchForm ?? []) {
  if (field.defaultValue !== undefined) search[field.prop] = field.defaultValue;
}

/** 查询条件持久化（原型 §7：查询条件与列设置均按「用户 + 路由」维度本地持久化） */
const searchStorageKey = computed(() => `fw_crud_search:${route.path}:${props.api}`);

function loadSearchSettings(): void {
  try {
    const raw = localStorage.getItem(searchStorageKey.value);
    if (!raw) return;
    const saved = JSON.parse(raw) as SearchModel;
    const allowed = new Set((props.searchForm ?? []).map((field) => field.prop));
    for (const [key, value] of Object.entries(saved)) {
      // 只恢复仍在查询区声明的字段，避免旧版本残留键偷偷带上查询条件
      if (allowed.has(key)) search[key] = value;
    }
  } catch {
    // 损坏的本地配置回退默认值
  }
}

function saveSearchSettings(): void {
  try {
    localStorage.setItem(searchStorageKey.value, JSON.stringify(search));
  } catch {
    // 隐私模式下降级为仅内存
  }
}

/** 列设置：可见性（按用户 + 路由 + 接口维度持久化，原型 §7） */
const columnStorageKey = computed(() => `fw_crud_cols:${route.path}:${props.api}`);
const hiddenColumns = ref<Set<string>>(new Set(props.columns.filter((c) => c.defaultHidden).map((c) => c.prop)));

function loadColumnSettings(): void {
  try {
    const raw = localStorage.getItem(columnStorageKey.value);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, boolean>;
      hiddenColumns.value = new Set(Object.entries(saved).filter(([, visible]) => !visible).map(([prop]) => prop));
    }
  } catch {
    // 损坏的本地配置回退默认
  }
}

function saveColumnSettings(): void {
  const record: Record<string, boolean> = {};
  for (const column of props.columns) record[column.prop] = !hiddenColumns.value.has(column.prop);
  try {
    localStorage.setItem(columnStorageKey.value, JSON.stringify(record));
  } catch {
    // 隐私模式下降级
  }
}

/** 可见列（列设置过滤后） */
const visibleColumns = computed(() => props.columns.filter((c) => !hiddenColumns.value.has(c.prop)));

/** 弹窗状态 */
const dialogVisible = ref(false);
const dialogMode = ref<'create' | 'edit'>('create');
const dialogTitle = ref('');
const formModel = reactive<FormModel>({});
const submitting = ref(false);
const editingId = ref<string | null>(null);
const formDialogRef = ref<InstanceType<typeof FormDialog>>();

/** 权限按钮（无 permission 前缀时全部放行） */
function perm(code: 'create' | 'update' | 'delete' | 'export'): PermissionCode | null {
  // 显式覆盖优先：后端权限码常与「前缀 + 标准动作」不一致（如字典只有 dict:read / dict:write）
  const override = props.permissionActions?.[code];
  if (override) return override as PermissionCode;
  // 模板拼接结果在类型层面是 string，这里断言为 PermissionCode（<前缀>:<动作> 形状由调用方保证）
  return props.permission ? (`${props.permission}:${code}` as PermissionCode) : null;
}

function canCreate(): boolean {
  const code = perm('create');
  return code === null || user.hasPermission(code);
}

function canUpdate(): boolean {
  const code = perm('update');
  return code === null || user.hasPermission(code);
}

function canDelete(): boolean {
  const code = perm('delete');
  return code === null || user.hasPermission(code);
}

function canExport(): boolean {
  const code = perm('export');
  return code === null || user.hasPermission(code);
}

/** 查询参数（固定 filters + 查询区（去掉空值；daterange 转 min/max）+ 分页 + 排序） */
function buildParams(): SearchModel {
  const params: SearchModel = { ...(props.filters ?? {}), ...search };
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete params[key];
    }
  }
  if (props.pagination) {
    params.page = page.value;
    params.pageSize = size.value;
  }
  if (sort.value) params.sort = sort.value;
  return params;
}

/** 拉取列表 */
async function fetchList(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await request.get<PagePayload<Record<string, unknown>> | Record<string, unknown>[]>(props.api, { params: buildParams() });
    if (props.pagination) {
      const payload = data as PagePayload<Record<string, unknown>>;
      list.value = payload.items ?? [];
      total.value = payload.total ?? 0;
    } else {
      // 非分页接口约定返回裸数组；兼容后端误包 PageResult 的情况（取 items），避免 el-table 拿到非数组崩溃
      const array = Array.isArray(data) ? (data as Record<string, unknown>[]) : ((data as PagePayload<Record<string, unknown>>)?.items ?? []);
      list.value = array;
      total.value = array.length;
    }
  } catch (err) {
    list.value = [];
    total.value = 0;
    if (err instanceof BizError) {
      error.value = { message: describeBizError(err), traceId: err.traceId };
    } else {
      error.value = { message: '加载失败，请重试', traceId: null };
    }
  } finally {
    loading.value = false;
  }
}

/** 查询 / 重置 */
function handleSearch(): void {
  page.value = 1;
  saveSearchSettings();
  void fetchList();
}

function handleReset(): void {
  for (const field of props.searchForm ?? []) {
    search[field.prop] = field.defaultValue ?? (field.type === 'daterange' ? [] : '');
  }
  page.value = 1;
  saveSearchSettings();
  void fetchList();
}

function handlePageChange(next: number): void {
  page.value = next;
  void fetchList();
}

function handleSizeChange(next: number): void {
  size.value = next;
  page.value = 1;
  void fetchList();
}

/**
 * 服务端排序（el-table custom）
 *
 * 参数构造抽到 `./sort` 的纯函数（buildSortParam）：列 prop 通常是 camelCase，而 api-spec §1.5
 * 约定 `sort=<snake_case 字段>:<asc|desc>`，转换必须在前端完成 —— 后端按白名单收 snake_case，
 * 传 camelCase 会被 400 拒绝（不静默忽略）。
 */
function handleSortChange({ prop, order }: { prop: string; order: TableSortOrder }): void {
  sort.value = buildSortParam(prop, order, props.columns);
  void fetchList();
}

function handleSelectionChange(rows: Record<string, unknown>[]): void {
  selectedRows.value = rows;
  emit('selection-change', rows);
}

/** 行标识 */
function rowId(row: Record<string, unknown>): string {
  return String(row[props.rowKey] ?? '');
}

/** 新建 */
function handleCreate(): void {
  dialogMode.value = 'create';
  dialogTitle.value = props.createTitle ?? '新建';
  editingId.value = null;
  for (const field of props.formFields ?? []) {
    // 初值按控件类型给：number 必须留空（undefined），给 '' 会让 el-input-number 收到非法值；
    // 多选控件（值为数组）必须是 []，否则提交成字符串、接口按数组校验时报 1001
    if (field.type === 'switch') formModel[field.prop] = false;
    else if (field.type === 'number') formModel[field.prop] = undefined;
    else if (field.multiple) formModel[field.prop] = [];
    else formModel[field.prop] = '';
  }
  // 预置固定值（如从属分类 id），字段配置中无需声明
  Object.assign(formModel, props.formDefaults ?? {});
  dialogVisible.value = true;
}

/** 编辑：优先拉详情，失败回退行数据 */
async function handleEdit(row: Record<string, unknown>): Promise<void> {
  dialogMode.value = 'edit';
  editingId.value = rowId(row);
  dialogTitle.value = (props.editTitle ?? '编辑 #{id}').replace('{id}', rowId(row));
  const fields = props.formFields ?? [];
  for (const field of fields) formModel[field.prop] = field.multiple ? [] : '';
  try {
    const detail = await request.get<Record<string, unknown>>(`${props.api}/${editingId.value}`);
    Object.assign(formModel, detail);
  } catch {
    Object.assign(formModel, row);
  }
  // 后端若把关联数组拆到别的字段（如 roleIds 缺失）也不至于渲染崩溃：非数组归一为 []
  for (const field of fields) {
    if (field.multiple && !Array.isArray(formModel[field.prop])) formModel[field.prop] = [];
  }
  dialogVisible.value = true;
}

/** 提交（创建 / 更新） */
async function handleSubmit(): Promise<void> {
  submitting.value = true;
  try {
    const payload: FormModel = { ...formModel };
    if (dialogMode.value === 'create') {
      await request.post(props.api, payload);
      ElMessage.success('创建成功');
    } else {
      await request.put(`${props.api}/${editingId.value}`, payload);
      ElMessage.success('保存成功');
    }
    dialogVisible.value = false;
    void fetchList();
  } catch (err) {
    // 服务端字段级错误回显到对应表单项（原型 §5.3）
    if (err instanceof BizError && err.details?.length) {
      formDialogRef.value?.applyServerErrors(err.details);
    } else {
      ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败，请重试');
    }
  } finally {
    submitting.value = false;
  }
}

/** 删除（单个 / 批量，二次确认，NFR：危险操作必须确认） */
async function handleDelete(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const label = rows.length === 1 ? `「${rowId(rows[0] as Record<string, unknown>)}」` : `选中 ${rows.length} 项`;
  try {
    await ElMessageBox.confirm(`确认删除${label}？删除后不可恢复`, '危险操作', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  // 后端未提供批量删除端点，逐条删除；任一条失败不中断其余，最后按成功/失败数给出可读结论，
  // 并无论如何刷新列表与清空选择，避免出现「界面还显示已删数据」的假成功
  let succeeded = 0;
  let firstError: unknown = null;
  for (const row of rows) {
    try {
      await request.delete(`${props.api}/${rowId(row)}`);
      succeeded += 1;
    } catch (err) {
      if (firstError === null) firstError = err;
    }
  }
  selectedRows.value = [];
  void fetchList();
  if (firstError === null) {
    ElMessage.success('删除成功');
    return;
  }
  const reason = firstError instanceof BizError ? describeBizError(firstError) : '删除失败，请重试';
  if (succeeded > 0) {
    ElMessage.warning(`已删除 ${succeeded} 项，${rows.length - succeeded} 项失败：${reason}`);
  } else {
    ElMessage.error(reason);
  }
}

/** 批量删除 */
function handleBatchDelete(): void {
  void handleDelete(selectedRows.value);
}

/** 导出（页面实现；这里只透传当前查询条件） */
function handleExport(): void {
  emit('export', { search: { ...search }, sort: sort.value });
}

/** 列设置 */
function toggleColumn(column: CrudColumn): void {
  const next = new Set(hiddenColumns.value);
  if (next.has(column.prop)) next.delete(column.prop);
  else next.add(column.prop);
  hiddenColumns.value = next;
  saveColumnSettings();
}

function resetColumns(): void {
  hiddenColumns.value = new Set(props.columns.filter((c) => c.defaultHidden).map((c) => c.prop));
  saveColumnSettings();
}

/** 查询区折叠：超过 3 个字段时默认收起 */
const collapsedFields = computed<SearchField[]>(() => {
  const fields = props.searchForm ?? [];
  if (fields.length <= 3 || expanded.value) return fields;
  return fields.slice(0, 3);
});

const hasMoreSearch = computed(() => (props.searchForm ?? []).length > 3);

/** 对外暴露：供父页面在关联操作后刷新（如分配角色、启用禁用） */
function refresh(): void {
  void fetchList();
}

defineExpose({ refresh });

onMounted(() => {
  loadColumnSettings();
  loadSearchSettings();
  void fetchList();
});
</script>

<template>
  <div class="fw-crud">
    <!-- 查询区 -->
    <div v-if="searchForm?.length" class="fw-crud-search">
      <el-form :model="search" inline @submit.prevent>
        <el-form-item v-for="field in collapsedFields" :key="field.prop" :label="field.label">
          <el-input v-if="field.type === 'input'" v-model="search[field.prop]" :placeholder="field.placeholder ?? '请输入'" clearable style="width: 180px" />
          <span v-else-if="field.type === 'select' && field.dictCode" class="fw-crud-search-dict">
            <dict-select v-model="search[field.prop]" :dict-code="field.dictCode" />
          </span>
          <el-select v-else-if="field.type === 'select'" v-model="search[field.prop]" clearable placeholder="请选择" style="width: 180px">
            <el-option v-for="option in field.options" :key="String(option.value)" :label="option.label" :value="option.value" />
          </el-select>
          <el-date-picker
            v-else-if="field.type === 'date'"
            v-model="search[field.prop]"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 180px"
          />
          <el-date-picker
            v-else-if="field.type === 'daterange'"
            v-model="search[field.prop]"
            type="daterange"
            range-separator="~"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
          <el-button v-if="hasMoreSearch" link type="primary" @click="expanded = !expanded">
            {{ expanded ? '收起' : '展开' }}
          </el-button>
        </el-form-item>
      </el-form>
    </div>

    <!-- 工具栏 -->
    <div class="fw-crud-toolbar">
      <div class="fw-crud-toolbar-left">
        <el-button v-if="formFields?.length && canCreate()" type="primary" @click="handleCreate">+ 新建</el-button>
        <el-button v-if="selection && canDelete()" type="danger" plain :disabled="selectedRows.length === 0" @click="handleBatchDelete">
          批量删除
        </el-button>
      </div>
      <div class="fw-crud-toolbar-right">
        <slot name="toolbar" />
        <el-dropdown v-if="columns.length > 1" trigger="click">
          <el-button :icon="Setting" link>列设置</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-checkbox
                v-for="column in columns"
                :key="column.prop"
                :model-value="!hiddenColumns.has(column.prop)"
                @change="toggleColumn(column)"
              >
                {{ column.label }}
              </el-checkbox>
              <el-dropdown-item divided @click="resetColumns">恢复默认</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="exportable && canExport()" link @click="handleExport">导出</el-button>
        <el-button :icon="Refresh" link @click="refresh">刷新</el-button>
      </div>
    </div>

    <!-- 错误态（含 traceId 便于报障） -->
    <div v-if="error" class="fw-crud-error">
      <el-result icon="error" title="加载失败" :sub-title="error.message">
        <template #extra>
          <span v-if="error.traceId" class="fw-text-weak">traceId：{{ error.traceId }}</span>
          <el-button type="primary" size="small" @click="refresh">重试</el-button>
        </template>
      </el-result>
    </div>

    <!-- 表格 -->
    <el-table
      v-else
      v-loading="loading"
      :data="list"
      :row-key="rowKey"
      border
      stripe
      style="width: 100%"
      @selection-change="handleSelectionChange"
      @sort-change="handleSortChange"
    >
      <el-table-column v-if="selection" type="selection" width="42" reserve-selection />
      <el-table-column v-if="index" type="index" label="#" width="50" />
      <template v-for="column in visibleColumns" :key="column.prop">
        <el-table-column
          :prop="column.prop"
          :label="column.label"
          :width="column.width"
          :min-width="column.minWidth"
          :align="column.align ?? 'left'"
          :fixed="column.fixed"
          :show-overflow-tooltip="column.showOverflowTooltip ?? true"
          :sortable="column.sortable ? 'custom' : false"
        >
          <template #default="{ row }">
            <slot :name="`cell-${column.slot ?? column.prop}`" :row="row" :column="column">
              {{ row[column.prop] ?? '—' }}
            </slot>
          </template>
        </el-table-column>
      </template>
      <!--
        操作列渲染条件必须包含 actions-extra 插槽：审计日志、只读业务页只挂该插槽（无 formFields
        且无 delete 权限），早期条件会让整列消失、「详情」入口不可达。
      -->
      <el-table-column v-if="actions && (formFields?.length || canDelete() || hasActionsSlot)" label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <div class="fw-table-actions">
            <el-button v-if="formFields?.length && canUpdate()" link type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button v-if="canDelete() && !hideDelete" link type="danger" @click="handleDelete([row])">删除</el-button>
            <slot name="actions-extra" :row="row" />
          </div>
        </template>
      </el-table-column>
      <!-- 空态 -->
      <template #empty>
        <div class="fw-crud-empty">
          <el-empty description="暂无数据">
            <el-button v-if="formFields?.length && canCreate()" type="primary" size="small" @click="handleCreate">立即新建</el-button>
          </el-empty>
        </div>
      </template>
    </el-table>

    <!-- 分页 -->
    <div v-if="pagination" class="fw-crud-pagination">
      <span class="fw-text-weak">共 {{ total }} 条</span>
      <el-pagination
        :current-page="page"
        :page-size="size"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="sizes, prev, pager, next, jumper"
        background
        @current-change="handlePageChange"
        @size-change="handleSizeChange"
      />
    </div>

    <!-- 内置表单弹窗 -->
    <FormDialog
      v-if="formFields?.length"
      ref="formDialogRef"
      :visible="dialogVisible"
      :title="dialogTitle"
      :fields="formFields"
      :model="formModel"
      :mode="dialogMode"
      :submitting="submitting"
      :width="dialogWidth"
      @update:visible="(value: boolean) => (dialogVisible = value)"
      @submit="handleSubmit"
    />
  </div>
</template>

<style scoped>
.fw-crud-search {
  background: var(--fw-surface);
  border: 1px solid var(--fw-border);
  border-radius: 8px;
  padding: 12px 16px 0;
  margin-bottom: 16px;
}

.fw-crud-search-dict {
  display: inline-block;
  width: 180px;
}

.fw-crud-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.fw-crud-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fw-crud-error {
  padding: 24px 0;
}

.fw-crud-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  margin-top: 12px;
}

.fw-crud :deep(.el-table) {
  background: var(--fw-surface);
}
</style>
