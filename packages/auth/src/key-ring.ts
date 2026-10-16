/*
 * @file 双 Key Ring：Replacement Ring 与 JWT Ring（ADR-0023）
 * @description M11.4 密钥管理抽象——密钥材料仍全部封在 TokenService（ADR-0020 红线），
 *   本文件只提供 Ring 数据结构与配置解析：
 *   - ReplacementKeyRing：显式 AUTH_REPLACEMENT_KEYS（<keyId>:<secret> 列表）；未配置时
 *     TokenService 回退 legacy HKDF(JWT_SECRET) 派生（M11.1–11.3 部署零配置零破坏）；
 *   - JwtKeyRing：由 JWT_SECRET（current）/ JWT_SECRET_PREV（previous）构造，行为与现状等价。
 *   解密路由遵循 ADR-0023 Rule 6（显式命中仅试该 key / legacy 回退链 / 未知 keyId fail closed，
 *   禁全 Ring brute-force）——路由逻辑在 TokenService，不在本文件。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { createHash, hkdfSync } from 'node:crypto';

/** Key Ring 可观测快照的密钥来源枚举（ADR-0024 决策 3：API 契约冻结，不允许自由字符串） */
export type KeySource = 'explicit' | 'legacy-hkdf' | 'jwt-secret' | 'jwt-secret-prev';

/** Ring 密钥条目 */
export interface KeyRingEntry {
  /** 密钥标识（禁含 `:` 与 `|`；全局唯一） */
  keyId: string;
  /** 密钥材料（禁含 `|`；≥ 32 UTF-8 bytes） */
  secret: string;
}

/** 单条 secret 的最小字节数（UTF-8 bytes，非 JS 字符数） */
export const KEY_SECRET_MIN_BYTES = 32;

/** Replacement 密钥域 HKDF salt（与 legacy 派生共用，域分离自 JWT 签名密钥） */
export const REPLACEMENT_HKDF_SALT = 'fw/auth/replacement/v1';

/**
 * 解析 AUTH_REPLACEMENT_KEYS（`<keyId>:<secret>` 列表，`|` 分隔）。
 * 解析规则（ADR-0023 决策 1，启动即校验）：
 * ① keyId 禁含 `:` 与 `|`；② secret 禁含 `|`；③ 空 entry 启动即失败；
 * ④ 重复 keyId 启动即失败；⑤ secret ≥ 32 UTF-8 bytes。
 * @param raw 环境变量原始串（空/未配置 → 空数组，调用方回退 legacy 派生）
 * @throws Error 任一规则违反（启动即失败，fail-safe）
 */
export function parseReplacementKeys(raw: string | undefined | null): KeyRingEntry[] {
  if (!raw || raw.trim() === '') return [];
  const entries: KeyRingEntry[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split('|')) {
    if (segment.trim() === '') {
      throw new Error('AUTH_REPLACEMENT_KEYS 存在空 entry（连续 | 或首尾空段）：请修正配置');
    }
    const sep = segment.indexOf(':');
    if (sep <= 0) {
      throw new Error(`AUTH_REPLACEMENT_KEYS 条目格式非法（应为 <keyId>:<secret>）: ${segment.slice(0, 24)}…`);
    }
    const keyId = segment.slice(0, sep);
    const secret = segment.slice(sep + 1);
    if (keyId.includes(':') || keyId.includes('|')) {
      throw new Error(`AUTH_REPLACEMENT_KEYS keyId 禁含 : 与 |: ${keyId.slice(0, 24)}`);
    }
    if (secret.includes('|')) {
      throw new Error(`AUTH_REPLACEMENT_KEYS secret 禁含 |（keyId=${keyId.slice(0, 24)}）`);
    }
    if (secret.length === 0) {
      throw new Error(`AUTH_REPLACEMENT_KEYS secret 为空（keyId=${keyId.slice(0, 24)}）`);
    }
    if (Buffer.byteLength(secret, 'utf8') < KEY_SECRET_MIN_BYTES) {
      throw new Error(
        `AUTH_REPLACEMENT_KEYS secret 长度不足（keyId=${keyId.slice(0, 24)}）：需 ≥ ${KEY_SECRET_MIN_BYTES} UTF-8 bytes`,
      );
    }
    if (seen.has(keyId)) {
      throw new Error(`AUTH_REPLACEMENT_KEYS 存在重复 keyId: ${keyId.slice(0, 24)}`);
    }
    seen.add(keyId);
    entries.push({ keyId, secret });
  }
  if (entries.length === 0) {
    throw new Error('AUTH_REPLACEMENT_KEYS 未解析出任何有效条目');
  }
  return entries;
}

/**
 * Replacement 密钥环：显式配置的多代密钥（current = 列表末位）。
 * 仅存密钥材料与 keyId 路由——加解密与 Rule 6 路由在 TokenService。
 */
export class ReplacementKeyRing {
  private readonly keys = new Map<string, Buffer>();
  private readonly current: string;

  constructor(entries: KeyRingEntry[]) {
    if (entries.length === 0) {
      throw new Error('ReplacementKeyRing 至少需要一个密钥条目');
    }
    let latest = entries[0]!.keyId;
    for (const entry of entries) {
      // 字符校验（防御直接构造 entries 绕过 parseReplacementKeys 的场景）
      if (entry.keyId.includes(':') || entry.keyId.includes('|')) {
        throw new Error(`keyId 禁含 : 与 |: ${entry.keyId.slice(0, 24)}`);
      }
      if (entry.secret.includes('|')) {
        throw new Error(`secret 禁含 |（keyId=${entry.keyId.slice(0, 24)}）`);
      }
      if (Buffer.byteLength(entry.secret, 'utf8') < KEY_SECRET_MIN_BYTES) {
        throw new Error(`secret 长度不足（keyId=${entry.keyId.slice(0, 24)}）：需 ≥ ${KEY_SECRET_MIN_BYTES} UTF-8 bytes`);
      }
      // AES-256 需恰好 32 字节：secret 经 HKDF 派生（info 不含 keyId——同 secret 不同
      // keyId 视为同一密钥的不同标签，使 Rule 6④「显式命中失败不试其它 key」可验证）
      this.keys.set(
        entry.keyId,
        Buffer.from(hkdfSync('sha256', entry.secret, REPLACEMENT_HKDF_SALT, 'replacement-ring', 32)),
      );
      latest = entry.keyId;
    }
    this.current = latest;
  }

  /** 当前签发/加密用的 keyId（列表末位 = 最新代际） */
  get currentKeyId(): string {
    return this.current;
  }

  /** 全部已登记 keyId（审计/排障用） */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** 按 keyId 取密钥材料；未登记返回 null（调用方按 Rule 6 决定 fail closed） */
  keyFor(keyId: string): Buffer | null {
    return this.keys.get(keyId) ?? null;
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }
}

/**
 * JWT Ring 的 legacy 角色路由标识（ADR-0023 过渡期 token 兼容用；ADR-0024 起新签发
 * token 全部携带稳定 kid，这两个标识只出现在存量 token header 中）。
 */
export const JWT_CURRENT_KID = 'jwt-current';
export const JWT_PREVIOUS_KID = 'jwt-prev';

/** 稳定 kid 派生：'jwt-' + sha256(secret) 前 16 hex（64 bit，ADR-0024 决策 1） */
export function deriveJwtKid(secret: string): string {
  return `jwt-${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
}

/**
 * JWT 密钥环：由 JWT_SECRET（current）/ JWT_SECRET_PREV（previous）构造。
 * ADR-0024：kid 升级为**稳定指纹标识**（同 secret 跨部署/实例/重启不变；不同 secret
 * 派生不同 kid）；同 Ring 内 kid collision 启动即失败（keyFor 路由无歧义）。
 */
export class JwtKeyRing {
  private readonly currentKey: Uint8Array;
  private readonly previousKey: Uint8Array | null;
  private readonly currentKid: string;
  private readonly previousKid: string | null;

  constructor(currentSecret: string, previousSecret?: string) {
    this.currentKey = new TextEncoder().encode(currentSecret);
    this.previousKey = previousSecret ? new TextEncoder().encode(previousSecret) : null;
    this.currentKid = deriveJwtKid(currentSecret);
    this.previousKid = previousSecret ? deriveJwtKid(previousSecret) : null;
    // 同 Ring 内 kid collision → 启动即失败（不同 secret 派生出相同 kid 会造成 keyFor 路由歧义）
    if (this.previousKid !== null && this.previousKid === this.currentKid) {
      throw new Error(`JWT Key Ring kid collision（current 与 previous 派生出相同 kid: ${this.currentKid}）——请更换 JWT_SECRET_PREV`);
    }
  }

  /** 当前签发用的稳定 kid */
  get currentKeyId(): string {
    return this.currentKid;
  }

  /** 上一代稳定 kid（未配置 PREV 为 null） */
  get previousKeyId(): string | null {
    return this.previousKid;
  }

  /**
   * 按稳定 kid 取验签密钥；未知 kid 返回 null。
   * 调用方（TokenService.verify）按 ADR-0024 四分支路由：absent / legacy 角色标识 →
   * dual-try 兼容；known stable kid → 只验证该 key；unknown → 拒绝。
   */
  keyFor(keyId: string): Uint8Array | null {
    if (keyId === this.currentKid) return this.currentKey;
    if (keyId === this.previousKid && this.previousKey) return this.previousKey;
    return null;
  }

  /** kid 是否为已知稳定 kid */
  knowsKid(keyId: string): boolean {
    return keyId === this.currentKid || (this.previousKid !== null && keyId === this.previousKid);
  }

  hasPrevious(): boolean {
    return this.previousKey !== null;
  }
}
