/**
 * 画布助手的语音输入：录音 → 16k 单声道 WAV → 后端 /api/asr/transcribe。
 * 不用 Web Speech API：Electron 与国内网络下它不可用，转写统一交给后端选好的音频模型。
 */

/** 后端转写只吃 16k 单声道 PCM；采集端多为 44.1k / 48k，必须自己降采样 */
const TARGET_RATE = 16000;
const DEFAULT_MAX_SECONDS = 90;

export type VoicePhase = "idle" | "recording" | "transcribing";

export type VoiceResult = { ok: boolean; text?: string; code?: string; error?: string };

export type VoiceCapture = {
  /** 结束录音并返回 WAV；已经结束 / 取消过时返回 null（重复调用安全） */
  stop: () => Promise<Blob | null>;
  /** 丢弃这段录音并释放麦克风（重复调用安全） */
  cancel: () => void;
};

export type VoiceCaptureOptions = {
  maxSeconds?: number;
  /** 到达时长上限自动结束：回调带着编码好的 WAV，调用方不用再调 stop() */
  onAutoStop?: (blob: Blob) => void;
};

/**
 * 降采样到目标采样率：按区间取平均（盒式滤波），比直接抽点少一点混叠。
 * 纯函数，不碰 window / AudioContext，node 单测直接用。
 */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (!input.length) return new Float32Array(0);
  if (!(to > 0) || !(from > to)) return input.slice();
  const ratio = from / to;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    out[i] = end > start ? sum / (end - start) : input[start] || 0;
  }
  return out;
}

/** Float32 样本 → 单声道 16bit WAV（RIFF）。纯函数，不依赖 window，供 node 单测。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** 开始录音。权限 / 设备错误直接 reject 原始 DOMException，由调用方转成人话。 */
export async function startVoiceCapture(options: VoiceCaptureOptions = {}): Promise<VoiceCapture> {
  const maxSeconds = Number(options.maxSeconds) > 0 ? Number(options.maxSeconds) : DEFAULT_MAX_SECONDS;
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) throw new DOMException("当前环境不支持录音", "NotSupportedError");
  const stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
  if (!Ctor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new DOMException("当前环境不支持录音", "NotSupportedError");
  }
  const context = new Ctor();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  // ScriptProcessor 只有接到 destination 才会持续触发；串一个静音 Gain，避免把麦克风放出来
  const mute = context.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  const sampleRate = context.sampleRate;
  let stopped = false;
  let timer: number | null = null;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  // 部分浏览器在用户手势之外创建时状态是 suspended，接着录会一直收不到声音
  if (context.state === "suspended") void context.resume?.().catch(() => undefined);

  const release = () => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch { /* 可能已经断开 */ }
    try { source.disconnect(); } catch { /* 同上 */ }
    try { mute.disconnect(); } catch { /* 同上 */ }
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
  };

  const stop = async (): Promise<Blob | null> => {
    if (stopped) return null;
    stopped = true;
    release();
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!total) return null;
    const merged = new Float32Array(total);
    let at = 0;
    for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length; }
    chunks.length = 0;
    return encodeWav(downsample(merged, sampleRate, TARGET_RATE), TARGET_RATE);
  };

  const cancel = () => {
    if (stopped) return;
    stopped = true;
    chunks.length = 0;
    release();
  };

  timer = window.setTimeout(() => {
    if (stopped) return;
    void stop().then((blob) => { if (blob) options.onAutoStop?.(blob); });
  }, maxSeconds * 1000);

  return { stop, cancel };
}

/** 上传 WAV 给后端转写；网络 / 非 2xx 一律归一成 ASR_PROVIDER_ERROR */
export async function transcribeVoice(blob: Blob): Promise<VoiceResult> {
  try {
    const form = new FormData();
    form.append("audio", new File([blob], "voice-" + Date.now() + ".wav", { type: "audio/wav" }));
    form.append("lang", "zh");
    const response = await fetch("/api/asr/transcribe", { method: "POST", body: form });
    let payload: { ok?: boolean; text?: string; code?: string; error?: string } | null = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (payload && payload.ok === true) {
      const text = String(payload.text || "").trim();
      return text ? { ok: true, text } : { ok: false, code: "ASR_EMPTY", error: "转写结果为空" };
    }
    if (payload && typeof payload.code === "string" && payload.code) {
      return { ok: false, code: payload.code, error: String(payload.error || "") };
    }
    return {
      ok: false,
      code: "ASR_PROVIDER_ERROR",
      error: response.ok ? "转写服务没有返回内容" : "转写失败（HTTP " + response.status + "）",
    };
  } catch (error) {
    return { ok: false, code: "ASR_PROVIDER_ERROR", error: error instanceof Error ? error.message : "网络请求失败" };
  }
}

/** 错误码 / 媒体错误名 → 中文人话；权限与设备错误单独给操作路径 */
export function voiceErrorText(code?: string, error?: string): string {
  const detail = String(error || "").trim();
  switch (String(code || "")) {
    case "ASR_NOT_CONFIGURED":
      return "还没配置语音转写：设置 → 通用 → 语音转写 里选一个支持音频的模型";
    case "ASR_UNSUPPORTED":
      return "当前模型不支持音频转写：设置 → 通用 → 语音转写 里换一个支持音频的模型";
    case "ASR_AUDIO_INVALID":
      return "这段录音没能识别（格式不对或太短），再说一次试试";
    case "ASR_EMPTY":
      return "没听清，再说一次试试";
    case "NotAllowedError":
    case "SecurityError":
      return "没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风 里允许 NOVAI";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "没找到麦克风：检查设备是否已连接";
    case "NotReadableError":
    case "TrackStartError":
      return "麦克风被别的应用占用了，关掉它再试";
    case "NotSupportedError":
      return "当前环境不支持录音，可以用系统听写输入";
    case "ASR_PROVIDER_ERROR":
    default:
      return "语音转写失败" + (detail ? "：" + detail : "，过一会儿再试");
  }
}
