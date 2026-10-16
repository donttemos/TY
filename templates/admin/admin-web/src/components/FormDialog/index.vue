<!--
 * @file 表单弹窗
 * @description 统一新增 / 编辑弹窗（原型 §5.3 / §6）：按 FormField 配置渲染控件，
 *   前端规则校验 + 服务端 1001 字段级错误回显；保存中禁用防重复提交；
 *   字段 > 8 个建议改用抽屉（由 width/drawer  prop 控制）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 下拉支持 multiple（roleIds 等数组字段必须多选，否则回显为空、提交成字符串）
 * @modified 2026-10-16 donttemo PRD-010 E-09 新增 upload 控件分支（附件字段 *FileId，FileUpload 组件）
 * @module __APP_NAME__-web/components
-->

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormItemRule } from 'element-plus';
import DictSelect from '@/components/DictSelect/index.vue';
import FileUpload from '@/components/FileUpload/index.vue';
import type { FormField, FormModel } from '@/components/CrudTable/types';

const props = defineProps<{
  /** 是否打开 */
  visible: boolean;
  /** 标题 */
  title: string;
  /** 字段配置 */
  fields: FormField[];
  /** 表单数据（受控：由父组件维护） */
  model: FormModel;
  /** 提交中（禁用底部按钮） */
  submitting?: boolean;
  /** 模式：新建 / 编辑（影响 disabledOnEdit、hiddenOnEdit） */
  mode?: 'create' | 'edit';
  /** 宽度 */
  width?: string | number;
}>();

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'submit', model: FormModel): void;
}>();

const formRef = ref<FormInstance>();

/** 当前模式可见字段 */
const visibleFields = computed(() =>
  props.fields.filter((field) => {
    if (props.mode === 'edit' && field.hiddenOnEdit) return false;
    if (props.mode === 'create' && field.hiddenOnCreate) return false;
    return true;
  }),
);

/** 汇总校验规则（字段级 rules 与 required 提示） */
const rules = computed<Record<string, FormItemRule[]>>(() => {
  const result: Record<string, FormItemRule[]> = {};
  for (const field of visibleFields.value) {
    if (field.rules?.length) result[field.prop] = field.rules;
  }
  return result;
});

/** 服务端字段级错误（1001 details 回显） */
const serverErrors = reactive<Record<string, string>>({});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      // 打开时清空残留的服务端错误
      for (const key of Object.keys(serverErrors)) delete serverErrors[key];
      formRef.value?.clearValidate();
    }
  },
);

/** 暴露给父组件：渲染服务端字段错误 */
function applyServerErrors(errors: { field: string; message: string }[]): void {
  for (const key of Object.keys(serverErrors)) delete serverErrors[key];
  for (const error of errors) serverErrors[error.field] = error.message;
}

/** 校验并提交 */
async function handleSubmit(): Promise<void> {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  emit('submit', props.model);
}

function close(): void {
  emit('update:visible', false);
}

defineExpose({ applyServerErrors });
</script>

<template>
  <el-dialog :model-value="visible" :title="title" :width="width ?? 520" @close="close">
    <el-form ref="formRef" :model="model" :rules="rules" label-width="96px">
      <el-row :gutter="16">
        <el-col v-for="field in visibleFields" :key="field.prop" :span="field.span ?? 12">
          <el-form-item :label="field.label" :prop="field.prop" :error="serverErrors[field.prop]">
            <!-- 文本 -->
            <el-input
              v-if="field.type === 'input'"
              v-model="model[field.prop]"
              :placeholder="field.placeholder ?? `请输入${field.label}`"
              :disabled="mode === 'edit' && field.disabledOnEdit"
            />
            <!-- 多行文本 -->
            <el-input
              v-else-if="field.type === 'textarea'"
              v-model="model[field.prop]"
              type="textarea"
              :rows="3"
              :placeholder="field.placeholder ?? `请输入${field.label}`"
            />
            <!-- 数字 -->
            <el-input-number
              v-else-if="field.type === 'number'"
              v-model="model[field.prop]"
              :controls-position="'right'"
              style="width: 100%"
            />
            <!-- 密码 -->
            <el-input
              v-else-if="field.type === 'password'"
              v-model="model[field.prop]"
              type="password"
              show-password
              :placeholder="field.placeholder ?? `请输入${field.label}`"
            />
            <!-- 下拉（multiple 时值为数组，用于关联字段如 roleIds） -->
            <el-select
              v-else-if="field.type === 'select'"
              v-model="model[field.prop]"
              :multiple="field.multiple"
              :placeholder="field.placeholder ?? '请选择'"
              clearable
              style="width: 100%"
            >
              <el-option v-for="option in field.options" :key="String(option.value)" :label="option.label" :value="option.value" />
            </el-select>
            <!-- 字典下拉 -->
            <dict-select
              v-else-if="field.type === 'dict-select'"
              v-model="model[field.prop]"
              :dict-code="field.dictCode ?? ''"
            />
            <!-- 附件（PRD-010 E-09：上传走 /api/v1/files，文件 id 写回表单模型） -->
            <file-upload
              v-else-if="field.type === 'upload'"
              :model-value="(model[field.prop] as string) ?? ''"
              :disabled="mode === 'edit' && field.disabledOnEdit"
              @update:model-value="(value: string) => (model[field.prop] = value)"
            />
            <!-- 单选组 -->
            <el-radio-group v-else-if="field.type === 'radio'" v-model="model[field.prop]">
              <el-radio v-for="option in field.options" :key="String(option.value)" :value="option.value">{{ option.label }}</el-radio>
            </el-radio-group>
            <!-- 开关 -->
            <el-switch v-else-if="field.type === 'switch'" v-model="model[field.prop]" />
            <!-- 日期 -->
            <el-date-picker
              v-else-if="field.type === 'date'"
              v-model="model[field.prop]"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="选择日期"
              style="width: 100%"
            />
            <!-- 日期时间（提交转 UTC ISO 8601，原型 §5.3） -->
            <el-date-picker
              v-else-if="field.type === 'datetime'"
              v-model="model[field.prop]"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ss.sssZ"
              placeholder="选择时间"
              style="width: 100%"
            />
            <!-- 回退：文本 -->
            <el-input v-else v-model="model[field.prop]" :placeholder="field.placeholder ?? `请输入${field.label}`" />
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
    </template>
  </el-dialog>
</template>
