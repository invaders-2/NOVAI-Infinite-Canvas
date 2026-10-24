# Opus 5.5 Motion Icon

Create one small, readable animated icon as deterministic HTML/CSS/JavaScript,
record it frame by frame in headless Chromium, encode it with FFmpeg, and only
call the result a delivered video after media checks pass. The icon may represent
an interface control, product feature, device, material, technology concept,
brand mark, data motif, or another supplied subject. The output is a motion icon,
not a full scene, a website, or a game integration.

## Route and preflight

Use exactly one route: **Motion icon**. Ask only for missing information that
changes the implementation or acceptance check. Return a compact preflight before
coding:

- subject and source: a prompt, an approved still, or a supplied asset path;
- runtime/model: confirm the active model is Opus 5.5 (or record model identity as
 unavailable); do not silently fall back to another model;
- one physical motion sentence and its strategy (`native`, `event`, `part`, or
 `surface`);
- palette, background/alpha requirement, canvas size, and target surface;
- duration and FPS, with the hard maximum shown as `5.000s`;
- source, font, logo, and audio rights or explicit evidence gaps;
- output files and one acceptance check.

Do not claim that Opus 5.5, another model, a renderer, browser, encoder, Canvas
exporter, or asset is available until the runtime actually exposes it. If the
active model cannot be identified, label the model as unverified rather than
calling the run an Opus 5.5 execution. A plan, an HTML URL, a browser Blob, or a
preview tab is not a verified MP4.

## Hard limits

These rules cannot be relaxed to make a render easier:

- `0 < duration <= 5.000s` for every mode. Default/spec mode is exactly
 `5.000s`, `120 BPM`, `500ms/beat`, `60fps`, and `300` encoded frames.
- Never render a frame after the last index (`0..299` in spec mode). Do not add a
 tail frame, fade-out tail, trailing audio, or an extra loop frame.
- Every final FFmpeg command has an explicit finite `-t <duration>`. Use finite
 `apad=pad_dur=<seconds>` only; never use bare/infinite `apad`, infinite loops,
 or a gateway timeout as the stopping mechanism.
- The production composition is deterministic. Every animated property is derived
 from `t` and stable inputs; no wall-clock time, unseeded randomness, hidden
 accumulated physics, or non-reproducible camera drift.
- `seek(0)` and `seek(duration)` settle to the same subject geometry, silhouette,
 label/title, color, and spring values. The encoded last frame is at
 `(frameCount - 1) / FPS`; the conceptual end state is checked separately.
- Headless Chromium screenshots and FFmpeg encoding are mandatory for a video
 deliverable. If either is unavailable, stop at an HTML preview and report the
 blocker instead of substituting an unverified recording.

If a shorter duration is explicitly requested, recompute the beat interval and
slot count in the preflight. Do not describe a shorter cut as `10 x 500ms` and do
not exceed the cap to preserve a beat grid.

## Approval gates

When the user supplies only a prompt, generate exactly one still first. Show it
and ask whether the static design is approved. On approval, propose exactly one
motion in plain physical language and wait for approval before spending on motion
or a full render. If the user supplied an already-approved still, skip only the
still approval gate. Do not generate a comparison grid unless the user asks for
variants.

Translate ordinary motion language into:

| Question | Choice |
|---|---|
| What happens when left alone? | `native` for self-moving matter; `event` for an inert object performing an action; `part` for one loose or hinged part; `surface` for light/material moving across a fixed form. |
| How much does the body move? | `still`, `calm`, `lively`, or `playful`; use the smallest energy that reads at icon size. |
| Does the action throw something off? | Add a small `emit` detail only when the supplied subject supports it; it must return, settle, or be reabsorbed before the loop. |

Prefer motion in the subject's own details over a turntable spin. Do not let the
whole icon drift out of frame. A squash, recoil, hinge, fill, sweep, reveal, or
material response is acceptable when it returns to the opening state.

## Default 5-second beat grid

Use this abstract grid for icons and map the subject's own action onto it. The
slots are fixed in spec mode; they are not permission to add scenes or a second
subject.

| Time | Beat | Icon event |
|---:|---:|---|
| `0.0s` | 1 | Resting opening pose; this is the loop frame. |
| `0.5s` | 2 | Anticipation, compression, or a small pre-action detail. |
| `1.0s` | 3 | Primary action begins. |
| `1.5s` | 4 | Primary action reaches its readable peak. |
| `2.0s` | 5 | The subject settles while a secondary detail responds. |
| `2.5s` | 6 | A controlled overshoot, hinge, fill, or material change. |
| `3.0s` | 7 | The secondary detail resolves; keep the main silhouette legible. |
| `3.5s` | 8 | Highlight, small emission, or surface pass, only if physically justified. |
| `4.0s` | 9 | Action resolves and the subject returns toward rest. |
| `4.5s` | 10 | Final settle into the opening pose. |
| `5.000s` | loop | Same settled state as `0.0s`; do not encode frame 301. |

For a shorter mode, show the revised grid and receive confirmation before writing
the implementation. Do not move events to create extra time; compress the state.

## Deterministic implementation

Prefer one self-contained HTML file unless the target runtime requires another
stack. Expose testable functions with this shape (adapt names to the source):

```js
const DURATION = 5.0;
const FPS = 60;
const FRAME_COUNT = Math.round(DURATION * FPS);

function reset() {
  seek(0);
}

function seek(seconds) {
  const t = Math.max(0, Math.min(seconds, DURATION));
  renderFrame(t);
}

function renderFrame(t) {
  // Derive all geometry, color, text, and spring values from t.
}
```

The interactive preview may use `requestAnimationFrame`, but capture must call
`seek(t)` for each requested frame. Use fixed initial state and closed-form or
explicitly bounded easing. Keep the icon centered with enough margin for small
viewports; keep stroke widths, corner radii, and text sizes consistent. Do not use
pointer/cursor/caret overlays, click demonstrations, generic UI chrome gradients,
unrelated particles, glow halos, mismatched icon strokes, or a template-like
layout.

For a transparent asset, render against a known, uniform matte color and retain
that color in the evidence. Use a verified unpremultiply/matting path before
claiming true alpha. Do not switch to green or magenta chroma key, and do not
claim that an H.264 MP4 contains transparency. If the alpha path is unavailable,
deliver the opaque MP4 with its background status stated.

## Mandatory Chromium-to-FFmpeg pipeline

Run these stages in order. Keep the source HTML, frame directory, and logs until
verification is complete.

1. **Check the actual runtime.** Confirm a usable headless Chromium/Playwright,
 `ffmpeg`, and `ffprobe`. Start the page through a local HTTP server when
 `file://` would change loading behavior. If a dependency is missing, report
 it; do not invent a binary path or silently use a different recorder.
2. **Run browser QA.** Load the real page in headless Chromium, wait for fonts and
 supplied assets, and fail on page errors. Exercise `seek(0)`, one middle beat,
 `seek(duration)`, reset, and the smallest requested viewport. Capture one still
 per confirmed beat before the full render and inspect icon readability/crowding.
3. **Record frame by frame.** For `i = 0..FRAME_COUNT-1`, evaluate
 `window.seek(i / FPS)` in Chromium, wait for the page to settle without using
 wall-clock animation, and screenshot the exact viewport to
 `frames/%05d.png`. The frame count is finite and known before recording.
4. **Encode with FFmpeg.** A spec-mode visual encode has the following bounded
 shape; substitute the confirmed dimensions and output path:

   ```bash
   ffmpeg -y \
     -framerate 60 -i frames/%05d.png \
     -frames:v 300 -t 5.000 \
     -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
     icon.mp4
   ```

 If audio is requested, it is optional and independent of the visual grid. Use
 only a contiguous, direct trim; do not audition, parse, fingerprint, infer BPM,
 build a waveform, beat-match, peak-align, remix, or time-stretch it:

   ```bash
   ffmpeg -y -ss <start> -i source-audio \
     -vn -t 5.000 -c:a aac -b:a 160k audio.m4a
   ffmpeg -y -i icon.mp4 -i audio.m4a \
     -map 0:v:0 -map 1:a:0 -t 5.000 -shortest \
     -c:v copy -c:a aac -movflags +faststart icon-with-audio.mp4
   ```

 Keep source/license/access evidence for an audio file. If BPM is not declared
 by the source, record `unknown`; never derive it from the file.
5. **Enforce a watchdog.** The host process must time out below the five-minute
 gateway limit (use about `240s`), send `SIGTERM`, allow a short grace period,
 then send `SIGKILL`. Delete incomplete output and mark the render failed after
 timeout. A still-running shell or child process is not success.

## Verification and delivery

Run the checks that match the requested output and report each tier separately:

1. **Source/static:** HTML/JS syntax, asset loading, and any available focused
 checks. Verify that `DURATION`, `FPS`, and frame count are explicit.
2. **Browser:** no console/page errors; initial, middle, final, reset, narrow
 viewport, and reduced-motion behavior where applicable; beat stills reviewed.
3. **Media decode:** decode the MP4 with FFmpeg and inspect it with `ffprobe`.
 Confirm duration is `<= 5.000s`, frame count is exactly the planned finite
 count, FPS and dimensions match, audio is bounded when present, and there are
 no black or missing frames. A successful FFmpeg exit alone is insufficient.
4. **Loop:** compare the rendered `seek(0)` and `seek(DURATION)` states. Confirm
 the encoded final frame is the last planned frame and that no frame 301 exists.
5. **Canvas export:** only when the user explicitly requests it, use the current
CLI help/schema to upload the verified MP4 and reread the created Canvas
 node for source, duration, dimensions, and playable state. Do not upload HTML,
 a browser Blob, a render plan, or an unverified recording.

Label each delivered artifact as one of `source code`, `beat grid`, `HTML
preview`, `render plan`, `opaque MP4`, `transparent asset`, or `verified MP4`.
State which checks passed, which were blocked, and what remains unverified. If a
hard limit, dependency, source/rights gate, decode check, frame count, or loop
check fails, stop and report that state instead of calling the result complete.

## Reference boundary

This workflow adapts the public [`3dicon`](https://github.com/samyost1/3dicon)
pattern of one approved still, a single physical motion proposal, first/last
state closure, and known-background edge handling to the canvas's deterministic HTML
capture path. It deliberately keeps the
runtime boundary explicit: the reference's model/provider and Python CLI
are not assumed to exist here. Use only tools and models exposed by the current
Agent runtime.