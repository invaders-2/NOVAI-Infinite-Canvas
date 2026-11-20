/**
 * 节点编辑器模型下拉里的「清单外模型」：用户在下拉里从上游目录挑的模型只记在本机，
 * 不改 api_providers.json 里的 image_models / video_models —— 那是设置页的配置，
 * 画布里挑个模型不该顺手改掉用户的模型清单。删掉本地记录 / 换一台设备就回到设置里那一份。
 */
export type ExtraModelPick = { provider: string; kind: "image" | "video"; model: string };

const EXTRA_MODELS_KEY = "novai-canvas:extra-models:v1";
const PICK_KINDS: ExtraModelPick["kind"][] = ["image", "video"];
const text = (value: unknown) => String(value ?? "").trim();
/** 隐私模式 / 非浏览器上下文里没有 localStorage：读写都当空表，不抛错 */
const storage = () => (typeof localStorage !== "undefined" ? localStorage : null);

const samePick = (a: ExtraModelPick, b: ExtraModelPick) =>
  a.provider.toLowerCase() === b.provider.toLowerCase() && a.kind === b.kind && a.model.toLowerCase() === b.model.toLowerCase();

export function readExtraModels(): ExtraModelPick[] {
  const store = storage();
  if (!store) return [];
  let raw: unknown;
  try { raw = JSON.parse(store.getItem(EXTRA_MODELS_KEY) || "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: ExtraModelPick[] = [];
  for (const item of raw) {
    const row = (item || {}) as Partial<ExtraModelPick>;
    const provider = text(row.provider);
    const model = text(row.model);
    const kind = text(row.kind) as ExtraModelPick["kind"];
    if (!provider || !model || !PICK_KINDS.includes(kind)) continue;
    const pick: ExtraModelPick = { provider, kind, model };
    if (!out.some((x) => samePick(x, pick))) out.push(pick);
  }
  return out;
}

function save(list: ExtraModelPick[]): ExtraModelPick[] {
  try { storage()?.setItem(EXTRA_MODELS_KEY, JSON.stringify(list)); } catch { /* 写不进去就只影响下次打开，不打断当前操作 */ }
  return list;
}

/** 加一条清单外模型；已经加过（大小写不同也算同一条）就不重复写 */
export function addExtraModel(pick: ExtraModelPick): ExtraModelPick[] {
  const list = readExtraModels();
  return list.some((x) => samePick(x, pick)) ? list : save([...list, pick]);
}

export function removeExtraModel(pick: ExtraModelPick): ExtraModelPick[] {
  return save(readExtraModels().filter((x) => !samePick(x, pick)));
}
