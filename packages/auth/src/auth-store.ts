/*
 * @file 鉴权存储端口（AuthStore）
 * @description @fw/auth 不感知具体表结构：所有持久化经本端口，由业务项目的 PrismaAuthStore 或
 *   内存实现（MemoryAuthStore）提供。这样框架包与项目 schema 解耦，与 M2「框架不感知 schema」一致。
 *   端口方法只表达意图（按账号找用户、置换角色），不暴露查询构造器，便于不同驱动实现。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 新增 hasActiveRefreshTokenInFamily（宽限通道前置校验族存活）
 * @module @fw/auth
 */

import type { PageResult } from '@fw/db';
import type {
  AuditLogRecord,
  AuditQuery,
  AuthMenu,
  AuthPermission,
  AuthRole,
  AuthUser,
  CreateUserInput,
  ID,
  RefreshTokenRecord,
  UserListItem,
  UserQuery,
} from './types.js';

/** 新增刷新令牌入参（id 由存储层生成） */
export type NewRefreshToken = Omit<RefreshTokenRecord, 'id'>;

/**
 * 轮换 CAS 入参（ADR-0020 Rule 1/3）
 *
 * replacement 的生成、签名、哈希、加密全部在**事务外**由服务层完成；
 * 存储层只做原子 CAS（更新 A + 插入 B）——不感知 JWT/SHA-256/AES（Rule 7）。
 */
export interface RotateRefreshTokenInput {
  /** 旧记录（A）主键 */
  oldTokenId: ID;
  /** A 的归属用户（服务层已从 A 行取得；userId/familyId 轮换期内不可变，无 stale 风险）——传入后事务内零 SELECT（Rule 3 严格两条持久化语句） */
  replacementUserId: ID;
  /** A 的轮换族 ID（同上） */
  replacementFamilyId: string;
  /** replacement（B）的 sha256 哈希 */
  replacementTokenHash: string;
  /** replacement（B）明文的 AES-256-GCM 密文（grace 恢复用） */
  replacementCipher: string;
  /** replacement 密钥标识 */
  replacementKeyId: string;
  /** replacement（B）自身的过期时间（refreshTtl，非 grace 窗口） */
  replacementTokenExpiresAt: Date;
  /**
   * replacement 密文可恢复期终点 = 轮换时刻 + graceSeconds（ADR-0020「时间基准」）。
   * 与 revokedAt 同源同一个 `now`，grace 评估收敛为 `now <= replacementRecoverableUntil` 一次列比较。
   */
  replacementRecoverableUntil: Date;
  /** replacement 记录的登录 IP（赢家请求上下文） */
  replacementLoginIp: string | null;
  /** replacement 记录的客户端标识（赢家请求上下文） */
  replacementUserAgent: string | null;
  /**
   * 赢家指纹（ADR-0022：SHA-256(normalizeUserAgent(ua))，服务层算好传入；IP 不参与）。
   * 与 rotation 同一 UPDATE 原子写入（禁止二次补写）；开关关闭时为 null。
   */
  fingerprint: string | null;
  /** CAS 谓词用当前时间（expires_at > now） */
  now: Date;
}

/**
 * 轮换 CAS 三态结果（ADR-0020）
 *
 * 结果只携带**事实**，不携带业务策略：
 *
 * - `rotated`：CAS 赢家，A 更新与 B 插入已原子提交；
 * - `already_rotated`：A 已被并发请求轮换，携带 grace 恢复所需事实——
 *   `userId` 不进结果（服务层已从旧记录获得）；grace 窗口与族存活评估由服务层完成；
 * - `replay_detected`：存储层可判定的不可恢复事实（`not_found` / `expired` /
 *   `no_replacement`）；`grace_expired` 由服务层基于窗口终点与族存活判定后
 *   走同一 replay 副作用路径（存储层不持 grace 策略，Rule 8）。
 */
export type RefreshRotationResult =
  | { outcome: 'rotated'; replacementId: ID }
  | {
      outcome: 'already_rotated';
      oldToken: { revokedAt: Date; familyId: string };
      replacement: { cipher: string; keyId: string; recoverableUntil: Date };
      /** A 行赢家指纹（ADR-0022）：服务层比对重试方指纹；NULL = 存量行/off 模式 → 放行 */
      fingerprint: string | null;
    }
  | { outcome: 'replay_detected'; reason: 'not_found' | 'expired' | 'no_replacement' };

/** 新增审计日志入参（id 由存储层生成） */
export type NewAuditLog = Omit<AuditLogRecord, 'id'>;

/**
 * 鉴权存储端口
 */
export interface AuthStore {
  // ---------- 用户 ----------

  /** 按账号（用户名 / 手机号 / 邮箱）查用户，未找到返回 null */
  findUserByAccount(account: string): Promise<AuthUser | null>;
  /** 按主键查用户 */
  findUserById(id: ID): Promise<AuthUser | null>;
  /** 创建用户（passwordHash 必填，调用方已哈希） */
  createUser(input: CreateUserInput): Promise<AuthUser>;
  /** 局部更新用户 */
  updateUser(id: ID, patch: Partial<AuthUser>): Promise<AuthUser>;
  /** 用户分页（返回结果不含口令哈希） */
  pageUsers(query: UserQuery): Promise<PageResult<UserListItem>>;
  /** 更新最近登录时间与 IP（登录成功时调用） */
  touchUserLogin(id: ID, at: Date, ip: string | null): Promise<void>;

  // ---------- 角色与权限 ----------

  /** 全部角色 */
  listRoles(): Promise<AuthRole[]>;
  /** 某用户持有的角色 */
  listRolesByUserId(userId: ID): Promise<AuthRole[]>;
  /** 全部权限点 */
  listPermissions(): Promise<AuthPermission[]>;
  /** 某用户经由角色聚合出的权限点（已去重） */
  listPermissionsByUserId(userId: ID): Promise<AuthPermission[]>;
  /** 全部菜单（可见性由调用方按权限码过滤） */
  listMenus(): Promise<AuthMenu[]>;
  /** 全量覆盖用户角色 */
  replaceUserRoles(userId: ID, roleIds: ID[]): Promise<void>;
  /** 全量覆盖角色权限 */
  replaceRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void>;
  /** 某角色已授权的权限点 ID 列表 */
  listPermissionIdsByRoleId(roleId: ID): Promise<ID[]>;
  /** 持有指定角色的用户 ID（角色权限变更后按标签失效其权限缓存） */
  listUserIdsByRoleId(roleId: ID): Promise<ID[]>;

  // ---------- 刷新令牌 ----------

  /** 落库一条刷新令牌记录（只存哈希） */
  createRefreshToken(record: NewRefreshToken): Promise<RefreshTokenRecord>;
  /** 按令牌哈希查记录 */
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** 撤销单条记录 */
  revokeRefreshToken(id: ID, at: Date): Promise<void>;
  /** 撤销整个轮换族，返回受影响条数 */
  revokeRefreshFamily(familyId: string, at: Date): Promise<number>;
  /**
   * 轮换族内是否仍存在有效（未撤销且未过期）令牌。
   * 用途：refresh 的并发宽限通道必须确认「族仍存活」——族被整族撤销（泄漏处置 / 登出 / 强制下线）后，
   * 族内任何旧令牌都不得再借宽限窗口换发新令牌，否则泄漏处置会被绕过。
   */
  hasActiveRefreshTokenInFamily(familyId: string, now: Date): Promise<boolean>;
  /** 撤销某用户全部刷新令牌（改密 / 踢下线），返回受影响条数 */
  revokeUserRefreshTokens(userId: ID, at: Date): Promise<number>;
  /**
   * 轮换 CAS（ADR-0020 Rule 1/3，必选）：原子地「CAS 更新 A + 插入 B」两条持久化语句——
   * UPDATE 一次性写入 revoked/replacedById/三列/指纹（replacedById 即本方法生成的
   * replacementId，不依赖读 A）；B 的归属由服务层经 input 传入，事务内零 SELECT。
   * CAS 谓词必须含未撤销 + 未软删 + 未过期；失败路径的判定性重读必须在事务外（Rule 4）。
   * 事务外的生成/签名/加密由服务层完成，存储层只持久化不透明串（Rule 7）。
   */
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<RefreshRotationResult>;
  /** 清理过期记录（保留期由定时任务决定），返回清理条数 */
  purgeExpiredRefreshTokens(before: Date): Promise<number>;
  /**
   * replacement 密文 grace 级清空（ADR-0021 决策 1）：
   * `replacement_expires_at` 是唯一判据（部分写入/脏数据同样回收）；
   * 幂等性由「清空时 expiresAt 一并置 NULL」自然保证（该行不再满足判据，重复执行 count = 0）；
   * 保留 revokedAt / replacedById（历史链），返回清空条数。
   */
  clearExpiredReplacementCiphers(now: Date): Promise<number>;
  /**
   * 各 replacement keyId 的「仍存在可恢复密文」计数（ADR-0024 退役判据）：
   * COUNT(replacement_cipher IS NOT NULL AND replacement_key_id 非空 AND replacement_expires_at > now)，
   * 按 keyId 聚合——retirable = 该 keyId 计数为 0。
   */
  countReplacementCiphersByKeyId(now: Date): Promise<Record<string, number>>;

  // ---------- 审计 ----------

  /** 写入审计日志（异步落盘，失败不得阻塞主流程） */
  writeAuditLog(record: NewAuditLog): Promise<void>;
  /** 审计日志分页查询 */
  pageAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>>;
}
