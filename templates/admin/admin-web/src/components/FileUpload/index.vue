<!--
 * @file 附件上传控件
 * @description PRD-010 E-09：CrudTable FormField type=upload 与 fw gen crud 附件字段（*FileId）共用的
 *   标准上传控件。el-upload 自定义 http-request 走 /api/v1/files（multipart），成功后把文件 id
 *   写回表单模型（v-model）；已选附件展示「查看 / 移除」，下载走带会话鉴权的 /files/:id/download。
 *   类型 / 大小白名单由服务端 @fw/storage 把关（默认收紧），前端不重复实现规则。
 * @author donttemo
 * @created 2026-10-16
 * @module __APP_NAME__-web/components
-->

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadRequestOptions } from 'element-plus';
import { fileDownloadUrl, uploadFile } from '@/api/files';

const props = defineProps<{
  /** 附件字段值（文件 id；空串/undefined = 未上传） */
  modelValue?: string | null;
  /** 禁用（编辑态锁定等） */
  disabled?: boolean;
  /** 上传按钮文案 */
  text?: string;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const uploading = ref(false);

/** 已选附件的下载地址 */
const fileUrl = computed(() => (props.modelValue ? fileDownloadUrl(props.modelValue) : ''));

/** 自定义上传：成功即回写文件 id（业务表单存 id，下载面按 id 现取） */
async function handleRequest(options: UploadRequestOptions): Promise<void> {
  uploading.value = true;
  try {
    const uploaded = await uploadFile(options.file);
    emit('update:modelValue', uploaded.id);
    ElMessage.success(`已上传：${uploaded.originalName}`);
  } finally {
    uploading.value = false;
  }
}

/** 移除附件（只清表单值；服务端文件保留——元数据删除属管理面，另行按权限操作） */
function handleRemove(): void {
  emit('update:modelValue', '');
}
</script>

<template>
  <div class="fw-file-upload">
    <el-upload :show-file-list="false" :http-request="handleRequest" :disabled="uploading || disabled">
      <el-button :loading="uploading" :disabled="disabled">{{ text ?? '选择文件' }}</el-button>
    </el-upload>
    <a v-if="modelValue" class="fw-file-upload-link" :href="fileUrl" target="_blank" rel="noopener">查看附件</a>
    <el-button v-if="modelValue && !disabled" link type="danger" @click="handleRemove">移除</el-button>
  </div>
</template>

<style scoped>
.fw-file-upload {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.fw-file-upload-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
</style>
