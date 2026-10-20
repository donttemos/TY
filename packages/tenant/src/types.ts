/*
 * @file 租户类型定义
 * @description PRD-008 FR-01/FR-02：租户信息与存储端口。租户 ID 统一以十进制数字字符串传递
 *   （与 @fw/logger 请求上下文的 tenantId 一致），由各层自行转换为 bigint。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/tenant
 */

/** 隔离级别：shared = 共享库 + tenant_id；dedicated = 独立库（按租户路由数据源） */
export type TenantIsolation = 'shared' | 'dedicated';

/** 租户信息（数据字典 §3.10 `tenants` 的运行时投影） */
export interface TenantInfo {
  /** 租户 ID（十进制数字字符串） */
  id: string;
  /** 租户编码（子域名 / 请求头匹配键） */
  code: string;
  /** 租户名称 */
  name: string;
  /** 隔离级别 */
  isolation: TenantIsolation;
  /** 独立库连接串（仅 dedicated；加密存储字段的运行时解密结果由实现方负责） */
  dbUrl: string | null;
  /** 状态 Int（ADR-0029 §2.4 五态编码）：0 存量停用 / 1 active / 2 grace / 3 frozen / 4 terminated / 5 pending。
   *  停用（0）与未开通（5）在解析层拒绝（4001，fail-closed）；grace/frozen/terminated 放行至业务面，
   *  由 M13 SaasLifecycleGuard 以 4031 拦截（冻结租户管理端登录/导出仍可用，ADR-0031 §3.2）。
   *  注：0 与 3 同义（frozen），0 为存量只读兼容码，领域写路径永不写 0（ADR-0029 §2.4）。 */
  status: 0 | 1 | 2 | 3 | 4 | 5;
  /** 到期时间（ISO 字符串；未设置为 null） */
  expireAt: string | null;
}

/**
 * 租户存储端口：由宿主应用提供实现（如 Prisma 查 `tenants` 表）。
 * 返回 null 表示编码不存在；停用 / 过期租户仍返回记录，由 TenantService 统一判定并报错。
 */
export interface TenantStorePort {
  findTenantByCode(code: string): Promise<TenantInfo | null>;
}

/** 租户解析配置（PRD-008 §9 已定稿：三级回退，顺序与各级开关可配） */
export interface TenantResolutionOptions {
  /**
   * 解析回退顺序，取值为 `subdomain` / `header` / `jwt` 的子序列。
   * 未列出的来源即视为关闭。默认「子域名 → 请求头 → JWT claim」。
   */
  order: TenantSource[];
  /** 请求头名称（小写），默认 `x-tenant-id` */
  headerName: string;
  /** 子域名解析的基准域名（如 `example.com`）；未配置时 subdomain 源按设计关闭 */
  baseDomain?: string;
  /** JWT claim 字段名，默认 `tenantId` */
  jwtClaim: string;
}

/** 租户识别来源 */
export type TenantSource = 'subdomain' | 'header' | 'jwt';

/** 解析输入：宿主从 HTTP 请求提取的最小集合 */
export interface TenantResolutionInput {
  /** Host 请求头（含端口亦可，解析时剥离） */
  host?: string;
  /** 归一化请求头集合（键小写） */
  headers: Record<string, string | string[] | undefined>;
  /**
   * JWT claim 提取器：入参为 claim 字段名，返回字符串值或 undefined。
   * 由宿主注入（通常委托 @fw/auth 的 access token 校验后取 claim）；
   * 未注入时 jwt 源按设计关闭。
   */
  extractJwtClaim?: (claim: string) => string | undefined;
}

/** 默认解析顺序（PRD-008 §9 定稿结论） */
export const DEFAULT_TENANT_ORDER: readonly TenantSource[] = ['subdomain', 'header', 'jwt'];

/** 租户编码约束：小写字母 / 数字 / 连字符，1–64 位（与数据字典 `tenants.code` varchar(64) 对齐） */
export const TENANT_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

/** 租户存储实现注入令牌 */
export const TENANT_STORE = Symbol('fw.tenant.store');

/** 租户运行时配置注入令牌 */
export const TENANT_OPTIONS = Symbol('fw.tenant.options');

/** express 级租户中间件令牌（宿主经 bootstrap beforeListen 以 app.use 注册） */
export const TENANT_MIDDLEWARE = Symbol('fw.tenant.middleware');
