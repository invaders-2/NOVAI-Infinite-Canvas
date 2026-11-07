# AI 角色库（对齐 TapNow）· 实测规格

> 证据来源：本机 Chrome CDP 连接 `127.0.0.1:9222`，目标 = 用户已登录的 TapNow 网页版
> （`https://app.tapnow.media/canvas/4b597cd9-…`，页面内渲染）。读取方式：CDP `Runtime.evaluate` +
> `getBoundingClientRect`/`getComputedStyle`。结论分「实测」与「推断」。

## 1. 入口（实测）

`素材库` 面板右上角按钮 `AI 角色`（class `flex h-8 … rounded-sm bg-white/10 px-2.5`，81×32），
点击后在画布区域打开整块 `AI角色库` 面板（不是对话框，覆盖画布宽度 1728×869）。

素材库面板本身（实测）：头部 `素材库` + `AI 角色` + `+`；分段 `个人 / 团队`；搜索框；
`收藏`、`主体库`（带 ⓘ）；分组 `文件夹`：`角色 / 场景 / 道具 / 风格 / 音效 / Others`，每行右侧有计数与展开箭头。

## 2. AI 角色库面板（实测）

容器：`relative w-full overflow-hidden flex flex-col`，背景 `rgba(8,8,8,0.72)`，`backdrop-filter: blur(56px)`。

- 头部：高 64（`px-4 pt-4 pb-3`）。标题 `AI角色库`：`text-2xl font-bold text-white/90 tracking-[-0.6px] pl-2`；
  右侧关闭按钮 `size-9 rounded-full`。
- 主体：`flex flex-1 min-h-0 gap-4 px-4 pb-4`。
  - 左栏：`w-[190px] shrink-0 overflow-y-auto py-3 pr-3`，右侧分隔线。
    - 行高 36，`rounded-lg px-2`；选中行 `text-[15px] font-semibold text-white/92`，其余 `text-[15px] font-medium text-white/62`。
    - 项目：`全部角色`（选中）+ `古代历史 / 近代历史 / 当代现实 / 科幻未来 / 架空幻想`，每行右端一个 16×16 `rounded-[4px]` 图标按钮。
  - 右栏：`flex-1 flex flex-col min-w-0 overflow-hidden`
    - 分类行：`text-sm`，当前项 `text-white/80 font-medium`。
    - 筛选条：`flex items-center gap-2 flex-wrap`；每个筛选按钮 `flex items-center gap-1.5 pl-2 pr-2.5 py-1`，左侧 13px 加号图标，文字 12–13px。
      筛选维度（实测 9 个）：`性别 / 年龄段 / 物种 / 体格 / 身高 / 肤色 / 发长 / 发色 / 气质`。
    - 卡片网格：`grid gap-3`，卡宽 152（1468 宽排 8 列）。
      - 卡：`flex flex-col rounded-xl overflow-hidden`，封面 `aspect-[3/4] bg-white/[0.04]` + `img object-cover`。
      - 文字区 `px-2.5 py-2`：名字 `text-sm font-medium text-white/90 leading-snug line-clamp-2`；
        属性行 `text-xs text-white/50 truncate`，格式 `男 · 中年 · 壮硕 · 威严`（性别 · 年龄 · 体格 · 气质）。
    - 网格底部：`加载更多` 按钮。

## 3. 角色详情（实测）

居中弹层：1026×726，`rounded-2xl`（16px），底色 `rgba(14,14,14,0.96)`。

- 头部高 62（`px-5 py-4`，下边线 `white/[0.07]`）：左返回按钮 30×30；
  标题 `text-xl font-semibold text-white/90 tracking-tight`；紧跟副标题 `text-sm text-white/45`，
  文案是「大类 · 文化区域·时代」例如 `古代历史 · 中国·先秦`；右端两个 30×30 图标按钮 + 关闭。
- 左区 `w-[65%] p-4 flex flex-col gap-4`，右侧分隔线 `white/[0.06]`：
  - 三个竖图 `grid grid-cols-3 gap-4`，每格 `aspect-[3/4] rounded-xl`（201×268），图下角标签
    `text-xs text-white/55 text-right`：`角色立绘` / `肖像特写` / `表情九宫格`。
  - 一张横图 `aspect-[43/24] w-full`（634×354），右下角标签 `三视图`。
- 右区 `flex-1 px-5 py-5 gap-6`：
  - `角色属性` `text-[14px] font-medium text-white/50`；随后两列 `dl`（`gap-x-5`），
    `dt text-[14px] text-white/32 py-[5px]`，`dd text-[14px] text-white/78`。
    字段（实测顺序）：`大类 / 文化区域 / 时代 / 性别 / 年龄段 / 物种 / 体格 / 身高 / 肤色 / 发长 / 发色 / 气质 / 场景`。
  - 两段自由文本：`辨识特征`、`着装描述`（标题 `white/50`，正文 `text-[14px] text-white/65 leading-[1.75]`）。
  - 底部主按钮：`应用到画布`，`w-full py-3 rounded-xl text-sm font-semibold text-white/90`。

## 4. NOVAI 落地映射（推断/决策）

TapNow 的卡片是它自己的预设角色库（服务端数据，我们拿不到也不该拿）。NOVAI 用**自己的角色数据**：

- 数据源：`src/canvas/canvas-next/elements.ts` 的 `CanvasElement`（`kind: "character"` 等），
  已有 localStorage 缓存 + 个人资产库同步（`canvas/assetLibrary/character*`）+ `@名字` 引用 + `placeRefs` 放画布。
  详见 `ui/Elements.tsx`（`ElementsSection` / `ElementEditor` / `placeRefs`）。
- 扩展 `CanvasElement`：可选属性 `attrs?: { era?: string; gender?: string; age?: string; species?: string; build?: string; height?: string; skin?: string; hairLen?: string; hairColor?: string; vibe?: string; scene?: string; feature?: string; outfit?: string }`。
  `era` 取值对齐左栏五项；其余字段对齐筛选九维 + 场景/辨识特征/着装描述。
- 卡片属性行：`性别 · 年龄段 · 体格 · 气质`（缺省字段跳过）。
- 详情四张图：`refs[0]`=角色立绘、`refs[1]`=肖像特写、`refs[2]`=表情九宫格、`refs[3]`=三视图，缺图显示占位。
- `应用到画布`：复用 `placeRefs`（把参考图作为图片节点放到画布中心），随后 toast。
- 空库：网格里给「还没有角色」+ 主按钮「从选中的图片新建角色」（复用 `createElementFrom`）。
- 入口：`ui/Library.tsx` 头部 `AI 角色` 按钮当前只是跳到 `folder:role`，改成打开本面板。

## 5. 视觉约束（以 NOVAI 规范为准）

TapNow 用的是 `border-white/[0.08]` 细线，**NOVAI 禁止发丝线**：分隔/层级用间距、半透明软底、字重与文字色变化表达；
弹层底色用磨砂玻璃配方（`--panel`+`backdrop-filter`，见 `AGENTS.md` 设计约束与 `web/src/styles/ds.css`）。
图标保持线性（lucide）。响应式：窄屏左栏收起为顶部横排。
