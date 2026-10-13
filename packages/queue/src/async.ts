/*
 * @file 异步工具：带超时的执行
 * @description 任务与定时任务统一在超时窗口内执行：超时按失败处理并记录（PRD-007 NFR：单任务默认 60s）。
 *   计时器 `unref`，避免阻塞进程退出；超时抛错而非静默吞掉，交由上层进入重试链路。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

/**
 * 在超时窗口内执行
 * @param task 待执行函数
 * @param timeoutMs 超时上限（毫秒）；<= 0 表示不限时
 * @param onTimeout 超时时构造的异常
 */
export async function withTimeout<T>(task: () => Promise<T> | T, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (timeoutMs <= 0) return task();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(task()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 延迟指定毫秒（不阻塞进程退出）
 * @param ms 毫秒
 */
export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
