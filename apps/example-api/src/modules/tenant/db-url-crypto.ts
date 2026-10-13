/*
 * @file 独立库连接串加解密（M8 T-M8-02，PRD-008 FR-02）
 * @description dedicated 租户的独立库连接串属敏感凭证：tenants.db_url_enc 只存密文，
 *   运行时由 PrismaTenantStore 解密后经请求上下文传递给数据源路由（禁入日志/审计）。
 *   方案：AES-256-GCM（认证加密，防篡改），密文格式 `v1.<iv-b64url>.<tag-b64url>.<ct-b64url>`；
 *   密钥取环境变量 TENANT_DB_KEY（64 位十六进制或 base64），缺省用内置开发密钥并告警
 *   （仅限本地开发；生产必须显式配置，部署手册已注明）。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/tenant
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Logger } from '@fw/logger';

const logger = Logger.for('tenant');

/** 密文版本前缀（算法升级时只增版本号，旧版本保留解密兼容） */
const ENC_PREFIX = 'v1';

/** 内置开发密钥（32 字节）：仅 TENANT_DB_KEY 未配置时使用，生产禁用 */
const DEV_KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

/** 解密结果：连接串或 null（非本方案密文 / 密钥不匹配时由调用方决定降级行为） */
function loadKey(): Buffer {
  const raw = process.env.TENANT_DB_KEY;
  if (!raw) {
    logger.warn('TENANT_DB_KEY 未配置，使用内置开发密钥解密独立库连接串（仅限本地开发）');
    return DEV_KEY;
  }
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null;
  if (hex) return hex;
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    /* 落到下面报错 */
  }
  throw new Error('TENANT_DB_KEY 格式错误：需为 64 位十六进制或 base64 编码的 32 字节密钥');
}

/** 进程内密钥单例（启动后不变；轮换靠重启） */
let cachedKey: Buffer | undefined;

function key(): Buffer {
  cachedKey ??= loadKey();
  return cachedKey;
}

/** base64url 编解码（连接串不入 URL query，但保持紧凑无填充） */
function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

/**
 * 加密独立库连接串（种子脚本与运维工具用）。
 * @returns `v1.<iv>.<tag>.<ct>` 格式密文
 */
export function encryptDbUrl(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, b64urlEncode(iv), b64urlEncode(tag), b64urlEncode(ct)].join('.');
}

/**
 * 解密独立库连接串。
 * @throws 密文格式非法 / 认证失败（密钥不匹配或密文被篡改）时抛错——
 *   由上层转为租户不可用（403），绝不回退成共享库静默放行。
 */
export function decryptDbUrl(enc: string): string {
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) {
    throw new Error('独立库连接串密文格式错误（期望 v1.<iv>.<tag>.<ct>）');
  }
  const [, ivText, tagText, ctText] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key(), b64urlDecode(ivText));
  decipher.setAuthTag(b64urlDecode(tagText));
  const plain = Buffer.concat([decipher.update(b64urlDecode(ctText)), decipher.final()]);
  return plain.toString('utf8');
}

/** 恒定时间比较（供测试与运维校验用） */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
