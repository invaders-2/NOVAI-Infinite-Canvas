import { BRAND_ICONS, BRAND_COLORS, DARK_LOGO_BRANDS, resolveBrand, brandInitial } from "./vendorIcons";

/**
 * 模型 / 平台的供应商 logo：模型厂商优先，其次平台；都没有就退回首字母方块。
 * 黑色品牌用 currentColor，跟着所在行的文字色走（深浅主题都不用单独处理）。
 */
export function VendorLogo({ name = "", id = "", model = "", size = 14 }: { name?: string; id?: string; model?: string; size?: number }) {
  const key = resolveBrand({ name, id, model });
  const initial = brandInitial({ name, id, model });
  if (!key || !BRAND_ICONS[key]) {
    const bg = BRAND_COLORS[key] || "var(--fg3)";
    return <span className="vlogo-fb" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.52), background: bg, color: "#fff" }}>{initial}</span>;
  }
  const color = DARK_LOGO_BRANDS.has(key) ? "currentColor" : BRAND_COLORS[key] || "currentColor";
  return <svg className="vlogo" aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ color, flex: "none", display: "block" }} dangerouslySetInnerHTML={{ __html: BRAND_ICONS[key] }} />;
}
