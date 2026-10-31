/**
 * 音频节点的波形数据。
 *
 * 把音频整段解码成单声道采样（只做一次，按地址缓存），再按段算音量（peaks）画胶囊波形。
 * 直接解码数据、不经过 <audio> 的 Web Audio 管线：播放地址是流式的 openarc-resource（不开 CORS），
 * createMediaElementSource 只会拿到静音，而这里不受影响。
 */

export type Decoded = { samples: Float32Array; sampleRate: number; duration: number };

const MAX_CACHE = 8;
const cache = new Map<string, Promise<Decoded | null>>();

let ctxRef: BaseAudioContext | null = null;
function decoderCtx(): BaseAudioContext | null {
  if (ctxRef) return ctxRef;
  const W = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; AudioContext?: typeof AudioContext };
  try {
    // OfflineAudioContext 不占用音频设备，也不需要用户手势
    if (W.OfflineAudioContext) ctxRef = new W.OfflineAudioContext(1, 1, 44100);
    else if (W.AudioContext) ctxRef = new W.AudioContext();
  } catch { ctxRef = null; }
  return ctxRef;
}

/**
 * 读出音频字节。桌面版页面的 CSP 是 connect-src 'none'，fetch 连 data: 都读不了，
 * 所以资源库给的 data URL 直接在本地解 base64；其它地址（开发页的 http / blob）才用 fetch。
 */
async function readBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(","); const meta = url.slice(5, comma); const body = url.slice(comma + 1);
    if (/;base64$/i.test(meta)) {
      const bin = atob(body); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u.buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(body)).buffer as ArrayBuffer;
  }
  const res = await fetch(url); if (!res.ok) throw new Error("HTTP " + res.status);
  return res.arrayBuffer();
}

/** 解码一段音频；失败（地址读不到、格式不支持）返回 null，界面退回占位波形。 */
export function decodeAudio(url: string): Promise<Decoded | null> {
  if (!url) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) { cache.delete(url); cache.set(url, hit); return hit; }
  const p = (async () => {
    const ctx = decoderCtx(); if (!ctx) return null;
    const buf = await ctx.decodeAudioData(await readBytes(url));
    const n = buf.length; const ch = buf.numberOfChannels;
    const samples = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) samples[i] += d[i] / ch; }
    return { samples, sampleRate: buf.sampleRate, duration: buf.duration } as Decoded;
  })().catch(() => null);
  p.then((r) => { if (!r) cache.delete(url); });
  cache.set(url, p);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return p;
}

/** 整段波形峰值（0~1，按最大值归一），count 根柱 */
export function peaks(d: Decoded, count: number): number[] {
  const out: number[] = []; const n = d.samples.length; const step = n / count;
  let max = 0;
  for (let b = 0; b < count; b++) {
    const s = Math.floor(b * step), e = Math.min(n, Math.floor((b + 1) * step));
    // 长音频每段最多抽 4000 个采样，避免节点一多就卡
    const stride = Math.max(1, Math.floor((e - s) / 4000));
    let sum = 0, k = 0;
    for (let i = s; i < e; i += stride) { const v = d.samples[i]; sum += v * v; k++; }
    const rms = k ? Math.sqrt(sum / k) : 0;
    out.push(rms); if (rms > max) max = rms;
  }
  return out.map((v) => (max > 0 ? Math.max(0.04, v / max) : 0.04));
}
