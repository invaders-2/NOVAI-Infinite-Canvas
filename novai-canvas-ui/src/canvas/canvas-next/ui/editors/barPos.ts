/**
 * 编辑条定位：横向居中于节点，但不超出画布左右边缘（宽工具条盖在靠边的节点上时会被裁掉）；
 * 节点上方放不下（会压住顶栏）就放到节点下方。
 */
import { useLayoutEffect, useRef, useState } from "react";

const TOP_SAFE = 64; // 顶栏高度 + 留白

export function useEdBar(cx: number, stageW: number) {
  const ref = useRef<HTMLDivElement>(null); const [w, setW] = useState(0);
  useLayoutEffect(() => { const el = ref.current; if (el && el.offsetWidth !== w) setW(el.offsetWidth); });
  const half = w / 2;
  const left = w ? Math.max(half + 8, Math.min(stageW - half - 8, cx)) : cx;
  return { ref, left };
}

/** 上方工具条的 top；放不下返回 null（调用方改放下方） */
export function barAbove(rectTop: number, barH = 48): number | null {
  const top = rectTop - barH - 8;
  return top >= TOP_SAFE ? top : null;
}
