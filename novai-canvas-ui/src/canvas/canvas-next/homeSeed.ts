/**
 * 首页进智能画布BEAT 的种子（web/src/pages/home/HomePage.vue 写 localStorage）。
 *
 * 种子里是一张小画布的规格（节点类型见 web/src/pages/home/templates.js），这里翻译成 BEAT 节点：
 * 读出来、立刻删掉，铺节点 + 连边 + 摆好位置，再把文字交给助手面板。
 * 读完即删才保证刷新 / 二次打开不会重复铺节点、重复自动发送。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import { connect } from "./actions";
import { frameOf } from "./groupFit";
import { defaultParams, uid, type ImageParams, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { normalizeSkillRef } from "./agent/skillRef";
import { emptyTable, withTable } from "./table";

export const HOME_SEED_PREFIX = "novai_canvas_seed:";

/** 画布助手的外部草稿：外壳把一句话交给面板填写；autoSend 时面板填好后自己发一次 */
export type AgentDraft = { seq: number; text: string; skill?: string; skillRef?: string; autoSend?: boolean };

type SeedImage = { url?: string; name?: string; kind?: string };
type SeedNode = {
    key?: string;
    type?: string;
    title?: string;
    text?: string;
    prompt?: string;
    ratio?: string;
    video?: boolean;
    images?: SeedImage[];
    inputs?: string[];
    col?: number;
    /** 首页只用来标记「参考图放这里 / 文字放这里」，BEAT 侧不需要额外处理 */
    ref?: boolean;
    brief?: boolean;
};
export type HomeSeed = { v?: number; nodes?: SeedNode[]; agent?: string; autoSend?: boolean; skillRef?: string; toast?: string; renderer?: string };

const IMAGE_W = 240;
const FALLBACK_H = 180;
const MAX_IMAGES = 12;
const TEXT_W = 320;
const TEXT_H = 240;
const LABEL_W = 240;
const LABEL_H = 120;
const TABLE_W = 420;
const TABLE_H = 220;
const ROW_GAP = 48;
const COL_GAP = 140;

/** 首页的语义比例 → BEAT 的比例串；模板里也有写死的 '16:9'，能原样用的就原样用 */
const RATIO: Record<string, string> = { square: "1:1", wide: "16:9", story: "9:16", portrait43: "3:4", landscape43: "4:3", ultrawide: "21:9" };

function ratioOfSpec(spec: SeedNode): string {
    const raw = String(spec.ratio || "").trim();
    if (!raw) return "1:1";
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(raw)) return raw;
    return RATIO[raw] || "1:1";
}

function takeSeed(canvasId: string): HomeSeed | null {
    if (!canvasId) return null;
    const key = HOME_SEED_PREFIX + canvasId;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); localStorage.removeItem(key); } catch { return null; }
    if (!raw) return null;
    try {
        const seed: unknown = JSON.parse(raw);
        return seed && typeof seed === "object" ? (seed as HomeSeed) : null;
    } catch {
        return null;
    }
}

/** 读图片真实宽高：一张图挂了也只是退化成方块，不能让整列节点都等不到 */
function probeSize(url: string): Promise<[number, number]> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve([image.naturalWidth || 0, image.naturalHeight || 0]);
        image.onerror = () => resolve([0, 0]);
        image.src = url;
    });
}

function imagesOf(spec: SeedNode): Array<{ url: string; name: string }> {
    const out: Array<{ url: string; name: string }> = [];
    for (const image of Array.isArray(spec.images) ? spec.images : []) {
        const url = String(image?.url || "").trim();
        if (url) out.push({ url, name: String(image?.name || "").trim() });
    }
    return out.slice(0, MAX_IMAGES);
}

/** 一个 spec 翻译出来的东西：节点、需要补的分组框、连边锚点 */
type BuiltSpec = {
    nodes: CanvasNode[];
    /** 分组框要等成员定位完才能算框（frameOf），这里先留 id 和成员 */
    frame?: { id: string; text: string; children: CanvasNode[] };
    /** 连边时这个 spec 的 key 指向哪些节点（多张参考图要全部作为输入连下去） */
    anchors: string[];
    /** 批量生成没有对应节点，只提示用法 */
    batch?: boolean;
};

/** 图片槽位：有几张铺几个节点；没有图就是空槽位（uploaded:true 的空图片节点就是「把图拖进来」的入口） */
async function imageNodes(store: CanvasStore, spec: SeedNode): Promise<CanvasNode[]> {
    const images = imagesOf(spec);
    if (!images.length) return [store.newNode("image", 0, 0, { title: spec.title || "参考图", uploaded: true, w: IMAGE_W, h: IMAGE_W })];
    const made: CanvasNode[] = [];
    for (const image of images) {
        const [w, h] = await probeSize(image.url);
        const height = w > 0 && h > 0 ? Math.round(Math.max(100, Math.min(520, IMAGE_W * h / w))) : FALLBACK_H;
        made.push(store.newNode("image", 0, 0, { title: image.name || spec.title || "参考图", uploaded: true, hist: [{ url: image.url, w, h }], w: IMAGE_W, h: height }));
    }
    return made;
}

async function buildSpec(store: CanvasStore, spec: SeedNode): Promise<BuiltSpec> {
    const type = String(spec.type || "image");
    if (type === "gen") {
        const video = spec.video === true;
        const kind = video ? "video" : "image";
        const ratio = ratioOfSpec(spec);
        // 参数用「全量默认值 + 覆盖比例」：节点自己的参数在创建时就要完整，不靠读的时候回落全局默认
        const params = video
            ? { ...(defaultParams("video", store.defaultModel("video")) as VideoParams), ratio, dur: 5 }
            : { ...(defaultParams("image", store.defaultModel("image")) as ImageParams), ratio };
        // 只建节点不运行：模板是搭好流程让用户自己点「运行」
        const node = store.newNode(kind, 0, 0, { title: spec.title || (video ? "视频" : "图片"), prompt: String(spec.prompt || ""), params });
        return { nodes: [node], anchors: [node.id] };
    }
    if (type === "text") {
        const text = String(spec.text || "");
        // brief 节点装的是首页输入框那句话，给个「创作说明」的名字比「文本」更像人话
        const title = spec.title || (spec.brief ? "创作说明" : text.trim().slice(0, 16) || "文本");
        const node = store.newNode("text", 0, 0, { title, manual: true, hist: [{ text }], w: TEXT_W, h: TEXT_H });
        return { nodes: [node], anchors: [node.id] };
    }
    if (type === "label") {
        // 便签是 BEAT 里最接近「标题胶囊」的可见形态：分组框只是容器、不承载文字，便签能直接写标题并读得到
        const text = String(spec.text || spec.title || "");
        const node: CanvasNode = { id: uid("n"), kind: "note", x: 0, y: 0, w: LABEL_W, h: LABEL_H, text };
        return { nodes: [node], anchors: [node.id] };
    }
    if (type === "table") {
        const title = spec.title || "多维表格";
        const node = withTable({ id: uid("t"), kind: "table", x: 0, y: 0, w: TABLE_W, h: TABLE_H, text: title }, { ...emptyTable(), title });
        return { nodes: [node], anchors: [node.id] };
    }
    if (type === "batch") {
        // BEAT 没有「批量生成输入」节点：批量出图是表格自带的能力，多建一个空节点只会让人不知道拿它干嘛
        return { nodes: [], anchors: [], batch: true };
    }
    if (type === "group") {
        const hasImages = imagesOf(spec).length > 0;
        const kids = await imageNodes(store, spec);
        if (!hasImages) {
            // BEAT 的分组是「给已有节点画框」的容器：没有子节点就算不出框，空组只能降级成同名的拖图槽位
            return { nodes: kids, anchors: kids.map((n) => n.id) };
        }
        const id = uid("g");
        // 连下游时用框当一个输入：BEAT 会把分组展开成组内节点（expandGroupInputs），多张图不用逐条连
        return { nodes: kids, frame: { id, text: spec.title || "分组", children: kids }, anchors: [id] };
    }
    const nodes = await imageNodes(store, spec);
    return { nodes, anchors: nodes.map((n) => n.id) };
}

/** 按 col 分列：列内自上而下 48，列间 140，各列垂直居中到最高那一列（和旧智能画布的摆法一致） */
function layoutColumns(columns: Map<number, CanvasNode[]>): CanvasNode[] {
    const cols = [...columns.keys()].sort((a, b) => a - b);
    const widthOf = new Map<number, number>();
    const heightOf = new Map<number, number>();
    for (const col of cols) {
        const list = columns.get(col) || [];
        widthOf.set(col, Math.max(...list.map((n) => n.w)));
        heightOf.set(col, list.reduce((sum, n) => sum + n.h, 0) + ROW_GAP * Math.max(0, list.length - 1));
    }
    const tallest = Math.max(0, ...cols.map((col) => heightOf.get(col) || 0));
    let x = 0;
    for (const col of cols) {
        let y = Math.round((tallest - (heightOf.get(col) || 0)) / 2);
        for (const node of columns.get(col) || []) { node.x = Math.round(x); node.y = Math.round(y); y += node.h + ROW_GAP; }
        x += (widthOf.get(col) || 0) + COL_GAP;
    }
    return cols.flatMap((col) => columns.get(col) || []);
}

function viewportSize(): { width: number; height: number } {
    const rect = document.getElementById("stage")?.getBoundingClientRect();
    return { width: Math.max(320, Math.round(rect?.width || window.innerWidth)), height: Math.max(240, Math.round(rect?.height || window.innerHeight)) };
}

/** 视口居中到包围盒：Viewport 的变换是 translate(view.x) scale(view.k)，即 screen = world * k + view。返回这次用的视口宽度 */
function centerView(store: CanvasStore, nodes: CanvasNode[]): number {
    if (!nodes.length) return 0;
    const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
    const x1 = Math.max(...nodes.map((n) => n.x + n.w)), y1 = Math.max(...nodes.map((n) => n.y + n.h));
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const rect = viewportSize();
    // 内容比视口大就缩到能看全（模板里一列 5 个节点很容易超出），否则保持 100%
    const k = Math.min(1, (rect.width * 0.86) / bw, (rect.height * 0.86) / bh);
    const scale = Math.max(0.2, Math.round(k * 100) / 100);
    store.setView({ x: Math.round(rect.width / 2 - (x0 + bw / 2) * scale), y: Math.round(rect.height / 2 - (y0 + bh / 2) * scale), k: scale });
    return rect.width;
}

/**
 * 打开助手面板会把 #stage 挤窄，而且抽屉是几百毫秒才滑完的动画：先按当前宽度居中（内容立刻可见），
 * 等宽度稳定下来再按最终宽度补一次，否则内容会偏左大半个面板。
 * 用「宽度稳定 + 最短等待」而不是固定延时：面板可能压根不开（窄窗口会强制收起），这时就是空等。
 */
function centerWhenSettled(store: CanvasStore, nodes: CanvasNode[]): void {
    centerView(store, nodes);
    const stage = document.getElementById("stage");
    if (!stage) return;
    const start = performance.now();
    let last = Math.round(stage.getBoundingClientRect().width);
    let stableSince = start;
    const tick = () => {
        const now = performance.now();
        const width = Math.round(stage.getBoundingClientRect().width);
        if (width !== last) { last = width; stableSince = now; }
        if ((now - stableSince >= 250 && now - start >= 700) || now - start > 2500) { centerView(store, nodes); return; }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

/** 铺完后选谁：有生成节点就选第一个生成节点（和旧智能画布一致），只有参考图就全选它们（助手要拿它们当上下文） */
function pickSelection(rows: Array<{ spec: SeedNode; built: BuiltSpec }>): string[] {
    const gen = rows.find((row) => row.spec.type === "gen" && row.built.anchors.length);
    if (gen) return [gen.built.anchors[0]];
    const images = rows.flatMap((row) => row.built.nodes.filter((n) => n.kind === "image").map((n) => n.id));
    if (images.length) return images;
    const first = rows.find((row) => row.built.nodes.length)?.built.nodes[0];
    return first ? [first.id] : [];
}

/** 把种子的节点规格铺成 BEAT 节点，返回铺出来的节点（空数组 = 没铺） */
async function placeSeed(store: CanvasStore, seed: HomeSeed): Promise<CanvasNode[]> {
    const specs = (Array.isArray(seed.nodes) ? seed.nodes : []).filter((spec) => !!spec && typeof spec === "object").slice(0, 24);
    if (!specs.length) return [];
    const rows: Array<{ spec: SeedNode; built: BuiltSpec }> = [];
    const columns = new Map<number, CanvasNode[]>();
    const anchors = new Map<string, string[]>();
    for (const spec of specs) {
        const built = await buildSpec(store, spec);
        rows.push({ spec, built });
        const key = String(spec.key || "").trim();
        if (key && built.anchors.length) anchors.set(key, built.anchors);
        if (!built.nodes.length) continue;
        const col = Math.max(0, Math.min(6, Number(spec.col) || 0));
        columns.set(col, [...(columns.get(col) || []), ...built.nodes]);
    }
    const placed = layoutColumns(columns);
    // 分组框要按成员最终位置算：位置定完再框，否则框会建在原点
    const frames: CanvasNode[] = [];
    for (const row of rows) {
        const frame = row.built.frame;
        if (!frame || !frame.children.length) continue;
        frames.push({ id: frame.id, kind: "group", ...frameOf(frame.children), text: frame.text, children: frame.children.map((n) => n.id) });
    }
    const all = [...placed, ...frames];
    if (!all.length) return [];
    store.addNodes(all, [], { select: false });
    // 连边放在节点落盘之后：connect 要按 id 找节点，还会顺手把视频生成方式 / 表格尺寸调到合理值
    for (const row of rows) {
        const targets = row.built.anchors;
        if (!targets.length) continue;
        for (const key of Array.isArray(row.spec.inputs) ? row.spec.inputs : []) {
            for (const from of anchors.get(String(key || "")) || []) {
                for (const to of targets) {
                    if (from === to || !store.node(from) || !store.node(to)) continue;
                    connect(store, from, to, { quiet: true, select: false });
                }
            }
        }
    }
    store.setUI({ sel: new Set(pickSelection(rows)), edge: null });
    centerView(store, all);
    if (rows.some((row) => row.built.batch)) store.toast("批量出图在 BEAT 里由表格自带：表格里每行写一句需求，再用表格的批量出图运行", 5000);
    return all;
}

/**
 * 消费首页种子：只给空画布铺节点（已画过的画布不能被动），然后打开助手并把第一句交出去。
 * 返回 null = 没有种子、也没有文字和技能，调用方不用改草稿。
 */
export async function consumeHomeSeed(store: CanvasStore): Promise<AgentDraft | null> {
    const seed = takeSeed(store.state.canvasId);
    if (!seed) return null;
    const text = String(seed.agent || "").trim();
    const skillRef = normalizeSkillRef(seed.skillRef);
    const placed: CanvasNode[] = store.state.doc.nodes.length ? [] : await placeSeed(store, seed);
    if (placed.length) {
        if (seed.toast) store.toast(String(seed.toast), 5000);
        // 节点必须先有服务端版本再交给助手：助手任务终结会 refreshAuthoritative()，本端还挂着
        // 800ms 延时保存就会被判成「未保存编辑」而跳过一次刷新；更糟的是助手先在服务端写节点，
        // 本端再落盘就撞 409。保存失败不挡流程，交给原有提示。
        await store.saveNow().catch(() => undefined);
    }
    store.setUI({ agentOpen: true });
    if (placed.length) centerWhenSettled(store, placed);
    if (!text && !skillRef) return null;
    // 只给技能、没有文字也要把胶囊挂上；自动发送必须有文字，空需求不替用户发
    return { seq: Date.now(), text, autoSend: seed.autoSend === true && !!text, ...(skillRef ? { skillRef } : {}) };
}
