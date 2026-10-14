<!--
 * @file 个人中心
 * @description 三个页签（PRD-005 FR-03）：基本资料（昵称 / 手机 / 邮箱）、
 *   修改密码（POST /auth/change-password，成功后其它设备下线需重新登录）、登录设备（会话查看与下线）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复自服务链路：资料读写改走 GET/PUT /auth/profile（需 auth:me），
 *   不再借 GET/PUT /users/:id（需 user:read / user:update）——普通角色此前回显为空、保存必 3002；
 *   另给「下线」按钮补 v-permission="'auth:revoke-session'"（普通角色无此权限，此前可点到并吃 3002）
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance } from 'element-plus';
import { useUserStore } from '@/store/user';
import { BizError, describeBizError } from '@/utils/biz-error';

const router = useRouter();
const user = useUserStore();
const activeTab = ref('profile');

/** 基本资料 */
const profileFormRef = ref<FormInstance>();
const profileForm = reactive({ nickname: '', phone: '', email: '' });
const profileSaving = ref(false);

/** 改密 */
const passwordFormRef = ref<FormInstance>();
const passwordForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
const passwordSaving = ref(false);

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 8, message: '新密码长度至少 8 位', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (value !== passwordForm.newPassword) callback(new Error('两次输入的密码不一致'));
        else callback();
      },
      trigger: 'blur',
    },
  ],
};

onMounted(async () => {
  if (user.profile) {
    profileForm.nickname = user.profile.nickname ?? '';
  }
  // 手机 / 邮箱以本人资料端点为准（/auth/me 不含这两个字段；该端点只需 auth:me，无需 user:read）
  try {
    const detail = await user.fetchProfile();
    profileForm.phone = detail.phone ?? '';
    profileForm.email = detail.email ?? '';
  } catch {
    // 回显失败不阻塞页面
  }
  void user.loadSessions();
});

/** 保存资料 */
async function saveProfile(): Promise<void> {
  if (!profileFormRef.value) return;
  try {
    await profileFormRef.value.validate();
  } catch {
    return;
  }
  profileSaving.value = true;
  try {
    await user.updateProfile({
      nickname: profileForm.nickname,
      phone: profileForm.phone,
      email: profileForm.email,
    });
    ElMessage.success('资料已保存');
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '保存失败');
  } finally {
    profileSaving.value = false;
  }
}

/** 改密：成功后本地令牌被吊销，跳登录 */
async function savePassword(): Promise<void> {
  if (!passwordFormRef.value) return;
  try {
    await passwordFormRef.value.validate();
  } catch {
    return;
  }
  passwordSaving.value = true;
  try {
    await user.changePassword(passwordForm.oldPassword, passwordForm.newPassword);
    ElMessage.success('密码已修改，请重新登录');
    await router.push('/login');
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '修改失败');
  } finally {
    passwordSaving.value = false;
  }
}

/** 下线设备 */
async function revoke(sessionId: string): Promise<void> {
  try {
    await user.revokeSession(sessionId);
    ElMessage.success('已下线该设备');
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '操作失败');
  }
}

/** 时间格式化（本地时区，原型 §5.5） */
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="fw-page">
    <div class="fw-card">
      <el-tabs v-model="activeTab">
        <!-- 基本资料 -->
        <el-tab-pane label="基本资料" name="profile">
          <el-form ref="profileFormRef" :model="profileForm" label-width="80px" style="max-width: 420px">
            <el-form-item label="账号">
              <el-input :model-value="user.profile?.username" disabled />
            </el-form-item>
            <el-form-item label="昵称">
              <el-input v-model="profileForm.nickname" maxlength="32" />
            </el-form-item>
            <el-form-item label="手机">
              <el-input v-model="profileForm.phone" maxlength="20" placeholder="选填" />
            </el-form-item>
            <el-form-item label="邮箱">
              <el-input v-model="profileForm.email" maxlength="64" placeholder="选填" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="profileSaving" @click="saveProfile">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 修改密码 -->
        <el-tab-pane label="修改密码" name="password">
          <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-width="96px" style="max-width: 420px">
            <el-form-item label="原密码" prop="oldPassword">
              <el-input v-model="passwordForm.oldPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
              <el-input v-model="passwordForm.newPassword" type="password" show-password placeholder="至少 8 位" />
            </el-form-item>
            <el-form-item label="确认新密码" prop="confirmPassword">
              <el-input v-model="passwordForm.confirmPassword" type="password" show-password />
            </el-form-item>
            <el-form-item>
              <el-alert type="warning" :closable="false" show-icon title="修改成功后，其它设备的登录状态将全部失效" style="margin-bottom: 12px" />
              <el-button type="primary" :loading="passwordSaving" @click="savePassword">确认修改</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 登录设备 -->
        <el-tab-pane label="登录设备" name="sessions">
          <el-table :data="user.sessions" border stripe>
            <el-table-column prop="device" label="设备" min-width="140" />
            <el-table-column prop="ip" label="IP" width="140" />
            <el-table-column label="最近活跃" width="200">
              <template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.current" type="success" size="small">当前设备</el-tag>
                <span v-else class="fw-text-weak">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" align="center">
              <template #default="{ row }">
                <el-button v-if="!row.current" v-permission="'auth:revoke-session'" link type="danger" @click="revoke(row.id)">下线</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>
