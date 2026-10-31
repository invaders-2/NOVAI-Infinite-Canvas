import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

const fmt = (value: number) => {
  const total = Math.max(0, Math.floor(value || 0));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};

export function AudioWaveform({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false); setPeaks([]); setDuration(0); setTime(0);
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || !url) { setFailed(true); return () => { cancelled = true; }; }
    void fetch(url).then((response) => response.arrayBuffer()).then((buffer) => {
      const ctx = new Ctx();
      return ctx.decodeAudioData(buffer).then((decoded) => ({ decoded, ctx }));
    }).then(({ decoded, ctx }) => {
      if (cancelled) { void ctx.close(); return; }
      const channel = decoded.getChannelData(0);
      const count = 96; const block = Math.max(1, Math.floor(channel.length / count)); const next: number[] = [];
      for (let index = 0; index < count; index += 1) {
        let peak = 0;
        for (let offset = 0; offset < block; offset += 1) peak = Math.max(peak, Math.abs(channel[index * block + offset] || 0));
        next.push(peak);
      }
      setPeaks(next); setDuration(decoded.duration); void ctx.close();
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const width = canvas.clientWidth || 260; const height = canvas.clientHeight || 48;
    canvas.width = width * 2; canvas.height = height * 2;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(2, 2); ctx.clearRect(0, 0, width, height);
    const ratio = duration > 0 ? Math.min(1, time / duration) : 0;
    const barWidth = width / 96;
    for (let index = 0; index < 96; index += 1) {
      const peak = peaks[index] || 0.08; const h = Math.max(3, peak * (height - 8));
      ctx.fillStyle = index / 96 <= ratio ? "#4f8cff" : "rgba(255,255,255,.22)";
      ctx.fillRect(index * barWidth + 1, (height - h) / 2, Math.max(1, barWidth - 2), h);
    }
    ctx.fillStyle = "#4f8cff"; ctx.fillRect(ratio * width, 0, 2, height);
  }, [peaks, time, duration]);

  const toggle = () => { const audio = audioRef.current; if (!audio) return; if (audio.paused) void audio.play().catch(() => setFailed(true)); else audio.pause(); };
  const seek = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current; if (!audio || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration));
    setTime(audio.currentTime);
  };
  const seekBy = (delta: number) => { const audio = audioRef.current; if (!audio) return; audio.currentTime = Math.max(0, Math.min(duration || audio.duration || 0, audio.currentTime + delta)); setTime(audio.currentTime); };

  return <div className="rc-audio-player" data-testid="node-audio-player">
    <audio ref={audioRef} src={url} data-testid="node-generated-audio" onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    <canvas ref={canvasRef} className="rc-audio-waveform" data-testid="node-audio-waveform" aria-label="音频波形，点击跳转播放位置" onClick={seek} />
    <div className="rc-audio-controls">
      <button aria-label="上一段" data-testid="node-audio-prev" onClick={() => seekBy(-10)}><SkipBack size={12} /></button>
      <button aria-label={playing ? "暂停" : "播放"} data-testid="node-audio-toggle" onClick={toggle}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
      <button aria-label="下一段" data-testid="node-audio-next" onClick={() => seekBy(10)}><SkipForward size={12} /></button>
      <span data-testid="node-audio-time">{fmt(time)} / {fmt(duration)}</span>
      <span className="rc-audio-mode">音乐 · 自适应</span>
    </div>
    {failed ? <audio controls src={url} className="rc-node-audio-real" data-testid="node-audio-fallback" /> : null}
    {failed ? <span className="rc-audio-error" data-testid="node-audio-error">音频解码失败，使用原生播放器</span> : null}
  </div>;
}
