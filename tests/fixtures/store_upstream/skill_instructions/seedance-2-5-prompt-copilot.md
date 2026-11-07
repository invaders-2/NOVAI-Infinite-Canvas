# Seedance 2.5 Prompt Copilot

## Purpose

Turn an approved brief and reference pack into one controllable Seedance 2.5
prompt, a complete timecoded audiovisual plan, and a selective review or repair
loop. Cover specialist domains through references rather than separate public
skills.

## Mandatory Preflight Form

This is a hard authorization gate. On every invocation, the first substantive
action must be `show_form` before research, routing, planning, prompt writing or
rewriting, diagnosis, reference selection, editing, or generation. There are no
clear-brief, direct-generation, quick-answer, or user-urgency exceptions.

Inspect the conversation, canvas, attachments, source media, and previous
approved answers first. Then show a compact form in the user's language:

1. **Brief confirmation** — required radio with
 `Confirm and continue (Recommended)` first and `Needs changes` second.
 Summarize the inferred goal, audience, destination, and deliverable.
2. **Duration or scope** — required; confirm the exact video duration or exact
 non-generation output scope.
3. **Reference jobs** — required; list every detected reference and its
 proposed role. Default the take to 全能参考, and for that route name what
 each non-asset still may lend and must not. Offer `First/last-frame mode`
 when the unit is interpolation or the user asked to lock endpoints; those
 stills are the opening and terminal pictures, not 仅供参考.
4. **Acceptance and risk** — required; confirm the primary visible success test
 and the highest-risk lock: identity, product/SKU, geometry, exact copy,
 dialogue, rights, evidence, safety, localization, disclosure, or end state.

Set `submit_label` to the localized equivalent of `Confirm and continue`.
Always use `show_form`. Never substitute a plain-text questionnaire,
`ask_question`, or `show_widget`. End the turn immediately after the form and
wait. Only a real, non-skipped structured submission referencing that form
authorizes the skill to continue. A skip, close, timeout, unrelated reply, or
tool error is not approval. Reissue a shorter form when necessary. If
`show_form` is unavailable, stop and report that required confirmation cannot be
collected.

Show a new form before continuing when the user changes the brief, duration,
mode, references, locks, or acceptance criterion.

## Default Multi-Reference Mode

Start every invocation in multi-reference mode. This is the creative default,
not a claim about live reference count or compatibility.

- Build an ordered `Reference Role Map` before prompt writing.
- Give each source one primary authority: identity/product/IP; setting/geometry;
 storyboard/shot order; motion/performance/camera; style/material/light;
 dialogue/voice/music/rhythm; source video/edit scope; or evidence/copy.
- Group large packs by role and priority. A published maximum is a ceiling, not
 a target; use full compatible reference coverage for every fact that must
 remain stable. One cast is one sheet; complementary assets are different jobs
 (sheet, plate, board), not several singles of the same face.
- Never silently omit, merge, reorder, or reduce a relevant reference to prose;
 exclude only conflicting sources or true duplicates that add no visible
 evidence.
- Resolve conflicts only after confirmation: user locks; identity/product/copy;
 geometry and state; storyboard/order; motion/camera; audio; style; atmosphere.
- If the pack is incomplete, keep 全能参考 and request the missing sheet or
 plate, or approval for named placeholders. Do not invent references.
- In 全能参考, every still that is not the asset is 仅供参考: the prompt names
 what it may lend and what it must not. An undeclared still is read as a frame.
- `First/last-frame mode` is a native route: the two stills own opening and
 terminal composition, and the prompt matches them. Do not rewrite that route
 as 仅供参考. Attachment count never implies it.

For direct generation, preserve the approved mode, reference order, and prompt.
Let the live runtime resolve the exact Seedance 2.5 request mode. If validation
rejects the pack, do not drop assets or switch modes; show a new form with valid
alternatives.

## Runtime Boundary

`-cli` owns current model IDs, modes, duration, resolution, input types,
reference limits, editing controls, parameters, price, availability, submission,
and result state. Public Seedance pages and community workflows inform prompt
design only.

Before generation:

1. read the exact live Seedance 2.5 contract;
2. resolve all confirmed media;
3. validate mode, pack, duration, and parameters;
4. submit the exact final prompt and reference order unchanged;
5. inspect the returned result.

If the exact model is unavailable, deliver the approved prompt, storyboard, or
edit package and report the gap. Never silently substitute Seedance 2.0 or
another model. Do not expose internal commands or payloads to users.

## Workflow

1. After form authorization, identify the primary acceptance family:
 reference orchestration; first/last-frame; story/previs/performance;
 commercial/growth; knowledge/enterprise/localization; factual/regulated;
 spaces/mobility/travel; or local editing/repair.
2. Load only the matching references from the router.
3. Build the `Reference Role Map`, immutable-lock list, and conflict notes.
4. Choose one outcome, a causal event sequence, camera and cut grammar, audio
 hierarchy, and concrete ending state.
5. Write a contiguous timeline covering the confirmed duration. Fill the
 30-second window when the piece can; every planned shot that fits is a
 range. Do not cap the take at three shots.
6. Assemble the final prompt from `references/10-prompt-architecture.md`.
7. Review reference influence, continuity, action order, audio, truth, rights,
 disclosure, and delivery format.
8. Repair only the failed region, segment, or instruction; keep passed layers.

## Reference Router

| Need | Read |
| --- | --- |
| Capability and runtime boundary | `references/01-capabilities-and-boundaries.md` |
| Large packs, R2V, storyboard, white/green model, conflicts | `references/02-reference-orchestration.md` |
| Endpoint interpolation | `references/03-first-last-frame.md` |
| Prompt structure, timecodes, camera, audio, copy | `references/10-prompt-architecture.md` |
| Story, previs, one-take, action, performance, game cinematic | `references/20-story-previs-performance.md` |
| Ads, ecommerce, social, product, fashion, food | `references/30-commercial-growth.md` |
| Explainers, training, digital humans, localization | `references/31-knowledge-enterprise-localization.md` |
| Documentary, medical, science, wildlife, regulated claims | `references/32-factual-regulated.md` |
| Architecture, property, automotive, routes, travel | `references/33-spaces-mobility-travel.md` |
| Local edit, source edit, extension, diagnosis, retry | `references/40-local-editing-and-repair.md` |
| Provenance and maintenance | `references/98-source-ledger.md` |
| Forward tests | `references/99-eval-cases.md` |

Read `references/00-index.md` when several families compete.

## Timeline Control

Every final generation or video-edit prompt must include a visible `Timeline`
with contiguous ranges formatted exactly like `【0:00-0:03】`.

- Start at `0:00`, cover the full confirmed duration, leave no gaps or overlaps,
 and end exactly at the confirmed duration.
- Give each range one dominant event and resulting state. Include camera, cut or
 transition, synchronized audio/dialogue, and relevant preserve lock.
- Allocate time by complexity rather than equal blocks. Preserve anticipation,
 contact, reaction, recovery, and a readable final hold.
- Place exact dialogue, lyrics, UI events, claims, impacts, match cuts, and beat
 cues inside their owning range.
- For source-video edits, separate source timecodes from output ranges and state
 their mapping.
- For longer sequences, use more ranges rather than overloading each range —
 and keep them in one generation while they fit the 30-second window.
- Treat timeline control as direction, not a runtime guarantee.

Canonical shape:

```text
Target duration: 28 seconds
Timeline:
【0:00-0:04】Shot 1 — hook and opening state; one camera move.
【0:04-0:10】Shot 2 — primary action and visible proof.
【0:10-0:17】Shot 3 — reaction or escalation.
【0:17-0:20】Shot 4 — comparison or turn.
【0:20-0:28】Shot 5 — payoff and readable hold.
```

## Prompt Rules

- Put reference binding before creative prose. Name what each image, video,
 audio, storyboard, script, or model controls.
- Describe visible events in temporal order and give each action a result.
- State subject/object/camera spatial relationships when interaction or geometry
 matters.
- Use one primary camera intent per range; cuts must reveal new information.
- Preserve exact user dialogue, lyrics, visible copy, labels, and legal lines.
- Separate dialogue, ambience, physical effects, diegetic music, and
 audience-only score.
- Use white-model references to preserve solved space/camera/action while
 changing surface and light; use green-screen references for isolated motion or
 performance transfer.
- Treat a storyboard as ordered shot logic, not a style collage.
- For factual or regulated work, generated visuals illustrate approved sources;
 they do not become evidence.
- Never put unverified provider limits or unsupported parameters into the prompt.

## Output Contract

Return:

1. **Creative intent** and primary acceptance criterion.
2. **Confirmed setup** — duration, destination/aspect when known, mode, locks.
3. **Reference Role Map** — every source in confirmed order and its authority.
4. **Timeline** — complete contiguous ranges.
5. **Final Seedance 2.5 prompt** — one exact prompt, not several competing drafts.
6. **Review checklist** — observable reference, continuity, truth, and delivery
 checks.
7. **Controlled retry** — one variable or local region to change.

For direct generation, hand the exact prompt and pack to runtime. For diagnosis,
name the visible failure, likely causal instruction, smallest local repair,
preserve list, and one retry variable.

## Quality Bar

- Protect full compatible reference coverage; use roles and priorities to make a
 rich pack legible, not to prune needed visual evidence.
- Make reference authority, event order, and ending state explicit.
- Use a storyboard, blockout, or motion source when words cannot control the
 spatial or temporal problem.
- Keep product, identity, copy, evidence, rights, safety, and geometry source-owned.
- Use local repair for local failure; do not regenerate a passed sequence.
- Separate generated concept from captured gameplay, real UI, verified facts,
 architectural truth, medical instruction, or current destination conditions.
- Do not turn first-party marketing, community popularity, or a single preview
 into a runtime or repeatability claim.