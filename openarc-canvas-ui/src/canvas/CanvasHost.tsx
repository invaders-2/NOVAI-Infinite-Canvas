/**
 * D5-02 入口与宿主 chrome · NOVAI 画布应用宿主（OpenArc 应用窗口内容）。
 *
 * 结构：**入口 = 上游原版列表首页 static/canvas-list.html（"画布工作台"：无限画布标题、开始创作、
 * 继续上次、新建画布与画布卡片列表）**，由 openarc-canvas:// 只读协议原样服务整棵 static/。
 * 首页上的每个入口都**直接打开真实编辑器 static/canvas.html?id=…**（不插欢迎页、不插选画布遮挡层），
 * 编辑器自带的返回按钮回到列表页：首页 ⇄ 编辑器就是完整的往返路径。
 * 宿主**不画任何 chrome**（没有顶部操作条、状态行、提示横幅）：OpenArc 只负责协议服务、消息闸门、
 * 账号分桶与资源失效复核，界面外观完全交给上游原版页面 —— 删除就是删除，不用 CSS 遮挡冒充。
 *
 * 边界（入口换成列表页后**仍然成立**）：
 *   · 应用页面在 sandbox="allow-scripts allow-same-origin allow-modals" 的 iframe 里：origin 是
 *     openarc-canvas://bundle，与 OpenArc 外壳（file://）**不同源**，页面拿不到 window.openarc / IPC / fs / 凭据；
 *     allow-modals 只放行 alert / confirm / prompt / print 这类模态对话（上游首页卡片菜单的「删除 / 重命名 /
 *     复制画布」与所有 alert 错误提示都要靠它们，此前缺这个标志时 Chromium 直接忽略），**不新增**文件系统、
 *     网络、origin、脚本执行或跨源能力；实例 token 校验 / CSP / 只读闸一律未动；
 *   · 宿主**只接受当前这一个应用帧**的消息：event.source 必须是本帧，且必须带本次挂载的随机 token
 *     （更深的子帧由外层中继附加 token，子帧自己拿不到 token）；
 *   · 账号作用域：入口 URL 的 #oa= 钥匙按"账号 + 本次挂载"生成，页面 localStorage/BroadcastChannel
 *     一律按该钥匙分桶（内存实现，不落盘）；切账号时窗口整体重建，旧页面与旧通道随之失效。
 *     页面内部跳转（列表 → 编辑器）会丢掉 fragment，所以桥在 fragment 之外回落到 oa:mount 找回同一把钥匙；
 *   · 每个应用页都靠桥的 800ms alive 心跳喂看门狗（入口不再固定是带中继的外壳页）；
 *   · 每次生成 = 一个 Task（预算/停止/审计归属）：模型调用只能经 canvas/modelChat|modelImage；
 *   · 本地导入图片进**资源库**，画布文档只存 openarc-asset:<ResourceRef>。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Window as WinDomain } from "../../electron/window-domain.ts";
import { buildCanvasModelLabelIndex, canvasModelBaseName } from "./canvasModelLabels";
import { closeStreamWithoutContent, isStreamContentEvent, pageFrameFor, sseChunk, streamCloseErrorFrame } from "./canvasLlmStream";
import { buildSizePolicyTable } from "../../electron/image-params.cjs";
import { Images, Package, Puzzle, Ticket, Users } from "lucide-react";
import { ASSET_PREFIX, resolveAssetRefsInDoc, restoreAssetRefsInDoc } from "./canvasAssetRefs";
import { CanvasCollabPanel, CanvasHostPanelEntry, CanvasPackagePanel } from "./CanvasDxosPanels";
import { CanvasAssetSyncPanel } from "./CanvasAssetSyncPanel";
import { CanvasInvitePanel } from "./CanvasInvitePanel";
import { CanvasPluginsPanel } from "./CanvasPluginsPanel";
import { CanvasShareEntry, CanvasSharePanel } from "./CanvasSharePanel";
import { accessChange, accessSignature, isAccessLostError, parseShareTargetMessage } from "./canvasShareModel";

type Rpc = {
  ch: string; dir: string; kind: string; id?: number | string; token?: string; method?: string;
  params?: Record<string, unknown>; frame?: string | null; state?: any; url?: string;
  message?: string; event?: string; ok?: boolean; value?: any; error?: any; reason?: string;
};

const CH = "openarc.canvas";
/** 入口 = 上游原版列表首页（无限画布）；画布编辑器由首页上的入口直接打开。*/
const IFRAME_BASE = "openarc-canvas://bundle/static/canvas-list.html";
const randomToken = () => "t_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
/** 不透明账号钥匙：账号 + 本次挂载，页面只拿它做作用域分桶，不含任何凭据。*/
function keyOf(seed: string) {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return "k" + h.toString(36) + Math.random().toString(36).slice(2, 6);
}

type CanvasListItem = { canvasId: string; title: string; icon: string; updatedAt: number; createdAt?: number; kind?: string; access?: { canEdit: boolean; source: string }; boardX?: number | null; boardY?: number | null; nodes?: number; edges?: number };

/** 服务端 access 投影 → 宿主 current 的权限字段（唯一映射，轮询/打开/保存共用）。*/
function accessFields(access: any) {
  return {
    canEdit: !!access?.canEdit,
    canManage: !!access?.canManage,
    canShare: !!access?.canShare,
    source: String(access?.source || ""),
  };
}

export function CanvasHost({ win, onOpenModelSettings }: { win: WinDomain; onOpenModelSettings?: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** "打开 OpenArc 总 API 设置"是宿主能力，不是页面能力：页面只能请求这一个固定动作（无参数）。*/
  const openModelSettings = useRef(onOpenModelSettings);
  openModelSettings.current = onOpenModelSettings;
  /** 环境"减少动态效果"：随 hello/context 传给应用页，守卫脚本据此跳过动效（跨不了 sandbox 的类名靠这个事实传）。*/
  const reducedMotion = () => (typeof document !== "undefined" && !!document.querySelector(".desktop.reduced")) ? true : false;
  const [items, setItems] = useState<CanvasListItem[]>([]);
  const [frameKey, setFrameKey] = useState(0);
  const [frameSrc, setFrameSrc] = useState<string>("");
  /** 当前画布 + 服务端投影的权限事实：canManage/canShare/source 与 canEdit 一起驱动入口与只读闸。*/
  const [current, setCurrent] = useState<{
    canvasId: string; title: string; revision: number; updatedAt: number;
    canEdit: boolean; canManage?: boolean; canShare?: boolean; source?: string;
  } | null>(null);
  /** 共享面板：画布页入口与列表卡片菜单（经桥 open-share）打开的是同一个宿主浮层。*/
  const [shareTarget, setShareTarget] = useState<{ canvasId: string; title: string; origin: "canvas" | "list" } | null>(null);
  /** 面板重读计数：权限事实一变就让面板按服务端最新能力重画（例如转移后变编辑者）。*/
  const [shareRefresh, setShareRefresh] = useState(0);
  /** 宿主动作浮层（协作 / 打包 / 素材同步 / 邀请 / 插件）：同一时刻只开一个，且绑定打开时的那本画布。*/
  type HostPanelKind = "collab" | "package" | "assets" | "invite" | "plugins";
  const [hostPanel, setHostPanel] = useState<{ kind: HostPanelKind; canvasId: string } | null>(null);
  const collabEntryRef = useRef<HTMLButtonElement | null>(null);
  const packageEntryRef = useRef<HTMLButtonElement | null>(null);
  const assetsEntryRef = useRef<HTMLButtonElement | null>(null);
  const inviteEntryRef = useRef<HTMLButtonElement | null>(null);
  const pluginsEntryRef = useRef<HTMLButtonElement | null>(null);
  // 宿主不再有状态行与提示横幅（那是 chrome），但 status/notice 的**写点全部保留**：
  // notice 另以根节点上的只读属性暴露给探针（资源失效复核 F3c 的证据通道），status 由看门狗与适配器路径写入。
  const [status, setStatus] = useState("初始化…");
  const [notice, setNotice] = useState<string>("");
  /** 清单外模型名被拒的次数（DOM 只读证据通道：data-canvas-model-not-found）。*/
  const [modelNotFound, setModelNotFound] = useState(0);
  /** 应用帧最后一次心跳（看门狗用）：被非预期导航/崩溃打断时整帧重置，绝不留在错误页上。*/
  const lastBeat = useRef(Date.now());
  /** 本帧说过的消息条数：iframe 换了文档之后用它判断"换出来的还是不是应用页"。*/
  const beatSeq = useRef(0);
  /** 最近一次推给 iframe 的文档版本（按 updatedAt 去重）：同一次改动只推一遍，推送失败由页面兜底轮询补齐。*/
  const lastPushed = useRef<{ canvasId: string; updatedAt: number } | null>(null);
  /** 帧加载后的说话窗口（见 onFrameLoad）。*/
  const loadCheck = useRef<number | null>(null);

  /** 本次挂载的实例 token：只有带它的宿主消息才被接受（重挂载后旧实例立即失效）。*/
  const instanceToken = useRef(randomToken());
  /** data URL ⇄ 稳定 ResourceRef 的双向映射（文档里只存 ref）。*/
  const refByDataUrl = useRef(new Map<string, string>());
  const dataUrlByRef = useRef(new Map<string, string>());
  /** 画布任务 id → 生成运行（停止/迟到结果都按 run 判定）。*/
  const runByTask = useRef(new Map<string, { runId: string; promise: Promise<Record<string, unknown>> }>());
  const labelToConfig = useRef(new Map<string, string>());
  const currentRef = useRef<typeof current>(null);
  currentRef.current = current;
  /** 上一轮已知的权限签名：canEdit / canManage / canShare / source 任一变化 = 权限被改过。*/
  const accessSig = useRef<string>("");
  /** 列表项（列表卡片的「共享…」消息只带 canvasId，标题从当前清单取）。*/
  const itemsRef = useRef<CanvasListItem[]>([]);
  itemsRef.current = items;
  const shareTargetRef = useRef<typeof shareTarget>(null);
  shareTargetRef.current = shareTarget;
  const shareEntryRef = useRef<HTMLButtonElement | null>(null);
  /** 整帧重置入口（accessLost 在 resetAppFrame 之前声明，用 ref 避免时序依赖）。*/
  const resetFrameRef = useRef<(reason: string) => void>(() => {});
  /** 画布卡片位置：会话内记忆（宿主不建第二套项目模型；刷新后由上游自动布局）。*/
  const boardPos = useRef(new Map<string, { x: number; y: number }>());
  /** 宿主 → 画布子页的请求（命令/撤销/状态），按 id 等回包。*/
  const shellPending = useRef(new Map<number, (v: any) => void>());
  const shellSeq = useRef(0);
  /** 流式 LLM：requestId → 该条流的推送入口（model:event 增量经它转成 iframe 的 SSE 分块）。*/
  const streams = useRef(new Map<string, { push: (ev: unknown) => void }>());
  /** 发起的流式调用 rpc id → 中止入口：页面关闭 / 用户停止都经它把取消传到主进程。*/
  const rpcStreams = useRef(new Map<number | string, { abort: () => void }>());

  const canvasCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.canvas;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);
  const modelCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.model;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);
  const taskCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.task;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const resourceCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.resource;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);
  /** 10-16 · 画布素材面板的数据形状（上游 /api/asset-library 的 library 结构），来源 = OpenArc 资源库。*/
  const libraryShape = useCallback(async () => {
    const res = await canvasCmd({ type: "canvas/libraryList", limit: 80 });
    const list: any[] = res && res.ok && Array.isArray(res.items) ? res.items : [];
    const toItem = (it: any) => ({ id: it.resourceId, name: it.name || "图片", url: it.ref, thumbnail: it.thumbnail || "", kind: "image", type: "image" });
    const all = list.map(toItem);
    const gen = list.filter((it) => it.generated).map(toItem);
    const categories = [
      { id: "oa-all", name: "全部图片", type: "image", items: all },
      { id: "oa-generated", name: "AI 生成", type: "image", items: gen },
    ];
    return { library: { active_library_id: "openarc", libraries: [{ id: "openarc", name: "OpenArc 资源库", categories }], categories } };
  }, [canvasCmd]);

  const buildConfig = useCallback(async () => {
    const res = await modelCmd({ type: "canvas/models" });
    const models: any[] = res && res.ok && Array.isArray(res.models) ? res.models : [];
    const defaults = (res && res.defaults) || { personal: {}, organization: {} };
    const usable = (cap: string) => models.filter((m) => m.status === "enabled" && Array.isArray(m.capabilities) && m.capabilities.includes(cap));
    /**
     * 画布下拉显示的是**供应商提供的模型名**（remoteModelId 优先，见 canvasModelLabels.ts），
     * 重名才按供应商 / 配置后缀消歧。显示名与反向映射都出自同一份索引：单一真源，
     * 不可能出现"下拉里是这个、反查又对不上 configId"的错位。
     */
    const modelLabels = buildCanvasModelLabelIndex(models);
    const label = (m: any) => modelLabels.labelOf.get(String(m.configId)) || canvasModelBaseName(m);
    labelToConfig.current = modelLabels.configOf;
    /**
     * 显式默认的**标签**（即使它不可用也照实投影）：页面要如实显示"你默认的那个模型不可用"，
     * 不能拿清单里另一个模型冒充。可用性事实仍由 defaultFact() 给出（唯一真源）。
     */
    const defaultLabelOf = (cap: string) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      if (!def) return "";
      const found = models.find((m) => m.configId === def);
      return found ? label(found) : "";
    };
    const chat = usable("chat");
    const image = usable("image-generation");
    const video = usable("video-generation");
    /** task-65：视频传输由后端 canvas/models.transports 决定，不再写死不可用。 */
    const transports = (res && res.transports) || {};
    const transportOf = (cap: string, fallback: boolean) => {
      if (transports[cap] === true) return "openarc-model-service";
      if (transports[cap] === false) return null;
      return fallback ? "openarc-model-service" : null;
    };
    const videoTransport = transportOf("video-generation", false);
    /**
     * 默认值只认 OpenArc 的**显式配置**，两种情况必须分开（这是"禁止静默换模型"的落点）：
     *   · def == null —— OpenArc 里根本没配该能力默认：回落到清单第一个可用模型只是**展示便利**
     *     （新节点有个开箱可用的初值），不是替换谁的显式配置，保持原行为；
     *   · def != null 却不在可用清单里（能力不符 / 被停用 / 不存在 / 没有 model.use 授权）——
     *     **绝不回落**：投影空字符串，让守卫脚本把该能力明确显示为不可用（原因见 defaultFact）。
     */
    const pick = (cap: string, list: any[]) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      if (!def) return list[0] ? label(list[0]) : "";
      const found = list.find((m) => m.configId === def);
      return found ? label(found) : "";
    };
    /**
     * 显式默认的可用性事实：由模型服务（唯一真源）判定原因，不在页面侧猜。
     *   defaultUsable = null（没配该能力默认）/ true（显式默认可用）/ false（显式默认不可用 + defaultReason）
     * 服务没给事实时 fail-closed 按"清单里找不到就是不可用"，绝不悄悄回落。
     */
    const defaultFact = (cap: string) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      if (!def) return { defaultUsable: null, defaultReason: null };
      const fact = res && res.defaultsState ? res.defaultsState[cap] : null;
      if (fact && typeof fact.usable === "boolean") return { defaultUsable: fact.usable, defaultReason: fact.usable ? null : (fact.reason || null) };
      const found = usable(cap).some((m) => m.configId === def);
      return { defaultUsable: found, defaultReason: found ? null : "MODEL_NOT_FOUND" };
    };
    /**
     * 供应商投影：**只含该能力下有可用模型的 provider**（OpenArc 是唯一真源，页面侧不再造供应商）。
     * 字段名严格按上游消费点取名 —— canvas.js 读 p.id / p.name / p.enabled /
     * p.chat_models / p.image_models / p.video_models（:713-800、:1141-1162、:7833/:8254）。
     * **不投影** baseUrl / protocol / credentialRef / has_key：页面既拿不到地址也拿不到凭据，
     * 因此不可能出现"看着连上了"的伪造供应商。
     */
    const providersOf = (cap: "chat" | "image-generation" | "video-generation") => {
      const out = new Map<string, { id: string; name: string; models: string[] }>();
      for (const m of usable(cap)) {
        const id = String(m.providerId || "");
        if (!id) continue;
        if (!out.has(id)) out.set(id, { id, name: String(m.providerName || id), models: [] });
        out.get(id)!.models.push(label(m));
      }
      return out;
    };
    const chatProviders = providersOf("chat");
    const imageProviders = providersOf("image-generation");
    const videoProviders = providersOf("video-generation");
    const apiProviders = Array.from(new Set([...chatProviders.keys(), ...imageProviders.keys(), ...videoProviders.keys()])).map((id) => ({
      id, name: String((chatProviders.get(id) || imageProviders.get(id) || videoProviders.get(id))!.name), enabled: true,
      chat_models: chatProviders.get(id)?.models || [], image_models: imageProviders.get(id)?.models || [],
      video_models: videoProviders.get(id)?.models || [],
    }));
    /**
     * 能力事实三件套，语义互不重叠（守卫脚本按它决定"未接通"还是"未配置"）：
     *   transport  传输是否存在（null = OpenArc 根本没接通这个能力）
     *   available  = transport != null（能力本身在不在）
     *   configured = 该能力有没有可用模型（缺模型是"未配置"，不是"不可用"）
     * 第四个事实 defaultUsable/defaultReason 见 defaultFact()：显式默认坏了也是"不可用"，但原因不同
     * （CAPABILITY_UNAVAILABLE / MODEL_DISABLED / MODEL_NOT_FOUND / MODEL_UNAUTHORIZED）。
     */
    const capability = (transport: string | null, configured: boolean, reason: string | null, reasonCode: string | null = null) => ({ available: !!transport, transport, configured, reason, reasonCode });
    /**
     * 显式默认不可用且它已不在"可用清单"里（停用 / provider 停用 / 跨能力）时，标签也要能如实显示。
     * 可用清单 models 是**可用模型**（停用的被过滤掉），所以这里只在"默认确实不可用且标签为空"时，
     * 向模型管理面补一次身份查询（只取 displayName / remoteModelId，不取地址、不取凭据），
     * **不会**把停用模型重新投影成可用模型。
     */
    const defaultModels = { chat: defaultLabelOf("chat"), "image-generation": defaultLabelOf("image-generation"), "video-generation": defaultLabelOf("video-generation") };
    const missingLabelCaps = (["chat", "image-generation", "video-generation"] as const).filter((cap) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      return !!def && !defaultModels[cap] && defaultFact(cap).defaultUsable === false;
    });
    if (missingLabelCaps.length) {
      const all = await modelCmd({ type: "model/list" });
      const items: any[] = all && all.ok && Array.isArray(all.items) ? all.items : [];
      for (const cap of missingLabelCaps) {
        const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
        const hit = items.find((m) => String(m.configId) === String(def));
        if (hit) defaultModels[cap] = canvasModelBaseName(hit);
      }
    }
    return {
      chat_models: chat.map(label),
      image_models: image.map(label),
      // task-65：视频模型按后端真实清单投影；传输由 capabilities["video-generation"].transport 表达。
      video_models: video.map(label), ms_chat_models: [], comfy_instances: [],
      api_providers: apiProviders,
      image_model: pick("image-generation", image),
      chat_model: pick("chat", chat),
      video_model: pick("video-generation", video),
      /** 显式默认的标签（只给"不可用"呈现用；空 = 没配默认或默认模型已不在清单里）。*/
      default_models: defaultModels,
      provider_count: apiProviders.length,
      chat_model_count: chat.length,
      image_model_count: image.length,
      video_model_count: video.length,
      /**
       * 能力可用性事实。**守卫脚本真的读它**（public/novai-canvas/openarc-canvas-guard.js 按
       * available / transport / reason 决定禁用哪些下拉、写什么说明、给不给"打开 OpenArc 总 API 设置"）。
       * 未接通的能力一律 available:false + reason —— 不是装饰字段。
       */
      capabilities: {
        chat: { ...capability(transportOf("chat", true), chat.length > 0, chat.length ? null : "OpenArc 总 API 设置里还没有可用的文本模型", chat.length ? null : "NO_MODEL"), ...defaultFact("chat") },
        "image-generation": { ...capability(transportOf("image-generation", true), image.length > 0, image.length ? null : "OpenArc 总 API 设置里还没有可用的生图模型", image.length ? null : "NO_MODEL"), ...defaultFact("image-generation") },
        // 视频：transport 读取后端真实装配；模型缺失与传输缺失分开给结构化原因。
        "video-generation": { ...capability(videoTransport, video.length > 0, videoTransport ? (video.length ? null : "OpenArc 总 API 设置里还没有可用的视频模型") : "OpenArc 后端未接通视频传输", videoTransport ? (video.length ? null : "NO_MODEL") : "TRANSPORT_UNAVAILABLE"), ...defaultFact("video-generation") },
        comfy: capability(null, false, "OpenArc 未接入 ComfyUI（不可用）", "TRANSPORT_UNAVAILABLE"),
      },
    };
  }, [modelCmd]);

  /**
   * 尺寸策略（GET /api/ai/size-policy → model.sizePolicy）：页面 shared/size-policy.js 的 load() 只读这一张表
   * （{format, default, models}）。值只来自唯一真源 electron/image-params.cjs 的 GPT_IMAGE_2_SIZE_POLICY；
   * models 的键 = 画布页看到的模型显示名（与 buildConfig 用同一份 buildCanvasModelLabelIndex，即 /api/config 的
   * image_models 标签），所以 gpt-image-2 家族在页面里是 enum 策略，其余模型走 default（free + 同一份 tiers）。
   * 这里按需取一次清单，不做启动期缓存：页面 NovaSizePolicy.load() 可能早于 buildConfig 完成。
   */
  const sizePolicyTable = useCallback(async () => {
    const res = await modelCmd({ type: "canvas/models" });
    const models: any[] = res && res.ok && Array.isArray(res.models) ? res.models : [];
    const labels = buildCanvasModelLabelIndex(models);
    const imageModels = models.filter((m) => m.status === "enabled" && Array.isArray(m.capabilities) && m.capabilities.includes("image-generation"));
    return buildSizePolicyTable(imageModels.map((m) => ({ key: labels.labelOf.get(String(m.configId)) || canvasModelBaseName(m), model: canvasModelBaseName(m) })));
  }, [modelCmd]);

  const listItem = useCallback((c: any): CanvasListItem => {
    const pos = boardPos.current.get(String(c.canvasId)) || null;
    return {
      canvasId: String(c.canvasId), title: String(c.title || ""), icon: String(c.icon || "🧩"),
      updatedAt: Number(c.updatedAt || 0), createdAt: Number(c.createdAt || 0), kind: String(c.kind || "classic"),
      access: c.access || null, boardX: pos ? pos.x : null, boardY: pos ? pos.y : null,
      nodes: (c.doc && c.doc.nodes ? c.doc.nodes.length : 0), edges: (c.doc && c.doc.connections ? c.doc.connections.length : 0),
    };
  }, []);

  const refreshList = useCallback(async () => {
    const res = await canvasCmd({ type: "canvas/list" });
    if (!res || !res.ok) { setStatus("读取画布列表失败：" + String(res && res.error)); return; }
    setItems((res.items || []).map(listItem));
  }, [canvasCmd, listItem]);

  /** 上游画布清单载荷（字段名与上游一致，不二次发明）。*/
  const upstreamCanvas = useCallback((c: any, docOverride?: any) => {
    const doc = docOverride || c.doc || { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const pos = boardPos.current.get(String(c.canvasId)) || null;
    return {
      id: c.canvasId, title: c.title, icon: c.icon || "🧩", kind: c.kind || "classic", project: "default",
      nodes: doc.nodes || [], connections: doc.connections || [],
      viewport: doc.viewport || { x: 0, y: 0, scale: 1 }, logs: doc.logs || [],
      updated_at: Number(c.updatedAt || 0), created_at: Number(c.createdAt || 0), revision: Number(c.revision || 1),
      node_count: (doc.nodes || []).length, connection_count: (doc.connections || []).length,
      board_x: pos ? pos.x : null, board_y: pos ? pos.y : null,
      access: c.access || null,
    };
  }, []);

  /**
   * 把文档里的稳定 ref 解析成可显示的数据（只读、逐资源授权、分批）。
   *
   * 承载引用的字段不止 node.url（node.refs[]、node.inputs[].url、封面/缩略图、嵌套 params 等都会出现
   * openarc-asset:），所以按前缀深度遍历全文，而不是只看 node.url —— 否则漏掉的字段会以原始 ref 落到
   * 页面的 <img> 上（页面 CSP 只允许 openarc-canvas: data: blob:），既 CSP 违规又图裂。
   * 读不出来的引用换成 data: 安全占位值（引用本身仍可还原，保存不丢），绝不把 openarc-asset: 留给页面。
   */
  const resolveRefs = useCallback(async (doc: any) => {
    const { doc: out, unavailable } = await resolveAssetRefsInDoc(doc, {
      cache: dataUrlByRef.current,
      reverse: refByDataUrl.current,
      resolve: async (ref: string) => {
        const res = await canvasCmd({ type: "canvas/readAsset", ref });
        return res && res.ok && res.dataUrl ? String(res.dataUrl) : null;
      },
    });
    if (unavailable.length) setNotice("引用资源已删除或无权限（" + unavailable.length + " 个）：画布上按不可用显示，不会拿旧缓存顶替");
    return out;
  }, [canvasCmd]);

  /** 保存回写：显示用的 data URL / 不可用占位值换回稳定 ref（旧 data URL 原样保留，不静默丢图）。*/
  const refsBack = useCallback((doc: any) => restoreAssetRefsInDoc(doc, refByDataUrl.current), []);

  const bindCanvas = useCallback(async (canvasId: string, title?: string) => {
    const res = await canvasCmd({ type: "canvas/get", canvasId });
    if (!res || !res.ok) { setStatus("打开画布失败：" + String(res && res.error)); return null; }
    const c = res.canvas;
    const next = { canvasId: c.canvasId, title: title || c.title, revision: Number(c.revision || 1), updatedAt: Number(c.updatedAt || 0), ...accessFields(c.access) };
    accessSig.current = accessSignature(c.access);
    setCurrent(next);
    setStatus("已打开 " + next.title + "（revision " + next.revision + "）");
    return next;
  }, [canvasCmd]);

  /** 宿主 → 画布子页（经外壳中继）：只发受限的几种消息。*/
  const toShell = useCallback(async (msg: Record<string, unknown>, wait = false): Promise<any> => {
    const frameWin = frameRef.current?.contentWindow;
    if (!frameWin) return { ok: false, error: "NO_FRAME" };
    if (!wait) { frameWin.postMessage({ ch: CH, dir: "host->canvas", ...msg }, "*"); return { ok: true }; }
    shellSeq.current += 1;
    const id = shellSeq.current;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { shellPending.current.delete(id); resolve({ ok: false, error: "SHELL_TIMEOUT" }); }, 15000);
      shellPending.current.set(id, (v) => { clearTimeout(timer); resolve(v); });
      frameWin.postMessage({ ch: CH, dir: "host->canvas", ...msg, id }, "*");
    });
  }, []);

  const pushContext = useCallback(async (c: { canEdit: boolean; canvasId: string } | null) => {
    await toShell({ kind: "context", canEdit: c ? c.canEdit : false, readOnly: c ? !c.canEdit : true, canvasId: c ? c.canvasId : null, reducedMotion: reducedMotion() });
  }, [toShell]);

  /**
   * 权限事实变了就把新的 canEdit 推给页面（bug3 前端部分）。
   * 比较的是**服务端投影**（canEdit/canManage/canShare/source），不是 revision：
   * 撤销共享、降级、转移所有权都不会改 revision，只改 access。
   */
  const notifyAccess = useCallback((canvasId: string, access: any) => {
    const change = accessChange(accessSig.current, access);
    accessSig.current = change.signature;
    if (change.changed) {
      void pushContext({ canvasId, canEdit: !!access?.canEdit });
      if (shareTargetRef.current && shareTargetRef.current.canvasId === canvasId) setShareRefresh((n) => n + 1);
    }
    return change.changed;
  }, [pushContext]);

  /**
   * 权限已经不在（READ_ONLY / NOT_FOUND_OR_FORBIDDEN）：
   *   · READ_ONLY          → 立刻切只读并 pushContext（页面只读闸关上），面板保留只读视图；
   *   · NOT_FOUND_OR_FORBIDDEN → 关闭面板、提示并返回列表（不能停在"看起来还能编辑"的旧文档上）。
   * 只处理"当前打开的那一本"：别的画布打开失败不影响当前上下文。
   */
  const accessLost = useCallback(async (code: string, canvasId: string) => {
    const cur = currentRef.current;
    if (!cur || (canvasId && cur.canvasId !== canvasId)) return false;
    const signatureAccess = { canView: !!cur.canEdit, canEdit: false, canManage: false, canShare: false, source: code };
    accessSig.current = accessSignature(signatureAccess);
    setCurrent({ ...cur, canEdit: false, canManage: false, canShare: false, source: code });
    await pushContext({ canvasId: cur.canvasId, canEdit: false });
    if (shareTargetRef.current && shareTargetRef.current.canvasId === cur.canvasId) setShareTarget(null);
    if (code === "NOT_FOUND_OR_FORBIDDEN") {
      setNotice("这本画布已不可访问（可能被移出共享），已返回列表");
      setCurrent(null);
      accessSig.current = "";
      resetFrameRef.current("画布已不可访问（可能被移出共享），已返回列表");
    } else {
      setNotice(cur.canEdit ? "权限已变更：现在是只读（编辑会被拒绝）" : "当前是只读状态");
    }
    return true;
  }, [pushContext]);

  /** 面板操作改变了我的权限（例如转移所有权）后，立刻按服务端事实刷新只读闸。*/
  const refreshCurrentAccess = useCallback(async (canvasId: string, bumpPanel = true) => {
    const res = await canvasCmd({ type: "canvas/meta", canvasId });
    if (res && res.ok && res.meta) {
      const a = res.meta.access || {};
      const change = accessChange(accessSig.current, a);
      accessSig.current = change.signature;
      const cur = currentRef.current;
      if (!cur || cur.canvasId !== canvasId) return;
      setCurrent({
        ...cur, ...accessFields(a),
        title: res.meta.title || cur.title,
        revision: Number(res.meta.revision || cur.revision),
        updatedAt: Number(res.meta.updatedAt || cur.updatedAt),
      });
      if (change.changed) {
        await pushContext({ canvasId, canEdit: !!a.canEdit });
        if (bumpPanel && shareTargetRef.current && shareTargetRef.current.canvasId === canvasId) setShareRefresh((n) => n + 1);
      }
      return;
    }
    if (res && !res.ok && isAccessLostError(res.error)) await accessLost(res.error, canvasId);
  }, [accessLost, canvasCmd, pushContext]);

  /** 关闭共享面板：焦点回到入口按钮；从列表打开时回到应用帧。*/
  const closeSharePanel = useCallback(() => {
    setShareTarget(null);
    window.setTimeout(() => {
      const btn = shareEntryRef.current;
      if (btn) { try { btn.focus(); return; } catch { /* ignore */ } }
      try { frameRef.current?.focus(); } catch { /* ignore */ }
    }, 0);
  }, []);

  /** 宿主动作浮层：与共享面板互斥，只对打开时那本画布生效。*/
  const toggleHostPanel = useCallback((kind: HostPanelKind) => {
    const cur = currentRef.current;
    if (!cur) return;
    setShareTarget(null);
    setHostPanel((previous) => (previous && previous.kind === kind && previous.canvasId === cur.canvasId ? null : { kind, canvasId: cur.canvasId }));
  }, []);

  /** 关闭宿主动作面板：焦点回到对应入口按钮。*/
  const closeHostPanel = useCallback(() => {
    const kind = hostPanel?.kind || null;
    setHostPanel(null);
    window.setTimeout(() => {
      const byKind: Record<string, HTMLButtonElement | null> = {
        collab: collabEntryRef.current,
        package: packageEntryRef.current,
        assets: assetsEntryRef.current,
        invite: inviteEntryRef.current,
        plugins: pluginsEntryRef.current,
      };
      const btn = kind ? byKind[kind] || null : null;
      if (btn) { try { btn.focus(); return; } catch { /* ignore */ } }
      try { frameRef.current?.focus(); } catch { /* ignore */ }
    }, 0);
  }, [hostPanel]);

  // 当前画布被关掉 / 换成另一本时，宿主浮层不能停在旧画布上（否则导出/协作会指向已不可见的画布）。
  useEffect(() => {
    if (!hostPanel) return;
    if (!current || current.canvasId !== hostPanel.canvasId) setHostPanel(null);
  }, [current, hostPanel]);

  // 宿主「减少动态效果」是实时开关：sandbox iframe 读不到外壳的类名，只能由宿主把事实重新推过去
  //（应用页的守卫按 data-openarc-reduced-motion 关掉自己的动效）。
  useEffect(() => {
    const root = typeof document !== "undefined" ? document.querySelector(".desktop") : null;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => { void pushContext(currentRef.current); });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [pushContext]);

  /** 宿主 RPC：应用页面的每一条请求都在这里被翻译成受控命令。*/
  const handleCall = useCallback(async (method: string, params: Record<string, any>): Promise<any> => {
    const cur = currentRef.current;
    const canvasId = (cur && cur.canvasId) || null;
    switch (method) {
      // —— 应用外壳 ——
      case "app.openModelSettings":
        openModelSettings.current?.();
        return { ok: true, app: "settings", pane: "model", label: "打开 OpenArc 总 API 设置" };
      case "app.info":
        return {
          name: "AI Studio · OpenArc", version: "1.0.117-openarc", repo_url: null, version_url: "", tree_url: "",
          sources: {}, update_disabled: true,
          openarc: { updateDisabled: true, reason: "OpenArc 不检查、不下载、不安装上游程序（更新/下载已禁用）" },
        };
      case "app.changelog":
        return { items: [] };
      case "app.queue": {
        const list = await taskCmd({ type: "task/list" });
        const running = list && list.ok && Array.isArray(list.items) ? list.items.filter((t: any) => String(t.status) === "RUNNING").length : 0;
        return { total: running, position: 0, running, source: "openarc-task-runtime" };
      }
      // —— 首页 ——
      case "canvas.recent": {
        const res = await canvasCmd({ type: "canvas/list" });
        if (!res || !res.ok) return [];
        return (res.items || []).slice(0, 12).map((c: any) => ({ id: c.canvasId, title: c.title, icon: c.icon, kind: c.kind, updated_at: Number(c.updatedAt || 0), created_at: Number(c.createdAt || 0), thumbnail: "" }));
      }
      case "project.list":
        return { projects: [{ id: "default", name: "默认画布", order: 0, canvas_count: items.length }] };
      case "canvas.list": {
        // 页面回到列表（入口页每次加载/刷新都会走这里）：宿主不再认为"有当前画布"。
        // 否则列表页右上角会残留上一本的共享入口，轮询也还在读一本已经不在屏幕上的画布。
        if (currentRef.current) {
          accessSig.current = "";
          setCurrent(null);
          setShareTarget((t) => (t && t.origin === "canvas" ? null : t));
          void pushContext(null);
        }
        return { canvases: items.map((c) => ({ ...upstreamCanvas({ canvasId: c.canvasId, title: c.title, icon: c.icon, kind: c.kind, updatedAt: c.updatedAt, createdAt: c.createdAt, access: c.access, doc: { nodes: new Array(c.nodes || 0), connections: new Array(c.edges || 0) } }), nodes: [], connections: [] })) };
      }
      case "canvas.trashList": {
        const res = await canvasCmd({ type: "canvas/list", includeTrashed: true });
        const trashed = res && res.ok ? (res.items || []).filter((c: any) => c.trashed) : [];
        return { canvases: trashed.map((c: any) => upstreamCanvas(c)) };
      }
      case "canvas.workflows": return { workflows: [] };
      case "canvas.create": {
        const res = await canvasCmd({ type: "canvas/create", title: params.title, icon: params.icon, kind: params.kind });
        if (!res.ok) return { __status: 502, body: { error: res.error } };
        if (params.boardX != null && params.boardY != null) boardPos.current.set(String(res.canvas.canvasId), { x: Number(params.boardX) || 0, y: Number(params.boardY) || 0 });
        await refreshList();
        const createdAccess = { canEdit: true, canManage: true, canShare: true, canView: true, source: "OWNER_POLICY" };
        accessSig.current = accessSignature(createdAccess);
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), ...accessFields(createdAccess) });
        await pushContext({ canvasId: res.canvas.canvasId, canEdit: true });
        return { canvas: upstreamCanvas(res.canvas) };
      }
      case "canvas.get": {
        const res = await canvasCmd({ type: "canvas/get", canvasId: params.canvasId });
        if (!res.ok) {
          // 被撤销共享后打开：页面拿 404；当前上下文的只读闸同步关上（不再"看起来能编辑"）。
          if (isAccessLostError(res.error)) await accessLost(res.error, String(params.canvasId || ""));
          return { __status: 404, body: { error: res.error } };
        }
        const access = res.canvas.access || {};
        const canEdit = !!access.canEdit;
        accessSig.current = accessSignature(access);
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), ...accessFields(access) });
        // 页面自己发起的打开（列表卡片 / 直链）与 canvas.create 同一口径：current 变了就立刻把
        // 只读事实推给页面，否则页面停在 hello 那一刻的 canEdit:false 上（重开的画布改不动、也存不了）。
        await pushContext({ canvasId: res.canvas.canvasId, canEdit });
        const doc = await resolveRefs(res.canvas.doc);
        return { canvas: upstreamCanvas(res.canvas, doc) };
      }
      case "canvas.meta": {
        const body = (params.body || {}) as any;
        if (params.httpMethod === "PUT" && body && (body.board_x != null || body.board_y != null)) {
          boardPos.current.set(String(params.canvasId), { x: Number(body.board_x) || 0, y: Number(body.board_y) || 0 });
        }
        const meta = await canvasCmd({ type: "canvas/meta", canvasId: params.canvasId });
        if (!meta || !meta.ok) {
          if (meta && isAccessLostError(meta.error)) await accessLost(meta.error, String(params.canvasId || ""));
          return { __status: 404, body: { error: (meta && meta.error) || "NOT_FOUND" } };
        }
        if (body && (body.title != null || body.icon != null)) {
          const r = await canvasCmd({ type: "canvas/save", canvasId: params.canvasId, baseRevision: cur ? cur.revision : null, doc: null, title: body.title, icon: body.icon });
          if (r.ok) { await refreshList(); return { canvas: upstreamCanvas(r.canvas) }; }
          return { __status: 502, body: { error: r.error } };
        }
        return Object.assign({}, meta.meta, { canvas: upstreamCanvas({ canvasId: params.canvasId, title: meta.meta.title, icon: meta.meta.icon, kind: meta.meta.kind, updatedAt: meta.meta.updatedAt, revision: meta.meta.revision, access: meta.meta.access }) });
      }
      /** 只读：AI 新增标记（页面据此给对应节点加来源标记 + 一次性 160ms 淡入）。*/
      case "canvas.agentMarks": {
        const target = String(params.canvasId || canvasId || "");
        if (!target) return { ok: false, error: "CANVAS_NOT_OPEN", marks: [] };
        return await agentMarksOf(canvasCmd, target);
      }
      case "canvas.save": {
        const body = (params.body || {}) as any;
        const target = String(params.canvasId || canvasId || "");
        const want = Number(body.base_updated_at || 0);
        /**
         * 页面声明的是"它最后一次成功同步的 updated_at"，要映射成 revision 才能做乐观并发检查。
         * 宿主的 current 快照在别处写入（宿主 IPC / AI / 其它窗口）之后最多落后 2.5s，拿落后快照判定会把
         * **已经对齐**的基线误判成 -1：页面只能靠反复重试等快照追上，而追上那一刻它就用手里的旧文档
         * 覆盖了对方（第八 / 十 / 十一批实测的"500ms 待保存窗口"缺陷）。这里按存储的当前事实对齐一次再映射：
         * 基线真的过期才冲突 —— 语义没放宽，只是不再用过期快照判"过期"。
         */
        let snapshot = currentRef.current;
        if (snapshot && want !== Number(snapshot.updatedAt) && (!snapshot.canvasId || snapshot.canvasId === target)) {
          const fresh = await canvasCmd({ type: "canvas/meta", canvasId: target });
          if (fresh && fresh.ok && fresh.meta) {
            snapshot = { canvasId: target, title: fresh.meta.title, revision: Number(fresh.meta.revision || 1), updatedAt: Number(fresh.meta.updatedAt || 0), ...accessFields(fresh.meta.access) };
            setCurrent(snapshot);
          } else if (fresh && !fresh.ok && isAccessLostError(fresh.error)) {
            await accessLost(fresh.error, target);
          }
        }
        const base = snapshot && want === Number(snapshot.updatedAt) ? snapshot.revision : -1;
        const res = await canvasCmd({
          type: "canvas/save", canvasId: target, baseRevision: base,
          doc: refsBack({ nodes: body.nodes || [], connections: body.connections || [], viewport: body.viewport || { x: 0, y: 0, scale: 1 }, logs: body.logs || [] }),
          title: body.title, icon: body.icon,
        });
        if (!res.ok && res.error === "REVISION_CONFLICT") {
          const c = (res.detail && res.detail.canvas) || null;
          setStatus("版本冲突：已在别处修改，保留双方内容");
          // 冲突回包就是页面做三方合并要用的 remote。它必须和 canvas.get 一样是**可显示形态**
          // （资源引用解析成当前用户有权读的 data URL）：否则页面拿 ref 与本地 data URL 比较，
          // 会把"没改过的图片字段"误判成远端改动，合并时把显示用的地址换掉。
          const doc = c ? await resolveRefs(c.doc) : null;
          return { __conflict: true, detail: { canvas: c ? upstreamCanvas(c, doc) : null, updated_at: c ? c.updatedAt : 0 } };
        }
        if (!res.ok) {
          setStatus("保存失败：" + String(res.error));
          // 撤销/降级后的第一次保存：服务端已经拒绝，页面必须立刻切成只读（不等下一次轮询）。
          if (isAccessLostError(res.error)) await accessLost(res.error, target);
          return { __status: 502, body: { error: res.error } };
        }
        const savedAccess = res.canvas.access || {};
        notifyAccess(res.canvas.canvasId, savedAccess);
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), ...accessFields(savedAccess) });
        setStatus("已保存（revision " + res.canvas.revision + "）");
        return { canvas: upstreamCanvas(res.canvas) };
      }
      case "canvas.trash": { const r = await canvasCmd({ type: "canvas/trash", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: upstreamCanvas(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.restore": { const r = await canvasCmd({ type: "canvas/restore", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: upstreamCanvas(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.purge": { const r = await canvasCmd({ type: "canvas/purge", canvasId: params.canvasId }); await refreshList(); return r; }
      case "canvas.touch": return { ok: true };
      case "canvas.assetStates": {
        const urls: string[] = Array.isArray((params.body || {}).urls) ? (params.body as any).urls : [];
        const refs = urls.filter((u) => u.startsWith(ASSET_PREFIX)).map((u) => u.slice(ASSET_PREFIX.length));
        const exists: Record<string, boolean> = {};
        if (!refs.length) return { exists };
        const res = await canvasCmd({ type: "canvas/assetStates", refs });
        const states = (res && res.exists) || {};
        urls.forEach((u) => { exists[u] = u.startsWith(ASSET_PREFIX) ? !!(states[u.slice(ASSET_PREFIX.length)] && states[u.slice(ASSET_PREFIX.length)].state === "AVAILABLE") : true; });
        return { exists };
      }
      case "canvas.upload": {
        // 桥在页面里把文件读成 data URL 再送过来（不把 File 对象丢过 postMessage）；这里只做有界导入。
        const incoming: any[] = Array.isArray((params as any).files) ? (params as any).files : [];
        const out: any[] = [];
        for (const f of incoming.slice(0, 8)) {
          const dataUrl = String((f && f.dataUrl) || "");
          const name = String((f && f.name) || "upload");
          if (!dataUrl.startsWith("data:")) { setNotice("未导入（不是受支持的文件）：" + name); continue; }
          const res = await canvasCmd({ type: "canvas/importAsset", canvasId, name, dataUrl });
          if (!res || !res.ok || !res.ref) { setNotice("导入资源库失败（" + String((res && res.error) || "UNKNOWN") + "）：" + name + " 未写入画布"); continue; }
          dataUrlByRef.current.set(String(res.ref).slice(ASSET_PREFIX.length), dataUrl);
          refByDataUrl.current.set(dataUrl, res.ref);
          out.push({ url: dataUrl, name, kind: String((f && f.type) || "").startsWith("video") ? "video" : "image" });
        }
        return { files: out };
      }
      // —— 模型（唯一入口，每次调用重新授权 + 任务级预算/停止/版本判定）——
      case "model.config": return await buildConfig();
      // 尺寸策略：页面 shared/size-policy.js 启动时 GET /api/ai/size-policy；只回策略内容，不含地址/凭据。
      case "model.sizePolicy": return await sizePolicyTable();
      case "model.chat": {
        const body = (params.body || {}) as any;
        if (!canvasId) return { __status: 502, body: { error: "CANVAS_NOT_OPEN" } };
        // 页面传的是清单里的标签（displayName · configId 尾号）：不在当前 OpenArc 清单 = 明确报错，
        // **绝不静默回落到"该能力的默认模型"**。判定发生在任何 canvas/run 之前：0 次 provider 请求。
        const wanted = String(body.model || "");
        const configId = wanted ? labelToConfig.current.get(wanted) : null;
        if (wanted && !configId) { setModelNotFound((n) => n + 1); setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wanted); return rejectUnknownModel("model.chat", wanted); }
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "chat", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const system = String(body.system_prompt || "You are a helpful assistant.");
        const history = Array.isArray(body.messages) ? body.messages : [];
        const messages = [{ role: "system", content: system }]
          .concat(history.slice(-20).map((m: any) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "") })))
          .concat([{ role: "user", content: String(body.message || "") }]);
        const res = await canvasCmd({
          type: "canvas/modelChat", canvasId, runId: run.runId, messages,
          configId,
        });
        const ok = !!(res && res.ok);
        await canvasCmd({ type: "canvas/runFinish", canvasId, runId: run.runId, status: ok ? "DONE" : "FAILED" });
        if (!ok) {
          const code = String((res && res.error) || "MODEL_ERROR");
          setNotice("模型调用失败：" + explain(code));
          return { __status: 502, body: { error: code, message: explain(code) } };
        }
        return { text: String(res.text || ""), model: String(body.model || ""), requestId: res.requestId || null, usage: res.usage || null };
      }
      case "model.imageTask": {
        const body = (params.body || {}) as any;
        if (!canvasId) return { __status: 502, body: { error: "CANVAS_NOT_OPEN" } };
        const wantedImage = String(body.model || "");
        const imageConfigId = wantedImage ? labelToConfig.current.get(wantedImage) : null;
        if (wantedImage && !imageConfigId) { setModelNotFound((n) => n + 1); setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wantedImage); return rejectUnknownModel("model.imageTask", wantedImage); }
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "image", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const taskId = "oa_img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const promise = (async () => {
          const res = await canvasCmd({
            type: "canvas/modelImage", canvasId, runId: run.runId, prompt: String(body.prompt || ""),
            size: body.size || null, count: Number(body.count) || 1,
            configId: imageConfigId,
          });
          const ok = !!(res && res.ok);
          await canvasCmd({ type: "canvas/runFinish", canvasId, runId: run.runId, status: ok ? "DONE" : "FAILED" });
          if (!ok) { const code = String((res && res.error) || "MODEL_ERROR"); setNotice("图片生成失败：" + explain(code)); return { ok: false, error: explain(code), code }; }
          return { ok: true, images: (res.images || []).map((i: any) => i.dataUrl || i.url).filter(Boolean) };
        })();
        runByTask.current.set(taskId, { runId: run.runId, promise });
        return { task_id: taskId, status: "pending" };
      }
      case "model.imageTaskResult": {
        const entry = runByTask.current.get(String(params.taskId));
        if (!entry) return { status: "failed", error: "任务不存在（宿主已重启）" };
        const r = await entry.promise;
        if (!r.ok) return { status: "failed", error: String(r.error) };
        return { status: "succeeded", result: { images: r.images, task_id: params.taskId, provider: "openarc" } };
      }
      case "model.videoTask": {
        const body = (params.body || {}) as any;
        if (!canvasId) return { __status: 502, body: { error: "CANVAS_NOT_OPEN" } };
        const wantedVideo = String(body.model || "");
        const videoConfigId = wantedVideo ? labelToConfig.current.get(wantedVideo) : null;
        if (wantedVideo && !videoConfigId) { setModelNotFound((n) => n + 1); setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wantedVideo); return rejectUnknownModel("model.videoTask", wantedVideo); }
        if (!videoConfigId) return { __status: 400, body: { error: "MODEL_REQUIRED", message: "节点未选择视频模型" } };
        // canvas/nodes/execute 内部完成 startRun / legacyExecute / 产物落库；宿主只负责把页面标签映射成 configId。
        const exec = await canvasCmd({
          type: "canvas/nodes/execute",
          payload: {
            type: "builtin.video-generator", canvasId, nodeId: body.nodeId || null,
            params: {
              prompt: String(body.prompt || ""), configId: videoConfigId,
              ...(body.size ? { size: String(body.size) } : {}),
              ...(body.aspect_ratio || body.ratio ? { ratio: String(body.aspect_ratio || body.ratio) } : {}),
              ...(body.resolution ? { resolution: String(body.resolution) } : {}),
              count: Number(body.batch_size || body.count) || 1,
            },
          },
        });
        if (!exec || exec.ok !== true) {
          const code = String((exec && exec.error) || "VIDEO_GENERATION_FAILED");
          setNotice("视频生成失败：" + explain(code));
          return { __status: 502, body: { error: code, message: explain(code), detail: exec && exec.detail ? exec.detail : null } };
        }
        const videos = (exec.outputs && exec.outputs.videos) || (exec.result && exec.result.videos) || [];
        const urls = (Array.isArray(videos) ? videos : []).map((v: any) => typeof v === "string" ? v : String((v && (v.url || v.value || v.sourceUrl)) || "")).filter(Boolean);
        return { urls, canvas_meta: {} };
      }
      case "model.queryTask": {
        const entry = runByTask.current.get(String((params.body || {}).task_id));
        if (!entry) return { status: "failed", error: "任务不存在" };
        const r = await entry.promise;
        return r.ok ? { status: "succeeded", result: { images: r.images } } : { status: "failed", error: String(r.error) };
      }
      case "run.stop": {
        if (!canvasId || !params.runId) return { ok: false, error: "RUN_NOT_FOUND" };
        const res = await canvasCmd({ type: "canvas/runStop", canvasId, runId: params.runId, reason: "USER_STOP" });
        setNotice("已停止生成（后续请求不会再发出）");
        return res || { ok: false };
      }
      // —— 10-16 · 素材库面板 = OpenArc 资源库 ——
      case "library.get": return await libraryShape();
      case "library.local": return { items: [], tree: null };
      case "library.resolve": {
        const url = String(params.url || "");
        if (!url.startsWith(ASSET_PREFIX)) return { __status: 400, body: { error: "INVALID_INPUT" } };
        const ref = url.slice(ASSET_PREFIX.length);
        const cached = dataUrlByRef.current.get(ref);
        if (cached) return { dataUrl: cached };
        const res = await canvasCmd({ type: "canvas/readAsset", ref });
        if (!res || !res.ok || !res.dataUrl) { setNotice("素材不可用（" + String((res && res.error) || "UNKNOWN") + "）"); return { __status: 404, body: { error: (res && res.error) || "ASSET_UNAVAILABLE" } }; }
        dataUrlByRef.current.set(ref, res.dataUrl);
        refByDataUrl.current.set(res.dataUrl, ASSET_PREFIX + ref);
        return { dataUrl: res.dataUrl, name: res.name };
      }
      case "library.addItem":
      case "library.addItems": {
        const list: { url: string; name: string }[] = method === "library.addItem" ? [{ url: String(params.url || ""), name: String(params.name || "") }] : (Array.isArray(params.items) ? params.items : []).map((it: any) => ({ url: String((it && it.url) || ""), name: String((it && it.name) || "") }));
        let saved = 0;
        for (const it of list.slice(0, 8)) {
          // 已经是资源库里的图（引用或其显示数据）→ 不重复入库
          if (it.url.startsWith(ASSET_PREFIX) || refByDataUrl.current.has(it.url)) { saved += 1; continue; }
          if (!it.url.startsWith("data:")) continue;
          if (!canvasId) return { __status: 409, body: { detail: "请先打开一个画布" } };
          const res = await canvasCmd({ type: "canvas/importAsset", canvasId, name: it.name || "画布素材", dataUrl: it.url });
          if (res && res.ok && res.ref) {
            dataUrlByRef.current.set(String(res.ref).slice(ASSET_PREFIX.length), it.url);
            refByDataUrl.current.set(it.url, res.ref);
            saved += 1;
          }
        }
        if (!saved && list.length) return { __status: 502, body: { detail: "保存到 OpenArc 资源库失败" } };
        setNotice("已保存到 OpenArc 资源库");
        return await libraryShape();
      }
      case "library.renameItem": {
        const name = String(params.name || "").trim();
        if (!name) return { __status: 400, body: { detail: "名称不能为空" } };
        const r = await resourceCmd({ type: "resource/updateMetadata", resourceRef: "resource://" + String(params.id || ""), name });
        if (!r || !r.ok) return { __status: 502, body: { detail: "重命名失败（" + String((r && r.error) || "UNKNOWN") + "）" } };
        return await libraryShape();
      }
      case "library.trashItems": {
        const ids: string[] = Array.isArray(params.ids) ? params.ids.map(String) : [];
        let failed = 0;
        for (const id of ids.slice(0, 50)) {
          const r = await resourceCmd({ type: "resource/delete", resourceRef: "resource://" + id });
          if (!r || !r.ok) failed += 1;
        }
        if (failed) setNotice(failed + " 个素材没能移到回收站（可能没有权限）");
        return await libraryShape();
      }
      case "library.unsupported":
        return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", detail: "素材分组由 OpenArc 资源库统一管理，请在「资源库」里整理" } };
      default: return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "不在 OpenArc 集成范围内的能力：" + method } };
    }
  }, [accessLost, buildConfig, canvasCmd, items, libraryShape, notifyAccess, pushContext, refreshList, resolveRefs, refsBack, resourceCmd, sizePolicyTable, taskCmd, upstreamCanvas]);

  /** 页面整帧重置 / 宿主卸载 / 窗口关闭时，把所有在途流式调用连同主进程请求一起停掉（不留悬挂）。*/
  const abortAllStreams = useCallback(() => {
    const list = Array.from(rpcStreams.current.values());
    rpcStreams.current.clear();
    for (const s of list) { try { s.abort(); } catch { /* ignore */ } }
  }, []);

  /**
   * `POST /api/canvas-llm/stream` 的宿主侧：真实走 ModelService.chatStream（经 canvas/modelChatStream），
   * 增量从既有 model:event 通道到达后转成页面要的 SSE 分块，经既有 postMessage 回传。
   * 开流时机 = 第一条真实正文（response.start / usage 不算），避免把非流式响应开成空流；
   * 一帧正文都没出过就按"这里没有流式"（409）如实收口，页面据此退回普通接口。
   * 取消：页面 abort → 宿主 canvas/runStop → 主进程 abort 在途 HTTP。
   */
  const handleStreamCall = useCallback(async (rpcId: number | string, params: Record<string, any>, frameWin: Window) => {
    const send = (msg: Record<string, unknown>) => { try { frameWin.postMessage({ ch: CH, dir: "host->canvas", ...msg }, "*"); } catch { /* 帧已失效 */ } };
    const body = (params.body || {}) as any;
    const cur = currentRef.current;
    const canvasId = (cur && cur.canvasId) || null;
    if (!canvasId) { send({ kind: "stream-open", id: rpcId, ok: false, status: 502, error: { error: "CANVAS_NOT_OPEN", message: "请先打开一个画布" } }); return; }
    const wanted = String(body.model || "");
    const configId = wanted ? labelToConfig.current.get(wanted) : null;
    if (wanted && !configId) {
      setModelNotFound((n) => n + 1);
      setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wanted);
      const rej = rejectUnknownModel("model.chatStream", wanted);
      send({ kind: "stream-open", id: rpcId, ok: false, status: rej.__status, error: { error: rej.body.error, message: rej.body.message } });
      return;
    }
    const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "chat", nodeId: body.nodeId || null });
    if (!run || !run.ok) {
      const code = String((run && run.error) || "RUN_FAILED");
      setNotice("无法开始生成：" + code);
      send({ kind: "stream-open", id: rpcId, ok: false, status: 502, error: { error: code, message: explain(code) } });
      return;
    }
    const requestId = "cvstream_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const state = { opened: false, settled: false, aborted: false, errorSent: false };
    const open = (msg: Record<string, unknown>) => { if (state.settled) return; state.settled = true; send({ kind: "stream-open", id: rpcId, ...msg }); };
    const chunk = (frame: Parameters<typeof sseChunk>[0]) => { send({ kind: "stream-chunk", id: rpcId, data: sseChunk(frame) }); };
    const entry = {
      push: (ev: unknown) => {
        if (state.aborted) return;
        const content = isStreamContentEvent(ev);
        if (content) {
          state.opened = true;
          open({ ok: true, status: 200 });
        } else if (!state.opened) {
          return; // 未出正文前：start / usage / complete / 早到的 error 都交给收尾统一判定
        }
        const frame = pageFrameFor(ev);
        if (frame && !(frame.type === "error" && state.errorSent)) {
          if (frame.type === "error") state.errorSent = true;
          chunk(frame);
        }
      },
    };
    streams.current.set(String(requestId), entry);
    rpcStreams.current.set(rpcId, {
      abort: () => {
        if (state.aborted) return;
        state.aborted = true;
        void canvasCmd({ type: "canvas/runStop", canvasId, runId: run.runId, reason: "USER_STOP" });
      },
    });
    const system = String(body.system_prompt || "You are a helpful assistant.");
    const history = Array.isArray(body.messages) ? body.messages : [];
    const messages = [{ role: "system", content: system }]
      .concat(history.slice(-20).map((m: any) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "") })))
      .concat([{ role: "user", content: String(body.message || "") }]);
    let res: any = null;
    try {
      res = await canvasCmd({ type: "canvas/modelChatStream", canvasId, runId: run.runId, messages, configId, requestId });
      await canvasCmd({ type: "canvas/runFinish", canvasId, runId: run.runId, status: (res && res.ok) ? "DONE" : "FAILED" });
    } finally {
      streams.current.delete(String(requestId));
      rpcStreams.current.delete(rpcId);
    }
    if (state.aborted) return; // 页面已取消：桥那边按 AbortError 收尾，这里不再回帧
    const finalText = String((res && res.text) || "");
    if (!state.opened) {
      if (res && res.ok && finalText.length > 0) {
        open({ ok: true, status: 200 }); // 真实输出已拿到，只是首帧没赶在收尾前到达：按 200 如实交付
      } else {
        const decision = closeStreamWithoutContent({ ok: !!(res && res.ok), error: res && res.error });
        if (decision.unsupported) setNotice("当前模型未返回流式正文，已自动改用普通接口（结果不会丢）：" + wanted);
        open({ ok: false, status: decision.status, error: { error: decision.error, message: decision.unsupported ? "当前模型不支持流式返回，已改用普通接口重试" : explain(String(decision.error)) } });
        return;
      }
    }
    if (res && res.ok) {
      chunk({ type: "done", text: finalText });
    } else if (!state.errorSent) {
      chunk(streamCloseErrorFrame(res && res.error));
    }
    send({ kind: "stream-end", id: rpcId });
  }, [canvasCmd]);

  // 应用页面的请求 → 受控命令 → 回包（**只接受当前外壳实例**；子页由外壳中继附加 token）
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data as Rpc;
      if (!d || d.ch !== CH || d.dir !== "canvas->host") return;
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) return;                       // 其他 iframe / 其他窗口一律忽略
      const relayed = typeof d.id === "string" && /^f\d+:\d+$/.test(d.id);       // 子页调用（外壳中继）
      if (d.kind !== "hello-request" && d.kind !== "notice" && d.kind !== "alive" && d.token !== instanceToken.current) return; // 旧实例 / 伪造 token 一律忽略
      lastBeat.current = Date.now();
      beatSeq.current += 1;
      if (d.kind === "alive") return;
      // 列表卡片菜单「共享…」（openarc-bridge.js 的 openShare）：只带 canvasId，面板由宿主打开；
      // 页面里没有任何共享 UI。token 校验已在上面的消息闸门做过。
      if (d.kind === "open-share") {
        const id = parseShareTargetMessage(d);
        if (!id) return;
        const cur = currentRef.current;
        const fromCurrent = !!cur && cur.canvasId === id;
        const title = fromCurrent ? cur!.title : (itemsRef.current.find((it) => it.canvasId === id)?.title || "");
        setHostPanel(null);
        setShareTarget({ canvasId: id, title, origin: fromCurrent ? "canvas" : "list" });
        return;
      }
      // 页面取消/中断：流式调用把取消传到主进程（canvas/runStop 中止在途 HTTP），不留悬挂请求。
      if (d.kind === "abort") {
        const s = rpcStreams.current.get(d.id as number | string);
        if (s) s.abort();
        return;
      }
      if (d.kind === "hello-request") {
        const cur = currentRef.current;
        frameWin.postMessage({
          ch: CH, dir: "host->canvas", kind: "hello", token: instanceToken.current,
          canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null,
          account: "openarc", accountKey: (frameSrc.split("#oa=")[1] || null), reducedMotion: reducedMotion(),
        }, "*");
        return;
      }
      if (d.kind === "context-request") {
        const cur = currentRef.current;
        frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "context", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null, accountKey: (frameSrc.split("#oa=")[1] || null), reducedMotion: reducedMotion() }, "*");
        return;
      }
      if (d.kind === "notice") { if (d.message) setNotice(String(d.message)); return; }
      if (d.kind === "frame" && d.event === "reset") return;
      if (d.kind === "blocked") { setNotice("只读画布：没有编辑权限（手工与 AI 修改都会被同一条权限规则拒绝）"); return; }
      if (d.kind === "frame") {
        if (d.event === "canvas-closed") { setStatus("已回到应用页面"); }
        return;
      }
      if (d.kind === "adapter-ready" || d.kind === "adapter-timeout") {
        setStatus(d.kind === "adapter-ready" ? "画布就绪" : "画布适配器未就绪");
        const st = (d.state || {}) as any;
        const id = st.canvasId ? String(st.canvasId) : null;
        if (d.kind === "adapter-ready" && id && (!currentRef.current || currentRef.current.canvasId !== id)) {
          void (async () => {
            const next = await bindCanvas(id);
            if (next) await pushContext(next);
          })();
        }
        return;
      }
      if ((d.kind === "command-result" || d.kind === "state") && typeof d.id === "number") {
        const resolve = shellPending.current.get(d.id);
        if (resolve) { shellPending.current.delete(d.id); resolve(d); }
        return;
      }
      if (d.kind === "call" && (typeof d.id === "number" || relayed) && d.method) {
        // 流式调用专用分发：它要边跑边把分块推回 iframe，不能走 handleCall 的一次性回包。
        if (d.method === "model.chatStream") { void handleStreamCall(d.id as number | string, (d.params || {}) as Record<string, any>, frameWin); return; }
        void handleCall(d.method, (d.params || {}) as Record<string, any>).then((value) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: true, value }, "*");
        }).catch((err) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: false, error: { error: "HOST_ERROR", message: String((err && err.message) || err) } }, "*");
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bindCanvas, frameSrc, handleCall, handleStreamCall, pushContext]);

  // 画布流式下行：主进程把 canvas/modelChatStream 的增量经**既有** model:event 通道送来
  //（payload.type = "canvas.stream"，带 requestId），按 requestId 路由到对应 iframe 的那条流。
  // 端口本身没有新增：仍然是 preload 已暴露的 window.openarc.model.onEvent。
  useEffect(() => {
    const api = (window as any).openarc?.model;
    if (!api || typeof api.onEvent !== "function") return;
    const off = api.onEvent((event: any) => {
      const payload = event && event.payload;
      if (!payload || payload.type !== "canvas.stream") return;
      const entry = streams.current.get(String(payload.requestId || ""));
      if (entry) entry.push(payload.event || null);
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  // 宿主卸载 / 窗口关闭：把所有在途流式调用停掉（避免用户关窗后主进程还挂着 provider 请求）。
  useEffect(() => {
    const onUnload = () => abortAllStreams();
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("beforeunload", onUnload); abortAllStreams(); };
  }, [abortAllStreams]);

  /** 整帧重置：换新实例 token + 把应用帧重挂载回 bundle 入口（旧页面与旧 token 立即失效）。
   *  看门狗（长时间不心跳）与"iframe 换了文档"复核共用这一条路径。*/
  const resetAppFrame = useCallback((reason: string) => {
    // 整帧重置（导航被替换/崩溃/看门狗）时，旧页面发起的流式调用一并停掉。
    abortAllStreams();
    lastBeat.current = Date.now();
    instanceToken.current = randomToken();
    setNotice(reason);
    void (async () => {
      let seed = "anon";
      try {
        const st: any = await (window as any).openarc?.identity?.command({ type: "identity/status" });
        const s = st?.snapshot;
        if (s && s.userId) seed = String(s.userId) + ":" + String(s.sessionRef || "");
      } catch { /* ignore */ }
      setFrameSrc(IFRAME_BASE + "#oa=" + keyOf(seed + ":" + instanceToken.current));
      setFrameKey((k) => k + 1);
    })();
  }, [abortAllStreams]);
  resetFrameRef.current = resetAppFrame;

  // 应用帧看门狗：正常情况下外壳中继每 800ms 发一次心跳。若连续 8s 没有任何消息，
  // 说明该帧被非预期导航/崩溃打断（例如页面自我导航到外部站点被 CSP/宿主拦下后停在错误页）——
  // 这里整帧重置到 bundle 入口（新 token），保证用户不会卡在错误页上，也保证旧页面立即失效。
  useEffect(() => {
    const timer = setInterval(() => {
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || !frameSrc) return;
      if (Date.now() - lastBeat.current < 8000) return;
      resetAppFrame("应用页面被非预期导航/崩溃中断，已重置（旧页面与旧实例 token 立即失效）");
    }, 3000);
    return () => clearInterval(timer);
  }, [frameSrc, resetAppFrame]);

  /** 帧内文档被换掉之后的复核：iframe 自我导航出网是被**父文档的 CSP frame-src** 拦下的，
   *  导航根本没走到主进程（will-frame-navigate 不触发），帧里落的是 Chromium 错误页；
   *  错误页同样会触发 iframe 的 load，所以只能按"换了文档之后还说不说话"判定：加载完成 3s 内
   *  连一条本帧消息都没有 = 换出来的不是应用页 → 立即整帧重置回入口（不用等 8s 看门狗）。*/
  // 主题同步：上游 theme.js 自带 {type:"studio-theme"} 消息协议（iframe 间广播用），
  // 宿主用同一协议把 OpenArc 的深浅色推给应用帧，让画布页底色与窗口标题条连成一片。
  const postTheme = useCallback(() => {
    const dark = !!document.querySelector(".desktop.dark");
    try { frameRef.current?.contentWindow?.postMessage({ type: "studio-theme", theme: dark ? "dark" : "light" }, "*"); } catch { /* 帧未就绪 */ }
  }, []);
  useEffect(() => {
    const desk = document.querySelector(".desktop");
    if (!desk) return;
    const mo = new MutationObserver(() => postTheme());
    mo.observe(desk, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [postTheme]);
  const onFrameLoad = useCallback(() => {
    postTheme();
    if (loadCheck.current) window.clearTimeout(loadCheck.current);
    const seen = beatSeq.current;
    loadCheck.current = window.setTimeout(() => {
      loadCheck.current = null;
      if (beatSeq.current === seen) resetAppFrame("应用页面被非预期导航替换，已立即重置（旧页面与旧实例 token 立即失效）");
    }, 3000);
  }, [resetAppFrame, postTheme]);
  useEffect(() => () => { if (loadCheck.current) window.clearTimeout(loadCheck.current); }, []);

  // 主进程拦截的应用内导航出网：证据留在宿主 notice 状态里（不再有计数徽标）
  useEffect(() => {
    const off = (window as any).openarc?.onNativeState?.((e: any) => {
      if (String(e?.type || "") !== "canvas-navigation-blocked") return;
      setNotice("已拦截应用内导航出网：" + String(e?.url || "").slice(0, 120));
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  // 账号作用域钥匙：账号 + 本次挂载；窗口重挂载（含切账号）后旧钥匙立即失效。
  useEffect(() => {
    void (async () => {
      let seed = "anon";
      try {
        const st: any = await (window as any).openarc?.identity?.command({ type: "identity/status" });
        const s = st?.snapshot;
        if (s && s.userId) seed = String(s.userId) + ":" + String(s.sessionRef || "") + ":" + String(s.sessionId || "");
      } catch { /* 未登录/不可用就用 anon */ }
      const key = keyOf(seed + ":" + instanceToken.current);
      setFrameSrc(IFRAME_BASE + "#oa=" + key);
    })();
  }, []);

  // 首次：列表 + 模型投影
  useEffect(() => {
    void (async () => {
      await refreshList();
      await buildConfig();
      setStatus("应用已就绪（首页）");
    })();
  }, [buildConfig, refreshList]);

  // 当前画布轮询：revision 跟着 OpenArc 存储走；同时做**引用资源可用性复核**
  //（删除 / 撤权之后，宿主的显示缓存必须失效，不能继续拿旧 data URL 顶替 —— 缺项 3）。
  // revision 检测 800ms：检测到"别处改了"就向已打开的 iframe **推送** doc-changed（页面按 updated_at
  // 幂等合并，输入/未保存改动时延后），页面不必再等自己的 2.5s 兜底轮询；引用资源复核保持原 2.5s 量级。
  useEffect(() => {
    let tick = 0;
    let busy = false;
    const timer = setInterval(() => {
      const cur = currentRef.current;
      if (!cur || busy) return;
      busy = true;
      tick += 1;
      void (async () => {
        try {
          const res = await canvasCmd({ type: "canvas/meta", canvasId: cur.canvasId });
          if (res && res.ok && res.meta) {
            const rev = Number(res.meta.revision || 1);
            const updatedAt = Number(res.meta.updatedAt || 0);
            /* 权限事实每轮都比一次：撤销共享 / 降级 / 转移所有权都不会改 revision，
               只改 access（canEdit/canManage/canShare/source）。变了就立刻 pushContext，
               页面只读闸当场关上，不等用户刷新页面。*/
            const accessChangedNow = notifyAccess(cur.canvasId, res.meta.access);
            const dataChanged = rev !== cur.revision || updatedAt !== cur.updatedAt;
            if (dataChanged || accessChangedNow) {
              setCurrent({ ...cur, revision: rev, updatedAt, ...accessFields(res.meta.access), title: res.meta.title || cur.title });
            }
            if (dataChanged) {
              /* 宿主推送（主路径）：AI / 宿主 IPC / 其它窗口的写入已经进存储，这里把**可显示形态**的文档
                 直接推给已打开的编辑器。push 失败 / iframe 忙时页面自己的 2.5s 轮询会补齐，内容不丢。*/
              const last = lastPushed.current;
              if (updatedAt && (!last || last.canvasId !== cur.canvasId || last.updatedAt !== updatedAt)) {
                const got = await canvasCmd({ type: "canvas/get", canvasId: cur.canvasId });
                if (got && got.ok) {
                  const doc = await resolveRefs(got.canvas.doc);
                  lastPushed.current = { canvasId: cur.canvasId, updatedAt };
                  void toShell({ kind: "doc-changed", canvasId: cur.canvasId, revision: Number(got.canvas.revision || rev), updatedAt, doc, title: got.canvas.title });
                }
              }
            }
          } else if (res && !res.ok && isAccessLostError(res.error)) {
            await accessLost(res.error, cur.canvasId);
            return; // 已切只读/返回列表：本轮不再做资源复核
          }
          if (tick % 3 !== 0) return;
          const refs = Array.from(dataUrlByRef.current.keys());
          if (!refs.length) return;
          const st = await canvasCmd({ type: "canvas/assetStates", refs });
          const exists = (st && st.exists) || {};
          const dead = refs.filter((r) => !(exists[r] && exists[r].state === "AVAILABLE"));
          if (!dead.length) return;
          for (const r of dead) {
            const url = dataUrlByRef.current.get(r);
            if (url) refByDataUrl.current.delete(url);
            dataUrlByRef.current.delete(r);
          }
          setNotice("引用资源已删除或无权限（" + dead.length + " 个）：画布上按不可用显示，不会拿旧缓存顶替");
          const got = await canvasCmd({ type: "canvas/get", canvasId: cur.canvasId });
          if (!got || !got.ok) return;
          const doc = await resolveRefs(got.canvas.doc);
          await toShell({ kind: "reload-doc", doc, updatedAt: Number(got.canvas.updatedAt || 0), title: got.canvas.title }, true);
        } finally {
          busy = false;
        }
      })();
    }, 800);
    return () => clearInterval(timer);
  }, [accessLost, canvasCmd, notifyAccess, resolveRefs, toShell]);

  return (
    <div
      className="browser-shell"
      data-canvas-host={win.id}
      data-canvas-app="novai-full"
      // 宿主不再画提示横幅（横幅是 chrome）。这一对**只读属性**是资源失效复核等路径的
      // 行为证据通道，供探针与门禁读取 —— 不是 UI，也没有用 CSS 把任何东西藏起来。
      data-canvas-asset-notice={notice ? "1" : "0"}
      data-canvas-asset-notice-text={notice || undefined}
      // 清单外模型名的拒绝计数（只读证据：配合"0 次 provider 请求"，证明没有静默回落）
      data-canvas-model-not-found={modelNotFound}
      // 当前打开的画布 id（只读证据通道：宿主浮层/探针据此判断"协作/打包作用于哪一本"）
      data-canvas-current-id={current ? current.canvasId : ""}
    >
      {frameSrc ? (
        <iframe
          key={frameKey}
          ref={frameRef}
          title="NOVAI 无限画布（OpenArc 集成）"
          className="canvas-host-frame"
          data-canvas-frame
          data-canvas-app-frame
          // allow-modals 只放行 alert / confirm / prompt / print 这类模态对话（上游卡片菜单的删除/重命名/复制
          // 与错误提示要用），不新增文件系统 / 网络 / origin / 脚本执行 / 跨源能力：帧仍与外壳不同源，
          // 实例 token 校验、CSP、只读闸一律未动。
          sandbox="allow-scripts allow-same-origin allow-modals"
          onLoad={onFrameLoad}
          src={frameSrc}
        />
      ) : (
        <div className="web-viewport" data-canvas-frame-pending>正在准备应用…</div>
      )}
      {/* 共享 / 协作 / 打包入口与面板都是**宿主浮层**：不修改 iframe 里的页面 DOM。
          三个入口在同一行（右上角），同一时刻只开一个面板；协作与打包只对当前打开的这本画布生效。*/}
      {current || shareTarget || hostPanel ? (
        <div
          className={"canvas-share-layer" + (reducedMotion() ? " reduced" : "")}
          data-canvas-share-layer
          data-canvas-share-open={shareTarget ? shareTarget.canvasId : ""}
          data-canvas-share-entry-source={current?.source || ""}
          data-canvas-share-reduced={reducedMotion() ? "1" : "0"}
          data-canvas-host-panel={hostPanel ? hostPanel.kind : ""}
        >
          {current ? (
            <div className="canvas-host-actions" data-canvas-host-actions>
              <CanvasShareEntry
                canManage={!!current.canManage}
                source={current.source}
                expanded={!!shareTarget && shareTarget.canvasId === current.canvasId}
                buttonRef={shareEntryRef}
                onOpen={() => { setHostPanel(null); setShareTarget({ canvasId: current.canvasId, title: current.title, origin: "canvas" }); }}
              />
              <CanvasHostPanelEntry
                kind="collab"
                label="协作"
                icon={<Users size={14} aria-hidden="true" />}
                expanded={!!hostPanel && hostPanel.kind === "collab" && hostPanel.canvasId === current.canvasId}
                buttonRef={collabEntryRef}
                onOpen={() => toggleHostPanel("collab")}
              />
              <CanvasHostPanelEntry
                kind="package"
                label="打包"
                icon={<Package size={14} aria-hidden="true" />}
                expanded={!!hostPanel && hostPanel.kind === "package" && hostPanel.canvasId === current.canvasId}
                buttonRef={packageEntryRef}
                onOpen={() => toggleHostPanel("package")}
              />
              <CanvasHostPanelEntry
                kind="assets"
                label="素材"
                icon={<Images size={14} aria-hidden="true" />}
                expanded={!!hostPanel && hostPanel.kind === "assets" && hostPanel.canvasId === current.canvasId}
                buttonRef={assetsEntryRef}
                onOpen={() => toggleHostPanel("assets")}
              />
              <CanvasHostPanelEntry
                kind="invite"
                label="邀请"
                icon={<Ticket size={14} aria-hidden="true" />}
                expanded={!!hostPanel && hostPanel.kind === "invite" && hostPanel.canvasId === current.canvasId}
                buttonRef={inviteEntryRef}
                onOpen={() => toggleHostPanel("invite")}
              />
              <CanvasHostPanelEntry
                kind="plugins"
                label="插件"
                icon={<Puzzle size={14} aria-hidden="true" />}
                expanded={!!hostPanel && hostPanel.kind === "plugins" && hostPanel.canvasId === current.canvasId}
                buttonRef={pluginsEntryRef}
                onOpen={() => toggleHostPanel("plugins")}
              />
            </div>
          ) : null}
          {shareTarget ? (
            <CanvasSharePanel
              canvasId={shareTarget.canvasId}
              title={shareTarget.title}
              cmd={canvasCmd}
              refreshToken={shareRefresh}
              onClose={closeSharePanel}
              onAccessChanged={() => { void refreshCurrentAccess(shareTarget.canvasId, false); }}
              onFatalAccessLost={(code) => { void accessLost(code, shareTarget.canvasId); }}
            />
          ) : null}
          {hostPanel && current && hostPanel.canvasId === current.canvasId && hostPanel.kind === "collab" ? (
            <CanvasCollabPanel key={"collab:" + hostPanel.canvasId} canvasId={hostPanel.canvasId} title={current.title} cmd={canvasCmd} onClose={closeHostPanel} />
          ) : null}
          {hostPanel && current && hostPanel.canvasId === current.canvasId && hostPanel.kind === "package" ? (
            <CanvasPackagePanel
              key={"package:" + hostPanel.canvasId}
              canvasId={hostPanel.canvasId}
              title={current.title}
              cmd={canvasCmd}
              onClose={closeHostPanel}
              onImported={() => { void refreshList(); }}
            />
          ) : null}
          {hostPanel && current && hostPanel.canvasId === current.canvasId && hostPanel.kind === "assets" ? (
            <CanvasAssetSyncPanel key={"assets:" + hostPanel.canvasId} canvasId={hostPanel.canvasId} title={current.title} cmd={canvasCmd} onClose={closeHostPanel} />
          ) : null}
          {hostPanel && current && hostPanel.canvasId === current.canvasId && hostPanel.kind === "invite" ? (
            <CanvasInvitePanel
              key={"invite:" + hostPanel.canvasId}
              canvasId={hostPanel.canvasId}
              title={current.title}
              canManage={!!current.canManage}
              cmd={canvasCmd}
              onClose={closeHostPanel}
              onRedeemed={() => { void refreshList(); }}
            />
          ) : null}
          {hostPanel && current && hostPanel.canvasId === current.canvasId && hostPanel.kind === "plugins" ? (
            <CanvasPluginsPanel key={"plugins:" + hostPanel.canvasId} cmd={canvasCmd} onClose={closeHostPanel} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「AI 新增」标记（MOTION_SYSTEM §6）：从**画布命令账本**里读出真正由 AI 新增、且**现在仍在文档里**
 * 的节点 / 连线 id。只读：走既有 canvas/log 与 canvas/get，不新增命令面、不动任何权限口径。
 * 判据是账本本身（actorKind=AGENT + outcome=APPLIED + 命令里带 id），**不是**"这次改动是远端同步来的"
 * —— 本地用户新增、别的窗口的 USER 操作都会走同一条远端同步路径，按同步来源猜会把它们全打成 AI。
 * 日志记的是命令，不是结果：只有命令里带了 id 的新增才能对上号（AI 的 canvas.edit 就是这么传的）；
 * node.copy / 未带 id 的新增在账本里没有 id 可对 —— 不猜、不标记（没有证据，而不是"漏了"）。
 */
async function agentMarksOf(canvasCmd: (p: Record<string, unknown>) => Promise<any>, target: string) {
  const log = await canvasCmd({ type: "canvas/log", canvasId: target, limit: 200 });
  if (!log || !log.ok) return { ok: false, error: String((log && log.error) || "LOG_UNAVAILABLE"), marks: [] };
  const got = await canvasCmd({ type: "canvas/get", canvasId: target });
  if (!got || !got.ok) return { ok: false, error: String((got && got.error) || "DOC_UNAVAILABLE"), marks: [] };
  const doc = (got.canvas && got.canvas.doc) || {};
  const liveNodes = new Set<string>((doc.nodes || []).map((n: any) => String(n && n.id)));
  const liveEdges = new Set<string>((doc.connections || []).map((c: any) => String(c && c.id)));
  const marks: Array<{ nodeIds: string[]; edgeIds: string[]; commandType: string; resultRevision: number | null; at: number | null }> = [];
  for (const row of ((log.items || []) as any[])) {
    if (String(row && row.actorKind).toUpperCase() !== "AGENT") continue;
    if (String(row && row.outcome).toUpperCase() !== "APPLIED") continue;
    const cmd = (row && row.command) || {};
    const type = String(cmd.type || "");
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    if (type === "node.add" && cmd.node && cmd.node.id) nodeIds.push(String(cmd.node.id));
    if (type === "edge.connect" && cmd.id) edgeIds.push(String(cmd.id));
    // 只回**仍存在于当前文档里**的 id：命令是历史，节点可能已经被删掉/撤销掉。
    const liveN = nodeIds.filter((id) => liveNodes.has(id));
    const liveE = edgeIds.filter((id) => liveEdges.has(id));
    if (!liveN.length && !liveE.length) continue;
    marks.push({ nodeIds: liveN, edgeIds: liveE, commandType: type, resultRevision: Number(row.resultRevision) || null, at: Number(row.at) || null });
  }
  return { ok: true, canvasId: target, marks, scanned: ((log.items || []) as any[]).length };
}

/** 清单外模型名的统一拒绝载荷（MODEL_NOT_FOUND；不建 run、不发 provider 请求）。*/
function rejectUnknownModel(method: string, label: string) {
  return {
    __status: 502,
    body: {
      // error 是稳定错误码（门禁断言用）；detail 是人话（上游错误弹窗优先显示它，避免只给一个错误码）。
      error: "MODEL_NOT_FOUND",
      detail: "该模型不在当前 OpenArc 模型清单里（不会改用其它模型）：" + label,
      message: "当前 OpenArc 模型清单里没有这个模型（不会改用其它模型）：" + label,
      model: label, method,
    },
  };
}

function explain(code: string) {
  if (code === "MODEL_NOT_FOUND") return "该模型不在当前 OpenArc 模型清单里（不会改用其它模型，请在 设置 → 模型 / AI 里登记）";
  if (code === "CAPABILITY_UNAVAILABLE") return "该模型没有这项能力（OpenArc 不会用文本接口顶替）";
  if (code === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置（请在 设置 → 模型 里配置）";
  if (code === "CREDENTIAL_MISSING") return "该模型缺少凭据";
  if (code === "PROXY_UNAUTHORIZED") return "没有权限使用该模型（应用授权已被撤销或未授予）";
  if (code === "BUDGET_EXHAUSTED") return "本次生成的任务预算已用尽";
  if (code === "TASK_CANCELLED" || code === "RUN_STOPPED") return "生成已停止";
  if (code === "CANVAS_CHANGED") return "画布在生成期间已被修改，结果未写入（保留你的内容）";
  return code;
}
