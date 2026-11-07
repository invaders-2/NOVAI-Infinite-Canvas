/**
 * 宿主桥（window.novai）的读取与钩子读写。
 *
 * 新名：window.novai / window.__novai*。旧名 window.openarc / window.__openarc* 只作兼容：
 * 外部桌面外壳与老探针脚本还按旧名字取，删掉它们那些外部代码会拿到 undefined。
 */

type AnyRoot = Record<string, any>;

/** 宿主桥根：新名优先，缺失时回落旧名（installNovaiBridge 让两者指向同一对象）。 */
export function hostRoot<T = AnyRoot>(): T {
  if (typeof window === "undefined") return {} as unknown as T;
  const w = window as unknown as { novai?: AnyRoot; openarc?: AnyRoot };
  return (w.novai || w.openarc || {}) as unknown as T;
}

/** __novaiXxx → __openarcXxx（只对 __novai 前缀生效）。 */
const legacyHookName = (name: string): string => name.startsWith("__novai") ? "__openarc" + name.slice("__novai".length) : name;

/** 读测试 / 宿主钩子：新名优先，旧名兜底。 */
export function hostHook<T>(name: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as AnyRoot;
  const value = w[name] ?? w[legacyHookName(name)];
  return value as T | undefined;
}

/** 写钩子：新名与旧名指向同一个值（同一函数），旧探针脚本不用改。 */
export function setHostHook(name: string, value: unknown): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as AnyRoot;
  w[name] = value;
  w[legacyHookName(name)] = value;
}

/** 删钩子：新旧一起删，避免卸载后还留着上一次的引用。 */
export function deleteHostHook(name: string): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as AnyRoot;
  delete w[name];
  delete w[legacyHookName(name)];
}
