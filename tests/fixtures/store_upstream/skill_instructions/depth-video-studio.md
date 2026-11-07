# Depth Video Studio

Take a clip the user already has, keep what is expensive to re-author — the movement, the timing, the spatial depth and the camera path — and replace what they actually want changed: the character and the setting. The mechanism is a two-stage chain. A depth-map pass turns the source clip into a per-frame grayscale depth video that carries motion and space but no identity; a second generation then treats that depth video as the motion authority and the new images as the appearance authority.

The deliverables are the depth video node, the recast video node, and the reference role map and prompt that produced them. All three stay on the canvas, so later variants reuse the same depth pass instead of paying for it again.

## When This Is The Right Shape

- The user points at a clip and wants the same action, blocking or camera move performed by someone else, somewhere else.
- The user asks directly for a depth map, depth pass or depth video, whether or not a recast follows.
- The motion already exists and is worth preserving. When the user is inventing motion from scratch, build a whitebox instead and use `whitebox-to-film`; when they want the source clip itself edited in place rather than re-performed, use the host's video edit route instead of a depth chain.

One depth pass serves many recasts. When the user asks for another character or another setting on a clip already converted in this conversation, reuse the existing depth node and go straight to the second generation.

## Stage 1 — The Depth Pass

Read the source clip before converting it. Look at the actual media, not just the node title: what the subject does, how the camera moves, how long the clip runs and what its frame is. That observation is what lets you write an honest role map later, and it is what tells you whether the motion is worth preserving at all.

Then read the depth model's live contract before submitting — accepted method, reference count and resolution options belong to the model, not to this skill. Depth conversion is a pure transform: it takes exactly one video, keeps the source length, and does not read the prompt, so the prompt is a short note and nothing about the desired final look belongs in it. Keep the source resolution unless the user asked otherwise.

Submitting opens a confirmation card and suspends the run. Wait for the real decision. See [Generating and Chaining](references/generation-and-chaining.md) for what to do while waiting, how to tell when the depth video is actually ready, and how to handle a rejection.

## Stage 2 — Ask What Changes

The depth pass fixes movement and space. Everything the user cares about — who and where — is still open, and guessing it wastes a generation. Ask, but ask only for what the canvas and the conversation cannot already answer.

The answer must be expressible **both** as a picked canvas asset and as a description in words. A user who already has the character on the canvas should point at it; a user who only has an idea should type it. A choice card built from fixed text options supports neither well, and is the wrong tool here.

Read [Asking What To Change](references/asking-the-user.md) before choosing an elicitation surface. It covers which surface carries canvas references, how to build image options from canvas nodes, what to infer instead of ask, and how to accept an answer that arrives as a node reference in ordinary conversation.

## Stage 3 — The Recast Generation

Look at every reference before writing the prompt, including the depth video you just produced. A depth pass that came back mostly flat, or that lost the subject, is a stage 1 problem and re-prompting stage 2 will not fix it.

Choose a model whose live contract offers a multi-reference video mode, and read that contract for the reference budget per media kind and for the duration, frame and resolution options. Two things routinely surprise users:

- **The recast is not length-locked to the depth video.** The depth pass keeps the source length, but the new generation's duration is an independent parameter with its own default and its own ceiling. When the user wants the whole clip recast, set the duration to the source length and say so if the model cannot reach it.
- **Defaults are not the user's request.** Resolution, aspect ratio and audio all have model defaults that quietly differ from what the user asked for. Set explicitly what the user stated; leave the rest at the model default rather than inventing values.

When the chosen model has its own prompt copilot skill, let it own the prompt's wording and craft; this skill owns the chain, the role map and the reference order, and those constraints survive into whatever prompt that copilot writes.

The prompt's whole job is to assign authority. Each reference gets one thing it controls and an explicit statement of what it must not contribute — above all that the depth video supplies motion, staging and spatial depth and must not contribute its grayscale rendering. Reference order matters: the submitted request rewrites node placeholders into ordinal labels per media kind, so the order references are passed is the order the prompt's roles must follow. See [Reference Roles and Prompting](references/reference-roles-and-prompting.md).

## Delivery

- Say which clip supplied the motion, which references supplied identity and setting, and what was generated at what duration and resolution. The user should be able to tell from the reply alone why the new video moves the way it does.
- Name the real differences from the source: a recast follows the depth pass, it does not reproduce the original frame for frame, and duration or frame may have changed.
- When the result inherits the grayscale, loses the character's identity or keeps the old background, fix it at the layer that caused it — see the failure table in [Reference Roles and Prompting](references/reference-roles-and-prompting.md). Do not resubmit an unchanged request hoping for a different sample.
- Do not claim a node was created, bound or completed without the submission result that proves it, and do not describe the depth video as the deliverable when the user asked for the recast.