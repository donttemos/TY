/**
 * @file 优雅停机信号发送器
 * @description 从 PID 文件读取服务进程 PID 并发送 SIGTERM，验证 setupGracefulShutdown 处理路径。
 * @author donttemo
 * @created 2026-10-12
 * @since v0.1.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const pidFile = process.argv[2];
if (!pidFile) {
  console.error('用法：node send-sigterm.mjs <pid-file>');
  process.exit(2);
}

if (!fs.existsSync(pidFile)) {
  console.error(`PID 文件不存在：${pidFile}`);
  process.exit(2);
}

const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
if (!pid) {
  console.error('PID 文件无有效内容');
  process.exit(2);
}

console.log(`向 PID ${pid} 发 SIGTERM`);
process.kill(pid, 'SIGTERM');
console.log('SIGTERM 已发送');
// 给目标进程 5s 走完优雅停机
await sleep(5000);
const stillAlive = process.platform === 'win32'
  ? fs.existsSync(pidFile)  // 服务关闭时 unlink 文件
  : (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
console.log(stillAlive ? '进程仍在运行（停机超时或失败）' : '进程已退出（优雅停机成功）');
process.exit(stillAlive ? 1 : 0);
