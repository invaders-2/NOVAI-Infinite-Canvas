/**
 * 「AI 生成角色」表单：填属性 → 依次生成四张纯白底设定图（角色立绘 / 肖像特写 / 表情九宫格 / 三视图）
 * → importAsset 入库 → saveElement 存成角色。不往画布建节点。
 *
 * 生成走 store.backend.generate（kind=image，count=1）；立绘先出，成功后作为后三张的参考图
 * （模型支持参考图时）。样式见 character.css，不在这里写内联配色。
 */
import { isAssetRef } from "../../canvasAssetRefs";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ELEMENT_ATTR_FIELDS, nameError, saveElement, type ElementAttrKey, type ElementAttrs } from "../elements";
import { nodeError } from "../errorText";
import type { GenInput } from "../backend/types";
import { defaultParams, type ImageParams, type ModelSpec } from "../model";
import { useStore } from "../store";
import type { Ctl } from "./ctx";
import { CHARACTER_OPTIONS } from "./characterOptions";
import { Icon } from "./Icon";
import { ImageViewer, type ViewItem } from "./ImageViewer";
import { openPop } from "./overlay";
import { PreviewImg, ThumbImg } from "./thumb";
import { resolveMediaUrl, useAssetUrl } from "./useAsset";
import { whitenBackground } from "./whiteBg";

const LABEL: Record<string, string> = Object.fromEntries([...ELEMENT_ATTR_FIELDS]) as Record<string, string>;
const FREE_FIELDS: Array<[ElementAttrKey, string, string]> = [
  ["scene", "场景 / 设定", "例如：雨夜长街；只用于角色气质，生成时仍是纯白背景"],
  ["feature", "辨识特征", "例如：左眉一道旧疤，随身带一块旧怀表"],
  ["outfit", "着装描述", "例如：深色立领长外套，袖口有磨损的铜扣，腰间工具袋"],
];

/** 四张图：固定顺序 = 元素 refs 顺序 */
const SHOTS = [
  { title: "角色立绘", ratio: "3:4", body: "全身模特档案照（full body digitals）：正面站立，双手自然垂在身侧或轻握、双脚与肩同宽，不摆时尚姿势，从头到脚完整入画不裁切。单张单画面：只画这一个人物、一个视图，不要拼图、不要分栏、不要多图并排、不要额外的小图或局部放大图" },
  { title: "肖像特写", ratio: "3:4", body: "正面大头照（front-facing casting headshot）：头肩构图，正面平视，表情自然放松（不笑或极轻微笑），没有复杂妆造。单张单画面：只画这一个人物；不要拼图、不要分栏、不要多图并排" },
  { title: "表情九宫格", ratio: "3:4", body: "3×3 九格等分、纯白留白分隔的模特档案表情表：同一角色、同一光位、同一身服装，九种表情依次为中性、轻微笑、大笑、惊讶、生气、难过、疑惑、害羞、疲惫，每格都是正面头肩档案照" },
  { title: "三视图", ratio: "16:9", body: "角色三视图档案照：只画三个视图——正面、正侧面、背面，从左到右并排等大，不要第四张、不要 3/4 侧面；全身站姿，同一均匀柔光" },
] as const;
/* 经纪公司模特档案照口径。否定句刻意避开了验收禁用的那几个词，意思不变：
   不是杂志编辑拍摄、不是商业人像广告、不是化妆品广告。 */
const STYLE = "纪实写实风格的经纪公司模特档案照（real agency model digitals），正面 casting headshot；素颜或极淡自然妆但有气色，五官自然协调、好看但不做网红审美；不做造型摆拍，不是杂志编辑拍摄、不是商业人像广告";
const BG = "纯白色背景（pure white seamless, #FFFFFF），无环境、无道具、无文字、无水印、无边框、无网格线";
const SKIN = "皮肤质感呈现高度真实的自然不均匀纹理，清晰可见细微毛孔（鼻翼与面颊内侧更明显、分布不均匀），具备真实的皮肤通透感与血色：脸颊与鼻尖有淡淡的自然红润，唇色自然有血色、唇纹清晰，颈部与耳廓有真实血色过渡，眼下轻微暗沉但不青不灰；拒绝任何磨皮或美颜处理，不要苍白、不要灰调、不要蜡黄";
const LIGHT = "镜头前上方大面积柔光源（large soft source above and slightly in front of camera），受光均匀，鼻翼两侧、眼下、下巴保留很柔和的自然阴影；不要把面部阴影填平，额头、鼻梁、脸颊不要出现强烈高光（避免蜡质感）；让脸颊与鼻尖保留自然血色与明暗过渡";
const COLOR = "纪实写实风格，色调真实自然（true-to-life neutral color），电影感但对比度克制、不过度夸张；白平衡自然，皮肤不被压灰也不被环境染色，高光不溢出、暗部有细节";
const LENS = "接近 85mm 人像视角，减少鼻子放大与脸型变形；光圈 f/5.6，眼睛、鼻子、嘴唇、发际线都在清晰范围内";
const IMPERFECT = "故意保留一点相机的不完美：轻微传感器颗粒（subtle sensor grain）、克制的微对比（restrained microcontrast）、边缘轻微光学柔度（slight optical softness）、真实 JPEG 成像质感（realistic JPEG texture）；不要每根头发每个毛孔都锐利得像贴图，不要过度锐化";
const PHOTO = "全图追求极致的照片级真实感，严禁任何 CGI 渲染感、3D 渲染感与数字优化痕迹（no CGI look, no digital retouch artifacts）";
const SAME = "同一角色：五官、发型、发色、服装与配饰保持一致";
/** 用户上传参考图：最多 3 张、单张 10MB，有参考图时提示词追加一句 */
const MAX_USER_REFS = 3;
const MAX_REF_BYTES = 10 * 1024 * 1024;
const REF_NOTE = "以参考图中人物的五官、发型、体型为准，保持同一角色。";

type Form = { name: string; attrs: ElementAttrs; extra: string };
type StepState = "idle" | "running" | "done" | "error";
type StepRun = { state: StepState; progress: number; error?: string; url?: string };
const IDLE_STEPS: StepRun[] = SHOTS.map(() => ({ state: "idle", progress: 0 }));

const describe = (form: Form) => {
  const a = form.attrs;
  const said = [
    a.gender && "性别：" + a.gender, a.age && "年龄段：" + a.age, a.species && "物种：" + a.species,
    a.build && "体格：" + a.build, a.height && "身高：" + a.height, a.skin && "肤色：" + a.skin,
    a.hairLen && "发长：" + a.hairLen, a.hairColor && "发色：" + a.hairColor, a.vibe && "气质：" + a.vibe,
    a.era && "时代风格：" + a.era,
    a.scene && "设定：" + a.scene, a.feature && "辨识特征：" + a.feature, a.outfit && "着装：" + a.outfit,
    form.extra && "补充：" + form.extra,
  ].filter(Boolean).join("；");
  return `角色「${form.name.trim()}」${said ? "：" + said : ""}。`;
};
/** Midjourney：比例要靠提示词里的 --ar 才生效（不传就出方图） */
const isMJ = (m: ModelSpec) => !!m.mj || /midjourney|\bmj\b/i.test(m.id + " " + m.name);
/** MJ 专属：上镜的模特脸（放在主体之后、--ar 之前）+ --style raw */
const MJ_FACE = "上镜的模特脸：五官比例协调对称、面部轮廓清晰、眼神有光，photogenic model face, symmetrical features, editorial casting。";
/** 参考图（图生图 / 编辑通道）单步超时：150s；超时算失败、可重试，后面的步骤继续跑 */
const EDIT_TIMEOUT_MS = 150_000;
/** 带参考图时立绘会被参考图构图带跑，补一句强制全身 */
const FULL_BODY_NOTE = "无论参考图怎样构图，本张必须是完整全身、从头顶到脚底全部入画、不要裁切";
const promptFor = (form: Form, i: number, model: ModelSpec, withUserRefs = false) => {
  const shotBody = i === 0 && withUserRefs ? `${SHOTS[0].body}。${FULL_BODY_NOTE}` : SHOTS[i].body;
  const base = `${describe(form)}${STYLE}。${shotBody}。${SKIN}。${LIGHT}。${COLOR}。${LENS}。${IMPERFECT}。${PHOTO}。${BG}。${SAME}。${withUserRefs ? REF_NOTE : ""}`;
  if (!isMJ(model)) return base;
  let out = `${base} ${MJ_FACE}`;
  if (!/--style\s+raw/i.test(out)) out += " --style raw";
  if (!/--ar\s+\S+/i.test(out)) out += ` --ar ${ratioFor(model, SHOTS[i].ratio)}`;
  return out;
};

/** 模型没声明想要的比例时，找一个同方向的（竖图 / 横图），都没有就用它的第一个 */
function ratioFor(m: ModelSpec, want: string): string {
  const list = m.ratios || [];
  if (!list.length || list.includes(want)) return want;
  const [w, h] = want.split(":").map(Number);
  const sameDir = list.find((r) => { const p = r.split(":").map(Number); return p.length === 2 && p[0] > 0 && p[1] > 0 && (w > h ? p[0] > p[1] : p[0] < p[1]); });
  return sameDir || list[0];
}
const isStopped = (e: unknown) => { const m = (e as { code?: string; name?: string } | null) || {}; return m.code === "STOPPED" || m.name === "AbortError"; };
/** 模型能不能吃参考图（i2i 且还有名额） */
const refOk = (m: ModelSpec | undefined) => !!m && !!m.i2i && (m.maxRefs ?? 0) > 0;
/** 模型的供应商（后端没写时归到「未标注供应商」） */
const vendorOf = (m: ModelSpec) => m.vendor || "未标注供应商";
/** 尺寸档：4K 优先，否则按数值取最高档（模型没给可解析档位时用它最后一档） */
const has4K = (m: ModelSpec | undefined) => !!m && (m.sizes || []).some((s) => /^4\s*k$/i.test(String(s).trim()));
const sizeRank = (raw: string) => {
  const t = String(raw).trim().toLowerCase();
  const k = /^([\d.]+)\s*k$/.exec(t); if (k) return Number(k[1]) * 1000;
  const p = /^([\d.]+)\s*p$/.exec(t); if (p) return Number(p[1]);
  const mp = /^([\d.]+)\s*mp$/.exec(t); if (mp) return Number(mp[1]) * 1000;
  return NaN;
};
function bestSize(m: ModelSpec | undefined): string {
  const list = m?.sizes || [];
  if (!list.length) return "1K";
  const four = list.find((s) => /^4\s*k$/i.test(String(s).trim()));
  if (four) return four;
  let best = list[list.length - 1]; let top = NaN;
  for (const s of list) { const r = sizeRank(s); if (Number.isNaN(r)) continue; if (Number.isNaN(top) || r > top) { best = s; top = r; } }
  return best;
}
/**
 * 默认模型（用户没手动改过时）：
 *   1) 画布记住的模型支持 4K → 用它
 *   2) 4K 模型里优先 gpt-image-2.5，其次 nano banana / gemini image
 *   3) 其余 4K 里取 maxRefs 最多的
 *   4) 没有 4K → 记住的 / 列表第一个
 */
function pickDefaultModel(models: ModelSpec[], rememberedId: string): ModelSpec | undefined {
  const remembered = models.find((m) => m.id === rememberedId);
  if (has4K(remembered)) return remembered;
  const four = models.filter(has4K);
  const named = (re: RegExp) => four.find((m) => re.test(m.id + " " + m.name));
  const preferred = named(/gpt[-_ ]?image[-_ ]?2[._-]?5/i) || named(/nano.?banana|gemini.*image/i);
  if (preferred) return preferred;
  if (four.length) return four.reduce((a, b) => ((b.maxRefs ?? 0) > (a.maxRefs ?? 0) ? b : a), four[0]);
  return remembered || models[0];
}

/** 产物入库：bridge 生成时可能已经转了 novai-asset 引用；data URL 走 importAsset，外链走 importRemote */
async function persistOutput(ctl: Ctl, url: string, name: string): Promise<string> {
  const be = ctl.store.backend; const canvasId = ctl.store.state.canvasId;
  if (isAssetRef(url)) return url;
  if (/^https?:\/\//i.test(url) && be.importRemote) {
    try { return (await be.importRemote(canvasId, url, name)) || url; } catch { return url; }
  }
  try { return (await be.importAsset(canvasId, url, name)) || url; } catch { return url; }
}

/* ---------- 生成任务集合：弹窗被外部卸载（保存冲突 / UI 重置）时不中断，各自继续跑并落库 ---------- */
type JobSpec = { name: string; model: ModelSpec; form: Form; refs: string[]; whiten: boolean };
type PersistedJob = { id: string; spec: JobSpec; steps: StepRun[]; urls: string[]; startedAt: number };
type Job = { id: string; spec: JobSpec; ctl: Ctl | null; active: boolean; steps: StepRun[]; urls: string[]; abort: AbortController | null; saving: boolean; savedId: string | null; error: string; startedAt: number };
export type CharacterJobView = { id: string; active: boolean; name: string; steps: StepRun[]; done: number; failed: boolean; saving: boolean; savedId: string | null; error: string; startedAt: number };
const JOBS_KEY = "canvas-next:chgen:jobs";
/** 旧版单任务键：只读一次做迁移，迁移后删掉 */
const LEGACY_JOB_KEY = "canvas-next:chgen:job";
const jobs = new Map<string, Job>();
/** 快照只在 emit 时重建：useSyncExternalStore 要求同一份数据返回同一个引用 */
let jobsSnap: CharacterJobView[] = [];
const jobSavedCbs = new Map<string, (id: string) => void>();
const jobSubs = new Set<() => void>();
const makeJobId = () => "ch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function decodeJob(raw: unknown): PersistedJob | null {
  const saved = raw as Partial<PersistedJob> | null;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const spec = saved.spec as JobSpec | undefined;
  if (!spec || typeof spec !== "object") return null;
  if (typeof spec.name !== "string" || !spec.name.trim()) return null;
  if (!spec.form || typeof spec.form !== "object" || !spec.model || typeof spec.model !== "object") return null;
  if (!Array.isArray(saved.steps) || !Array.isArray(saved.urls)) return null;
  const form = spec.form as Partial<Form>;
  const steps = SHOTS.map((_, i): StepRun => {
    const s = saved.steps?.[i] as StepRun | undefined;
    if (!s || typeof s !== "object") return { state: "idle", progress: 0 };
    if (s.state === "running") return { state: "idle", progress: 0 };
    return { ...s };
  });
  const urls = SHOTS.map((_, i) => (typeof saved.urls?.[i] === "string" ? saved.urls[i] : ""));
  return {
    id: typeof saved.id === "string" && saved.id ? saved.id : makeJobId(),
    spec: {
      ...spec,
      form: { name: typeof form.name === "string" ? form.name : spec.name, attrs: { ...(form.attrs && typeof form.attrs === "object" ? form.attrs : {}) }, extra: typeof form.extra === "string" ? form.extra : "" },
      refs: Array.isArray(spec.refs) ? spec.refs.filter((r): r is string => typeof r === "string") : [],
      whiten: spec.whiten !== false,
    },
    steps,
    urls,
    startedAt: typeof saved.startedAt === "number" && saved.startedAt > 0 ? saved.startedAt : Date.now(),
  };
}
/** 读存储：优先新数组；没有新键时把旧的单对象迁成一条。坏数据整条丢弃 */
export function decodeJobs(rawNew: string | null, rawOld: string | null): PersistedJob[] {
  const parse = (raw: string | null): unknown => { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
  const next = parse(rawNew);
  if (Array.isArray(next)) return next.map(decodeJob).filter((j): j is PersistedJob => !!j);
  const migrated = decodeJob(parse(rawOld));
  return migrated ? [migrated] : [];
}
const persistJobs = () => {
  try {
    if (!jobs.size) { localStorage.removeItem(JOBS_KEY); return; }
    const out = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
      .map((j) => ({ id: j.id, spec: j.spec, steps: j.steps, urls: j.urls, startedAt: j.startedAt }));
    localStorage.setItem(JOBS_KEY, JSON.stringify(out));
  } catch { /* 配额 / 隐私模式：内存里继续跑 */ }
};
const jobViewOf = (j: Job): CharacterJobView => ({
  id: j.id, active: j.active, name: j.spec.name, steps: j.steps, saving: j.saving, savedId: j.savedId, error: j.error, startedAt: j.startedAt,
  done: j.steps.filter((s) => s.state === "done").length, failed: j.steps.some((s) => s.state === "error"),
});
const jobEmit = () => {
  jobsSnap = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt).map(jobViewOf);
  persistJobs();
  for (const fn of jobSubs) fn();
};
function restoreJobs() {
  let rawNew: string | null = null; let rawOld: string | null = null;
  try { rawNew = localStorage.getItem(JOBS_KEY); rawOld = localStorage.getItem(LEGACY_JOB_KEY); } catch { return; }
  const saved = decodeJobs(rawNew, rawOld);
  if (rawOld) { try { localStorage.removeItem(LEGACY_JOB_KEY); } catch { /* ignore */ } }
  if (!saved.length) return;
  for (const p of saved) {
    jobs.set(p.id, { id: p.id, spec: p.spec, ctl: null, active: false, steps: p.steps, urls: p.urls, abort: null, saving: false, savedId: null, error: "", startedAt: p.startedAt });
  }
  jobEmit();
}
restoreJobs();
const jobSubscribe = (fn: () => void) => { jobSubs.add(fn); return () => { jobSubs.delete(fn); }; };
const jobGetSnapshot = () => jobsSnap;
/** 每个任务一个「生成完自动开详情」回调；窗口卸载时只清掉自己那颗任务 */
export function setCharacterJobHandler(jobId: string, cb: ((id: string) => void) | null) {
  if (cb) jobSavedCbs.set(jobId, cb); else jobSavedCbs.delete(jobId);
}
const jobStep = (jobId: string, i: number, patch: Partial<StepRun>) => { const j = jobs.get(jobId); if (!j) return; j.steps = j.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)); jobEmit(); };
const buildJobInputs = (spec: JobSpec, i: number, portrait: string | null): GenInput[] => {
  if (!refOk(spec.model)) return [];
  const cap = Math.max(0, spec.model.maxRefs ?? 0);
  const out: GenInput[] = [];
  if (i > 0 && portrait) out.push({ nodeId: "char:ref", title: "角色立绘", kind: "image", order: 1, role: "reference", url: portrait });
  for (let k = 0; k < spec.refs.length && out.length < cap; k++) out.push({ nodeId: "char:user:" + k, title: "参考图 " + (k + 1), kind: "image", order: out.length + 1, role: "reference", url: spec.refs[k] });
  return out;
};
async function saveJob(jobId: string) {
  const j = jobs.get(jobId); if (!j || !j.ctl) return;
  j.saving = true; j.error = ""; jobEmit();
  try {
    // 兜底：老逻辑漏填时代时归到「当代现实」，别落进未分类
    const attrs = { ...j.spec.form.attrs, era: j.spec.form.attrs.era || "当代现实" };
    const el = saveElement({ name: j.spec.name, kind: "character", desc: j.spec.form.extra.trim(), refs: j.urls, attrs });
    const ctl = j.ctl;
    const done = jobSavedCbs.get(jobId);
    j.saving = false; j.savedId = el.id;
    ctl.store.toast(`角色「${j.spec.name}」已生成并入库`);
    // 只删这一颗任务：其他并行任务不受影响
    jobs.delete(jobId); jobSavedCbs.delete(jobId); jobEmit();
    done?.(el.id);
  } catch (e) {
    const cur = jobs.get(jobId); if (!cur) return;
    cur.saving = false;
    cur.error = e instanceof Error ? e.message : "保存角色失败";
    jobEmit();
  }
}
async function runJob(jobId: string, indexes: number[]) {
  const j = jobs.get(jobId); if (!j || j.active || !j.ctl) return;
  const ctl = j.ctl;
  j.active = true; j.error = ""; jobEmit();
  let stopped = false;
  for (const i of indexes) {
    if (jobs.get(jobId) !== j) return;
    const ac = new AbortController(); j.abort = ac;
    jobStep(jobId, i, { state: "running", progress: 0, error: undefined });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const portrait = i === 0 ? null : j.urls[0] || null;
      const inputs = buildJobInputs(j.spec, i, portrait);
      const prompt = promptFor(j.spec.form, i, j.spec.model, inputs.some((x) => x.nodeId.startsWith("char:user:")));
      const m = j.spec.model;
      const params = { ...(defaultParams("image", m) as ImageParams), ratio: ratioFor(m, SHOTS[i].ratio), size: bestSize(m), count: 1 };
      const pending = ctl.store.backend.generate({ canvasId: ctl.store.state.canvasId, nodeId: "char:" + Date.now().toString(36) + ":" + i, kind: "image", model: m, prompt, resolvedPrompt: prompt, params, inputs },
        (e) => { if (e.type === "progress") jobStep(jobId, i, { progress: e.progress }); }, ac.signal);
      // 编辑通道（有参考图）单独加超时：卡住就当失败，后续步骤照常跑
      const guard = inputs.length ? new Promise<never>((_, no) => {
        timer = setTimeout(() => { timedOut = true; ac.abort(); no(new Error("EDIT_TIMEOUT")); }, EDIT_TIMEOUT_MS);
      }) : null;
      const res = await (guard ? Promise.race([pending, guard]) : pending);
      const out = res.outputs.find((o) => o.url) || res.outputs[0];
      if (!out?.url) throw new Error("模型没有返回图片");
      let raw = out.url;
      if (j.spec.whiten) {
        // 入库前把模型没听话的浅灰底刷成纯白；处理失败自动回落原图
        const resolved = isAssetRef(raw) ? (await resolveMediaUrl(ctl.store.backend, raw)) || raw : raw;
        raw = await whitenBackground(resolved);
      }
      const url = await persistOutput(ctl, raw, `${j.spec.name}-${SHOTS[i].title}`);
      if (jobs.get(jobId) !== j) return;
      j.urls[i] = url; jobStep(jobId, i, { state: "done", progress: 1, url });
    } catch (e) {
      if (jobs.get(jobId) !== j) return;
      if (timedOut) jobStep(jobId, i, { state: "error", progress: 0, error: "参考图生成超时，可重试" });
      else {
        stopped = isStopped(e);
        jobStep(jobId, i, { state: "error", progress: 0, error: stopped ? "已停止" : nodeError(e).err });
      }
      if (stopped) break;
    } finally {
      if (timer) clearTimeout(timer);
      if (j.abort === ac) j.abort = null;
    }
  }
  if (jobs.get(jobId) !== j) return;
  j.abort = null; j.active = false;
  if (!stopped && j.urls.length === SHOTS.length && j.urls.every(Boolean)) await saveJob(jobId);
  else jobEmit();
}
/** 每次都是全新任务（不复用同名任务的进度），返回任务 id，表单用它附着到这颗任务 */
export function startCharacterJob(ctl: Ctl, spec: JobSpec, indexes: number[]): string {
  let id = makeJobId();
  while (jobs.has(id)) id = makeJobId();
  jobs.set(id, { id, spec, ctl, active: false, saving: false, savedId: null, error: "", abort: null, startedAt: Date.now(),
    steps: SHOTS.map(() => ({ state: "idle", progress: 0 })), urls: SHOTS.map(() => "") });
  jobEmit();
  void runJob(id, indexes);
  return id;
}
export function retryCharacterJob(jobId: string, ctl: Ctl, spec: JobSpec, i: number) {
  const j = jobs.get(jobId); if (!j || j.active) return;
  j.spec = spec; j.ctl = ctl; j.error = "";
  void runJob(jobId, [i]);
}
export function saveCharacterJob(jobId: string, spec?: JobSpec, ctl?: Ctl) {
  const j = jobs.get(jobId); if (!j || j.active) return;
  if (spec) j.spec = spec;
  // 重载后任务的 ctl 是空的：从打开它的窗口借一个，手动「保存角色」才发得出去
  if (ctl) j.ctl = ctl;
  void saveJob(jobId);
}
export function cancelCharacterJob(jobId: string) {
  const j = jobs.get(jobId); if (!j) return;
  const ac = j.abort; jobs.delete(jobId); jobSavedCbs.delete(jobId); jobEmit(); ac?.abort();
}
/** 重载 / 失败后继续：已完成（urls 有值）的步骤跳过，其余重跑；全部完成则只补保存 */
export function resumeCharacterJob(ctl: Ctl, jobId: string) {
  const j = jobs.get(jobId); if (!j || j.active) return;
  if (!ctl.store.backend.available()) { ctl.store.toast("画布后端未连接，暂时不能继续生成"); return; }
  j.ctl = ctl;
  const pending = j.steps.map((_, i) => i).filter((i) => !j.urls[i]);
  if (!pending.length) { void saveJob(jobId); return; }
  void runJob(jobId, pending);
}
/** 角色库头部用：所有还没入库的任务，按开始时间升序（生成中的排后面也不会跳位） */
export function useCharacterJobs(): CharacterJobView[] {
  return useSyncExternalStore(jobSubscribe, jobGetSnapshot);
}

export function GenerateCharacter({ ctl, defaultEra, jobId, onClose, onSaved }: { ctl: Ctl; defaultEra?: string; jobId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  // attachId = 这个窗口当前附着的任务；null = 空白新表单（点头部的「AI 生成角色」进来的默认状态）
  const [attachId, setAttachId] = useState<string | null>(jobId ?? null);
  // 附着任务时表单初值取那颗任务的 spec；空白表单时代必选，默认取打开时左栏选中的分类
  const openedJob = jobId ? jobs.get(jobId) : null;
  const [form, setForm] = useState<Form>(() => openedJob
    ? { name: openedJob.spec.name, attrs: { ...openedJob.spec.form.attrs }, extra: openedJob.spec.form.extra }
    : { name: "", attrs: { era: defaultEra || "当代现实" }, extra: "" });
  // 纯白背景后处理默认开，状态记住
  const [whiten, setWhiten] = useState<boolean>(() => openedJob ? openedJob.spec.whiten : (() => { try { return localStorage.getItem("canvas-next:chgen:whiten") !== "0"; } catch { return true; } })());
  // 空 = 还没手动选过（自动按「记住的 4K > gpt-image-2.5 / nano banana > maxRefs 最多」挑）；手动改过就尊重用户
  const [modelId, setModelId] = useState<string>(() => openedJob?.spec.model.id || "");
  // null = 跟随当前模型的供应商；用户选了供应商只影响候选，不写记忆
  const [vendorSel, setVendorSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // 任务在模块级集合里：组件卸载后各自继续跑；从头部 chip 进来时附着到那颗任务
  const jobView = useCharacterJobs().find((j) => j.id === attachId) || null;
  const busy = !!jobView?.active;
  const steps = jobView?.steps ?? IDLE_STEPS;
  const [view, setView] = useState<{ items: ViewItem[]; start: number } | null>(null);
  const [refs, setRefs] = useState<string[]>(() => openedJob ? [...openedJob.spec.refs] : []);
  const [uploading, setUploading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null); const fileRef = useRef<HTMLInputElement>(null);
  // 模型清单可能在面板打开后才加载完，订阅一下，避免一直显示「没有可用模型」
  const models = useStore(ctl.store, (s) => s.models).filter((m) => m.kind === "image");
  const remembered = ctl.store.defaultModel("image")?.id || "";
  const manualModel = modelId ? models.find((m) => m.id === modelId) : undefined;
  const model = manualModel || pickDefaultModel(models, remembered);
  const canRef = refOk(model);
  const vendor = vendorSel === null ? (model ? vendorOf(model) : "") : vendorSel;
  const vendorModels = vendor ? models.filter((m) => vendorOf(m) === vendor) : models;
  const vendors = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of models) map.set(vendorOf(m), (map.get(vendorOf(m)) || 0) + 1);
    return [...map.entries()];
  }, [models]);
  // 弹窗在不在只决定「要不要自动开详情」；组件卸载不取消任务（只有用户点停止/取消才 abort 那一颗）
  // 回调按任务登记：关掉这个窗口只清掉自己，别的任务完成后不会误开详情
  useEffect(() => {
    if (!attachId) return;
    setCharacterJobHandler(attachId, (id) => onSaved(id));
    return () => setCharacterJobHandler(attachId, null);
  }, [attachId, onSaved]);
  const openViewer = (i: number) => {
    const src = steps[i]?.url; if (!src) return;
    const items = steps.map((s, k) => ({ src: s.url || "", title: SHOTS[k].title, ratio: SHOTS[k].ratio })).filter((x) => x.src);
    setView({ items, start: Math.max(0, items.findIndex((x) => x.src === src)) });
  };
  const setAttr = (k: ElementAttrKey, v: string) => setForm((f) => ({ ...f, attrs: { ...f.attrs, [k]: v } }));
  // 名字要不要改：@引用 的名字限制和元素共用一套规则，边写边提示（不拦输入，只拦「开始生成」）
  const nameIssue = form.name.trim() ? nameError(form.name) : "";
  /** 当前表单 / 模型 / 参考图的快照：启动、重试、手动保存都用它（任务跑在模块里，不依赖组件还活着） */
  const specNow = (): JobSpec | null => (model ? { name: form.name.trim(), model, form: { ...form, attrs: { ...form.attrs } }, refs: [...refs], whiten } : null);

  const runSteps = (indexes: number[]) => {
    if (busy) return;
    const m = model;
    const nameBad = nameError(form.name);
    if (nameBad) { setErr(""); nameRef.current?.focus(); nameRef.current?.select(); return; }
    if (!ctl.store.backend.available()) { setErr("画布后端未连接，暂时不能生成；角色库之外的功能仍可用"); return; }
    if (!m) { setErr("还没有可用的图片模型：到 设置 › 模型 里添加一个再试"); return; }
    setErr("");
    // 每次点「生成四张」都是新任务，并附着到它：旧任务继续在后台跑
    const id = startCharacterJob(ctl, { name: form.name.trim(), model: m, form: { ...form, attrs: { ...form.attrs } }, refs: [...refs], whiten }, indexes);
    setAttachId(id);
    setCharacterJobHandler(id, (elId) => onSaved(elId));
  };
  const retry = (i: number) => {
    if (busy || !attachId || !jobView) return;
    const spec = specNow(); if (!spec) return;
    retryCharacterJob(attachId, ctl, spec, i);
  };

  const readDataUrl = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || "")); r.onerror = () => no(r.error || new Error("读取失败")); r.readAsDataURL(f); });
  /** 选图后立刻 importAsset 入库，state 里只存引用 */
  const addRefs = async (picked: File[]) => {
    if (!picked.length || busy) return;
    if (!canRef) { setErr("当前模型不支持参考图：换一个支持参考图的模型再上传"); return; }
    if (refs.length >= MAX_USER_REFS) { setErr("参考图最多 " + MAX_USER_REFS + " 张"); return; }
    setUploading(true); setErr("");
    const next = [...refs]; let skipped = 0; let msg = "";
    for (const f of picked) {
      if (next.length >= MAX_USER_REFS) { skipped++; continue; }
      if (!/^image\//.test(f.type)) { msg = "只能上传图片文件"; continue; }
      if (f.size > MAX_REF_BYTES) { msg = "「" + f.name + "」超过 10MB，已跳过"; continue; }
      try {
        const dataUrl = await readDataUrl(f);
        const ref = await persistOutput(ctl, dataUrl, (form.name.trim() || "角色") + "-参考图" + (next.length + 1));
        next.push(ref); setRefs([...next]);
      } catch { msg = "参考图读取失败，换一张试试"; }
    }
    setUploading(false);
    if (skipped) msg = "最多 " + MAX_USER_REFS + " 张参考图，已忽略 " + skipped + " 张";
    if (msg) setErr(msg);
  };

  const pickVendor = (anchor: HTMLButtonElement) => {
    if (busy || !models.length) return;
    openPop(anchor, (done) => <>
      <div className="mh">供应商</div>
      <button type="button" className={"mi" + (vendor ? "" : " on")} data-ch-vendor-option="" onClick={() => { done(); setVendorSel(""); }}>全部<span className="k">{models.length} 个模型</span></button>
      {vendors.map(([v, n]) => <button type="button" key={v} className={"mi" + (vendor === v ? " on" : "")} data-ch-vendor-option={v} onClick={() => { done(); setVendorSel(v); }}>{v}<span className="k">{n} 个模型</span></button>)}
    </>, "down", "left", "chgen-vendor-pop");
  };
  const pickModel = (anchor: HTMLButtonElement) => {
    if (busy) return;
    if (!models.length) { setErr("还没有可用的图片模型：到 设置 › 模型 里添加一个再试"); return; }
    openPop(anchor, (done) => <ModelMenu models={vendorModels} currentId={model?.id} onPick={(m) => { done(); setModelId(m.id); ctl.store.rememberModel("image", m.id); setErr(""); }} />, "down", "left", "chgen-model-pop");
  };

  /** 关闭弹窗但不打断生成：任务在模块级单例里继续跑，完成后照常入库 + toast（只有显式「停止并关闭」才 abort） */
  const dismiss = () => {
    if (busy) ctl.store.toast("生成已转到后台继续，可在 AI 角色库顶部查看进度");
    onClose();
  };
  const stopAndClose = () => { if (attachId) cancelCharacterJob(attachId); onClose(); };
  const canSave = !!jobView && !jobView.active && jobView.steps.every((s) => s.state === "done");
  const canResume = !!jobView && !jobView.active && !canSave;
  const saving = !!jobView?.saving;
  const shownErr = err || jobView?.error || "";
  return <div className="chgen-layer" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) dismiss(); }}>
    <div className="chgen" role="dialog" aria-label="AI 生成角色" onPointerDown={(ev) => ev.stopPropagation()}>
      <div className="chgen-hd"><b>{jobView ? `AI 生成角色 · ${jobView.name}` : "AI 生成角色"}</b><span className="chgen-sub">四张纯白底设定图，生成完自动入库</span><span className="sp" /><button className="chdt-ib" aria-label="关闭" onClick={dismiss}><Icon name="x" size="s" /></button></div>
      <div className="chgen-main">
        <div className="chgen-left">
        <div className="chgen-f wide"><span>名字（必填，之后用 @名字 引用）</span><input ref={nameRef} className="rg-input" autoFocus data-ch-gen-name aria-invalid={!!nameIssue} value={form.name} maxLength={20} placeholder="例如：墨青" disabled={busy} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setErr(""); }} onKeyDown={(e) => e.stopPropagation()} />{nameIssue ? <span className="chgen-hint" data-ch-gen-name-hint>{nameIssue}</span> : null}</div>
        <div className="chgen-f wide"><span>参考图（可选，最多 {MAX_USER_REFS} 张）</span>
          <div className={"chgen-refs" + (canRef ? "" : " off")} data-ch-gen-refs>
            {refs.map((r, i) => <span key={r + ":" + i} className="chgen-ref" data-ch-gen-ref={i}><RefThumb src={r} /><button type="button" className="chgen-ref-x" aria-label="移除这张参考图" data-ch-gen-ref-remove={i} disabled={busy || uploading} onClick={() => setRefs((prev) => prev.filter((_, k) => k !== i))}><Icon name="x" size="xs" /></button></span>)}
            {refs.length < MAX_USER_REFS ? <button type="button" className="chgen-ref-add" data-ch-gen-ref-add disabled={!canRef || busy || uploading} onClick={() => fileRef.current?.click()} title={canRef ? "选择参考图（单张 ≤ 10MB）" : "当前模型不支持参考图"}><Icon name="plus" size="s" /><span>{uploading ? "上传中…" : "上传"}</span></button> : null}
          </div>
          <span className={"chgen-hint2" + (canRef ? "" : " bad")}>{!canRef ? "当前模型不支持参考图：上传已禁用，换一个支持参考图的模型再传" : refs.length === 0 ? "单张不超过 10MB；会先存进资源库，再把引用发给模型" : model && refs.length > (model.maxRefs ?? 0) ? "当前模型最多 " + (model.maxRefs ?? 0) + " 张参考图，超出的不会发送" : "生成时以参考图中人物的五官、发型、体型为准"}</span>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const picked = e.target.files ? [...e.target.files] : []; e.target.value = ""; void addRefs(picked); }} />
        </div>
        <fieldset className="chgen-fields" disabled={busy}>
          <label className="chgen-opt" title="生成后自动把浅灰底刷成 #FFFFFF，主体内部不会被误伤">
            <input type="checkbox" data-ch-gen-white checked={whiten} onChange={(e) => { const v = e.target.checked; setWhiten(v); try { localStorage.setItem("canvas-next:chgen:whiten", v ? "1" : "0"); } catch { /* ignore */ } }} />
            <span>统一纯白背景（推荐）</span>
            <em>生成后把浅灰底刷成 #FFFFFF</em>
          </label>
          <div className="chgen-grid">
            {CHARACTER_OPTIONS.map(([k, values]) => <label key={k} className="chgen-f"><span>{LABEL[k] || k}</span><select className="rg-input" data-ch-gen-attr={k} value={form.attrs[k] || ""} onChange={(e) => setAttr(k, e.target.value)}>{k === "era" ? null : <option value="">不指定</option>}{values.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>)}
          </div>
          {FREE_FIELDS.map(([k, label, ph]) => <label key={k} className="chgen-f wide"><span>{label}</span><input className="rg-input" data-ch-gen-attr={k} value={form.attrs[k] || ""} maxLength={160} placeholder={ph} onChange={(e) => setAttr(k, e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>)}
          <label className="chgen-f wide"><span>补充描述（可选，会一起写进提示词和元素描述）</span><textarea className="rg-input" data-ch-gen-extra rows={2} value={form.extra} maxLength={300} placeholder="例如：随身带一块旧怀表，语气疏离" onChange={(e) => setForm((f) => ({ ...f, extra: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} /></label>
        </fieldset>
        </div>
        <div className="chgen-right">
          <div className="chgen-grid3">{SHOTS.slice(0, 3).map((shot, i) => <PreviewCard key={shot.title} shot={shot} run={steps[i]} busy={busy} onRetry={() => retry(i)} onZoom={() => openViewer(i)} />)}</div>
          <PreviewCard wide shot={SHOTS[3]} run={steps[3]} busy={busy} onRetry={() => retry(3)} onZoom={() => openViewer(3)} />
        </div>
      </div>
      <div className="chgen-ft">
        <div className="chgen-ft-left">
          {models.length ? <>
            <button type="button" className="rg-input chgen-model chgen-model-vendor" data-ch-gen-vendor aria-haspopup="menu" disabled={busy} title={vendor ? `${vendor} · ${vendorModels.length} 个模型` : `全部供应商 · ${models.length} 个模型`} onClick={(ev) => pickVendor(ev.currentTarget)}>
              <span className="nm">{vendor || "全部供应商"}</span>
              <Icon name="down" size="xs" />
            </button>
            <button type="button" className="rg-input chgen-model chgen-model-name" data-ch-gen-model aria-haspopup="menu" disabled={busy} title={model ? `${model.name} · ${refOk(model) ? "支持参考图" + (model.maxRefs ? " ×" + model.maxRefs : "") : "不支持参考图"}` : "还没有可用的图片模型"} onClick={(ev) => pickModel(ev.currentTarget)}>
              <span className="nm">{model?.name || "还没有可用的图片模型"}</span>
              {model ? <span className="cap">{has4K(model) ? "4K" : bestSize(model)}</span> : null}
              <Icon name="down" size="xs" />
            </button>
          </> : <span className="chgen-ft-hint" data-ch-gen-nomodel>还没有可用的图片模型：到 设置 › 模型 里添加一个</span>}
          {shownErr ? <p className="chgen-err" data-ch-gen-error title={shownErr}>{shownErr}</p> : null}
        </div>
        <div className="chgen-ft-btns">
          <button className="btn" onClick={busy ? stopAndClose : dismiss}>{busy ? "停止并关闭" : "取消"}</button>
          {canSave ? <button className="btn solid" data-ch-gen-save disabled={saving} onClick={() => { if (attachId) saveCharacterJob(attachId, specNow() ?? undefined, ctl); }}>{saving ? "保存中…" : "保存角色"}</button>
            : canResume ? <button className="btn solid" data-ch-gen-resume onClick={() => { if (attachId) resumeCharacterJob(ctl, attachId); }}>{busy ? "生成中…" : "继续生成"}</button>
            : <button className="btn solid" data-ch-gen-run disabled={busy || !form.name.trim()} onClick={() => runSteps([0, 1, 2, 3])}>{busy ? "生成中…" : "生成四张"}</button>}
        </div>
      </div>
      {view ? <ImageViewer items={view.items} start={view.start} onClose={() => setView(null)} /> : null}
    </div>
  </div>;
}

// 54×72 的参考图：缩略图就够（72 档 → 256），失败留转圈占位而不是空白
function RefThumb({ src }: { src: string }) { return <ThumbImg src={src} width={72} fallback={<span className="chgen-ref-wait"><i className="chgen-spin" /></span>} />; }

/** 模型下拉：只列当前供应商的模型（供应商是上面另一个下拉） */
function ModelMenu({ models, currentId, onPick }: { models: ModelSpec[]; currentId?: string; onPick: (m: ModelSpec) => void }) {
  return <>
    <div className="mh">模型</div>
    {models.map((m) => <button type="button" key={m.id} className={"mi" + (m.id === currentId ? " on" : "")} data-ch-model-option={m.id} onClick={() => onPick(m)}>
      <span className="ic"><Icon name="image" size="s" /></span>
      <span>{m.name}<span className="d">{has4K(m) ? "4K · " : ""}{vendorOf(m)} · {refOk(m) ? "支持参考图" + (m.maxRefs ? " ×" + m.maxRefs : "") : "不支持参考图"}</span></span>
    </button>)}
    {models.length ? null : <div className="mh">这个供应商没有图片模型</div>}
  </>;
}

/** 右栏的四张白底预览卡：待生成 / 进度 / 完成（可点开放大）/ 失败原因 + 重试 */
function PreviewCard({ shot, run, busy, wide, onRetry, onZoom }: { shot: (typeof SHOTS)[number]; run: StepRun; busy: boolean; wide?: boolean; onRetry: () => void; onZoom: () => void }) {
  const url = useAssetUrl(run.url || "");
  const pct = Math.max(0, Math.min(100, Math.round(run.progress * 100)));
  const status = run.state === "idle" ? "待生成" : run.state === "running" ? "生成中 " + pct + "%" : run.state === "done" ? "已完成" : "失败";
  const open = () => { if (run.state === "done" && url) onZoom(); };
  return <div className={"chgen-card" + (wide ? " wide" : "")} data-ch-step={shot.title} data-state={run.state}>
    <div className="chgen-canvas" data-ch-preview={shot.title} role={run.state === "done" ? "button" : undefined} tabIndex={run.state === "done" ? 0 : undefined} aria-label={run.state === "done" ? shot.title + " 双击查看大图（可缩放）" : undefined} title={run.state === "done" && url ? "双击查看大图（可缩放）" : undefined}
      onDoubleClick={open} onKeyDown={(ev) => { if (run.state === "done" && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } }}>
      {url ? <PreviewImg src={run.url || ""} width={240} /> : null}
      {!url && run.state === "idle" ? <span className="chgen-idle"><Icon name="image" size="s" /><span>待生成</span></span> : null}
      {!url && run.state === "running" ? <span className="chgen-prog"><b className="tnum">{pct}%</b><span className="chgen-bar"><i style={{ width: pct + "%" }} /></span></span> : null}
      {!url && run.state === "done" ? <span className="chgen-idle"><i className="chgen-spin" /></span> : null}
      {run.state === "error" ? <span className="chgen-fail"><Icon name="alert" size="s" /><span className="msg">{run.error}</span><button className="chgen-retry" data-ch-gen-retry={shot.title} disabled={busy} onClick={(ev) => { ev.stopPropagation(); onRetry(); }}>重试</button></span> : null}
    </div>
    <div className="chgen-cap"><span className="t">{shot.title}</span><span className="r">{shot.ratio}</span><span className={"s" + (run.state === "error" ? " bad" : run.state === "done" ? " ok" : "")}>{status}</span></div>
  </div>;
}
