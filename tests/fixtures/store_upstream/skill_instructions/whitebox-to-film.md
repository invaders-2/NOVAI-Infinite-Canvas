# Generating Cinematic Video from a Whitebox

Based on the user's idea, build a 3D whitebox reference that clearly expresses space, action and camera intent, then use Seedance (hereafter SD) to generate the complete video. The whitebox provides a controllable staging; SD delivers the real appearance and natural performance.

The final outputs are a playable, recordable whitebox widget, reusable generation prompts and the generated video. Duration, aspect ratio, style, language and whether it is a single continuous take are determined by the specific requirements.

## The Whitebox Delivery Surface

In the current environment, the only way for the Agent to produce a whitebox is to write HTML: write the scene as an inline HTML fragment, render it with **raw WebGL**, and present it through `show_widget`. Do not depend on Three.js or any CDN library — the widget iframe only allows inline scripts, and external scripts will not load; do not assume the environment has Blender or an offline renderer either. When the user explicitly asks for other tools, follow their request, but never assume a library exists out of "habit".

A single whitebox widget carries three jobs at once:

- **Previs**: play, pause, scrub the timeline and switch cameras so the user can confirm blocking and shots inside the conversation.
- **Recording**: advance time frame by frame at a fixed frame rate and record a full-length, clean camera-view video.
- **Export**: provide a real download entry when the host allows; otherwise keep the preview and say so honestly.

Read [WebGL Whitebox Widget](references/webgl-widget-whitebox.md) before building: it specifies fragment structure and size, CSP boundaries, the minimal raw WebGL implementation, the deterministic timeline, the recording method and the file handoff. When a widget is needed, first call `visualize:building-widgets` to read the design tokens; for complex scenes, save an editable source file first, then pass the complete fragment of that same version to `show_widget`. The same file also records, under "Acceptance Request Example", the standard acceptance request that asks for a PNG screenshot, H.264 MP4 recording, `<a download>` download and add-to-canvas via `window..uploadToCanvas` inside one widget.

## Creation and Generation

### 1. First establish a staging that can be understood

Extract the core experience the user really wants to see: what the character wants to do, what stands in the way, how the action changes the situation, and what the audience sees at the end. When information is insufficient, fill in the necessary creative choices; do not pile on irrelevant action just to look complex.

Choose a continuous take or cuts according to the user's needs. A continuous take must have connected space and enough travel time; with cuts, each shot should have clear opening and closing compositions and action match points. Do not treat one genre's chase, slow motion or car scene as a fixed structure for every video.

### 2. Build only what affects reading the picture

Spend precision on spatial connections, object silhouettes, character routes, contact relationships and the camera path. Surface textures, skin, fine cloth folds and the like can be left to SD. In raw WebGL this means: only procedural geometry such as boxes, cylinders, planes and wedges, flat color plus soft shading, no texture maps.

**Hard rule — characters are plain cylinders.** Every person in the whitebox is a single upright cylinder: no head, torso, arms, legs, hands or feet, and no jointed or capsule figures, at any distance and in any shot. SD reads whatever body geometry it sees as a literal visual reference; crude limbs, hands and feet get copied into the finished people as stiff, puppet-like bodies and drag the quality of the whole video down. A deliberately coarse cylinder leaves SD nothing to copy, so it has to build real bodies from the prompt and the appearance references while still following position and timing. What a cylinder can express is exactly what the whitebox is for: where the person is, where they go, how fast, how far from others and from props, when contact happens, and a slight lean for weight shift. Everything about limbs, hands, feet, gait and gesture is written in the prompt, never modeled.

Simplify environment and props to the point where they do not lose their function. Distant cylinders can be shorter and dimmer to show crowd density; props a person touches (a cup, a door, a bag) are separate simple primitives so that handover and contact timing remain visible. First check whether the whitebox explains the staging, then decide whether to add detail — and never add it to the characters.

See [Whitebox and Blocking](references/whitebox-and-blocking.md) for construction and animation methods.

### 3. Be explicit about what must be preserved and what should be regenerated

- **Must preserve**: the spatial relationships, character identities, action causality, main travel directions, important contacts and camera intent that are key to this film.
- **Allowed to vary**: the whole human body — gait, limbs, hands, feet, expressions, cloth — since the whitebox deliberately provides none of it; plus real materials, slight camera follow and plausible detail.
- **Choose per task**: strict composition, exact event timing, character wardrobe, prop counts, shot size and effects pacing. Constrain only what matters to the current film.

Do not write "copy every movement exactly" while also asking for "natural re-performance"; and do not write "improvise freely" and then expect space and story to stay consistent. Pick the few invariants that matter most for this film first, then give freedom around them.

### 4. Write the final prompt

The prompt first states what the whitebox and the other references are each responsible for — always including that the cylinders mark position and timing only and that every person must be generated as a complete, natural human — then describes the final picture, characters, continuous action, camera and sound. Describe action as "trigger — reaction — result", not just a list of poses and adjectives.

See [Prompt Patterns](references/prompt-patterns.md) for the general template, examples across genres and targeted fixes.

### 5. Generate, and fix problems at the right layer

The whitebox recording exists only inside the user's browser. First get the file to actually reach the Agent or the SD tool following the handoff method in [WebGL Whitebox Widget](references/webgl-widget-whitebox.md) (provided by the user after downloading, or through a platform file-receiving bridge), then use the tool or CLI the user specified, query the current SD mode, reference inputs and duration limits, and submit the checked whitebox video and prompt. Do not generate extra material unless it fills a clear gap in character, vehicle or style.

Check the actual video: is it the same staging, does the action have causality, do the people have complete natural bodies rather than tube-like or stiff figures, is the performance natural, does the camera work hold up? For space or timing errors, first change the scene data in the source file, re-display and re-record; for appearance or performance errors, first change the reference roles and the prompt; a single local problem can be fixed with a local edit, but it must not break continuity before and after.

See [SD Generation and Refinement](references/generation-and-refinement.md) for specifics.

## Boundaries of Use

These methods apply to action scenes, and equally to dance, everyday interaction, advertising, product showcases, walkthroughs and so on. Do not load character constraints when there are no characters, do not add driving rules when there is no car, and do not add speed changes when there is no slow motion. Technical checks revolve around the actual problems of the current film.

After calling `show_widget`, end the turn and wait for the user's actual interaction or feedback; do not recite the whole panel, and do not treat default values of local controls as user confirmation. When the user only wants the whitebox, only the prompt or only the generation, deliver that product and do not automatically expand into other steps.