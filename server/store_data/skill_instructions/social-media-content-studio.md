# Social Media Content Studio

Create a small, useful set of social assets that supports a business decision. The default output is a reviewed draft package, not a published post. Keep the accepted source and the platform-specific derivatives traceable.

Read the relevant local references before planning:

- `references/content-contract.md` for source truth, social context, rights, disclosure, and fixed invariants.
- `references/platform-playbooks.md` for platform routes and live-recheck rules.
- `references/linkedin-visual-workflow.md` when a LinkedIn URL must become a text-led image, cover, or document page staged on Canvas.
- `references/short-form-media-workflow.md` for Instagram/Reels, TikTok, or cross-platform video/image packaging with headless Chromium and ffmpeg.
- `references/repurpose-matrix.md` when a source must become more than one platform output.
- `references/quality-gates.md` before generation, export, or a publishing handoff.

## Route the request

Choose one primary route before drafting:

- **Instagram content pack** — Reels, Stories, or carousel; use when the goal is visual discovery, proof, or a save/share action. Read `references/short-form-media-workflow.md` for the Reels/image-pack route and the 5-second source-clip cap.
- **TikTok hook lab** — short-form hooks, captions, and loopable endings; use when the decision is which opening earns attention. Read `references/short-form-media-workflow.md` for the one-axis variant and render contract.
- **LinkedIn insight studio** — evidence-backed posts, document carousels, founder-video outlines, or text-led visual assets; use when the goal is professional understanding or a qualified conversation. For a LinkedIn URL plus an image-with-text request, read `references/linkedin-visual-workflow.md` and use its URL → background → code overlay → Canvas staging contract.
- **YouTube-to-social repurposing** — accepted YouTube master, reviewed clip set, or transcript to native derivatives; use when the source already exists. The existing YouTube product-video workflow remains the source of truth for creating a first YouTube master.
- **Campaign calendar** — a focused two-week or weekly plan; use when the user needs a repeatable content system before individual assets.

If platform, business goal, audience, source, rights, or approval owner is missing and blocks the route, ask only for that blocker. Do not ask for every optional field up front.

## Establish the contract

1. Load the existing `socialContext` if one is available. It should contain account identity, audience, voice and tone, content pillars, platform mix, example posts, anti-patterns, and the business objective.
2. Inspect the actual source media, transcript, product brief, or cited evidence. Do not infer a claim from a filename or prompt.
3. Freeze exact facts, identity, rights, approved promise, required disclosure, language, CTA destination, and any accepted master. These are invariants.
4. State the target platform, format, aspect ratio, language, deadline, number of variants, approval owner, and the one metric or business signal the work should teach. For a LinkedIn visual asset, also record the source access status, exact copy, immutable background, overlay code, composite file, and Canvas node reference.

If product facts, rights, identity, disclosure, or source access are unresolved, stop at a brief and a review question. A missing source is not permission to invent one.

## Atomize before adapting

For repurposing, extract **3–7 independent content atoms** from the accepted source. Each atom must stand on its own and have a clear audience value, evidence role, platform fit, and candidate format. Do not copy one caption across platforms.

For each selected atom, create a platform-native brief:

- audience promise and opening hook;
- proof, source, or demonstration that earns the promise;
- format, frame, safe zones, pacing, sound and caption behavior;
- one primary CTA and any disclosure or accessibility text;
- `changed_variable`, `hypothesis`, and `metric` for the variant family.

Keep the accepted master intact. A crop, hook, caption, pacing, CTA, or cover change creates a new variant and keeps a reference to the source.

## Draft, review, then produce

1. Draft the brief, script, caption, shot or slide plan, and asset manifest in Markdown.
2. Present two or three materially different directions when the creative choice affects cost or the business outcome. Name the trade-off.
3. Wait for explicit approval of the direction and planned output count before paid generation or a large batch.
4. Generate or edit through the available runtime. Treat a mock, planning response, deferred job, or HTTP 200 as a draft-state signal, never as provider success.
5. Inspect every actual image, video, caption render, thumbnail, and audio result. Reject defects locally and keep the accepted source unchanged.
6. Package the result with platform, format, ratio, duration, text, CTA, rights, disclosure, alt text, file name, source reference, `changed_variable`, `hypothesis`, `metric`, and approval state. For short-form media, also include the media manifest, clip cap, source timecodes, poster/stills, render evidence, and frame inspection.

## Platform-specific rules

Use the playbooks as routing defaults, not permanent platform facts. Before delivery, recheck current platform requirements, account restrictions, music rights, ad policies, disclosure rules, and any connected publisher contract. The Skill can draft copy and assets without access to private platform data; it must label access gaps.

- **Instagram:** design Reels around a clear opening promise and caption readability; design carousels as a slide-by-slide argument with a promise on the first slide and one CTA on the last. Stories may include interactive-sticker placeholders, but do not claim that a sticker was published.
- **TikTok:** make the first beat earn attention, keep native pacing and caption behavior, and test one hook variable at a time. Trend references require a current source and rights check.
- **LinkedIn:** lead with a defensible insight, evidence, practical implication, and one useful CTA. For a LinkedIn URL plus a text-led image, follow `references/linkedin-visual-workflow.md`: Midjourney v8.2 supplies a background only, code renders the exact copy, and CLI stages the approved composite as a new ordinary image node while preserving the base. Professional tone does not permit unsupported performance or customer claims.
- **YouTube:** use an accepted YouTube source for derivatives, titles, descriptions, Shorts cuts, captions, and thumbnail direction. Do not change the existing YouTube product-video Skill or claim that this Skill publishes to a channel.
- **Cross-platform:** adapt hook, length, composition, caption density, safe zones, audio, CTA, and disclosure per destination. Read `references/short-form-media-workflow.md` for per-destination manifests and bounded clip assembly. A resized or copy-pasted post is not a native derivative.

## Done means

- the source, facts, rights, identity, disclosure, and accepted master are traceable;
- each platform gets a deliberate hook, format, pace, CTA, accessibility treatment, and safe-zone plan;
- every variant changes one declared major variable and names its hypothesis and metric;
- actual outputs were inspected, and unresolved defects are visible;
- the delivery package is review-ready and preserves an explicit publish/schedule boundary;
- LinkedIn visual assets separate the immutable background, overlay source/code, composite image, and verified Canvas node; Canvas staging is not LinkedIn publishing;
- short-form video/image packages record source timecodes, capture/render evidence, clip cap, final duration, poster/stills, caption method, and media inspection; every source clip is at most 5.000 seconds;
- no view, retention, sales, ranking, or virality guarantee is made.

## Hard boundaries

- Never auto-publish, schedule, DM, or upload to YouTube, Instagram, TikTok, LinkedIn, X, Threads, or another platform.
- Canvas staging is allowed when the user requests it, but it must remain an internal review step and must not be described as LinkedIn publication.
- Never claim that a browser screenshot is a finished video, or that an assembled short clip represents the complete source story without an explicit longer-form deliverable.
- Never render an unbounded ffmpeg process, omit the final duration bound, or keep an incomplete output after timeout or failure.
- Never scrape private account data or use a login wall, 403, or missing source as evidence that a topic has no update.
- Never invent product facts, testimonials, customer results, trend claims, rights, or disclosure status.
- Never expose raw provider identifiers in business-facing copy; model or connector choice belongs in the runtime adapter.
- Never report catalog presence, mock output, HTTP success, queued work, or a prompt as a completed provider result.