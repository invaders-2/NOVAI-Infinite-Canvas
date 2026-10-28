# NOVAI — Infinite Canvas AI Creation Platform

> Freely generate images and videos on an infinite canvas, connecting workflows with nodes. Built-in free ModelScope API, ready to use out of the box.
>
> **[Website](https://invaders-2.github.io/NOVAI-Infinite-Canvas/) · [Download](https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases) · [Docs](https://invaders-2.github.io/NOVAI-Infinite-Canvas/docs.html) · [Changelog](#changelog)**
>
> [![release](static/images/badges/release.svg)](https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases) ![platform](static/images/badges/platform.svg) ![quickstart](static/images/badges/quickstart.svg) ![README](static/images/badges/readme.svg)
>
> [中文](README.md) · **English**

## Introduction

NOVAI is an all-in-one AI workbench for creators. On an **infinite canvas** you can drag, connect, and combine various AI capabilities — text-to-image, image-to-image, AI video generation, GPT multimodal chat — all seamlessly in one interface. The canvas **AI assistant is a real Agent**: state a goal in one sentence and it plans and acts on its own — creating nodes, wiring them up, running generations, checking tasks — with every step visible and the whole run rollbackable. Paired with **Photoshop panels** and **Chrome extensions**, asset collection and creative workflows flow together.

---

## Screenshots

![Home](static/images/screenshots/home.png)

![Infinite Canvas](static/images/screenshots/canvas.png)

![AI Generation](static/images/screenshots/generate.png)

![API Settings](static/images/screenshots/settings.png)

![Asset Manager](static/images/screenshots/assets.png)

---

## Features

- **Infinite Canvas** — images, videos and text are all nodes on the canvas; zoom, drag and connect freely — no more shuttling files between separate tools.
- **Node workflows** — chain image, video and LLM nodes into one pipeline where upstream results feed downstream — configure a repetitive multi-step job once and reuse it.
- **Auto-place on canvas** — generated results become nodes automatically — no manual download and import.
- **@ reference** — type @ in the input box to use any canvas node as reference material — no re-uploading the same image.
- **Smart Canvas AI assistant (real Agent)** — state a goal in one sentence and the model plans and acts over multiple rounds (create nodes, wire them up, run generations, check tasks), every step visible and the whole run rollbackable — you do not have to click through complex jobs yourself.
- **Table-driven batch production** — one table drives batch image / video generation: per-row assets and prompts, real per-row progress, stop anytime, a single result node per batch — batch work stays controllable and does not blur together.
- **Chat-style creation** — LLM nodes and GPT chat support multi-turn context, selectable personas (default "Prompt Optimizer") and a live thinking process — refine prompts the way you would in a conversation.
- **Cutout** — the default path uses the image API (green-screen matting); "High-quality cutout" runs the local RMBG-2.0 model offline with edge refinement (about 349MB model download on first use) — transparent PNGs even without online quota.
- **HD upscale** — local Real-ESRGAN upscales offline to 2K / 4K, and images already close to the target resolution fall back to high-quality resampling (about 50MB of components on first use) — free, offline, and your originals never leave the machine.
- **Face blur** — one click blurs every face in a video (local YuNet detection) — helps avoid platform review issues with real people on camera.
- **Lovart design agent** — connect with an Access Key / Secret Key for image and video generation, asset upload and result download — hand work off to a design agent platform.
- **Plugins and external tools** — Photoshop panel, Chrome extension and CLI tools such as Jimeng CLI — connect asset capture with your local workflow.
- **Multi-repo updates and rollback** — GitHub / Gitee / ModelScope update channels with backup and rollback — updates work on Chinese networks and you can always go back.
- **Chinese-first** — deep Qwen ecosystem integration — Chinese prompts and Chinese text rendering suit Chinese creators.

---

## Quick Start

### Download & Install (Recommended)

No Python installation or environment configuration needed — download the installer and run.

#### Windows

1. Grab `NOVAI-Setup-<version>.exe` from [Releases](https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases)
2. Double-click to install and follow the wizard (desktop shortcut auto-created)
3. Launch the "NOVAI" icon on your desktop, browser opens `http://127.0.0.1:3000/` automatically

#### macOS

1. Grab `NOVAI-Setup-<version>.dmg` from [Releases](https://github.com/invaders-2/NOVAI-Infinite-Canvas/releases)
2. Open the DMG and drag `NOVAI.app` into the `Applications` folder
3. Double-click `NOVAI.app` to launch, browser opens `http://127.0.0.1:3000/` automatically

> Want the desktop client with a bundled Chromium engine and one-click auto-update? Use the Electron build: `NOVAI-Electron-Setup-<version>.exe` on Windows, `NOVAI-<version>-arm64.dmg` on macOS. Both **share the same data directory** as the build above, so you can switch at any time — see "Desktop Client" below.

> **First launch note (the macOS installer is not signed with an Apple Developer certificate — this is expected)**: you may see "cannot be opened because it is from an unidentified developer", and occasionally "**NOVAI is damaged and can't be opened**". That does **not** mean the file is corrupt — Gatekeeper is blocking an unsigned app. Any of these works:
> - Right-click `NOVAI.app` → "Open" → "Open" again;
> - Or System Settings → Privacy & Security → click "**Open Anyway**";
> - Or run: `sudo xattr -rd com.apple.quarantine /Applications/NOVAI.app` (adjust the path if you installed elsewhere).
>
> To first make sure the download is intact: `shasum -a 256 NOVAI-<version>-arm64.dmg` and compare with the sha256 shown on the Release page, or run `hdiutil verify NOVAI-<version>-arm64.dmg`. If it still says "damaged" after clearing quarantine, add: `sudo codesign --force --deep --sign - /Applications/NOVAI.app`.

---

### Manual Install (Developers)

If you want to run from source or contribute:

```bash
# Clone the repository
git clone https://github.com/invaders-2/NOVAI-Infinite-Canvas.git
cd NOVAI-Infinite-Canvas

# Install dependencies
pip install -r requirements.txt

# Start the server
python main.py
```

Open `http://127.0.0.1:3000/` in your browser.

> Requirements: Python 3.10+

---

## FAQ

### Windows

| Issue | Solution |
|-------|----------|
| **Cannot open after install** | Check firewall settings; try running as administrator |
| **Port 3000 in use** | Close the program using the port, or set env var `DEPLOY_RUN_PORT=3001` before starting |
| **Dependency install fails** | Ensure Python 3.10+ is installed with "Add Python to PATH" checked |
| **Antivirus false positive** | Add the NOVAI installation directory to antivirus whitelist |

### macOS

| Issue | Solution |
|-------|----------|
| **"Unidentified developer" warning** | Normal for an unsigned build: right-click the app → "Open" → "Open" again; or System Settings → Privacy & Security → "Open Anyway" |
| **"App is damaged" warning (the file is fine)** | Gatekeeper blocking an unsigned app. First verify the download: `shasum -a 256 NOVAI-<version>-arm64.dmg` (compare with the sha256 on the Release page) or `hdiutil verify <dmg>`; then clear quarantine: `sudo xattr -rd com.apple.quarantine /Applications/NOVAI.app`; if it still complains, add `sudo codesign --force --deep --sign - /Applications/NOVAI.app` |
| **Port 3000 in use** | Run `lsof -i :3000` to find the process, `kill <PID>` to end it; or set `DEPLOY_RUN_PORT=3001` |
| **Dependency issues (manual install)** | Ensure Python 3.10+: `python3 --version`, then `pip3 install -r requirements.txt` |

---

## AI Models

Built-in **ModelScope** free API, ready out of the box:

| Type | Model | Description |
|------|-------|-------------|
| Chat | Qwen3-235B | Tongyi Qianwen flagship, reasoning/writing |
| Chat | Qwen3-VL-235B | Multimodal, image analysis |
| Image | Qwen-Image-2512 | Best Chinese text rendering, posters/banners |
| Image | FLUX.2-klein-9B | Best visual quality |
| Image | Z-Image-Turbo | 1-2s fast generation |
| Image | Qwen-Image-Edit-2511 | Edit images by talking |
| Video | agnes-video-2.5 | Free video generation |

Beyond the built-in free quota, "API Settings → Add platform" connects platforms from your own accounts. Model names are kept per platform and never swapped between them:

| Protocol | Platforms |
|----------|-----------|
| OpenAI-compatible | Relays / official-compatible endpoints (gpt-image, Nano Banana, …); presets: Agnes AI, EXELLOME, FHL, VIP-GPT |
| Async protocol | APIMart |
| Native Gemini | Google Gemini (images via `/v1beta`) |
| Ark | Volcengine (Doubao Seedream images, Seedance video) |
| RunningHub | OpenAPI workflows |
| CLI | Jimeng CLI, OpenAI Codex CLI, Antigravity CLI |
| Design agent | Lovart (Access Key / Secret Key signing) |

Provider dropdowns only list platforms **with a configured key**; platforms without one never appear in generation nodes and are never chosen as the default.

---

---

## Responsible Use & Content Compliance

Please use NOVAI responsibly and in compliance with applicable laws and platform content-safety policies. When working with footage that contains recognizable people, ensure you have the necessary rights or consent, and avoid using any media that infringes on others' personal rights or privacy.

> **Privacy tip**: If your reference footage contains bystanders or people who have not given consent, use the built-in **Face Blur** tool (Smart Canvas → select the video node → toolbar "Face Blur") to protect their identity before using the material.

---

## Download & Updates

Installers and update sources:

| Platform | URL |
|----------|-----|
| GitHub | https://github.com/invaders-2/NOVAI-Infinite-Canvas |
| Gitee | https://gitee.com/invaders/novai |
| ModelScope | https://modelscope.cn/models/bllack/NOVAI-releases |

The app checks all three sources for the latest version on startup, pushes update notifications, and upgrades with one click (ModelScope installers live under `electron-release/` in that repo — the same source the app uses for mirror updates).

---

## Desktop Client (Electron · Beta)

> New packaging route: **Electron** with its own Chromium engine (consistent behavior across platforms, no more system WebView differences), with electron-updater auto-update.

- Source & build docs: **desktop/README.md**
- Reuses the existing frontend through a pywebview compatibility bridge (window.pywebview.api) — native dialogs / window controls / system tray with zero frontend changes
- **Fully shares data with the official build**: same port 3000 and same data directory (Windows `%APPDATA%/NOVAI`, macOS `~/NOVAI`) — canvases, settings and chat history are shared, **no data re-download or migration needed, just install and run**; if the official build is already running, the Electron app reuses its backend instead of starting a second one
- **Three-repo update channel**: GitHub Releases as the primary source; if the check fails (common on Chinese networks) it automatically falls back to a ModelScope mirror (`bllack/NOVAI-releases`), with Gitee Releases as a manual-download backup. The cloud pipeline (triggered by pushing a `v*` tag) syncs installers to all three repos automatically
- **Auto-restart after update**: on Windows the update installs and restarts automatically after user confirmation; on macOS, unsigned builds cannot auto-install (Squirrel requires code signing), so the app falls back to a guided manual download — data is never affected

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

- You may use, modify and redistribute it, including commercially;
- If you distribute a modified version, or run a modified version as a network service for others, you must release its complete source code under AGPL-3.0 and keep the original copyright and license notices.

See [LICENSE](LICENSE) for the full terms.

---

## Changelog

### v1.0.128

- **No upload dialog when creating nodes**: new image / video nodes start empty instead of opening the file picker; pick or drop media when you actually need it
- **Groups resize freely**: group nodes are no longer locked to aspect ratio — drag width and height independently, and media inside reflows to the new box
- **Multi-image nodes and batch-result groups scale freely**: scaling a multi-image node or a batch-result group reflows the media automatically, with no clipping or overlap
- **How to update**: users on 1.0.127 can update in-app; this release only changes external static / Python files, not the bundled runtime, and new downloads include all fixes

### v1.0.127

- **Fixed OpenClaw showing "unavailable" when NOVAI is launched from the desktop**: on macOS a Finder / login-item launch gives the process a very short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the `#!/usr/bin/env node` shebang in `openclaw` could not find Node; detection and the installer now include OpenClaw's bundled user-level Node directory, so machines with Node and the Gateway already set up work right after updating
- **More accurate Node detection**: the Node under `~/.openclaw/tools/node/bin` is preferred, so an older system Node no longer produces a false "Node does not satisfy requirements" warning
- **No reinstall needed**: users on 1.0.126 can update in-app

### v1.0.126

- **Hotfix: 1.0.125 crashed on launch on macOS** (`No module named 'html.parser'`) — machines still on the 1.0.124 or older frozen runtime were missing the module, and the new external code took the whole backend down on import; a missing `html.parser` now falls back to a built-in text extractor, so report and web-link parsing keep working
- **Older runtime compatibility**: in-app updates only replace external files, not the bundled runtime, so a missing module no longer stops the backend from starting
- **Clearer startup errors**: when program files and the installer version do not match, the app now tells you to download the latest full installer and install it over the old one
- **Bundled dependencies**: new installers include `html.parser` and `openpyxl` in the frozen runtime
- **macOS users**: you must download and install the full dmg over the existing app — the in-app updater cannot fix this; on Windows either the classic exe or the Electron installer works

### v1.0.125

- **Image and video sizes / ratios follow the official specs**: presets, ratios and duration limits are aligned with each platform's docs, and unsupported picks are called out in the dropdown instead of failing at generation time
- **Editor split by node type**: image nodes expose only image parameters and video nodes only video parameters; the new-node menu gains "Image node" and "Video node" entries
- **Right-click image / video nodes**: duplicate, copy, generate another, pick, download, add to group and delete without opening the node first
- **Group drag and scale**: drag a whole group and scale it proportionally, members are laid out in a grid and never clipped even when tiny; align / distribute tidies the canvas in one click
- **Asset library type filter**: browse by image / video / audio instead of paging through everything
- **Storyboard tables with multiple rows and per-row duration**: reference videos are cut per row using the seconds set on that row
- **Agent capability overview**: built-in skills, skill import and the OpenClaw setup guide in one place, so you can see what the current platform supports
- **Fixes**: Agnes video model aliases are normalised to 2.5 / 2.5-flash with official ratios and 1K–4K tiers; Lovart only counts as configured when both Access Key and Secret Key are set; the Run button on generation / video nodes is no longer pushed out of view; Chinese and English strings are back in sync

### v1.0.124

- **New front end (NOVAI 2.0), page by page**: the shell, canvas list, online image / Z-Image, GPT chat and the whole settings modal (general / API / workflow / backup / appearance / about) are rewritten in Vue; the previous UI stays available from the "Legacy UI" entry
- **Rebuilt image color adjust + new "Lossless edit"**: adjust light, color, curves, detail and effects with a draggable before/after divider; lossless edit changes colors and local effects without regenerating
- **New template library**: portraits, e-commerce sets, multi-angle, posters, retouching, storyboards, try-on, white background, social covers, product videos, video relay and more, applied in one click
- **New "Data backup"**: package and export canvases, assets and settings in one click, with size stats and a busy hint; settings also gain a "Memory" panel
- **Provider registry**: each provider's base URL, docs link, aliases and default models now live in one config file, so adding a platform no longer needs code changes; upstream rate limits are retried automatically and errors are explained
- **Fixed Windows update failures**: when the install folder is not writable, the update no longer fails halfway — it tells you to run as administrator or reinstall with the latest installer
- **Fix**: update failures now show the real reason instead of an unreadable file error; the desktop app fully shuts its backend down before restarting to install, so new files are not blocked by files in use
- **Improvement**: new Windows installs default to a user-writable folder, so one-click update works without administrator rights

### v1.0.123

- **New floating toolbar on Smart Canvas image nodes**: portrait & emotion adjustment, panorama, multi-angle, relighting, nine-grid templates, crop (HD / outpainting / redraw / erase / cutout / crop), element editing, layer separation, grid split, annotation, rotate, download and preview — all from one entry point
- **New "HD Upscale"**: free offline local AI upscaling to 2K / 4K; images already close to the target resolution fall back to high-quality resampling instead of forcing the AI model (about 50MB of components download on first use)
- **PSD export with real layers**: a single image is split into subject + background automatically, multiple images become one layer each, and text can be layered automatically
- **Reference videos turn into storyboard tables automatically**: works on both the classic canvas and the Smart Canvas — set "seconds per shot" (1–5, default 3) and the video is cut into one row per shot, with each row using only its own clip as the video reference
- **Canvas Agent plan mode and a rebuilt LLM console**: the Agent now presents a plan card and its impact first and only runs after you confirm, keeps a run history and matches image / video providers to the model you picked; LLM nodes and the prompt console stream as they generate, can be cancelled or retried, abort automatically when no text arrives for a long time, support @-referencing upstream assets, and use unified dropdowns for provider / model / output form
- **Upgraded image and video node parameters**: image generation adds a Background option (auto / keep / transparent), and sizes can be picked from presets, entered manually or matched to the input image's aspect ratio; video nodes add count, aspect ratio, resolution, a sound toggle and a "More parameters" panel, with a status label and elapsed time while generating
- **Consistent UI and a slimmer installer**: outlines and hairlines are gone across the app, popovers use frosted glass, every select caret is the same linear chevron and selection uses a soft tint; the HD upscale runtime and the cutout model are no longer bundled and download on first use instead
- **Fixes**: saving or downloading no longer opens several system dialogs from a single click; JSON containing real newlines from a model no longer breaks table parsing; macOS HD upscale components are made executable after extraction, so no more "Permission denied"

### v1.0.122

- **Fix**: Lovart was missing from existing installs — the platform list only received it when it was empty (fresh installs). After upgrading it shows up directly in API Settings; fill in an Access Key / Secret Key to use it. A platform without keys never appears in generation node dropdowns
- **Improvement**: an auto-added platform can no longer take over your default — a provider without configured keys is no longer picked as the primary provider

### v1.0.121

- **The Smart Canvas AI assistant is now a real Agent**: give it one instruction and the model plans and executes multiple rounds by itself (create nodes, wire connections, run generations, check tasks); every step streams live, canvas edits appear immediately, and the whole run can be rolled back
- **New Lovart design-agent provider**: image / video generation, asset upload and result download, connected with an Access Key / Secret Key
- **Chat mode on LLM nodes**: multi-turn context, selectable personas (default "Prompt Optimizer"), a live thinking process (stopwatch + breathing animation), and a draggable input height that is remembered
- **Unified motion**: dropdowns and select lists use a Glide highlight pill, buttons give state feedback (MorphButton), light/dark aware; API Settings and ComfyUI workflow settings rebuilt to one design language
- **Model selection fixes**: models you picked in canvas settings are no longer cleared or replaced by the first list entry, providers without keys no longer appear in dropdowns; a stale model left on a node after switching platforms is normalized to that platform's remembered model with a visible hint
- **Table / batch generation fixes**: each row references only its own assets, `@图片N` placeholders resolve against the global index, one batch run produces a single result node, groups containing each other no longer hang, and the mouse wheel inside tables no longer zooms the canvas

### v1.0.120

- **Fix: the Electron desktop backend failed to start** — the shell passed `--port` while the backend only accepted a positional argument, so it crashed on launch ("backend failed to load"); it now accepts `--port` / positional / env var, the first-launch wait is extended to 3 minutes, and a startup failure shows the backend log in a dialog
- **Update pipeline fixes**: `prompt_intelligence.py` added to mirror sync / one-click update / packaged resources; the fallback source order now prefers the domestic mirror and deprioritizes known-stale sources; Gitee split-volume sync recognizes the new Electron installer name
- **UI**: the top title area was rebuilt to native macOS specs (traffic lights back in place, 28px bar); side padding unified to 24px across 9 content pages

### v1.0.119

- **Update UI revamp**: the "one-click update" dialog follows the project design language (light/dark aware); when a new version is found a persistent reminder appears in the bottom-right — update now or dismiss it (the same version won't nag again, a newer one will)
- **Fix**: the ModelScope connectivity check in the update dialog pointed at a long-retired address; it now uses the `bllack/NOVAI-releases` model repo

### v1.0.118

- **Windows auto-update fix**: the installer name didn't match `latest.yml` (404 downloads / checksum failures) — Electron installers are now named `NOVAI-Electron-Setup-<version>.exe`; also fixed mirror sync overwriting each other across platforms, which had left some platform update files missing

### v1.0.117

- **Fix: in-app updates on Chinese networks**: the domestic fallback pointed at a ModelScope studio page that only returns HTML (no update files); it now uses the ModelScope model-repo mirror. Unsigned macOS builds no longer attempt auto-install and instead guide a manual download

### v1.0.116

- **Agnes AI Video 2.5 / 2.5 Flash** video models (OpenAI Videos compatible protocol)
- **Protocol tables** gained text/image/video entries for Agnes; `/api/ai/descriptor` now understands the video intent for both
- **Fix**: `gpt-image-1 / 1.5` failed on some relays (the request carried the removed top-level `response_format`); it is no longer sent, and retried once without it when the upstream rejects it
- **Improvement**: generated images show their real pixel size (e.g. `gpt-image-2 · 1254×1254`) so downscaled output isn't mistaken for 2K/4K
- **Fix**: the GPT chat model picker only lists configured platforms (enabled + key + models); built-in ModelScope default chat models are retired and cleaned out of existing configs
- **Fix**: GPT chat could not be scrolled back while streaming (it now follows only when already at the bottom); the header lost its visible border and block

### v1.0.115

- **Pro color grading for image nodes**: a new Adjust mode in the image editor — glfx (WebGL) real-time filters with 5 parameter groups (light / color / curve / detail / effect) plus a draggable RGB curve, and a drag divider to compare against the original; applying creates a new image node and keeps the original
- **Group layout rebuilt**: members fill a grid sized by the group's largest original aspect ratio (full width, slack centered vertically) and reflow live while you resize the group; groups now support custom names (Enter to commit / Esc to revert)
- **One-click group run**: "Run group" on the classic canvas and "Run all" on the smart canvas execute members in order
- **Canvas assistant redesigned**: now follows Spectrum's "AI Chat Card" — the empty state types sample prompts into the composer (click to take over), sunken composer, round attach/send buttons, one-click reset
- **Connection ports rebuilt**: white outlined plus-in-circle that thickens and scales on hover/select; fixes ports being invisible in dark theme and disappearing when hovered
- **Fix**: smart canvas `#world` was positioned relative, shifting coordinate math so nodes rendered in the wrong place or not at all
- **Fix**: smart canvas image preview's **compare with original** entry point was never visible — the button was set to `display:none` by earlier logic and nothing restored it; visibility is now owned by the preview panel (hidden for video / 360 panorama, shown for images, greyed out when there is no upstream to compare)
- **Fix (important)**: historical assets missing after upgrading on Windows — the asset directory was mis-resolved because the installer ships bundled assets into the install folder, silently switching existing users there so every historical image 404'd; existing users now always keep their data directory, and `/assets` falls back to the other folder so assets on either side stay visible

### v1.0.114

- **Historical asset fix**: fixed missing historical images after macOS upgrades — the asset directory was wrongly resolved to a read-only folder inside the app bundle; it now falls back to the real data directory (`~/NOVAI/assets`), restoring canvases and local assets

### v1.0.113

- **Install & launch fix**: fixed installers failing to start — cloud builds were missing the server backend module, causing `No module named 'server'`; the server router module is now included in the repo and rebuilt into the packages, restoring the asset library / local assets / prompt library APIs

### v1.0.112

- **Unified visual refresh**: design tokens converged across 11 feature pages (marvis-shared/theme), unifying colors, spacing, radius and typography
- **GPT chat revamp**: header / input / empty state / model picker (V17-V19) redesigned
- **Configurable thinking effort**: pushed from backend, read directly by frontend
- **Fixes**: explicit size selection no longer overridden by prompt keywords (stable gpt-image-2 resolutions); gemini color-cast rollback and other backend fixes
- **Other**: beam lighting visual effects, centralized frontend icons (shared/icons.js)

### v1.0.112-beta.1 (Beta)

- **Electron desktop client**: bundled Chromium engine; shares port 3000 + the same data directory with the official build (full data interop); tray / native dialogs / window controls
- **Live update progress bar**: per-stage percentage (download / verify / backup / replace) + current file name, with toast notifications for update results
- **Three-repo update channel**: GitHub primary, automatic ModelScope mirror fallback for Chinese networks, Gitee manual-download backup
- **Desktop sidebar flicker fix**: hover-expand no longer toggles rapidly under Chromium

### v1.0.111

- **Local high-quality cutout**: image nodes get "High-Quality Cutout" — RMBG-2.0 local model downloads on demand (349MB, first use only), then offline & free; edge refinement (alpha stretch + erode/feather + background-color decontamination); one-click fallback to online cutout
- **Windows title bar drag fix**: frameless window title bar is draggable again
- **Old model cleanup**: leftover RMBG-1.4 model is removed automatically after upgrade

### v1.0.108

- **Port fix**: restored official port 3000 (accidental test-build 3001 push corrected)
- **Model whitelist**: assets/models/ added to online-update whitelist, face-detection model ships with updates

### v1.0.107

- **Face Blur tool**: select video node → one-click blur all faces in toolbar for better privacy (YuNet detection + Gaussian blur), result auto-added to node
- **Video playback fixes**: play / pause / fullscreen / progress bar fully fixed, desktop matches browser (native controls)
- **Reference media publicization**: cloud upload (Litterbox / temp.sh) preferred, no longer depends on local tunnel

### v1.0.86

- **Cloud build pipeline**: Windows/Mac cloud packaging pipelines, auto build & release
- **Carousel assets in repo**: fixed carousel images missing after updates
- **Frameless window fixes**: Win frameless drag / edge resize / title bar layout fixes
- **Mac signing optimization**: dmg ad-hoc signing prevents "damaged" warning, fixed signature broken by copy
- **Encoding fixes**: fixed Chinese encoding issues in Windows cloud builds

### v1.0.85

- **Smart Canvas fixes**: composer positioning, modal clipping, sidebar offset, title bar layout fixes

### v1.0.84

- **Canvas list enhancement**: cards support up to 4 images in 2×2 grid preview
- **Desktop upgrade**: frameless window + system tray (minimize to tray) + LAN access
- **Desktop icon update**: white-on-black rounded logo
- **Fixes**: 64-bit ctypes WndProc pointer truncation crash, pystray packaging, port conflicts
- **Repo cleanup**: improved .gitignore, excluded drafts/test screenshots/backups

### v1.0.83

- **Frontend performance**: Lucide icon subsetting (90% size reduction), NovaUtils/NovaMedia shared modules, Marvis-style CSS dedup, timer leak fixes, pause rAF rendering when hidden, touch-mouse layout cache optimization
- **Model picker redesign**: two-column layout, hover-linked provider switching, dynamic height
- **GPT chat fixes**: fixed TDZ error causing blank model picker
- **Icon & tooltip fixes**: multiple pages' Lucide icons, asset library status bar leaking English errors
- **Unified settings style**: API settings & workflow settings redesigned to Marvis style, fixed CSS syntax errors
- **New backend tool APIs**: 7 endpoints (storage management, image detection, category prompts, model normalization, RunningHub wallet status)
- **Race condition fixes**: sendChatMessage re-entry guard, setTimeout recursive polling, node.running premature reset
