/*
 * @file 异步请求竞态守卫（M14/PRD-014 FR-14-04：AC-14-04 乱序返回安全）
 * @author donttemo
 * @created 2026-10-20
 * @description 解决「先发后到」覆盖：订阅 / 用量 / 生命周期页的查询结果不得由**旧请求**写入页面状态。
 *   两重校验缺一不可：
 *   ① 请求序号：每次 begin() 递增，先前票据立即失效。任何新查询（换租户、换筛选、换指标、翻页、
 *      换时间窗）都让上一张票据作废，故「B 先返回、A 后返回」时 A 的 apply 被丢弃。这是唯一能覆盖
 *      「同租户内多维度切换」的机制（租户快照对同租户无效）。
 *   ② 作用域快照：begin(scope) 记下发起时刻上下文（tenantId、`租户|指标|窗口|页码`），提交前比对。
 *      防的是序号机制的盲区——切租户后 reset 未及时失效票据，或 keep-alive 停用/复用期间序号被重置。
 *   为什么不用 watch + 标志位：watch 是异步 flush，promise 回调可能先于 watch 执行，标志位晚一拍；
 *   序号在 begin() 同步递增，没有这个时间窗。
 * @usage const t = guard.begin(() => tenantId.value); const r = await api();
 *   t.apply(() => { rows.value = r; });            // 过期票据静默丢弃
 *   复位：guard.invalidate()；catch/finally 用 t.isFresh() 判断，避免旧请求误报错误或提前关 loading。
 *   每个数据域一个实例（共享会互相误杀：换时间窗会让在途用量请求作废）。纯函数，可在 setup 外构造。
 * @module admin-web/composables
 */

/** 作用域：固定字符串，或每次求值的读取函数（通常读一个 ref 的当前值） */
export type RequestScope = string | (() => string);

/** 一次请求的票据：由 begin() 发放，只有「最新且作用域未变」时才允许提交 */
export interface RequestTicket {
  /** 该票据是否仍可写入页面状态（序号最新 + 作用域快照一致） */
  isFresh(): boolean;
  /**
   * 条件提交：票据仍有效则执行 apply 并返回 true；已过期则**不执行**并返回 false。
   * 用于一行式保护赋值，避免调用方重复写 if (ticket.isFresh())。
   */
  apply(apply: () => void): boolean;
}

export interface RequestGuard {
  /** 开始一次请求：使先前所有票据失效，并记录当前作用域快照 */
  begin(scope?: RequestScope): RequestTicket;
  /** 主动作废全部在途票据（切换租户复位、清空选择），不发放新票据 */
  invalidate(): void;
}

/**
 * 创建独立守卫。**每个数据域一个实例**：同一个实例被两个并行请求（如配额 + 指标）共用时，
 * 后发者会使先发者失效，导致前者结果被丢弃（用量页因此分成 quotaGuard / metricGuard 两个）。
 */
export function createRequestGuard(): RequestGuard {
  let seq = 0;
  return {
    begin(scope?: RequestScope): RequestTicket {
      const id = ++seq;
      const read = typeof scope === 'function' ? scope : (): string | undefined => scope;
      const snapshot = read();
      const fresh = (): boolean => id === seq && (scope === undefined || read() === snapshot);
      return {
        isFresh: fresh,
        apply(fn: () => void): boolean {
          if (!fresh()) return false;
          fn();
          return true;
        },
      };
    },
    invalidate(): void {
      seq += 1;
    },
  };
}
