<!--
 * @file 订单列表（演示页：验证「新业务列表页 ≤ 80 行」）
 * @description 只用 <CrudTable> + 一段配置完成完整列表页（PRD-005 AC / 原型 §5.2 配置示例）；
 *   订单退款按钮演示按钮级权限 v-permission="'order:refund'"（alice 无此权限，按钮不渲染）。
 *   生成器（M6）产出的业务页面形态与本页一致。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/views
-->

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import StatusTag from '@/components/StatusTag/index.vue';
import type { CrudColumn, FormField, SearchField } from '@/components/CrudTable/types';

const columns: CrudColumn[] = [
  { prop: 'orderNo', label: '订单号', minWidth: 180 },
  { prop: 'customer', label: '客户', width: 100 },
  { prop: 'amount', label: '金额（元）', width: 120, align: 'right' },
  { prop: 'channel', label: '渠道', width: 100, align: 'center', slot: 'channel' },
  { prop: 'status', label: '状态', width: 90, align: 'center', slot: 'status' },
  { prop: 'createdAt', label: '创建时间', width: 180 },
];

const searchForm: SearchField[] = [
  { prop: 'keyword', label: '关键字', type: 'input', placeholder: '订单号 / 客户' },
  { prop: 'status', label: '状态', type: 'select', dictCode: 'user_status' },
  { prop: 'channel', label: '渠道', type: 'select', dictCode: 'order_channel' },
];

const formFields: FormField[] = [
  { prop: 'orderNo', label: '订单号', type: 'input', rules: [{ required: true, message: '请输入订单号', trigger: 'blur' }] },
  { prop: 'customer', label: '客户', type: 'input', rules: [{ required: true, message: '请输入客户', trigger: 'blur' }] },
  { prop: 'amount', label: '金额', type: 'input', rules: [{ required: true, message: '请输入金额', trigger: 'blur' }] },
  { prop: 'channel', label: '渠道', type: 'dict-select', dictCode: 'order_channel' },
  { prop: 'status', label: '状态', type: 'dict-select', dictCode: 'user_status' },
];
</script>

<template>
  <div class="fw-page">
    <CrudTable
      api="/orders"
      :columns="columns"
      :search-form="searchForm"
      :form-fields="formFields"
      permission="order"
      create-title="新建订单"
      selection
    >
      <template #cell-channel="{ row }">
        <status-tag :value="row.channel" dict-code="order_channel" />
      </template>
      <template #cell-status="{ row }">
        <status-tag :value="row.status" dict-code="user_status" />
      </template>
      <template #actions-extra="{ row }">
        <el-button v-permission="'order:refund'" link type="warning" @click="ElMessage.info(`演示：订单 ${row.orderNo} 退款申请已提交`)">
          退款
        </el-button>
      </template>
    </CrudTable>
  </div>
</template>
