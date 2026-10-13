/*
 * @file 测试环境 DOM 补丁
 * @description happy-dom 缺失 ResizeObserver（Element Plus 表格/虚拟列依赖），测试环境补齐空实现；
 *   同时静默 ElMessage 通知，避免断言输出被提示框污染。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
