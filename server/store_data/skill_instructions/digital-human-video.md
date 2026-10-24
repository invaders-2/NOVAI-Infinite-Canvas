# Digital Human Video

Use one shared presenter workflow and route-specific video methods. This package
contains all routing, identity, and execution instructions; do not invoke another
Skill, open Casting Room, or create an MCP App to complete a route.

## Route the user's query

Infer the desired result from the current query, supplied material, and prior
approved work. Choose by the viewer's job, not by a matching platform or topic word.
Read only the selected route reference, plus shared references when needed.

| Route | User's intended result | Example query | Read |
| --- | --- | --- | --- |
| `asset` | Create/save a reusable presenter or fill an existing Element's Look/voice gaps | "Create a digital human first, add an office look, and do not make a video" | [Asset method](references/asset.md) |
| `social` | A short direct-to-camera message, announcement, or general social explanation | "Have the digital human deliver this script as a Reels talking-head video" | [Social method](references/social.md) |
| `property` | Help viewers evaluate or visit a specific real property, venue, or facility with guide-to-space cutaways | "Make a TikTok video introducing this hotel" | [Property method](references/property.md) |
| `product` | Demonstrate/promote a product's value, feature, or use with presenter-to-product cutaways and product evidence | "Have a digital human demo this app's new feature and end with a trial call to action" | [Product method](references/product.md) |
| `course` | Teach a skill or process with an observable learning outcome, alternating on-camera presenter delivery and teaching visuals | "Teach new users how to export a report in this app" | [Course method](references/course.md) |
| `market` | Explain dated developments, trends, or changes using sources and data | "Report this week's property-market changes" | [Market method](references/market.md) |
| `news` | Report current events or a news story from network-searched sources with source-labelled visual evidence | "Report today's AI industry news" | [News method](references/news.md) |

Apply these precedence rules:

1. **A local revision stays with its existing route.** "Only change the CTA" or "Replace the second shot"
 reuses the existing brief, presenter, and accepted assets. Ask for the target
 artifact only if it cannot be identified; do not restart onboarding.
2. **Explicit outcomes outrank channel and subject.** A TikTok hotel tour is
 `property`; a property-market update is `market`; a current-event bulletin is
 `news`; a software lesson is `course`;
 a persuasive software launch demo is `product`. General short speech is `social`
 when a more specific outcome does not apply.
3. **Missing identity is a prerequisite, not a route change.** "There is no person yet;
 make a product demo" remains `product` with the shared production sequence below.
 Create or reuse its character subject without adding an unrequested actor package,
 multiple Looks, or voice library.
4. **Combine only requested deliverables.** If the user requests a tour and a market
 update, plan two deliverables under `property` and `market`, reuse the adopted
 presenter, and keep each script, evidence ledger, and output state separate.
 If they request a reusable presenter plus a video, use the shared sequence once;
 saving the subject also fulfills the asset deliverable.
5. **Ask one outcome question only when needed.** For an ambiguous "product
 walkthrough", use the CTA, audience, and supplied script to distinguish promotion
 from instruction.
 If still unresolved, ask whether viewers should choose the product or learn to
 complete a task. Do not make users select internal route names or six modules.

6. **Object and space outcomes require cutaways.** A `product` or `property` brief
 that contains a physical product, software interface, room, venue, building, or
 amenity must include a shot plan with presenter A-roll and subject cutaways. Do
 not deliver an all-presenter talking head when the viewer needs to inspect the
 thing being introduced. `social` and `market` stay presenter-led unless
 their brief explicitly requests supporting inserts.
7. **Course outcomes require teaching visuals.** A `course` brief must map each
 learning beat to on-camera presenter A-roll, GPT-generated explanatory B-roll,
 deterministic HTML/CSS/JS recording, supplied capture, or uploaded B-roll. When a
 visual carries the concept, alternate A-roll and B-roll in the shot plan and read
 [Course method](references/course.md);
 do not deliver an all-presenter lesson or an unordered asset list.
8. **News outcomes require network research and recorded evidence.** A `news` brief
 must search the network before scripting, preserve a source ledger and cut-off
 time, and render source-labelled HTML evidence as B-roll. Every HTML-to-video path
 must use the installed `ffmpeg` and `headless Chromium` chain; read [News method](references/news.md)
 and do not present search snippets, stale pages, or an all-presenter bulletin as
 the finished news deliverable.

The route is internal planning state. Explain the intended deliverable in the user's
language. If the request falls outside these outcomes, explain the scope instead
of forcing it into a digital-human workflow.

## Shared presenter gate

Inspect explicit attachments and selected Canvas/Element references. Reuse an
authorized single-person identity that the user has chosen; never select the latest
node, a filename, or a person from a group photo by inference. The identity gate is
the visual anchor only; it does not approve the keyframe previs, voice, character
subject, or video.

For a local revision, reuse the identity recorded in the existing project. A text or
overlay-only edit that creates no new presenter media does not reopen this gate.

If no person is supplied, read [Presenter identity](references/presenter-identity.md):
one ordinary `show_form`, exact account-available **Midjourney v8.2**, a **2:3**
headshot on **#808080**, a short English prompt ending in **`--style raw`**,
exact-result inspection, then explicit user adoption. Do not require a provider
output count or reject a supported Midjourney result because of its returned shape.
Use the route's live structured parameters for ratio, resolution, and quality. Do not
use a beauty fallback or nearby-version fallback.

Keep the selected business route while waiting. Before identity adoption, do not
generate presenter media. Already supplied facts and copy remain inputs; never discard
or recollect them. Once adopted, the same exact face reference serves every route.

## Required production sequence

For a new presenter-led video, keep this order. Skip a stage only when its approved
artifact already exists and is still valid for the requested change.

1. **Lock the brief and aspect.** Collect audience, objective, script or topic,
 duration, and orientation. Use landscape `16:9` or portrait `9:16` according to
 the brief; if it is genuinely ambiguous, ask before generating. Resolve the live
 model contract for the exact ratio instead of guessing a provider parameter.
2. **Create the visual identity.** Reuse an explicitly approved person or follow
 [Presenter identity](references/presenter-identity.md) to use Midjourney v8.2 for
 the raw headshot. The prompt must describe one person and one casting headshot;
 do not turn it into multiple casting options or enumerate candidate identities.
 Inspect the result(s) returned by the live route and wait for explicit adoption of
 one face anchor; keep that anchor fixed afterward.
3. **Select and fix the voice.** Reuse an approved voice. For a user-designated upload,
 inspect its exact audio reference and bind it as `voice_ref`; an explicit request
 to use that voice counts as selection. Do not generate alternative voices for it.
 Otherwise resolve the newest available Seed Audio model, generate a small voice
 candidate set (default two) using the same short audition line, let the user listen
 and choose, and bind that result as `voice_ref`. Use fast, clear speech and lively
 intonation. Read the live model contract before generating; do not hard-code an
 assumed latest version. Keep this voice identity for every subsequent audio job.
4. **Build and confirm the keyframe scene.** After the face and voice are approved,
 use the live GPT 2.5 model contract to make the minimum keyframe previs for the
 requested scene(s), with the selected person, scene, action, framing, and locked
 `16:9` or `9:16` ratio. Pass the adopted face as the identity reference; describe a
 real human in a live-action scene. For `product` and `property`, include the
 subject in the keyframe plan: presenter framing, `presenter_with_object` or
 `presenter_in_space` when the relation matters, product/space hero, close-up or
 detail, and the return to the presenter. Generate one keyframe per distinct
 composition. For `course`, cover the presenter, `concept_visual`,
 `worked_example`, and any `screen_demo` or `html_recording` frame required by
 the learning beat. For `news`, cover the `news_anchor`, headline/source card,
 timeline, chart/map/quote frame, and return to the anchor needed by the source
 claims. A continuous shot can reuse its approved keyframe across several
 audio segments. Use a few concise sentences for person, action, framing, setting,
 object/space detail, and light. Put aspect, count, and quality in supported
 structured parameters. Inspect the exact person-in-scene and subject keyframes
 and get explicit approval.
5. **Create the character subject.** Only after the keyframe scene is approved, create
 or update the character subject/Element through the current persistence contract.
 Bind the adopted face, selected `voice_ref`, approved scene/keyframe references,
 and only the requested Look assets. Preserve unrelated members.
6. **Generate the first talking scene.** Prepare the first scene's spoken audio with
 the selected Seed Audio voice anchor with fast delivery and lively, varied
 intonation, then use Seedance 2.5 for the first talking-video segment and the
 continuation workflow. Seedance 2.0 or MiniMax H3 remain alternatives for separate
 video requests when selected by the user; never silently switch an explicitly
 chosen model. The video prompt must require a real human presenter, fast but clear
 speech, varied expressions that follow the meaning, natural eye contact, head
 movements, and gestures. Bind the character
 subject, approved keyframe, scene-one audio, exact spoken copy, locked aspect, and
 timing. For `product` and `property`, generate presenter and cutaway source clips
 as separate shot units, then assemble their approved order on the timeline. For
 `course`, generate presenter A-roll and each teaching B-roll unit separately;
 record approved HTML/CSS/JS visuals before assembly and export the assembled
 lesson timeline to Canvas through the supported path. Inspect the exact completed
 first scene and its first teaching or subject cutaway before continuing. For
 `news`, search and verify the source ledger before writing the final lines, then
 generate the presenter A-roll and source-labelled HTML B-roll separately. Any
 HTML-to-video recording must use the installed `ffmpeg` and `headless Chromium`
 chain before the assembled bulletin is exported to Canvas.

 Reuse this compact performance clause in each video prompt, then add only the
 scene-specific action and continuity details:

   ```text
   A real person on camera, with a natural live-action look; a fast pace with clear articulation, varied intonation, expressions that follow the meaning, natural coordination of the eyes, head, and gestures, a relaxed body, and fluid movement.
   ```

7. **Make the next scene audio and extend.** After the first scene is accepted,
 generate the next scene's audio with the same `voice_ref` and the current Seed
 Audio contract. Extend the continuous presenter A-roll in Seedance 2.5 using the
 immediately preceding accepted presenter video, the new scene audio, the same
 subject, and supported scene/keyframe context. For `product` and `property`, put
 approved B-roll over the A-roll in the final timeline. For `course`, place each
 approved teaching visual under the matching `voice_span`; HTML recordings and
 source captures remain independent B-roll unless the live contract explicitly
 supports their continuation. Only use a direct A→B or
 B→A video continuation when the live contract explicitly supports that shot-type
 change; otherwise generate the B-roll independently and keep its voiceover span
 in the renderer manifest. Scene 2 uses scene 1's accepted predecessor, scene 3
 uses scene 2's accepted predecessor, and so on. Keep voice, aspect, and performance
 consistent. Follow the runtime contract for continuity, output overlap, and audio
 timing; stop when the complete approved script has been spoken and the requested
 deliverable is covered. For `news`, keep the source-labelled HTML B-roll
 independent unless the live contract explicitly supports a shot-type change, and
 assemble it under the matching verified news `voice_span`.

## Product and property cutaway layer

Read the selected [Product method](references/product.md) or [Property method](references/property.md)
for the route-specific shot grammar. The shared rule is:

- Keep presenter speech, product/space visuals, and sourced proof as separate shot
 units. A cutaway may carry the continuing approved voiceover, but it must not be
 hidden inside a talking-head generation prompt.
- Give every shot a `shot_type`, `source_ref`, `script_span`, `voice_span`, duration,
 transition point, and acceptance state. Use `presenter` for A-roll,
 `presenter_with_object` or `presenter_in_space` for a person-subject relationship,
 `object_hero` or `object_detail` for product views, `demo_action` for use, and
 `space_wide`, `space_detail`, or `amenity` for property views.
- Alternate on purpose: presenter establishes the claim, the product or space proves
 it visually, and the presenter returns for interpretation or CTA. Do not cut on
 every sentence or use an insert that has no spoken or evidentiary role.
- Generate object/space clips separately from presenter clips. For a real product,
 UI, address, room, amenity, measurement, label, or price, use supplied or captured
 source media whenever exact appearance matters. Generated subject footage is
 illustrative until matched to an approved source. Keep pure B-roll prompts short:
 object/space, shot size, action, light, and continuity detail. Use the real-human,
 fast, expressive performance clause only for `presenter` or `presenter_with_object`
 shots, never for a product/space-only closeup.
- Assemble only after the individual clips and their audio spans are approved. Check
 that cuts preserve the fixed person, product identity, spatial orientation, speech
 continuity, safe areas, and readable labels. An ordered clip list is partial when a
 rendered master was requested.

## Course teaching B-roll layer

Read the selected [Course method](references/course.md) for the full teaching
contract. The shared rule is:

- Keep on-camera presenter A-roll and teaching B-roll as separate shot units. Use `presenter`
 for goals, explanations, judgment, correction, recap, and practice; use
 `presenter_with_visual` when the relationship between the person and visual is
 itself instructional.
- Use `concept_visual` for an illustrative GPT visual, `html_recording` for exact
 UI/code/formula/chart/table/timeline states, `screen_demo` for supplied or
 captured procedures, `worked_example` for sourced calculations, and
 `caption_card` for exact definitions or warnings. Do not use generated imagery
 as an exact UI, live-data, official-chart, or completed-experiment substitute.
- Give every teaching unit a `learning_step` or `claim_id`, `visual_mode`,
 `source_ref` or `html_artifact_ref`, `script_span`, `voice_span`, duration,
 cut-in/cut-out, `evidence_role`, and `review_state`. For HTML, also record the
 artifact version, viewport, frame rate, duration, start/end state, and recording
 reference before export.
- Keep approved voiceover under silent B-roll only within its matching `voice_span`;
 return to on-camera presenter delivery for interpretation, correction, emphasis, recap, or the next
 action. Cut on a teaching event such as a visual reveal, code action, formula
 change, or worked result instead of cutting only for variety.
- Export the assembled course timeline to Canvas through the supported renderer or
 write-back path and read back the returned Canvas reference. An HTML preview,
 local recording, A-roll clip set, or unordered B-roll list is partial when a
 lesson video was requested.

## News bulletin layer

Read the selected [News method](references/news.md) before planning a news video.
News is a source-verification and visual-evidence route, not a generic market or
talking-head route:

- Search the network before writing the final script or generating news visuals. Fix
 the source cutoff time, timezone, geography, language, audience, and freshness
 window. Prefer primary sources, then independently corroborate material claims.
 Keep facts, source claims, interpretation, and unresolved items separate.
- Give every claim a source URL/document, title, publication or update time, search
 and access time, source type, status, exact source span, and `claim_id`. A 403,
 login wall, missing date, or stale page is an access/freshness gap, not proof that
 no update exists.
- Use a deliberate A/B sequence: `news_anchor` says what happened, source-labelled
 HTML B-roll shows the headline, timeline, chart, map, quote, or source strip, and
 the anchor returns to explain impact, uncertainty, or the next item. Keep each
 B-roll unit tied to one verified `claim_id` and `voice_span`.
- Any HTML-to-video or page-recording path is fixed to the installed stack:
 **ffmpeg and headless Chromium are installed**. Headless Chromium renders the
 deterministic page at the locked viewport; ffmpeg encodes or packages the captured
 frames and audio into video. A browser preview, HTML file, or search-result screenshot is not a finished
 video. Record browser/ffmpeg versions, viewport, fps, duration, start/end state,
 output reference, source cutoff, and Canvas reference.
- Export the assembled bulletin to Canvas and read back the returned reference. If
 network search, source ledger, fixed-stack recording, or Canvas write-back is
 unavailable, report the news result as partial and preserve the exact gap.

Do not add a separate image or exploratory keyframe generation stage solely to create
selection candidates, and do not force a provider-specific image count. Keep the
Midjourney prompt focused on one person; use the result shape returned by the live
route and bind only the image the user explicitly adopts as the face anchor. Voice
candidates remain the intentional selection set. If a visual, voice, or video result
is rejected, regenerate only that stage after the user supplies a changed direction;
keep approved stages and references unchanged.

Use "real human" and positive performance direction in generation prompts.
Do not label the subject “digital human”, “AI avatar”, or “virtual presenter”, even in
a stock negative clause. Avoid stiff posture, frozen expressions, mechanical nodding,
or looping gestures in the result. This describes the desired visual performance;
retain truthful synthetic-media context in delivery.

## Shared execution

1. **Establish the brief.** Read the selected route's method, reuse known inputs,
 and collect only blocking gaps: audience, objective, exact facts/source media,
 script or prompt, orientation, duration, voice, and final deliverables.
2. **Plan the staged artifacts.** Preserve supplied exact copy. For a topic prompt,
 produce the full spoken script, compact GPT 2.5 presenter/subject keyframe prompts,
 shot plan, cutaway and teaching-visual source list, per-claim source ledger, and
 per-scene audio lines before generation. For `course`, choose a visual mode for
 every beat (`gpt_visual`, `html_recording`, `source_capture`, or `uploaded_broll`)
 before generation. For `news`, complete network search and the source ledger
 before final script, HTML, or A-roll generation. Reuse existing approval for
 unchanged work. Asset-only requests follow `asset.md` and do not enter video
 production.
3. **Record dependencies.** Track route, aspect, identity reference/state, keyframe
 references, approved script, voice candidates and selected `voice_ref`, character
 subject, facts/sources, scene ids, shot types, cutaway source refs, spoken
 lines/audio results, media/reference roles, overlay/caption text, teaching
 `learning_step`/`claim_id`, visual mode, HTML artifact and recording references,
 news source URL/title/published-at/accessed-at/status/cutoff fields, browser and
 ffmpeg versions, viewport, fps, timing, cut order, segment chain, exact
 job/result references, Canvas export and read-back references, review state, and
 export state. This is a project manifest, not a new Element schema or backend API.
4. **Execute the current contract.** Read [Runtime contract](references/runtime-contract.md)
 before generation, media inspection, persistence, or rendering. Use standard
CLI and existing forms. For every HTML-to-video/page-recording task, verify
 the installed stack exactly as **ffmpeg and headless Chromium are installed** before capture;
 do not substitute a browser preview or an untracked recorder. A source reference,
 submitted job, completed media result, inspected result, and final export are
 distinct states.
5. **Review the smallest changed unit.** Keep the face anchor, keyframes, voice, and
 accepted assets fixed. Re-render changed information cards without regenerating
 the presenter; regenerate a spoken line only when speech changed. Changing a
 scene's audio regenerates that scene's video. A changed video invalidates downstream
 continuations that used it as their source; preserve earlier scenes and recheck or
 regenerate affected continuations. A new identity invalidates dependent presenter
 visuals; a new voice invalidates dependent speech and talking video. For product or
 property work, a changed object/space source invalidates only the affected cutaway
 and any downstream assembly that depends on its timing. For `course`, a changed
 claim, formula, code result, HTML artifact, source capture, or learning step
 invalidates its teaching shot, narration/caption timing, and dependent assembly,
 while preserving unrelated chapters. For `news`, a changed source, cutoff,
 claim, date, number, quote, or HTML evidence card invalidates that claim's source
 ledger row, A-roll line, B-roll recording, captions, and dependent assembly.
6. **Deliver the real result.** Match the requested asset or video scope. A full
 business video requires an actual assembled export; an A-roll clip or ordered
 segment set is partial when assembly was requested. Report missing runtime
 capabilities and remaining work precisely. Do not publish externally.

## Interaction and acceptance

- Keep form submission, identity adoption, voice confirmation, keyframe-previs
 approval, subject creation, platform cost confirmation, and final review
 separate. Honor authorization already given for the same scope; do not stack
 duplicate forms or add confirmation at every scene.
- Preserve the presenter's truthful role. Generated presenters do not create
 evidence of customer experience, credentials, real locations, product performance,
 or financial outcomes. Apply the selected route's specific evidence rules.
- Inspect exact completed media for identity continuity, fixed voice, complete speech,
 lip sync, fast clear delivery, expressive natural movement, facts, caption/chart
 legibility, teaching order, HTML/screen readability, timing, cut order, cutaway
 continuity, product/space identity, news source ledger and cutoff, publication/
 access times, fixed ffmpeg + headless Chromium recording state, Canvas export state,
 safe areas, and the CTA or next learning action. Frozen faces, stiff movement,
 repeated gestures, voice drift,
 unexplained cuts, or skipped/repeated lines fail review.
 State which checks could not run; structural validation alone is not visual acceptance.
- Deliver exact asset/media references, the script or captions when relevant,
 sources/rights and synthetic-presenter context, unresolved items, and the actual
 export status. Do not promise virality, sales, or guaranteed outcomes.