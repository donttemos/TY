<!--
 * @file 订阅管理页（M13，PRD-013 §2.3）
 * @description 按租户查询生效订阅、开通（一租户一生效，重复 → 409/1003）、取消（幂等）。
 *   权限 ops:saas:read / ops:saas:write（写操作按钮按权限码渲染由 RBAC 指令/后端守卫兜底）。
 * @author donttemo
 * @created 2026-10-19
 * @module admin-web/views
-->

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { SubscriptionView } from '@/api/types';
import { BizError, describeBizError } from '@/utils/biz-error';

const loading = ref(false);
const tenantId = ref('');
const subscription = ref<SubscriptionView | null>(null);
const createForm = reactive({ tenantId: '', planCode: 'default', planVersion: undefined as number | undefined, expireAt: '' });

async function query(): Promise<void> {
  if (!tenantId.value) {
    ElMessage.warning('请输入租户 ID');
    return;
  }
  loading.value = true;
  try {
    subscription.value = await saasApi.fetchTenantSubscription(tenantId.value);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

async function onCreate(): Promise<void> {
  if (!createForm.tenantId || !createForm.planCode) {
    ElMessage.warning('租户 ID 与套餐编码必填');
    return;
  }
  try {
    await ElMessageBox.confirm(`为租户 ${createForm.tenantId} 开通「${createForm.planCode}」订阅？`, '开通订阅', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await saasApi.createSubscription({
      tenantId: createForm.tenantId,
      planCode: createForm.planCode,
      planVersion: createForm.planVersion,
      expireAt: createForm.expireAt || undefined,
    });
    ElMessage.success('订阅已开通（版本快照已生成）');
    tenantId.value = createForm.tenantId;
    await query();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  }
}

async function onCancel(): Promise<void> {
  if (!subscription.value) return;
  try {
    await ElMessageBox.prompt('输入取消原因（留空亦可）', '取消订阅', { type: 'warning', inputValue: '' });
  } catch {
    return;
  }
  try {
    await saasApi.cancelSubscription(subscription.value.id);
    ElMessage.success('订阅已取消');
    await query();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  }
}
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="query-card">
      <template #header><span>查询生效订阅</span></template>
      <el-form inline @submit.prevent="query">
        <el-form-item label="租户 ID">
          <el-input v-model="tenantId" placeholder="tenants.id" clearable style="width: 260px" @keyup.enter="query" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="query">查询</el-button>
        </el-form-item>
      </el-form>

      <el-descriptions v-if="subscription" :column="2" border>
        <el-descriptions-item label="订阅 ID">{{ subscription.id }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="subscription.status === 'active' ? 'success' : 'info'">{{ subscription.status }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="生效时间">{{ subscription.effectiveAt }}</el-descriptions-item>
        <el-descriptions-item label="到期时间">{{ subscription.expireAt ?? '无期限' }}</el-descriptions-item>
        <el-descriptions-item label="关闭时间">{{ subscription.closedAt ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="操作">
          <el-button v-if="subscription.status === 'active'" size="small" type="danger" plain @click="onCancel">取消订阅</el-button>
        </el-descriptions-item>
      </el-descriptions>
      <el-empty v-else-if="tenantId" description="无生效订阅" :image-size="60" />
    </el-card>

    <el-card shadow="never" class="create-card">
      <template #header><span>开通订阅</span></template>
      <el-form inline>
        <el-form-item label="租户 ID">
          <el-input v-model="createForm.tenantId" placeholder="tenants.id" style="width: 220px" />
        </el-form-item>
        <el-form-item label="套餐编码">
          <el-input v-model="createForm.planCode" placeholder="default" style="width: 160px" />
        </el-form-item>
        <el-form-item label="绑定版本">
          <el-input-number v-model="createForm.planVersion" :min="1" placeholder="最新" style="width: 120px" />
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker v-model="createForm.expireAt" type="date" value-format="YYYY-MM-DD" placeholder="可留空（无期限）" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="onCreate">开通</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.query-card {
  margin-bottom: 16px;
}
</style>
