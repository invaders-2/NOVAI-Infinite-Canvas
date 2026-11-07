import { useEffect, useState } from "react";

export function TimelineWaveform({ url, inPoint, outPoint }: { url: string; inPoint: number; outPoint: number }) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPeaks(null); setFailed(false);
    (async () => {
      try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const audio = await ctx.decodeAudioData(buffer.slice(0));
        const channel = audio.getChannelData(0);
        const bars = 96;
        const step = Math.max(1, Math.floor(channel.length / bars));
        const next: number[] = [];
        for (let i = 0; i < bars; i += 1) {
          let peak = 0;
          const start = i * step;
          for (let j = start; j < Math.min(channel.length, start + step); j += 1) peak = Math.max(peak, Math.abs(channel[j]));
          next.push(Math.min(1, peak));
        }

        if (!cancelled) setPeaks(next);
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (failed || !peaks) return <div className="rc-waveform is-flat" data-testid="timeline-waveform" data-bars="0" data-fallback="true"><span /></div>;
  const duration = Math.max(0.1, outPoint - inPoint);
  return <div className="rc-waveform" data-testid="timeline-waveform" data-bars={peaks.length}>{peaks.map((peak, index) => { const at = (index / peaks.length) * duration; const active = at >= 0 && at <= duration; return <span key={index} className={active ? "is-inside" : ""} style={{ height: Math.max(2, Math.round(peak * 18)) + "px" }} />; })}</div>;
}
