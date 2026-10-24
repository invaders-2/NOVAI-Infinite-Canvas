# Seedance Prompt Copilot

## Purpose

This skill only writes creative prompt text for Seedance-oriented video
requests: user intent, reference roles, visible motion, timeline, sound,
continuity locks, and likely failure risks.

## Boundary With -cli

`-cli` owns runtime capability and execution checks. Do not decide or
promise available models, modes, durations, resolutions, parameters, reference
compatibility, prices, queue behavior, submission state, or success. For actual
canvas generation, use the `-cli` skill as the source of truth to read
the current model catalog and generation workflow, resolve media refs, validate
the request, submit generation, and verify result state.

Keep the layers separate: this skill writes wording; `-cli` reads current
options, handles refs, and runs generation. Never expose internal CLI or tool
names to users.

## Workflow

1. Identify direct canvas generation, reusable prompt, storyboard, reference
 plan, prompt rewrite, or failure diagnosis.
2. If generating on canvas, write one final structured prompt, then let the
 runtime workflow execute it. For direct generation, do not show a prompt
 draft, do not ask whether to submit, and do not mention `-cli` in
 user-facing text.
3. Ask one compact question only when missing information blocks generation;
 otherwise proceed with a stated assumption.
4. Write the final generation prompt in the user's language, including visible
 section labels. If the user writes in Chinese, write the final prompt in
 Chinese unless they ask otherwise.
5. Always use a structured prompt body with section labels. Keep simple requests
 concise, but do not output an unstructured paragraph.
6. Include Reference roles when refs are present. Give each source one creative
 role, separate from execution refs. Cite each source as `{{node/<id>}}` or
 `{{library_asset/<id>}}`, never `{{Image 1}}`. In 全能参考 a cast enters as
 one sheet and every other still is 仅供参考 — what it may lend and must not.
 In first/last or image-to-video the bound still is that frame; match it. For
 direct generation, keep the same structured prompt body and resolve and pass
 actual refs; do not collapse it into prose.
7. Include a Timeline or Action beats section for visible motion. Use timecodes
 when ordered beats, dialogue timing, transitions, music sync, or choreography
 matter.
8. Use `references/prompt-patterns.md` only for multi-ref roles, ordered action
 beats, sound timing, or a repair rewrite.
9. Use `references/eval-cases.md` only when reviewing or testing this skill.

## Output Contract

For prompt-only requests, return:

- Creative intent label in product terms, not runtime capability terms.
- Reference role summary and Reference roles section when refs are present.
- Structured prompt body with visible section labels.
- Timeline or Action beats section when motion matters.
- Final generation prompt in the user's language.
- Short avoid list focused on likely failures.
- One controlled retry variable.

For direct generation requests, do not expose this skill, file names, internal
refs, CLI commands, flags, raw payloads, or backend lifecycle details. After
`-cli` verifies the real state, answer only in product terms.

For diagnosis, ask for the failed output if missing, then identify the visible
failure, likely prompt cause, smallest prompt change, preserve list, and one
controlled retry variable.

## Quality Bar

- Keep simple requests concise, but still structured.
- Put the intended outcome, subject, and primary action early.
- One action per shot; pack every planned shot that fits the 15-second window
 into one generation. Do not cap the take at three shots.
- Use timecodes only when they reduce ambiguity.
- For dialogue, state speaker, line, tone, pause, and visible reaction.
- Give every reference a clear visible role. Use full compatible reference
 coverage for every fact that must stay fixed, and keep its visual role
 separate from execution references; exclude only conflicting sources or true
 duplicates that add no visible evidence.
- Do not invent unseen reference details.
- Do not turn public claims into runtime promises.