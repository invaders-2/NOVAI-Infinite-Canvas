---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 61f46ed86177e3450f5dac6d16b8e4ee_4351f886ab3511f1ac01525400e6dd8f
    ReservedCode1: sytkem5JqGW9KAjPBk0Die76M/XBwa/RzNtJEXtO0OTtzFxK+nUKTC5opLgJV1FR7dsdexYJTEsbd5qT4CvJa/VPQfXW+ciSeX1XRzhpi4gaQYIW+P2OSSNpi0vwK9Y3CjqMRaFlUoIH16+iBaQ5No/ESCYNNTS1jdFVKr02hg5lBIp823QRaVwPulw=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 61f46ed86177e3450f5dac6d16b8e4ee_4351f886ab3511f1ac01525400e6dd8f
    ReservedCode2: sytkem5JqGW9KAjPBk0Die76M/XBwa/RzNtJEXtO0OTtzFxK+nUKTC5opLgJV1FR7dsdexYJTEsbd5qT4CvJa/VPQfXW+ciSeX1XRzhpi4gaQYIW+P2OSSNpi0vwK9Y3CjqMRaFlUoIH16+iBaQ5No/ESCYNNTS1jdFVKr02hg5lBIp823QRaVwPulw=
---



# 图片节点「专业调色」功能设计（定稿）

> 状态：已定稿，待落地实现
> 日期：2026-09-08
> 适用范围：NOVAI-Infinite-Canvas 传统画布（canvas.html / canvas.js）与智能画布（smart-canvas.html / smart-canvas.js）双端同步
> 背景记录：docs/UI_PROGRESS.md（前端界面续接记录）

## 1. 入口

双击图片节点弹出编辑器弹窗 `imageEditModal`，顶部模式条现有模式：预览 / 裁剪 / 扩展 / 遮罩 / 画笔 / 缩放 / 宫格切分（白名单 `['preview','crop','outpaint','mask','brush','resize','grid']`）。

新增「调色」模式（模式键 `adjust`），位于宫格切分之后：
- 模式白名单加入 `adjust`
- 工具栏节点 id：`imageAdjustTools`
- 模式按钮沿用 `data-image-edit-mode` 机制

`applyImageEdit()` 按 `imageEditMode` 分发，新增 `applyImageAdjust()` 分支。调色为本地 canvas 逐像素处理（降采样约 1200px 长边 + requestAnimationFrame 节流），不请求后端；最终应用产物沿用 `uploadCroppedBlob` → 生成新图片节点、原图保留（复用 `addGeneratedImageNode` 机制，不替换原图）。

## 2. 功能结构

### 2.1 预设行（9 个初版）
原图 / 明亮通透 / 暖阳日系 / 冷调电影感 / 青橙对比 / 复古胶片 / 黑白经典 / 柔光梦幻 / 鲜亮美食

点击预设填充下方参数并可继续微调。

### 2.2 参数组
| 组 | 参数 |
|---|---|
| 光线 | 曝光 / 对比度 / 高光 / 阴影 / 白色 / 黑色 |
| 颜色 | 色温 / 色调 / 自然饱和度 / 饱和度 |
| 细节 | 清晰度 / 锐化 / 降噪 |
| 效果 | 晕影 / 颗粒 / 黑白强度 / 柔光 / 辉光 |

- 全部滑块实时预览（本地像素处理，不请求后端）
- 「按住查看原图」对比
- 「重置」一键归零

### 2.3 自动校色
自动白平衡 + 自动色阶，一键拉正偏色/发灰图；参数联动可继续微调。

### 2.4 AI 细节增强（不依赖 ComfyUI）
- 独立小下拉选择通道：ModelScope（FLUX.2-Klein）/ RunningHub（gpt-image-2 系）/ 火山引擎（doubao 系）
- 超分输出尺寸：原始尺寸 / 2x 2048 / 4x 4096
- 交互：当前图作参考图 + 内置细节增强提示词 → 走所选通道图生图 → 加载态可取消 → 结果生成新图片节点（原图保留）
- 尽量复用现有端点；个别通道缺统一封装时后端补轻量路由（只接现有平台，不新增模型供应商）

## 3. 产物约定

调色应用 / 自动校色 / AI 细节增强 的结果均生成新图片节点、原图保留。

## 4. 涉及文件

- static/canvas.html、static/smart-canvas.html（模式按钮 + imageAdjustTools 工具条 + 预设行 + AI 增强区）
- static/js/canvas.js、static/js/smart-canvas.js（adjust 模式白名单 / UI 切换 / 滑块状态 / 像素算法 / applyImageEdit 分支 / 自动校色 / AI 增强调用）
- 共享 CSS（调色样式）
- main.py（如个别通道需统一增强路由）

## 5. 备注

- 项目已有 AI 增强/超分链路（ComfyUI enhance/upscale）本次不使用；AI 细节增强通道面板可切换，不新增模型平台。
- 新文案沿用现有中英 i18n 风格。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*

## 6. 2026-10-07 升级：专业调色面板（已实现）

- 引擎：`static/js/image-adjust-engine.js`（WebGL1 自写着色器，替代 glfx；glfx 已不再加载）。预览降采样 ≤1600px，导出按原图全分辨率跑同一套着色器。
- 面板：`static/js/image-adjust-editor.js`（对外接口不变）+ `static/css/image-adjust.css`（iaj- 前缀，两个画布共用）。
- 功能：实时 RGB 直方图（剪切提示、悬停取色）· 自动校色 · 撤销/重做（⌘Z / ⇧⌘Z）· 复制/粘贴参数 · 内置 9 个预设（缩略图用当前图实时生成，强度可调）+「我的预设」（localStorage）
  · 基础（白平衡：原照/自动/自定 + 吸管；曝光/对比度/高光/阴影/白色/黑色）· 质感（纹理/清晰度/去朦胧/自然饱和度/饱和度）
  · 曲线（亮度 + 红/绿/蓝，单调三次插值，点击加点/拖出删除/双击复位，曲线预设）· 颜色混合 HSL（8 色 × 色相/饱和度/明度，图上拖动定向调整）
  · 色彩分级（阴影/中间调/高光/全局色轮 + 混合/平衡）· 细节（锐化 数量/半径/细节/蒙版，降噪 明亮度/颜色）· 效果（晕影/颗粒/柔光/辉光）
  · 每组可折叠、单独隐藏、单独重置；对比：单图 / 拖动对比 / 并排，按住按钮或 \ 键看原图。
- 再次编辑：结果节点保存 `adjust = {v:2, source:{url,name}, params}`（智能画布存在 images[i].adjust，传统画布存在 node.adjust），再进调色会从原图 + 这组参数继续。
- 视觉：黑白灰；白平衡 / HSL / 色轮滑轨用低饱和彩色（用户确认的例外）。
