# Commerce Ad Studio

Every job here has the same shape. The user brings a **source** — product photos, an ad they already run, a reference video, reviews, a results table. Some things about it are **fixed**: the product's look, the brand, the offer, what may be claimed. One thing **changes**: the language, the size, the headline, the opening seconds, the product inside a borrowed structure. Write both lists down before anything is generated. Almost every bad result in ad work is a fixed thing that quietly changed, or two things that changed when the user asked for one.

## Pick the job

| The user wants | Job | Stays fixed | Changes | Read |
| --- | --- | --- | --- | --- |
| The ad for other countries or languages | Localize | product, brand, offer terms, layout family | copy, typography, number and currency formats | [static ads](references/static-ads.md) |
| The ad in other sizes or placements | Resize | message, copy, product | aspect and layout | [static ads](references/static-ads.md) |
| Several headlines on one ad, to test | Headline variants | everything outside the headline | the headline | [static ads](references/static-ads.md) |
| Several openings on one video, to test | Hook variants | body, ending, offer | the first seconds | [video ads](references/video-ads.md) |
| "One like this video" for their product | Recreate | the reference's selling structure and pacing — nothing else | footage, words, product: all new | [video ads](references/video-ads.md) |
| An ad from real reviews, nobody on screen, with a voice | Customer voice | the customers' real words, the product facts | — | [video ads](references/video-ads.md) |
| A video ad in other languages | Localize video | picture and key timing | voice, captions, on-screen copy | [video ads](references/video-ads.md) |
| What to say, which angles, what competitors do | Strategy | verified facts | — | [strategy and analysis](references/strategy-and-analysis.md) |
| What the campaign numbers mean and what to do next | Analysis | read-only | — | [strategy and analysis](references/strategy-and-analysis.md) |
| Illustration, collage, whiteboard, a deck, app screens or brand assets set in motion | Motion | the source art, exact copy, facts | movement | [motion formats](references/motion-formats.md) |

Read the reference for the job before planning it, and only that one. A request that fits no row still takes the same shape: name the source, the fixed list and the one change. A coherent listing photo set — white-background main image, feature, detail and lifestyle shots — is a product-image-set job, not an ad job; this skill takes an image from such a set as its source.

Jobs chain. Strategy yields concepts; a chosen concept becomes the control for headline variants; the winner gets resized, then localized. Run one job at a time and let it land before the next starts: the output of one is the source of the next, and a change upstream sends everything downstream back to draft.

## Product truth before copy

Every visible word in an ad is a claim the user's business answers for. Read [Product Truth](references/product-truth.md) before writing any copy. Price, discount, shipping promise, certification, rating, result and customer quote come from the user or from a source you can name — never from what would sound persuasive.

## Ask once, for what blocks

Look first: the conversation, the Canvas, attachments, the Library — the user may already keep a product dossier or earlier ads there. Then ask only for what this job cannot proceed without, in one surface:

- `show_form` for several facts at once — target markets, placements, number of variants, the offer per market. Use `image_select` to pick which ad or product photo is the source; it takes images only, so a video source is picked by title in a `select` field. Put the default you would assume on every field and a companion text field wherever your options might miss. After showing a form, end the turn and wait for the submission.
- A choice between creative alternatives whose text is heavy — two recreated scripts, five angles — is a `show_widget` decision panel with one button per alternative.
- `AskUserQuestion` only for a blocking choice whose options are exhaustive: translate or transcreate, dub or subtitle.

Facts, the choice of a concept, and the go-ahead to generate are separate decisions; never fold them into one yes. Copy is the user's words — offer versions, let them pick and edit, and generate only approved copy.

## Making

Generation follows the Making contract in your instructions unchanged: available models, the model's described contract, two-pass confirmation, recovery after a failure. This skill adds:

- **The source is a reference with a job.** The prompt says what it controls and what it must not contribute — "keep everything in the referenced ad: product, layout, colors, background, every other line of text; replace only the headline with …". The one exception is a Recreate reference video, which is analysed and never passed.
- **Exact text is quoted exactly.** Approved copy goes into the prompt one string per text zone. After generation, read every visible character back from the image against the approved copy — a wrong accent, a dropped character, an extra word — and treat any mismatch as a failed take, never a deliverable.
- **Variants of one job are one batch**: same model, same parameters, only the prompt and per-item references differ, so the user confirms them on one card. Different aspect ratios are different batches.
- **A model's prompt copilot skill, when one exists, owns the wording.** This skill owns the fixed list, the change and the reference roles; they survive into whatever prompt the copilot writes.
- **Nothing here joins clips.** When a job needs pieces combined — a new hook onto the old body, a voiceover over picture, captions on top — deliver the pieces plus an edit list with exact timecodes, and say the final cut is assembled in their editor. Never call pieces a finished ad.

## Judging and delivering

Look at every result before calling it done. Check the fixed list first — product shape, logo, colors, offer, layout, the untouched text — then the one thing meant to change. A variant where two things changed is a failed variant however good it looks; retry it with the drift named in the prompt, never with an unchanged roll.

Deliver in the shape the user will use:

- On the Canvas, one group per job, each output titled by what varies: "DE · 4:5", "标题 C · 痛点型", "Hook B · 演示开场".
- In the project record's plan, a variant table: variant, the one change, the hypothesis it tests, node, state — and for tests, what to measure.
- Anything that exists only as a spec — an edit list, a subtitle script, a copy deck — is labelled as a spec, not as media.

Accepted ads are saved to the project's Library folder, as your instructions describe for accepted work.