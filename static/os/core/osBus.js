// ============================================================================
// NOVAI OS · Event Bus (osBus.js)
// 补齐现有架构缺口：目前跨页/跨组件只有手工 postMessage，无统一事件总线。
// Phase 2 只提供最小实现：on / off / once / emit，无中间件、无异步、无通配符。
//
// 约定事件（Phase 2）：
//   apps:loaded   { apps }                 App Registry 合并完成
//   app:launch    { appId, source }        Desktop Icon / Dock / Launcher 请求启动
//   window:open   { window }               Window Store 创建窗口
//   window:close  { id }                   Window Store 移除窗口
//   window:focus  { id }                   z 提升（最小激活语义）
//   store:change  { windows, activeId }    任意窗口状态变化（供 Dock 订阅）
// ============================================================================

const listeners = new Map();

function bucket(type) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  return listeners.get(type);
}

/** 订阅；返回取消订阅函数 */
export function on(type, handler) {
  if (typeof handler !== "function") return () => {};
  bucket(type).add(handler);
  return () => off(type, handler);
}

/** 取消订阅 */
export function off(type, handler) {
  const set = listeners.get(type);
  if (set) set.delete(handler);
}

/** 订阅一次 */
export function once(type, handler) {
  const wrapped = (payload) => {
    off(type, wrapped);
    handler(payload);
  };
  return on(type, wrapped);
}

/**
 * 发布事件。单个 handler 抛错不影响其余订阅者，错误打到 console.error
 * （不静默吞掉，便于验收阶段发现）。
 */
export function emit(type, payload) {
  const set = listeners.get(type);
  if (!set || set.size === 0) return;
  for (const handler of Array.from(set)) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[osBus] handler failed for "${type}"`, err);
    }
  }
}

/** 清空（测试用） */
export function resetBus() {
  listeners.clear();
}

export default { on, off, once, emit, resetBus };
