/*
 * @file 统一请求层（PRD-005 FR-10）
 * @description axios 封装：请求拦截注入 Bearer token 与 X-Trace-Id（透传上游链路）；响应拦截解包统一信封，
 *   错误码转 BizError；3001/3003 触发无感刷新（并发请求共用同一刷新 Promise，刷新成功自动重放原请求），
 *   刷新失败清令牌并跳登录；9003 读取 Retry-After 供页面倒计时。业务代码只面对解包后的 data。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/utils
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { BIZ_CODE, BizError, describeBizError, toBizError, type FieldError } from './biz-error';
import { tokenStore } from './token';

/** 刷新进行中的 Promise（并发 401 共用，避免多次刷新互相轮换） */
let refreshing: Promise<string> | null = null;

/** 跳登录（带 redirect，登录后回跳原路径） */
function redirectToLogin(): void {
  tokenStore.clear();
  const current = `${window.location.pathname}${window.location.search}`;
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign(`/login?redirect=${encodeURIComponent(current)}`);
  }
}

/** 生成链路 ID（服务端缺省时由前端生成，随请求透传） */
function ensureTraceId(config: InternalAxiosRequestConfig): string {
  const existing = config.headers['X-Trace-Id'];
  if (typeof existing === 'string' && existing) return existing;
  const generated = `web-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
  config.headers['X-Trace-Id'] = generated;
  return generated;
}

/** 执行刷新：双 token 轮换；失败即 rejected（调用方走跳登录） */
function doRefresh(): Promise<string> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) return Promise.reject(new BizError(BIZ_CODE.UNAUTHORIZED, '未登录'));
  // 用裸 axios 发刷新请求，避开实例拦截器造成递归
  return axios
    .post<{ code: number; message: string; data: { accessToken: string; refreshToken: string } | null }>(
      `${import.meta.env.VITE_API_BASE_URL}/auth/refresh`,
      { refreshToken },
      { timeout: 15000 },
    )
    .then((response) => {
      const body = response.data;
      if (body.code !== BIZ_CODE.OK || !body.data) {
        // 刷新响应的 data 是令牌对（非错误详情），直接构造 BizError 并保留服务端错误码（如 3004 锁定）
        throw new BizError(body.code ?? BIZ_CODE.UNAUTHORIZED, body.message || '刷新登录状态失败');
      }
      tokenStore.setAccess(body.data.accessToken);
      tokenStore.setRefresh(body.data.refreshToken);
      return body.data.accessToken;
    })
    .catch((error: unknown) => {
      throw error instanceof BizError ? error : new BizError(BIZ_CODE.UNAUTHORIZED, '刷新登录状态失败');
    });
}

/** 无感刷新：并发共用同一 Promise */
export function ensureFreshToken(): Promise<string> {
  if (!refreshing) {
    refreshing = doRefresh().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

service.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.getAccess();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  ensureTraceId(config);
  return config;
});

service.interceptors.response.use(
  (response: AxiosResponse) => {
    const body = response.data as { code?: number; message?: string; data?: unknown; traceId?: string } | null;
    // 非信封响应（如静态资源）原样返回
    if (body === null || typeof body !== 'object' || !('code' in body)) {
      return response.data;
    }
    if (body.code === BIZ_CODE.OK) {
      return body.data;
    }
    const details = Array.isArray((body.data as { details?: FieldError[] })?.details)
      ? ((body.data as { details?: FieldError[] }).details as FieldError[])
      : null;
    return Promise.reject(new BizError(body.code ?? BIZ_CODE.INTERNAL, body.message ?? '', body.traceId ?? null, details));
  },
  async (error: unknown) => {
    // HTTP 层错误：优先取响应信封转 BizError
    const axiosError = error as { response?: AxiosResponse<{ code?: number; message?: string; traceId?: string; data?: { details?: FieldError[] } }>; config?: InternalAxiosRequestConfig; message?: string };
    if (axiosError.response) {
      const body = axiosError.response.data;
      if (body && typeof body === 'object' && typeof body.code === 'number') {
        const bizError = toBizError(body);
        // 令牌问题：刷新一次并重放（刷新请求自身不参与，避免递归）
        const isRefreshCall = axiosError.config?.url?.includes('/auth/refresh') ?? false;
        if (bizError.shouldTryRefresh && !isRefreshCall && axiosError.config) {
          try {
            await ensureFreshToken();
            return service.request(axiosError.config);
          } catch {
            redirectToLogin();
            return Promise.reject(new BizError(BIZ_CODE.UNAUTHORIZED, '登录状态已失效，请重新登录'));
          }
        }
        if (bizError.shouldRedirectLogin) {
          redirectToLogin();
        }
        return Promise.reject(bizError);
      }
      // 无信封的系统级错误（网关 502 等）
      const traceId = (axiosError.response.headers['x-trace-id'] as string | undefined) ?? null;
      return Promise.reject(new BizError(BIZ_CODE.INTERNAL, axiosError.message ?? '网络异常', traceId));
    }
    return Promise.reject(new BizError(BIZ_CODE.INTERNAL, '网络连接失败，请检查网络后重试'));
  },
);

/**
 * 收敛 axios 1.20 的条件返回类型
 * axios 1.20 的 get/post/put/delete 返回 Promise<AxiosResponseResult<T, R, D, P>>，
 * 其中 R 为显式传入的响应类型；泛型上下文下该条件类型无法解析为 T。
 * 本实例的响应拦截器已解包统一信封（直接返回 data），故此处断言为 Promise<T>。
 */
function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  return promise as Promise<T>;
}

/** 封装的请求方法（业务侧只面对 data） */
export const request = {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return unwrap<T>(service.get<T, T>(url, config));
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return unwrap<T>(service.post<T, T>(url, data, config));
  },
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return unwrap<T>(service.put<T, T>(url, data, config));
  },
  delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return unwrap<T>(service.delete<T, T>(url, config));
  },
};

/** 统一错误提示（页面 catch 后调用；9003 附退避提示） */
export function toastBizError(error: unknown): string {
  if (error instanceof BizError) {
    return describeBizError(error);
  }
  return '请求失败，请稍后重试';
}

export { BizError, describeBizError };
