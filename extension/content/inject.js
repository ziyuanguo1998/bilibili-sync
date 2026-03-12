/**
 * inject.js —— 注入到页面主世界的脚本
 *
 * 通过 manifest.json 中 "world": "MAIN" 配置，此脚本直接运行在 B 站页面的
 * 主 JavaScript 环境中（而非 content script 的隔离沙箱）。
 *
 * 职责：拦截 history.pushState / replaceState，发送自定义事件通知 content script。
 *
 * 通信链路：
 *   B站 JS 调用 pushState（主世界）
 *     -> 本脚本拦截（同在主世界）
 *     -> dispatchEvent('bilibili-sync-urlchange')
 *     -> content script 监听到事件（自定义 DOM 事件可跨世界传递）
 */

(function () {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    window.dispatchEvent(new CustomEvent('bilibili-sync-urlchange'));
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    window.dispatchEvent(new CustomEvent('bilibili-sync-urlchange'));
  };
})();
