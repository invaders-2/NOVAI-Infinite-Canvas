# GPT Image 2 Prompt Copilot

## Purpose

This skill only writes creative prompt text for GPT Image 2/OpenAI image
requests: purpose, hierarchy, edit invariants, reference roles, text,
constraints, and retry guidance.

## Boundary With -cli

`-cli` owns runtime capability and execution checks. Do not decide or
promise available models, parameters, image sizes, reference compatibility,
prices, queue behavior, submission state, transparency, exact dimensions, or
success. For actual canvas generation, use the `-cli` skill as the source
of truth to read the current model catalog and generation workflow, resolve
media refs, validate the request, submit generation, and verify result state.

Keep the layers separate: this skill writes wording; `-cli` reads current
options, handles refs, and runs generation. Never expose internal CLI or tool
names to users.

For OpenAI API facts outside, verify official OpenAI docs first.

## Workflow

1. Identify direct canvas generation, reusable prompt, edit prompt, reference
 plan, variants, rewrite, or diagnosis.
2. If generating on canvas, write one final structured prompt with visible
 section labels, then let the runtime workflow execute it. For direct
 generation, do not show a prompt draft, do not ask whether to submit, and do
 not mention `-cli` in user-facing text.
3. Ask one compact question only when missing information materially changes
 the prompt; otherwise proceed with a stated assumption.
4. Write the final generation prompt in the user's language, including visible
 section labels. If the user writes in Chinese, write the final prompt in
 Chinese unless they ask otherwise.
5. Always use a structured prompt body with section labels. Keep simple
 requests concise, but do not output an unstructured paragraph.
6. Include Reference roles when refs are present. Give each source one creative
 role, separate from execution refs. Cite each source as `{{node/<id>}}` or
 `{{library_asset/<id>}}`, never `{{Image 1}}`. For direct generation,
 keep the same structured prompt body and resolve and pass actual refs; do not
 rewrite, summarize, or collapse it before submission.
7. Convert the idea into a purpose-first still-image plan: intended use,
 subject, hierarchy, composition, environment, light, exact text, preserved
 references, and failure controls.
8. Use `references/prompt-patterns.md` when the prompt needs typography,
 poster/layout hierarchy, UI mockups, product edits, variants, or failure
 repair.
9. Use `references/eval-cases.md` only when reviewing or testing this skill.

## Output Contract

For prompt-only requests, return:

- Creative intent label in product terms, not runtime capability terms.
- Reference role summary when refs are present.
- Structured prompt body with visible section labels.
- Final generation prompt in the user's language, including exact visible text
 when text matters.
- Short constraints for likely failures.
- One controlled retry variable, or 2-4 variants with one changed axis each.

For direct generation requests, do not expose this skill, file names, internal
refs, CLI commands, flags, raw payloads, or backend lifecycle details. After
`-cli` verifies the real state, answer only in product terms.

For diagnosis, ask for the failed output if missing, then identify the visible
failure, likely prompt cause, smallest prompt change, preserve list, and one
controlled retry variable.

## Quality Bar

- Start with the image purpose and hierarchy.
- Put exact text early and quote it exactly.
- Prefer positive constraints over generic negative walls.
- For edits, lead with what must remain unchanged.
- For UI or layout images, specify structure before decoration.
- Give every reference a clear visible role. Use full compatible reference
 coverage for every fact that must stay fixed; exclude only conflicting sources
 or true duplicates that add no visible evidence.
- Do not invent unseen reference details.
- Do not turn public claims into runtime promises.