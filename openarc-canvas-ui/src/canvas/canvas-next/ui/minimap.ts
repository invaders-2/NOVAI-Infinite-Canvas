/** 小地图浮出规则：默认跟随缩放自动（对齐 TapNow：缩小到一定程度自动浮出），也保留手动偏好 */
export const MINIMAP_ZOOM = 0.35;

/**
 * @param pref 用户偏好：null/undefined = 自动按缩放；true = 强制显示；false = 强制隐藏
 * @param k 当前缩放倍率
 */
export function minimapVisible(pref: boolean | null | undefined, k: number): boolean {
  if (pref === true) return true;
  if (pref === false) return false;
  return Number.isFinite(k) && k < MINIMAP_ZOOM;
}
