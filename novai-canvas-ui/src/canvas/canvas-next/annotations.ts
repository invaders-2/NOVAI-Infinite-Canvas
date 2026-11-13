/** 全屏查看器里的图片标注：只保留 Agent 真正需要的字段（相对图片的 0–1 百分比坐标） */
export type CanvasAnnotation = {
    no: number;
    type: "point" | "lasso" | "rect";
    label: string;
    text: string;
    point?: { x: number; y: number };
    rect?: { x: number; y: number; w: number; h: number };
};

export type AnnotationPayload = {
    nodeId: string;
    nodeTitle: string;
    image?: { w: number; h: number };
    annotations: CanvasAnnotation[];
    mode: "chat" | "send";
};

const pct = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100) + "%";

function where(a: CanvasAnnotation): string {
    if (a.type === "point" && a.point) return "坐标 " + pct(a.point.x) + " , " + pct(a.point.y);
    if (a.rect) return "区域 x" + pct(a.rect.x) + " y" + pct(a.rect.y) + " w" + pct(a.rect.w) + " h" + pct(a.rect.h);
    return "位置未知";
}

const KIND: Record<CanvasAnnotation["type"], string> = { point: "点选", lasso: "圈选", rect: "框选" };

/** 单条标注压成一行：编号 · 类型 · 对象 · 描述 · 位置 */
export function annotationLine(a: CanvasAnnotation): string {
    return a.no + ". " + KIND[a.type] + " · " + (a.label || "画面") + " · " + where(a) + " · 描述：" + (a.text.trim() || "（无描述）");
}

/** 发给画布助手的一段说明：图片节点 + 每条标注 + 一句执行要求 */
export function annotationsPrompt(items: AnnotationPayload[]): string {
    const rows: string[] = [];
    for (const item of items) {
        const head = "【图片标注】图片节点 " + item.nodeId + "（" + item.nodeTitle + "）" + (item.image?.w && item.image?.h ? "，" + item.image.w + "×" + item.image.h + " 像素" : "") + "，坐标是相对图片左上角的百分比：";
        rows.push(head);
        for (const a of item.annotations) rows.push(annotationLine(a));
    }
    if (!rows.length) return "";
    return "\n\n" + rows.join("\n") + "\n请按这些标注修改对应图片节点（标注只用来定位与理解意图，不用把坐标复述给用户）。";
}
