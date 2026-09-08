# NOVAI OS · Design System / Material Baseline v1.0（已冻结）

> **状态：FROZEN**
> 冻结时间：2026-09-08
> 冻结基线提交：`1d9c0fa8b714d954b3ea2f4740443d1029f1efea`（`feature/novai-os`）
> 冻结依据：Phase 1 五轮视觉迭代全部通过验收（`docs/PHASE1_ACCEPTANCE.md` → PASS）

本文件是 NOVAI OS **唯一**的视觉与材质基线。后续所有 Phase（Desktop / Dock / Window / App / Dialog / Menu / AI Assistant）必须**消费**本基线，不得新建平行体系。

---

## 一、冻结范围（唯一真实来源）

| 关注点 | 唯一来源文件 | 禁止 |
|---|---|---|
| Design Tokens | `static/css/os-tokens.css` | 另建 token 文件 / 另加 `--os2-*`、`--phase2-*` 平行前缀 |
| Glass Material | `static/css/os-glass.css` | 另写材质引擎 / 另造 glass 层结构 / 组件内私自写 `backdrop-filter` |
| Material Tier | `os-glass.css` 的 `.os-glass--{ultraThin,thin,regular,thick}` | 新增第 5 档 / 覆盖 4 档数值 |
| Motion | `static/css/os-motion.css` | 自定义时长 / 自定义 bounce 曲线 |
| Icon Style | `static/os/icons/osIcon.js` | 引入第二套图标库 / 实心 / 彩色 / Emoji |
| Theme System | `static/os/theme/themeRuntime.js` + `themePersistence.js` | 另建主题状态 / 另读 `localStorage` 主题键 |
| 组件 | `static/os/ui/glass*.js` | 组件内硬编码色值 / 硬编码 blur / 硬编码 border |

**扩展规则**：需要新 Token → 追加进 `os-tokens.css` 的既有作用域；需要新图标 → 追加进 `osIcon.js` 的 `PATHS`；需要新组件 → 放在 `static/os/ui/`，复用 `glassSurface.js`。**不新建平行文件。**

---

## 二、主题

- 三态：`light` / `dark` / `system`
- 载体：`<html data-os-theme="...">`；`system` 由 `@media (prefers-color-scheme)` 解析，无需 JS 介入视觉
- 持久化：`localStorage` 键 `novai-os:theme`（由 `themePersistence.js` 独占读写）
- 降级开关：`data-os-reduce-motion="true"` / `data-os-reduce-transparency="true"`（`<html>` 属性）
- **默认材质已等于此前 Reduce Transparency = ON 的方向**；RT 打开只是进一步去掉残余 haze

---

## 三、背景

- 纯色，由 `--bg-material` 控制：Light `#f5f5f7` / Dark `#0f1012`
- **禁止**：彩色渐变、蓝粉渐变、环境彩色背景、大面积 glow、背景氛围光
- 背景只承载材质，不抢 UI 视觉

---

## 四、色彩主体

- **黑 / 白 / 中性灰 ≥ 95%，为绝对主体**
- 青柠 `#CDFF00`（`--brand-accent`）**仅**允许：
  1. Send Button
  2. AI Orb 光晕
  3. AI Beam
  4. AI Thinking 光流
  5. AI Processing 能量轨迹
  6. 极少量品牌动画
- **禁止**青柠用于：普通 CTA、Menu、Tab、Hover、Focus、Selection、Card、Panel、Dialog、Notification、Dock active、Window active、页面标题、普通状态点

---

## 五、Low-haze Liquid Material（默认材质）

默认材质 = **低雾化、低 haze、弱 blur、少背景穿透、较清晰、接近半实**。

| 参数 | 默认值 |
|---|---|
| blur 4 档 | `4px / 8px / 12px / 18px`（ultraThin / thin / regular / thick） |
| saturate | `104% / 108% / 112% / 116%` |
| refraction opacity | `0.30` |
| sheen 强度 | `0.26` |
| refraction strength | `0.015 / 0.02 / 0.03 / 0.04` |
| ambient（内部受光） | `0.18 / 0.24 / 0.30 / 0.38` |

**4 档差异 = fill 实度（明度）+ material tint + 内部受光 + blur + 阴影厚度**，不是"只有 blur 不同"。

### Material Tier 明度分级 Token
`--glass-fill-ultraThin / --glass-fill-thin / --glass-fill-regular / --glass-fill-thick`

- Light（白叠加，相对 `#f5f5f7`）：`0.55 / 0.70 / 0.84 / 0.96` → 约 `+2% / +2.9% / +3.5% / +4%` 明度差
- Dark（中性提亮，相对 `#0f1012`）：`0.05 / 0.075 / 0.10 / 0.13`

目标：**看得见这块材质，但看不到边框。**

---

## 六、边框（硬性规则）

**0 可见 border、0 hairline、0 outline、0 focus ring、0 selection ring、0 container stroke。**

覆盖：Surface / Active / Selection / Focus / Card / Panel / Dialog / Menu / Dock / Window / Input / IconButton / 图标容器。

判定标准：**即使技术上不是 border，只要用户视觉上能明显看见"一圈线"，即判不合格。**

### 状态改用材质差表达
Surface / Active / Selection / Focus 必须通过：明度变化、材质厚度、opacity、surface tint、内部受光、极轻 ambient shadow、微弱 depth 表达。

Token：`--surface-active` / `--selection-neutral` / `--focus-neutral` / `--interactive-secondary`

---

## 七、阴影

- 系统 Surface 阴影：**约 3%～5% alpha**
- Light：`0.03 / 0.035 / 0.045 / 0.05`（xs / sm / md / lg）
- Dark：`0.24 / 0.30 / 0.36 / 0.42`
- 玻璃 stack 最高 alpha **≤ 0.05**
- **禁止**：厚重 drop shadow、黑色大面积投影、卡片悬空感过强、Dialog 下方明显黑块

**实现约束**：阴影必须挂在根 `.os-glass` 上。挂在内部 `__shadow` 层会被根的 `overflow: hidden` 裁掉（元素自身 box-shadow 不受自身 overflow 影响）。

---

## 八、Input 规范

- 无 border、无 outline、无 focus ring、**无阴影（inset 与外阴影全部为 0）**、无重 blur、无雾蒙蒙叠层
- 状态只靠 `--input-fill` / `--input-fill-hover` / `--input-fill-focus` 的表面明度差
- 默认 tier：`ultraThin`（4px blur）
- 视觉目标：**嵌入材质中的柔和输入区域**，不是漂浮卡片

---

## 九、Button 规范

- Primary：Light 黑底白字 / Dark 白底黑字（走 `--interactive-primary`）
- Secondary / Ghost：黑白灰中性材质
- Danger：语义红仅用于文字 / 必要状态
- 全部：无 border、无 outline、无发丝线
- Hover：轻微抬起 + `scale 1.01～1.02` + lift `-1～-2px`
- Active：`scale 0.985`
- **不做明显 bounce**（曲线走 `--ease-material`）

---

## 十、Icon System

- 风格：**Linear / Outline / Stroke**（禁止实心、粗黑、Emoji、卡通、彩色、跨库混搭）
- stroke 规范：`12→1.2 / 14→1.3 / 16→1.4 / 18→1.5 / 20→1.6 / 24→1.7 / 32+→1.8`
- 尺寸体系：`12 / 14 / 16 / 18 / 20 / 24 / 32 / 48 / 64`（禁止 17 / 21 / 23 / 27 这类尺寸）
- 统一：`fill="none"`、`stroke-linecap="round"`、`stroke-linejoin="round"`、`aria-hidden`
- 颜色 Token：`--icon-primary / --icon-secondary / --icon-tertiary / --icon-disabled / --icon-on-brand`
- 唯一入口：`createIcon({ name, size, color, strokeWidth, className })`
- AI Assistant = **菱形外框 + 中心小圆**（极简几何线性 symbol，Idle 中性）
- IconButton（`glassIconButton.js`）：尺寸 28/32/40/48，**0 border / 0 ring / 0 container**

---

## 十一、字体

- 系统 UI 一律 `--font-system`（`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", …`）
- **Space Grotesk（`--font-display`）仅用于品牌 / Welcome / 官网等非系统 UI 场景**，不进入 OS 组件

---

## 十二、Motion

- 时长档位：`100ms / 160ms / 240ms / 360ms`
- 曲线：
  - `--ease-material: cubic-bezier(.2, 0, .2, 1)` — **默认**，无 overshoot，交互态一律走它
  - `--ease-standard` / `--ease-emphasized` / `--ease-decelerate`
  - `--ease-spring` — **仅** AI Beam / Thinking 等流体光效例外
- 禁止：大幅弹跳、夸张 bounce、持续闪烁、无意义 rotate

---

## 十三、消费清单（后续 Phase 必须遵守）

| Phase 2+ 组件 | 必须消费的冻结资产 |
|---|---|
| Desktop / Wallpaper | `--bg-material`（纯色，禁渐变） |
| Window | `glassSurface.js` tier `regular` / `thick` |
| Dock | `glassSurface.js` tier `thick` + `createGlassIconButton`（尺寸 32/48） |
| App Icon | `createIcon` 尺寸 48 / 64 |
| Dialog | `glassDialog.js` |
| Menu / Context Menu | `glassContextMenu.js` |
| Notification | `glassNotification.js` |
| Tooltip | `glassTooltip.js` |
| AI Assistant | `createIcon({ name: "ai" })` + `--brand-accent` 仅外围光效 |
| Send | 青柠 `#CDFF00` + `createIcon({ name: "send", size: 20, color: "var(--icon-on-brand)" })` |

**禁止**：任何 Phase 自行创建第二套 Design Tokens、Glass Material、Icon Style、Theme System 或平行视觉体系。

---

## 十四、验收命令

```bash
cd /Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main
NOVAI_PORT=3100 /usr/bin/python3 main.py

# 验收
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/os-preview   # 200
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/             # 200（Legacy）
curl -s --noproxy '*' http://127.0.0.1:3100/api/apps                                       # {"apps":[]}
```
