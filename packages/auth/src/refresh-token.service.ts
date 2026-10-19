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
 * @modified 2026-10-16 donttemo M11.3（ADR-0022）：grace 重试绑定轮换赢家指纹——CAS 写入
 *   rotated_fingerprint（同一 UPDATE），重试方指纹不匹配 → replay（安全事件，Rule 8 全链）；
 *   IP 不参与指纹；NULL 仅存量/off 来源
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-07，ADR-0025）：replay 安全事件走统一审计
 *   事件契约（category/event/result/familyId/jti 落位）+ 审计行 traceId 取自请求上下文（修复
 *   硬编码 null 断链）+ 全部调用点强制传入 ip/userAgent（修复主泄漏路径丢失）+ reason 结构化
 * @modified 2026-10-18 donttemo 复核修复（P1）：grace 指纹比对去掉「本次指纹为 NULL 即跳过」的
 *   缺失值旁路——重试方指纹恒可计算（缺失 UA = SHA-256("") 定值，决策 3a），赢家指纹非 NULL 时
 *   一律比对；AUTH_FINGERPRINT=off 只影响新轮换是否写指纹，不再改变已有指纹行的判定语义
 *   （双节点配置漂移不放宽 grace 绑定），漂移时补一条 warn 以便运维发现。
 * @module @fw/auth
 */

import { createHash, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { BizError, ErrorCode } from '@fw/core';
import { Logger, getRequestContext, getTraceId, patchRequestContext } from '@fw/logger';
import { recordFamilyRevokedMetric, recordReplayDetectedMetric, recordRefreshMetric } from './auth-metrics.js';
import type { AuthStore, RotateRefreshTokenInput } from './auth-store.js';
import { DEFAULT_REFRESH_GRACE_SECONDS } from './constants.js';
import type { TokenService } from './token.service.js';
import type { ID, RefreshTokenRecord } from './types.js';

const logger = Logger.for('auth.refresh');

/**
 * replay 安全事件的结构化原因（PRD-012 OBS-07，低基数枚举）：
 * 人读描述走 detail（审计 afterValue.detail），检索与统计走 reason（afterValue.reason）。
 */
export type ReplayReason =
  | 'not_found'
  | 'no_replacement'
  | 'fingerprint_mismatch'
  | 'grace_expired'
  | 'family_revoked'
  | 'restore_failed'
  | 'replacement_invalid';

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
    /**
     * 指纹绑定开关（ADR-0022，AUTH_FINGERPRINT）：off 时**新轮换不写指纹**（NULL 的唯一合法来源）；
     * 已有指纹行的 grace 比对不受此开关影响（2026-10-18 加固：配置漂移不得放宽绑定）。
     */
    private readonly fingerprintEnabled: boolean = true,
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
      rotatedFingerprint: null,
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
    // M12 W2 OBS-12：轮换结果计数（fw_auth_refresh_total）；失败路径统一收敛（含 replay 3001）
    try {
      return await this.performRotate(refreshToken, ip, userAgent);
    } catch (error) {
      recordRefreshMetric('failed');
      throw error;
    }
  }

  /** 轮换主体（OBS-12 计数包装拆出，逻辑与拆分前逐字一致） */
  private async performRotate(
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
    // 复用方令牌标识（PRD-012 OBS-07：安全事件审计的九要素之一；decode 不验签，
    // 验签语义已在此前入口完成——A 能走到这里说明格式合法）
    const jti = extractJti(refreshToken) || null;
    // M12 W2 OBS-10：编排边界把令牌身份写进统一上下文（familyId/jti 为非凭证标识，ADR-0026）——
    // 后续日志与审计自动携带；只补「记录什么」，rotation 判定语义零改动（ADR-0020 Rule 8 保持）
    patchRequestContext({ familyId: record.familyId, ...(jti ? { jti } : {}) });
    const outcome = await this.rotateWithCas(record, ip, userAgent, now, jti);
    recordRefreshMetric('success');
    return outcome;
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
    jti: string | null,
  ): Promise<RotationIssued> {
    const rotate = this.store.rotateRefreshToken.bind(this.store);

    const signed = await this.tokens.signRefresh(record.userId, record.familyId);
    const { cipher, keyId } = this.tokens.encryptReplacement(signed.token);
    const input: RotateRefreshTokenInput = {
      oldTokenId: record.id,
      replacementUserId: record.userId,
      replacementFamilyId: record.familyId,
      replacementTokenHash: hashToken(signed.token),
      replacementCipher: cipher,
      replacementKeyId: keyId,
      replacementTokenExpiresAt: new Date(signed.exp * 1000),
      replacementRecoverableUntil: new Date(now.getTime() + this.graceSeconds * 1000),
      replacementLoginIp: ip,
      replacementUserAgent: userAgent,
      fingerprint: this.fingerprintEnabled ? computeFingerprint(userAgent) : null,
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
      return this.recoverReplacement(record, result, ip, userAgent, now, jti);
    }

    // replay_detected（存储层可判定的事实）
    if (result.reason === 'expired') {
      // Case F：A 自身已过期，仅拒绝，不做族撤销（与 legacy 过期路径同语义）
      throw new BizError(ErrorCode.TOKEN_EXPIRED, '刷新令牌已过期，请重新登录');
    }
    // no_replacement：A 被撤销但从未成功轮换（登出 / 泄漏处置 / 强制下线后的复用）
    // not_found：CAS 时点记录已被清理（并发窗口内被 purge，按泄漏处置从紧）
    await this.handleReplay(record.familyId, record.userId, now, result.reason, `replay_detected: ${result.reason}`, {
      ip,
      userAgent,
      jti,
    });
    throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
  }

  /**
   * already_rotated 的 grace 恢复：窗口未过 + 族存活 + replacement 仍有效 ⇒ 解密返回原 B；
   * 任一不满足 ⇒ fail closed（族撤销 + 抛泄漏），绝不从 A 生成第二个 replacement。
   */
  private async recoverReplacement(
    record: RefreshTokenRecord,
    result: Extract<Awaited<ReturnType<typeof this.store.rotateRefreshToken>>, { outcome: 'already_rotated' }>,
    ip: string | null,
    userAgent: string | null,
    now: Date,
    jti: string | null,
  ): Promise<RotationIssued> {
    const familyId = result.oldToken.familyId;

    // 指纹比对（ADR-0022 决策 5/7 + 2026-10-18 复核加固）：赢家指纹非 NULL 时**必须**与重试方一致。
    // 重试方指纹恒可计算——computeFingerprint 对 null/空 UA 返回 SHA-256("") 定值（决策 3a），
    // 所以不存在「本次请求算不出指纹 ⇒ 跳过比对」的旁路：UA 缺失只是得到另一个确定指纹。
    // AUTH_FINGERPRINT=off 仅决定「新轮换是否写指纹」（合法 NULL 的唯一来源，决策 3），
    // 不改变已有指纹行的比对语义——双节点配置漂移不得放宽 grace 重试绑定。
    const retryFingerprint = computeFingerprint(userAgent);
    const winnerFingerprint = result.fingerprint ?? null;
    if (winnerFingerprint !== null && !this.fingerprintEnabled) {
      // 可观测的配置漂移信号：本地开关 off，但这行轮换赢家是开指纹时写入的（或对端实例开启）
      logger.warn('指纹开关为 off 但赢家已记录指纹：仍按指纹比对 grace 重试（配置漂移不放宽绑定）', { familyId });
    }
    if (winnerFingerprint !== null && retryFingerprint !== winnerFingerprint) {
      await this.handleReplay(familyId, record.userId, now, 'fingerprint_mismatch', 'grace 重试客户端指纹不匹配', {
        ip,
        userAgent,
        jti,
      });
      throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
    }

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
        graceOk ? 'family_revoked' : 'grace_expired',
        graceOk ? '族已撤销后 grace 重试' : 'grace 窗口外复用',
        { ip, userAgent, jti },
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
      await this.handleReplay(familyId, record.userId, now, 'restore_failed', 'replacement 恢复失败', {
        ip,
        userAgent,
        jti,
      });
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

    await this.handleReplay(familyId, record.userId, now, 'replacement_invalid', 'grace 重试但 replacement 已失效', {
      ip,
      userAgent,
      jti,
    });
    throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
  }

  /**
   * replay 副作用编排（ADR-0020 Rule 8）：整族撤销 + 用户全部 refresh 作废 + 告警日志。
   * 存储层保持纯持久化，业务副作用一律在本服务层。
   *
   * PRD-012 OBS-07（ADR-0025）：安全事件走统一审计事件契约——审计行携带
   * category='security' / event='refresh.replay_detected' / result='denied' / familyId / jti，
   * 且 traceId 取自请求上下文（修复此前的硬编码 null 断链）、ip/userAgent 由全部调用点强制传入
   * （修复主泄漏路径丢失）。reason 为低基数结构化原因，detail 保留人读描述。
   */
  private async handleReplay(
    familyId: string,
    userId: ID,
    now: Date,
    reason: ReplayReason,
    detail: string,
    context: { ip: string | null; userAgent: string | null; jti: string | null },
  ): Promise<void> {
    const revoked = await this.store.revokeRefreshFamily(familyId, now);
    const others = await this.store.revokeUserRefreshTokens(userId, now);
    // M12 W2 OBS-12：安全事件计数（fw_security_replay_detected_total{reason} / fw_security_family_revoked_total）
    recordReplayDetectedMetric(reason);
    recordFamilyRevokedMetric(1);
    // ADR-0022 决策 7：replay / 指纹不匹配是安全事件，落审计（不阻塞主流程）
    try {
      await this.store.writeAuditLog({
        userId,
        module: 'auth',
        category: 'security',
        action: 'security',
        event: 'refresh.replay_detected',
        result: 'denied',
        targetType: 'refresh_family',
        targetId: familyId,
        beforeValue: null,
        afterValue: { detail, reason },
        familyId,
        jti: context.jti,
        // M12 W2 OBS-09：由统一上下文填充（requestId 列 W1 先行落位；直连 store 路径自取 ALS）
        requestId: getRequestContext()?.requestId ?? null,
        ip: context.ip,
        userAgent: context.userAgent,
        traceId: getTraceId() || null,
        createdAt: now,
      });
    } catch (error) {
      logger.warn('replay 安全事件审计落库失败（不阻塞主流程）', {
        familyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.error('检测到 refresh 令牌复用，已终止该用户全部会话', {
      userId,
      familyId,
      reason,
      jti: context.jti,
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
    const affected = await this.store.revokeRefreshFamily(familyId, new Date());
    if (affected > 0) recordFamilyRevokedMetric(1);
    return affected;
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
   * replacement 密文 grace 级清空（ADR-0021 决策 4：编排门面）。
   * 清库动作全部在 Store（纯持久化）；本方法只承担编排语义（供 cleanup cron 调用）。
   * @param now 清理判据时间（默认当前时间；判据 = replacement_expires_at < now）
   * @returns 清空条数
   */
  async cleanupReplacements(now: Date = new Date()): Promise<number> {
    return this.store.clearExpiredReplacementCiphers(now);
  }

  /**
   * 查询令牌记录（测试与排障用）
   * @param refreshToken 明文
   */
  async find(refreshToken: string): Promise<RefreshTokenRecord | null> {
    return this.store.findRefreshTokenByHash(hashToken(refreshToken));
  }
}

/**
 * UA 规范化（ADR-0022 决策 3a：规则冻结，刻意最保守——仅去首尾空白，
 * 不做去版本号/大小写/品牌归并等模糊规则，杜绝行为漂移）；null/undefined → ""。
 */
export function normalizeUserAgent(userAgent: string | null | undefined): string {
  return (userAgent ?? '').trim();
}

/**
 * 客户端指纹 = SHA-256(normalizeUserAgent(userAgent)) 十六进制串（IP 不参与）。
 * 输出恒为非空字符串（null/空 UA 得到 SHA-256("") 的固定值）。
 */
export function computeFingerprint(userAgent: string | null | undefined): string {
  return createHash('sha256').update(normalizeUserAgent(userAgent)).digest('hex');
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
