<!--
 * @file 字典管理页
 * @description PRD-005 FR-07：左侧分类列表 + 右侧字典项维护（CrudTable）；useDict 全局消费，
 *   维护后主动失效字典缓存，页面即时刷新。字典项颜色供 StatusTag 使用。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import * as dictApi from '@/api/dict';
import { useDictStore } from '@/store/dict';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, FormField } from '@/components/CrudTable/types';
import type { DictCategory, DictItem } from '@/api/types';

const dictStore = useDictStore();

const categories = ref<DictCategory[]>([]);
const activeCategory = ref<string>('');

const currentCategory = computed(() => categories.value.find((c) => c.id === activeCategory.value) ?? null);

const itemColumns: CrudColumn[] = [
  { prop: 'label', label: '标签', minWidth: 140 },
  { prop: 'value', label: '值', minWidth: 120 },
  { prop: 'color', label: '颜色', width: 110, align: 'center', slot: 'color' },
  { prop: 'sort', label: '排序', width: 80, align: 'center' },
];

const itemFormFields: FormField[] = [
  { prop: 'label', label: '标签', type: 'input', rules: [{ required: true, message: '请输入标签', trigger: 'blur' }] },
  { prop: 'value', label: '值', type: 'input', rules: [{ required: true, message: '请输入值', trigger: 'blur' }] },
  {
    prop: 'color',
    label: '颜色',
    type: 'select',
    span: 12,
    options: [
      { label: '主色', value: 'primary' },
      { label: '成功', value: 'success' },
      { label: '警告', value: 'warning' },
      { label: '危险', value: 'danger' },
      { label: '信息', value: 'info' },
    ],
  },
  { prop: 'sort', label: '排序', type: 'number', span: 12 },
];

const crudRef = ref<InstanceType<typeof CrudTable>>();

async function loadCategories(): Promise<void> {
  try {
    categories.value = await dictApi.fetchDictCategories();
    if (categories.value.length > 0 && !categories.value.some((c) => c.id === activeCategory.value)) {
      activeCategory.value = categories.value[0]?.id ?? '';
    }
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '分类加载失败');
  }
}

onMounted(loadCategories);

/** 切换分类：失效缓存并刷新字典项列表 */
function handleSelect(categoryId: string): void {
  activeCategory.value = categoryId;
  crudRef.value?.refresh();
}

/** ---------- 分类维护 ---------- */
const categoryDialog = ref(false);
const categorySaving = ref(false);
const editingCategory = ref<DictCategory | null>(null);
const categoryForm = reactive({ code: '', name: '', remark: '' });

function openCreateCategory(): void {
  editingCategory.value = null;
  Object.assign(categoryForm, { code: '', name: '', remark: '' });
  categoryDialog.value = true;
}

function openEditCategory(category: DictCategory): void {
  editingCategory.value = category;
  Object.assign(categoryForm, { code: category.code, name: category.name, remark: category.remark ?? '' });
  categoryDialog.value = true;
}

async function submitCategory(): Promise<void> {
  if (!categoryForm.name.trim()) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  categorySaving.value = true;
  try {
    if (editingCategory.value) {
      await dictApi.updateDictCategory(editingCategory.value.id, { name: categoryForm.name, remark: categoryForm.remark });
      ElMessage.success('分类已更新');
    } else {
      if (!categoryForm.code.trim()) {
        ElMessage.warning('请输入分类编码');
        categorySaving.value = false;
        return;
      }
      await dictApi.createDictCategory({ code: categoryForm.code, name: categoryForm.name, remark: categoryForm.remark });
      ElMessage.success('分类已创建');
    }
    categoryDialog.value = false;
    await loadCategories();
    dictStore.invalidate();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败');
  } finally {
    categorySaving.value = false;
  }
}

async function handleDeleteCategory(category: DictCategory): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除分类「${category.name}」？其下字典项将一并删除。`, '危险操作', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await dictApi.deleteDictCategory(category.id);
    ElMessage.success('已删除');
    if (activeCategory.value === category.id) activeCategory.value = '';
    await loadCategories();
    dictStore.invalidate();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '删除失败');
  }
}

/** ---------- 字典项 ---------- */
const crudRef = ref<InstanceType<typeof CrudTable>>();

/** 固定查询条件：当前分类（不在查询区展示） */
const itemFilters = computed(() => ({ category_id: activeCategory.value }));

function handleItemSaved(): void {
  // 维护后失效字典缓存（useDict 消费方下次加载即取新值）
  if (currentCategory.value) dictStore.invalidate(currentCategory.value.code);
}
</script>

<template>
  <div class="fw-page fw-dict-layout">
    <!-- 分类列表 -->
    <div class="fw-card fw-dict-side">
      <div class="fw-flex-between" style="margin-bottom: 12px">
        <span class="fw-text-secondary">字典分类</span>
        <el-button link type="primary" @click="openCreateCategory">+ 新建</el-button>
      </div>
      <ul class="fw-dict-categories">
        <li
          v-for="category in categories"
          :key="category.id"
          class="fw-dict-category"
          :class="{ active: category.id === activeCategory }"
          @click="handleSelect(category.id)"
        >
          <span class="fw-dict-category-name">{{ category.name }}</span>
          <span class="fw-dict-category-code">{{ category.code }}</span>
          <span class="fw-dict-category-actions" @click.stop>
            <el-button link type="primary" size="small" @click="openEditCategory(category)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDeleteCategory(category)">删除</el-button>
          </span>
        </li>
      </ul>
    </div>

    <!-- 字典项 -->
    <div class="fw-dict-main">
      <template v-if="currentCategory">
        <h3 class="fw-dict-title">{{ currentCategory.name }}（{{ currentCategory.code }}）</h3>
        <CrudTable
          ref="crudRef"
          api="/dict/items"
          :columns="itemColumns"
          :form-fields="itemFormFields"
          :filters="itemFilters"
          :form-defaults="{ categoryId: activeCategory }"
          permission="dict"
          :pagination="false"
          create-title="新建字典项"
          @refresh="handleItemSaved"
        >
          <template #cell-color="{ row }">
            <el-tag :type="(row.color as 'primary') ?? 'info'" size="small">{{ row.color ?? '默认' }}</el-tag>
          </template>
        </CrudTable>
      </template>
      <el-empty v-else description="请选择或新建字典分类" />
    </div>

    <!-- 分类弹窗 -->
    <el-dialog v-model="categoryDialog" :title="editingCategory ? '编辑分类' : '新建分类'" width="420px">
      <el-form :model="categoryForm" label-width="88px">
        <el-form-item label="编码" required>
          <el-input v-model="categoryForm.code" :disabled="Boolean(editingCategory)" placeholder="user_status" maxlength="64" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="categoryForm.name" maxlength="32" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="categoryForm.remark" type="textarea" :rows="2" maxlength="128" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="categoryDialog = false">取消</el-button>
        <el-button type="primary" :loading="categorySaving" @click="submitCategory">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fw-dict-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  align-items: start;
}

.fw-dict-side {
  padding: 12px;
}

.fw-dict-categories {
  list-style: none;
  margin: 0;
  padding: 0;
}

.fw-dict-category {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}

.fw-dict-category:hover {
  background: var(--fw-bg);
}

.fw-dict-category.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.fw-dict-category-name {
  font-weight: 500;
}

.fw-dict-category-code {
  flex: 1;
  font-size: 12px;
  color: var(--fw-text-3);
}

.fw-dict-category-actions {
  display: none;
}

.fw-dict-category:hover .fw-dict-category-actions {
  display: inline-flex;
}

.fw-dict-title {
  margin: 0 0 12px;
  font-size: 16px;
}
</style>
