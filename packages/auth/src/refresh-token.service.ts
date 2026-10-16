/*
 * @file 刷新令牌轮换与重放检测
 * @description PRD-003 FR-02 与 TC-AUTH-006/007/008：refresh 每次使用即轮换，旧令牌立即失效；
 *   复用已撤销的旧令牌在宽限窗口（默认 10s）内返回**同一个已持久化的 replacement**（解密恢复，
 *   绝不重新签发——ADR-0020 Rule 6），超出窗口或族已死判定为泄漏——整个轮换族（family）撤销
 *   + 用户其余刷新令牌作废 + 告警日志。令牌只存 sha256 哈希，明文仅存在于响应体；
 *   replacement 明文以 AES-256-GCM 密文暂存于旧记录（grace 恢复专用，ADR-0020 Rule 7）。
 *   并发 rotation 由存储层 CAS 原子裁决：N × A ⇒ exactly 1 × B（ADR-0020 Rule 1/5）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 宽限通道增加「族仍存活」前置校验：整族撤销后旧令牌不得再借窗口换发
 * @modified 2026-10-16 donttemo M11.1（ADR-0020）：rotation 改为存储层 CAS 三态裁决 + grace 解密恢复
 *   + replay 副作用统一编排；Prisma/Memory 双实现均走 CAS 三态裁决（legacy 路径已移除）
 * @module @fw/auth
 */

import { createHash, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import type { AuthStore, RotateRefreshTokenInput } from './auth-store.js';
import { DEFAULT_REFRESH_GRACE_SECONDS } from './constants.js';
import type { TokenService } from './token.service.js';
import type { ID, RefreshTokenRecord } from './types.js';

const logger = Logger.for('auth.refresh');

/**
 * 计算令牌哈希（落库前一律哈希，明文不落盘）
 * @param token 令牌明文
 * @returns sha256 十六进制串
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 轮换结果 */
export interface RotationOutcome {
  /** 命中记录所属轮换族 */
  familyId: string;
  /** 记录归属用户 */
  userId: ID;
  /** 是否触发了复用检测（超宽限窗口使用旧令牌） */
  reuseDetected: boolean;
  /** 是否走并发宽限通道（返回已持久化的同一个 replacement） */
  withinGrace: boolean;
}

/** rotation 成功返回体 */
interface RotationIssued {
  outcome: RotationOutcome;
  refreshToken: string;
  expireAt: Date;
  jti: string;
}

/**
 * 刷新令牌服务：签发、轮换、族撤销
 */
export class RefreshTokenService {
  /**
   * @param store 鉴权存储
   * @param tokens 令牌服务（签发 refresh 与 replacement 加解密）
   * @param graceSeconds 并发宽限窗口（秒，ADR-0020：维持秒单位，上限 30）
   */
  constructor(
    private readonly store: AuthStore,
    private readonly tokens: TokenService,
    private readonly graceSeconds: number = DEFAULT_REFRESH_GRACE_SECONDS,
  ) {}

  /**
   * 首次签发：登录 / 注册 / OAuth2 回调后调用
   * @param userId 用户 ID
   * @param ip 登录 IP
   * @param userAgent 客户端标识
   * @returns refresh 明文、族 ID 与过期时间
   */
  async issue(
    userId: ID,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ refreshToken: string; familyId: string; expireAt: Date; jti: string }> {
    const familyId = randomUUID();
    // jti 以 signRefresh 实际签入 JWT 的值为准（此前本地另生成一个未传入，
    // 返回的 jti 与令牌载荷内 jti 不一致——修复：直接消费签发结果）
    const signed = await this.tokens.signRefresh(userId, familyId);
    await this.store.createRefreshToken({
      userId,
      tokenHash: hashToken(signed.token),
      familyId,
      expireAt: new Date(signed.exp * 1000),
      revokedAt: null,
      loginIp: ip,
      userAgent,
      replacedById: null,
      replacementCipher: null,
      replacementKeyId: null,
      replacementExpiresAt: null,
    });
    return { refreshToken: signed.token, familyId, expireAt: new Date(signed.exp * 1000), jti: signed.jti };
  }

  /**
   * 校验并轮换：CAS 赢家撤销旧记录并建立唯一 replacement；并发/重试路径解密恢复同一个 B；
   * 泄漏路径整族撤销。
   * @param refreshToken refresh 明文
   * @param ip 本次请求 IP
   * @param userAgent 本次请求客户端标识
   * @returns 轮换结果与新令牌
   * @throws BizError 3001 令牌无效 / 3003 令牌过期 / 3001 复用泄漏
   */
  async rotate(
    refreshToken: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ outcome: RotationOutcome; refreshToken: string; expireAt: Date; jti: string }> {
    const record = await this.store.findRefreshTokenByHash(hashToken(refreshToken));
    if (!record) throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌无效');

    const now = new Date();
    if (record.expireAt.getTime() <= now.getTime()) {
      throw new BizError(ErrorCode.TOKEN_EXPIRED, '刷新令牌已过期，请重新登录');
    }
    return this.rotateWithCas(record, ip, userAgent, now);
  }

  /**
   * CAS 路径（ADR-0020）：事务外生成 B（签名/哈希/加密均为纯计算，Rule 3），
   * 存储层原子裁决三态；grace 评估与 replay 副作用留在本服务层（Rule 8）。
   */
  private async rotateWithCas(
    record: RefreshTokenRecord,
    ip: string | null,
    userAgent: string | null,
    now: Date,
  ): Promise<RotationIssued> {
    const rotate = this.store.rotateRefreshToken.bind(this.store);

    const signed = await this.tokens.signRefresh(record.userId, record.familyId);
    const { cipher, keyId } = this.tokens.encryptReplacement(signed.token);
    const input: RotateRefreshTokenInput = {
      oldTokenId: record.id,
      replacementTokenHash: hashToken(signed.token),
      replacementCipher: cipher,
      replacementKeyId: keyId,
      replacementTokenExpiresAt: new Date(signed.exp * 1000),
      replacementRecoverableUntil: new Date(now.getTime() + this.graceSeconds * 1000),
      replacementLoginIp: ip,
      replacementUserAgent: userAgent,
      now,
    };

    const result = await rotate(input);

    if (result.outcome === 'rotated') {
      return {
        outcome: { familyId: record.familyId, userId: record.userId, reuseDetected: false, withinGrace: false },
        refreshToken: signed.token,
        expireAt: input.replacementTokenExpiresAt,
        jti: signed.jti,
      };
    }

    if (result.outcome === 'already_rotated') {
      return this.recoverReplacement(record, result, now);
    }

    // replay_detected（存储层可判定的事实）
    if (result.reason === 'expired') {
      // Case F：A 自身已过期，仅拒绝，不做族撤销（与 legacy 过期路径同语义）
      throw new BizError(ErrorCode.TOKEN_EXPIRED, '刷新令牌已过期，请重新登录');
    }
    // no_replacement：A 被撤销但从未成功轮换（登出 / 泄漏处置 / 强制下线后的复用）
    // not_found：CAS 时点记录已被清理（并发窗口内被 purge，按泄漏处置从紧）
    await this.handleReplay(record.familyId, record.userId, now, `replay_detected: ${result.reason}`);
    throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
  }

  /**
   * already_rotated 的 grace 恢复：窗口未过 + 族存活 + replacement 仍有效 ⇒ 解密返回原 B；
   * 任一不满足 ⇒ fail closed（族撤销 + 抛泄漏），绝不从 A 生成第二个 replacement。
   */
  private async recoverReplacement(
    record: RefreshTokenRecord,
    result: Extract<Awaited<ReturnType<typeof this.store.rotateRefreshToken>>, { outcome: 'already_rotated' }>,
    now: Date,
  ): Promise<RotationIssued> {
    const familyId = result.oldToken.familyId;
    const graceOk = now.getTime() <= result.replacement.recoverableUntil.getTime();
    const familyAlive = graceOk
      ? await this.store.hasActiveRefreshTokenInFamily(familyId, now)
      : false;

    if (!graceOk || !familyAlive) {
      // Case D（grace 过期）/ 登出后借窗口（族已死）
      await this.handleReplay(
        familyId,
        record.userId,
        now,
        graceOk ? '族已撤销后 grace 重试' : 'grace 窗口外复用',
      );
      throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
    }

    let plaintext: string;
    try {
      plaintext = this.tokens.decryptReplacement(result.replacement.cipher, result.replacement.keyId);
    } catch (error) {
      // Security Invariant（ADR-0020）：恢复失败必须 fail closed，绝不生成 C
      logger.error('replacement 恢复失败，按泄漏处置（fail closed）', {
        userId: record.userId,
        familyId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.handleReplay(familyId, record.userId, now, 'replacement 恢复失败');
      throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
    }

    // B 仍有效才可返回（Case E：B 已被消费后 A replay ⇒ 族撤销）
    const replacementRecord = await this.store.findRefreshTokenByHash(hashToken(plaintext));
    if (
      replacementRecord &&
      !replacementRecord.revokedAt &&
      replacementRecord.expireAt.getTime() > now.getTime()
    ) {
      return {
        outcome: { familyId, userId: record.userId, reuseDetected: false, withinGrace: true },
        refreshToken: plaintext,
        expireAt: replacementRecord.expireAt,
        jti: extractJti(plaintext),
      };
    }

    await this.handleReplay(familyId, record.userId, now, 'grace 重试但 replacement 已失效');
    throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
  }

  /**
   * replay 副作用编排（ADR-0020 Rule 8）：整族撤销 + 用户全部 refresh 作废 + 告警日志。
   * 存储层保持纯持久化，业务副作用一律在本服务层。
   */
  private async handleReplay(familyId: string, userId: ID, now: Date, detail: string): Promise<void> {
    const revoked = await this.store.revokeRefreshFamily(familyId, now);
    const others = await this.store.revokeUserRefreshTokens(userId, now);
    logger.error('检测到 refresh 令牌复用，已终止该用户全部会话', {
      userId,
      familyId,
      familyRevoked: revoked,
      userTokensRevoked: others,
      detail,
    });
  }

  /**
   * 撤销一个轮换族（登出单设备）
   * @param familyId 族 ID
   * @returns 受影响条数
   */
  async revokeFamily(familyId: string): Promise<number> {
    return this.store.revokeRefreshFamily(familyId, new Date());
  }

  /**
   * 撤销用户全部刷新令牌（改密 / 强制下线）
   * @param userId 用户 ID
   * @returns 受影响条数
   */
  async revokeAllForUser(userId: ID): Promise<number> {
    return this.store.revokeUserRefreshTokens(userId, new Date());
  }

  /**
   * 清理过期记录（数据字典 §3.9：过期 30 天以上由定时任务清理）
   * @param before 早于该时间的记录将被删除
   * @returns 清理条数
   */
  async cleanup(before: Date): Promise<number> {
    return this.store.purgeExpiredRefreshTokens(before);
  }

  /**
   * 查询令牌记录（测试与排障用）
   * @param refreshToken 明文
   */
  async find(refreshToken: string): Promise<RefreshTokenRecord | null> {
    return this.store.findRefreshTokenByHash(hashToken(refreshToken));
  }
}

/** 从 replacement 明文 JWT 中取出 jti（自有令牌，decode 不验签——验签在此前 rotate 入口已完成语义校验） */
function extractJti(token: string): string {
  try {
    const payload = decodeJwt(token) as { jti?: string };
    return payload.jti ?? '';
  } catch {
    return '';
  }
}
