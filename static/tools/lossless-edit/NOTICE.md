# 无损改图（NOVAI 本地内置副本）说明 / NOTICE

## 来源

- 上游仓库：<https://github.com/Apai-Ji/ai-web-tools>
  - 页面内许可头标注的仓库地址为 <https://github.com/perfect12369874/ai-web-tools>（同一项目，抓取时两处地址都存在）。
- 上游目录：`eraser`
- 作者：陶醉（[taozui.name](https://taozui.name)）
- 上游版本：`v260923b`（页面右下角版本号，日期即版本号，2026-09-23）
- 抓取日期：2026-10-09
- 抓取方式：upstream main 分支原文，按 git blob 哈希逐字节校验下载：

  | 文件 | 字节数 | git blob |
  | --- | --- | --- |
  | `index.html` | 88622 | `ebf2cc0c1cf9371207912ba07d2637ada30486bb` |
  | `ag-psd.js` | 828929 | `0d348bac1c6f6043317cef9096d616b2951fea35` |

## 本目录文件

- `index.html` —— 上游单文件主程序（全部逻辑内联；含下述 NOVAI 桥接改动）
- `vendor/ag-psd.js` —— ag-psd v31.0.2，仅导出 PSD 时按需加载
- `LICENSE.md` —— 上游 CC BY-NC-SA 4.0 许可全文
- `THIRD_PARTY_NOTICES.md` —— 上游第三方组件声明（ag-psd，MIT）
- `README-upstream.md` —— 上游 `README.md` 原样改名（避免与项目根 README 混淆）

## 许可与分发

- **本副本整体（含 NOVAI 的桥接修改）仍按 CC BY-NC-SA 4.0 分发**：<https://creativecommons.org/licenses/by-nc-sa/4.0/>
  - 必须署名原作者「陶醉 (taozui.name)」并保留来源与许可链接；
  - 不得用于商业用途；
  - 衍生作品必须以相同协议（CC BY-NC-SA 4.0）开源。
  - 完整法律文本见同目录 `LICENSE.md`。
- **`vendor/ag-psd.js` 不受 CC 协议约束，仍为 MIT**（Copyright (c) 2016 Agamnentzar），见 `THIRD_PARTY_NOTICES.md`。
- NOVAI 是开源、非商用项目，因此允许在上述非商业条款下内置本工具。

## NOVAI 做的桥接修改（逐条）

只改动了 `index.html`：桥接逻辑集中在文件末尾的脚本区；另在文件末尾的样式区追加了「浅色主题」与「嵌入模式右侧栏」两块；并按第 7 条移除一处失效链接、按第 11–14 条移除界面署名/版本号、去掉工具页自身背景、对齐右侧栏底色、修复笔刷可用性。默认深色变量未改，独立打开仍是原来的底部栏布局；上游许可头与 `LICENSE.md`/`NOTICE.md`/`README-upstream.md` 中的作者署名、来源与协议声明一律保留。当前本地 `index.html`（含全部改动）为 97320 字节，上游原文为 88622 字节。

1. **抽出 `loadFromUrls(origUrl, aiUrl)` / `novaiFileFromUrl(url, name)`**：把上游原有的 `?orig=&ai=` 自动载入逻辑从内联 IIFE 中抽出为具名函数，逻辑本身未改，供 URL 参数载入、`prefill` 与 `pick-result` 共用同一条「URL → File → `setOriginal`/`setAi`」通路。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host`
2. **页面加载后广播 ready**：`parent.postMessage({ source: 'novai-lossless-edit', type: 'ready' }, location.origin)`。独立打开时 `parent === window`，非 http origin 下 `postMessage` 可能抛错，已用 `try/catch` 静默。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit`
3. **监听宿主要求结果的请求**：收到 `{ source: 'novai-lossless-edit-host', type: 'request-result' }` 时，先等待 `prefill`/URL 参数的载入完成，再**复用页面里「下载合成图」已有的导出通路 `exportPngBlob()`**（未新写导出逻辑）生成当前合成的原尺寸 PNG，用 `FileReader` 转成 dataURL 后回发：
   `parent.postMessage({ source: 'novai-lossless-edit', type: 'result', dataUrl, width, height }, location.origin)`；
   出错则回 `{ source: 'novai-lossless-edit', type: 'error', message }`。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host` / `// NOVAI 内置改动 + 协议标记: novai-lossless-edit`
4. **支持 URL 参数**：`?embed=1` 进入嵌入模式（`html.novai-embed` 类 + `window.__novaiEmbed = true` 标记，右侧栏布局见第 8 条）；`&orig=<url>` 必填、`&ai=<url>` 可选，复用上游原有的 `?orig=&ai=` 自动载入逻辑填入素材槽，`ai` 缺省时 AI 槽留空；`&theme=dark|light` 设定初始主题（之后可被 `theme` 消息覆盖）。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host`
5. **兼容父窗口 prefill 消息**：收到 `{ source: 'novai-lossless-edit-host', type: 'prefill', orig, ai }` 时走上面同一套 `novaiPrefill()` → `loadFromUrls()` 载入逻辑。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host`
6. **协议标记注释**：除第 7 条（纯删除，无注释）外，其余每处修改旁都有一行 `// NOVAI 内置改动 + 协议标记: <标记>`，标记字符串为 `novai-lossless-edit` 与 `novai-lossless-edit-host`，便于日后同步上游。
7. **移除失效链接**：删掉 `#links` 里指向 `无损改图-本地版.zip` 的「本地版」`<a>`（该压缩包未随源码提供，内嵌后点击必 404）；当时保留的 `#credit`（© 陶醉）与 `#ver`（版本号 + 源码仓库链接）两项界面署名，已在第 11 条按宿主产品要求移除——署名与来源链接改由本文件、`LICENSE.md` 与源文件顶部注释履行。
8. **嵌入模式右侧栏（布局重排）**：仅在 `html.novai-embed` 作用域内，把 `#app` 改为横向排布——`#stage` 占满剩余空间，`#bar` 变成右侧固定宽度（324px，对齐 NOVAI「专业调色」右边栏）、可滚动的一列控制栏，承载素材槽与 `#tools` 全部控件；独立打开（无 `embed`）仍是原来的底部栏。所有元素 id / 类名 / 事件绑定 / 快捷键均未改动。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit`
9. **浅色主题**：新增 `html.novai-light` 变量集（参照 NOVAI 浅色 token：`--bg:#f5f5f5`、面板白、文字 `#0a0a0a`、强调色 `#171717`），只覆盖浅色类；默认深色变量与独立打开的布局未改（工具页自身背景的移除见第 12 条）。`?theme=light|dark` 参数或 `{ type:'theme', theme }` 消息即时切换，无需刷新。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit`
10. **从画布挑图（pick 桥接）**：嵌入模式下点击 `#sOrig` / `#sAi`（`<label for>`）与空状态 `.dz` 拖放区时 `preventDefault()` 拦住原生文件选择，改发 `{ type:'pick-request', slot }`；系统文件框、拖放与粘贴通路在独立模式下行为不变。收到 `{ type:'pick-result', slot, url, name }` 时复用第 1 条的「URL → File → `setOriginal`/`setAi`」通路载入并刷新缩略图与按钮状态；`{ type:'pick-cancel', slot }` 不处理。嵌入模式下素材槽/拖放区 tooltip 改为「点击从画布挑选」。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit` / `// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host`

11. **移除界面署名与版本号**：按宿主产品要求删掉 `#bar` 里的 `#credit`（「© 陶醉」，链到 taozui.name）、`#links` 容器与 `#ver`（`v260923b`，链到源码仓库），以及只服务于它们的 CSS；`#bar` 其余结构不变。**仓库内的署名与来源链接一律保留**：源文件顶部注释、`LICENSE.md`、本文件、`README-upstream.md` 中的作者「陶醉 (taozui.name)」、来源仓库与 CC BY-NC-SA 4.0 链接均未改动，署名与来源链接义务由它们履行。
   - 标记：`/* NOVAI 内置改动 + 协议标记: novai-lossless-edit */`（样式区）
12. **去掉工具页自身背景**：`main` 原有 22px 点阵网格 + 径向渐变（深色 `#101013`→`--stage`，浅色见 `html.novai-light main` 的白色版），现两套都改为透明，不再有点阵或渐变；嵌入时 `html.novai-embed` 与 `html.novai-embed body` 也设为透明，让宿主的弹窗底色透上来。只动背景，`#view` 画布、按钮、滑块等样式未动。
   - 标记：`/* NOVAI 内置改动 + 协议标记: novai-lossless-edit */`（样式区）
13. **右侧编辑栏对齐「调色」右栏**：嵌入模式下 `#bar` 改为无独立背景、无网格、无描边分隔线、无投影（`background:transparent; box-shadow:none; border-top:0`），底色与「调色」右栏一致（透明，承托在宿主弹窗面板底上）；`#tools>.sep` 在嵌入时本就隐藏，分隔靠间距/留白。所有控件、id、类名、事件绑定、快捷键均未改动；独立打开（无 `embed`）仍是原来的底部栏观感。
   - 标记：`/* NOVAI 内置改动 + 协议标记: novai-lossless-edit */`（样式区）
14. **笔刷可用性修复（两条成因）**：
   - 成因①（静默未就绪窗口）：原 `#busy` 遮罩只在 `setupAi()` 的自动对齐阶段出现，图片解码与 URL 拉取期间已经隐藏，而画笔/光标由 `ready() = !!(S.origBmp && S.aiBmp)` 把关，于是「图还没好」的窗口里拖动画笔既无反应也无提示。现新增 `busyState`（`load` 计数 + `align` 标记）与 `syncBusy()`：`setOriginal`/`setAi`/`novaiFileFromUrl`/`loadFromUrls` 全程保持可见的「正在载入图片…」，自动对齐期间显示「正在自动对齐和校色…」；失败路径在 `catch/finally` 里收起遮罩并 toast 提示，不会永久卡住遮罩。
   - 成因②（空状态把整条右栏藏掉）：上游 `#app:has(#empty:not([hidden])) #bar .slots, … #tools{display:none}` 在「只放了一张图」时藏掉素材槽与工具栏；嵌入作用域内新增同名覆盖使其 `display:flex`，右侧栏与工具始终存在（此修复同时消除「右栏只剩一片空白」）。
   - 另外 `refreshButtons()` 在 `!ready()` 时给 `#tools` 内所有按钮与滑块加上 `disabled`（不再「可点但无效」），就绪后自动恢复。
   - 标记：`// NOVAI 内置改动 + 协议标记: novai-lossless-edit`
15. **移除界面「快捷键」入口（纯删除，无新增注释）**：删掉右下角「快捷键」小胶囊 `#keys` 与点它弹出的快捷键列表 `#keysPanel`，以及只服务它们的 CSS 与 JS（`keysToggle` 及其两个监听、`#keys` 的 hidden 赋值、触屏下的「双指缩放、拖动」文案改写、`Escape` 关闭弹层的分支）。**脚本区真正的键盘快捷键功能原样保留**：⌘Z/⇧⌘Z 撤销重做、X 切修改/还原、C 重做、`[`/`]` 改画笔大小、1 对比、空格平移等；与 `#keys` 共用选择器的 `#chip`（尺寸/缩放状态胶囊）保留。`#bClear` 的 tooltip 仍写作「快捷键 C」，它描述的是仍然生效的快捷键。

16. **调整初始状态口径（只传 `ai` 时右槽预填、左槽留空）**：按宿主新约定，进入时只传被点击的那张图（`ai`），右侧「修改图」槽预填、左侧「原图」槽留空，换图重进不得残留上一次的图。为此：
    - 深链载入条件由「必须给 `orig`」放宽为「`orig` 或 `ai` 任一存在」，且 `location.protocol` 为 http(s)；只给 `ai` 时左槽保持空，`?orig=` 单独使用（调试/独立打开）照旧可用。
    - `loadFromUrls(origUrl, aiUrl, reset)` / `novaiPrefill(origUrl, aiUrl, reset)` 新增 `reset` 参数：`{ source:'novai-lossless-edit-host', type:'prefill', ai, orig, reset:true }` 先按页面已有的 `clearSlot()` 移除逻辑清空本次未提供的槽（未给 `orig` 清左槽、未给 `ai` 清右槽，缩略图/按钮/自动分析状态一并复位），再载入提供的槽；带 `reset:true` 且 `orig`/`ai` 都没有时两侧都清空，`ready()` 自然为 false，界面回到既有空状态（未新增文案）。
    - 不带 `reset` 的 `prefill` 仍是「只补不清」，向后兼容。
    - 桥接协议其余部分、槽点击从画布挑图、拖放/粘贴/本地上传、右侧栏布局、笔刷与快捷键、许可头与仓库署名均未改动。
    - 标记：沿用该区域既有的 `// NOVAI 内置改动 + 协议标记: novai-lossless-edit-host`

17. **按宿主设计语言替换界面颜色（只改颜色，不改结构/尺寸/交互）**：把工具页（`index.html` 样式区 + logo SVG）的颜色全部对齐宿主 NOVAI 的设计 token，权威来源为 `static/css/marvis-shared.css`（浅色 `:root`、深色 `html.theme-dark`）。深色 `:root` 变量按角色重映射：`--bg→--bg`、`--stage→--stage-bg`、`--panel→--surface`、`--raise→--surface-2`、`--raise-2→--elevated`、`--line/--line-2→--border/--border-2`、`--text/--muted/--faint→--text/--text-2/--text-3`、`--accent→--accent`（深色为中性近白 `#fafafa`，不再是蓝色 `#6b8cff`）、`--accent-soft→--accent-subtle`、`--danger/--ok/--warn→--danger/--success/--warning`、`--pop→--shadow-lg`；`html.novai-light` 同样按角色对应浅色 token。硬编码字面量一并换值：主按钮（accent / accent-hover / accent-pressed / accent-text）、`button.on`（accent-subtle / accent / text-on-accent）、拖放区默认与悬停渐变、`#bar` 渐变与投影、`#hint`/`#toast`/`#busy`/`#chip`/`#adv` 浮层底色、滑块，以及 logo SVG 的 `fill`/`stroke`（改用 `currentColor` + `--text-3` 值跟随主题）。尺寸、间距、圆角、字体、层级、动画时长、文案、DOM 结构、事件绑定与内联脚本一律未改（内联脚本 `node --check` 通过）。功能色（5 个候选标注色、蒙版红、图片占位深底）按原样保留。
   - 映射来源：`static/css/marvis-shared.css`
   - 标记：`/* NOVAI 内置改动 + 协议标记: novai-lossless-edit */`（样式区）

### 桥接协议速查（供宿主对接）

| 方向 | 消息 |
| --- | --- |
| 子 → 父 | `{ source: 'novai-lossless-edit', type: 'ready' }` |
| 子 → 父 | `{ source: 'novai-lossless-edit', type: 'result', dataUrl, width, height }` |
| 子 → 父 | `{ source: 'novai-lossless-edit', type: 'error', message }` |
| 子 → 父 | `{ source: 'novai-lossless-edit', type: 'pick-request', slot: 'orig' \| 'ai' }` |
| 父 → 子 | `{ source: 'novai-lossless-edit-host', type: 'prefill', orig, ai, reset }`（`orig`/`ai` 为同源图片 URL，`ai` 可单独给；`reset:true` 先清空本次未提供的槽） |
| 父 → 子 | `{ source: 'novai-lossless-edit-host', type: 'request-result' }` |
| 父 → 子 | `{ source: 'novai-lossless-edit-host', type: 'theme', theme: 'dark' \| 'light' }` |
| 父 → 子 | `{ source: 'novai-lossless-edit-host', type: 'pick-result', slot: 'orig' \| 'ai', url, name }` |
| 父 → 子 | `{ source: 'novai-lossless-edit-host', type: 'pick-cancel', slot: 'orig' \| 'ai' }` |

URL 参数：`?embed=1&orig=<url>&ai=<url>&theme=dark|light`（`orig`/`ai` 任一即可，只给 `ai` 时左槽留空）；消息目标一律 `location.origin`。

## 无外部依赖

`index.html` 及本目录所有资源均本地化，不含任何外部 CDN 引用：ag-psd 由同目录 `vendor/ag-psd.js` 按需加载，字体使用系统字体栈。
