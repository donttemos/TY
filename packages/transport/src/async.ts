/*
 * @file 异步工具：带超时的执行与延迟
 * @description 传输调用统一在超时窗口内执行：超时抛 TransportTimeoutError 而非静默吞掉。
 *   计时器 `unref`，避免阻塞进程退出。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { TransportTimeoutError } from './errors.js';

/**
 * 在超时窗口内执行
 * @param task 待执行函数（同步或异步）
 * @param timeoutMs 超时上限（毫秒）；<= 0 表示不限时
 * @param address 传输地址（超时错误携带）
 */
export async function withTimeout<T>(task: () => Promise<T> | T, timeoutMs: number, address: string): Promise<T> {
  if (timeoutMs <= 0) return task();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(task()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransportTimeoutError(address, timeoutMs)), timeoutMs);
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
