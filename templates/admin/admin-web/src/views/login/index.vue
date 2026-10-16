<!--
 * @file 登录页
 * @description 账号密码登录（原型 §5.1）：验证码钩子（VITE_LOGIN_CAPTCHA 控制，默认关闭）、记住我、
 *   错误码分级提示（3001 凭证错误 / 3004 账号锁定 / 9003 限流倒计时）、登录后回跳 redirect 原路径。
 *   E-07：OAuth2 授权码登录——按后端已注册提供方渲染入口（空列表不渲染，mock/未配置即无感）；
 *   回调经 URL fragment 携带令牌返回本页，解析后落地登录态并立即清除 hash。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-07：OAuth2 授权码入口 + 回调接管（providers 列表驱动，
 *   拉取失败按空处理不阻塞密码登录；回调解析抽 utils/oauth2.ts 供单测）
 * @module __APP_NAME__-web/views
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance } from 'element-plus';
import { Lock, User } from '@element-plus/icons-vue';
import { useUserStore } from '@/store/user';
import { BIZ_CODE, BizError, describeBizError } from '@/utils/biz-error';
import { fetchOAuth2Providers } from '@/api/auth';
import { API_BASE } from '@/utils/request';
import { buildOAuth2AuthorizeUrl, parseOAuth2CallbackHash } from '@/utils/oauth2';

const route = useRoute();
const router = useRouter();
const user = useUserStore();

const formRef = ref<FormInstance>();
const loading = ref(false);
const remember = ref(true);

const form = ref({ account: '', password: '', captcha: '' });

/** OAuth2 已注册提供方（空 = 未启用，不渲染入口；拉取失败按空处理） */
const oauthProviders = ref<string[]>([]);

/** 跳转 IdP 授权（整页跳转，回调带 fragment 回到本页） */
function startOAuth2(provider: string): void {
  const loginUrl = `${window.location.origin}/login`;
  window.location.href = buildOAuth2AuthorizeUrl(API_BASE, provider, loginUrl);
}

/** OAuth2 回调接管：fragment 带令牌 → 落地登录态 → 清 hash → 回跳 */
async function consumeOAuth2Callback(): Promise<boolean> {
  const tokens = parseOAuth2CallbackHash(window.location.hash);
  if (!tokens) return false;
  // 立即清除地址栏 hash，防令牌留在历史记录与复制分享的 URL 里
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    await user.loginWithTokens(tokens.accessToken, tokens.refreshToken, remember.value);
    ElMessage.success('登录成功');
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.push(redirect);
    return true;
  } catch {
    ElMessage.error('OAuth2 登录失败：令牌无效或已过期');
    return false;
  }
}

onMounted(async () => {
  if (await consumeOAuth2Callback()) return;
  try {
    oauthProviders.value = (await fetchOAuth2Providers()).providers ?? [];
  } catch {
    oauthProviders.value = [];
  }
});

/** 验证码钩子：VITE_LOGIN_CAPTCHA=true 时显示（PRD-005 待定问题：默认关闭） */
const captchaEnabled = computed(() => import.meta.env.VITE_LOGIN_CAPTCHA === 'true');
const captchaText = ref('');
const captchaCanvas = ref<HTMLCanvasElement>();

/** 生成 4 位图形验证码（钩子演示；生产可替换为后端 /auth/captcha） */
function refreshCaptcha(): void {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  captchaText.value = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const canvas = captchaCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f0f2f5';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 22px serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < 4; i += 1) {
    ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)}, 60%, 40%)`;
    ctx.fillText(captchaText.value[i] as string, 16 + i * 22, 26 + (Math.random() * 4 - 2));
  }
}

/** 限流倒计时（9003，按 Retry-After 退避，原型 §7） */
const cooldown = ref(0);
let timer: number | undefined;

function startCooldown(seconds: number): void {
  cooldown.value = seconds;
  timer = window.setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0 && timer) window.clearInterval(timer);
  }, 1000);
}

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});

const rules = {
  account: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captcha: [{ required: true, message: '请输入验证码', trigger: 'blur' }],
};

/** 提交登录 */
async function handleLogin(): Promise<void> {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  if (captchaEnabled.value && form.value.captcha.toUpperCase() !== captchaText.value) {
    ElMessage.error('验证码不正确');
    refreshCaptcha();
    return;
  }
  loading.value = true;
  try {
    await user.login(form.value.account, form.value.password, remember.value);
    ElMessage.success('登录成功');
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.push(redirect);
  } catch (err) {
    if (err instanceof BizError) {
      if (err.code === BIZ_CODE.RATE_LIMITED) {
        startCooldown(30);
        ElMessage.error(describeBizError(err));
      } else {
        ElMessage.error(describeBizError(err));
      }
      refreshCaptcha();
    } else {
      ElMessage.error('登录失败，请稍后重试');
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="fw-login">
    <div class="fw-login-panel">
      <div class="fw-login-brand">
        <span class="fw-login-logo">FW</span>
        <h1 class="fw-login-title">通用应用框架</h1>
        <p class="fw-login-subtitle">管理后台（PRD-005 模板）</p>
      </div>
      <el-form ref="formRef" :model="form" :rules="rules" size="large" @submit.prevent="handleLogin">
        <el-form-item prop="account">
          <el-input v-model="form.account" placeholder="账号" :prefix-icon="User" autocomplete="username" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            :prefix-icon="Lock"
            show-password
            autocomplete="current-password"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item v-if="captchaEnabled" prop="captcha">
          <div class="fw-login-captcha">
            <el-input v-model="form.captcha" placeholder="验证码" maxlength="4" style="flex: 1" />
            <canvas ref="captchaCanvas" width="96" height="36" title="点击刷新" @click="refreshCaptcha" />
          </div>
        </el-form-item>
        <div class="fw-login-options">
          <el-checkbox v-model="remember">记住我</el-checkbox>
          <el-link type="primary" :underline="false" @click="ElMessage.info('请联系管理员重置密码')">忘记密码？</el-link>
        </div>
        <el-button type="primary" size="large" class="fw-login-submit" :loading="loading" :disabled="cooldown > 0" @click="handleLogin">
          {{ cooldown > 0 ? `请稍候（${cooldown}s）` : '登 录' }}
        </el-button>
        <template v-if="oauthProviders.length > 0">
          <el-divider class="fw-login-divider">或</el-divider>
          <el-button
            v-for="provider in oauthProviders"
            :key="provider"
            size="large"
            class="fw-login-oauth2"
            @click="startOAuth2(provider)"
          >
            OAuth2 登录（{{ provider }}）
          </el-button>
        </template>
      </el-form>
    </div>
  </div>
</template>

<style scoped>
.fw-login {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--el-color-primary-light-9), var(--fw-bg));
}

.fw-login-panel {
  width: 380px;
  padding: 32px;
  background: var(--fw-surface);
  border-radius: 8px;
  box-shadow: var(--fw-card-shadow);
}

.fw-login-brand {
  text-align: center;
  margin-bottom: 24px;
}

.fw-login-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  font-weight: 700;
}

.fw-login-title {
  margin: 12px 0 4px;
  font-size: 20px;
}

.fw-login-subtitle {
  margin: 0;
  color: var(--fw-text-3);
  font-size: 12px;
}

.fw-login-captcha {
  display: flex;
  gap: 8px;
  width: 100%;
}

.fw-login-captcha canvas {
  border-radius: 4px;
  cursor: pointer;
}

.fw-login-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.fw-login-submit {
  width: 100%;
}

.fw-login-divider {
  margin: 16px 0;
}

.fw-login-oauth2 {
  width: 100%;
  margin: 0 0 4px;
}
</style>
