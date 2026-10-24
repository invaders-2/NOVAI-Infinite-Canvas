# HTML Beat Morph Video

## Overview

Turn one visual subject or connected composition into a sequence of morphing states and render it as a beat-driven, pure-HTML video loop. UI remains a supported recipe, but the same motion grammar also covers product/commercial promos, technology launch films, brand openers, data or concept explainers, and short social title pieces. Preserve the original single-subject, state-order, pure-`seek(t)`, and rendering framework; the default is 120 BPM, 10 beats, and 5.000 seconds. Keep this entrypoint short and load detailed capability from `references/` only when needed.

## Interaction gate

1. Use the user's language for questions, state grids, visible copy, and delivery notes: English input gets English by default; Chinese input gets Chinese by default unless the user explicitly requests another copy language.
2. Take the shortest path to collect three inputs: 8–12 desired visual states or beats, pure black and white or one accent color, and a royalty-free, commercial-use song. The `120 BPM` value belongs to the visual grid; never verify it from the audio file. States may be UI components, product surfaces or features, device or packaging silhouettes, technical diagrams, data motifs, brand/title moments, or other supplied visual subjects. Prefer one targeted Mixkit search; do not add unrelated explanation or play the song.
3. Duration is not a normal input: default `5.000s`, hard maximum `5.000s`. Canvas dimensions may follow the user's request; use square `1440×1440` when unspecified. Never ask for or propose more than 5 seconds.
4. Show the complete state list and time grid before writing code and wait for explicit confirmation. If the user asks for the fastest path, use canonical states and one Mixkit candidate as provisional defaults and ask one compact confirmation; never skip the confirmation gate.
5. The 10-beat slots, one event per beat, single-subject morphing, and return to the first frame are fixed framework rules. Map the user's 8–12 state candidates into the fixed slots; do not move beat points or add an eleventh beat.

## Duration and runtime boundary

- The default/spec mode is `5.000s`, `10 beats`, `500ms/beat`, `60fps`, and `300 frames`.
- A shorter duration or different dimensions is allowed, but preserve state order, beat-driven changes, pure time evaluation, and loop identity; every mode must be `≤ 5.000s`. Only spec mode simultaneously uses `120 BPM / 500ms beat / 10 beats`; a shorter mode must explicitly reduce slots or recompute beat interval/BPM in the confirmation grid and must not claim to remain 10×500ms.
- The 5-second cap is also a system-performance guard: longer videos are more likely to fail in browser rendering, encoding, or gateway streaming. Do not extend duration to solve crowding; compress a state or adjust the configurable dimensions.

## Immutable output rules

- One visual subject morphs continuously; do not cut between scenes. `seek(end)` and `seek(0)` must have identical subject geometry, label or title, radius or silhouette, color, and settled spring values.
- Output obeys the requested duration with `0 < duration ≤ 5.000s`; spec mode remains `5.000s / 300 frames`. Any export, tail frame, audio, or loop beyond the cap fails.
- Do not use a pointer, cursor, caret, click, drag hand, fade-out tail, particle burst, glow, UI-chrome gradient, bouncy easing, mismatched icon strokes, dead time, or template-like treatment.
- Every FFmpeg synthesis command must be bounded: final output uses `-t <video_duration>` (optionally with `-shortest`), `apad` may only be bounded as `apad=pad_dur=...`; never use infinite `apad`, infinite tail audio, or a Gateway 5-minute stream timeout as the stopping mechanism. Give the FFmpeg process a watchdog/abort below 5 minutes, clean up timed-out processes, and remove incomplete output.

## Read as needed

- Input questions, language, confirmation gate, and configurable parameters: [`references/input-gate.md`](references/input-gate.md)
- One-subagent Mixkit search, license evidence, and source logging: [`references/mixkit-fast-path.md`](references/mixkit-fast-path.md)
- 120 BPM and the complete 10-beat timing table: [`references/beat-grid.md`](references/beat-grid.md)
- Single-subject visual direction, camera, font, and bans: [`references/visual-motion-rules.md`](references/visual-motion-rules.md)
- Single HTML, configurable dimensions, pure `seek(t)`, closed-form springs, and morph implementation: [`references/seek-spring-implementation.md`](references/seek-spring-implementation.md)
- Direct audio trim, no audio analysis, no playback, Playwright, bounded FFmpeg/watchdog, and frame output: [`references/audio-render-pipeline.md`](references/audio-render-pipeline.md)
- Text timing, `will-change`, loop identity, timeout, and final checks: [`references/qa-gotchas.md`](references/qa-gotchas.md)

## Delivery order

Confirm the grid first. Then use one Mixkit subagent to find and log a candidate, implement the single HTML and audio, directly trim the selected track to the confirmed window, render one still per confirmed beat slot, fix timing/crowding/readability, and run the bounded full render under a watchdog. Do not parse, analyze, audition, beat-match, or peak-align the music; the visual grid is independent of the audio. When requested, deliver the HTML, video, and audio source/license record. Acceptance covers state order, timing, direct audio window, frame count, FFmpeg boundedness, and loop identity.