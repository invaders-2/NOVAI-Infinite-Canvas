#!/usr/bin/env node
'use strict';
/**
 * 深度动作捕捉的本地模型改为「按需下载」（2.0.08 安装版报缺少文件的修复）。
 *
 * 契约（照抠图那套 RMBG 下载链路）：
 * 1. 后端适配器：depthModelStatus / depthModelDownload / depthModelCancel 打最新的
 *    /api/video/depth-model/* 三条路由，字段与 MattingModelStatus 一致；400 报错能翻译成「去下载模型」。
 * 2. GenPanel 的 runDepthCapture：点之前先查 status —— 没下载就弹「本地深度模型」，下完自动接着提取；
 *    runtime_ready=false（少了 onnxruntime）直接提示更新安装包，不弹下载（下了也没用）。
 * 3. 弹窗只用现成的磨砂弹窗（modal.mm + .mm-* 样式）：零边框零发丝线、不新造一套皮肤。
 * 4. 构建产物 static/novai-canvas 已跟着重建（否则老用户仍吃旧 canvas.js）。
 * 只读源码与构建产物，不联网、不花额度。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui/';
const genPanel = read(ui + 'GenPanel.tsx');
const editorsCss = read(ui + 'editors/editors.css');
const types = read('novai-canvas-ui/src/canvas/canvas-next/backend/types.ts');
const novai = read('novai-canvas-ui/src/novaiBackend.ts');
const built = read('static/novai-canvas/canvas.js');

/* ---------- 1. 类型与后端接线 ---------- */
assert(/export type DepthModelStatus = \{[^}]*downloaded: boolean/.test(types), 'DepthModelStatus 类型存在（downloaded 必填）');
for (const key of ['downloading', 'verifying', 'progress', 'downloaded_mb', 'total_mb', 'speed_mbps',
  'eta_seconds', 'attempt', 'retrying', 'hint', 'cancelled', 'error', 'load_error', 'runtime_ready']) {
  assert(new RegExp('\\b' + key + '\\??:').test(types.slice(types.indexOf('DepthModelStatus'), types.indexOf('UpscaleRuntimeStatus'))),
    'DepthModelStatus 带 ' + key);
}
assert(types.includes('depthModelStatus?(): Promise<DepthModelStatus>'), 'CanvasBackend 有 depthModelStatus');
assert(types.includes('depthModelDownload?()'), 'CanvasBackend 有 depthModelDownload');
assert(types.includes('depthModelCancel?()'), 'CanvasBackend 有 depthModelCancel');

assert(novai.includes('"/api/video/depth-model/status"'), 'status 打 /api/video/depth-model/status');
assert(novai.includes('"/api/video/depth-model/download"'), 'download 打 /api/video/depth-model/download');
assert(novai.includes('"/api/video/depth-model/cancel"'), 'cancel 打 /api/video/depth-model/cancel');
for (const field of ['downloaded_mb', 'total_mb', 'speed_mbps', 'eta_seconds', 'attempt', 'retrying',
  'cancelled', 'load_error', 'runtime_ready']) {
  assert(novai.includes('data?.' + field), '适配器把 ' + field + ' 读出来');
}
// 抠图那套错误映射的形状：400 且「未下载」→ 专门错误码，文案要能落到「去下载模型」
assert(novai.includes('const depthError = (error: unknown): Error'), '深度捕捉有自己的错误映射（照 mattingError）');
assert(/status === "400" && \/深度模型未下载\|未下载\//.test(novai), '400 且未下载 → 单独识别');
assert(novai.includes('DEPTH_MODEL_MISSING'), '错误码 DEPTH_MODEL_MISSING');
assert(novai.includes('onnxruntime'), '错误映射里区分 onnxruntime 缺失');
assert(/try \{[\s\S]{0,160}request\("\/api\/video\/depth-capture"/.test(novai), 'depthCapture 请求包了 try（否则错误码拿不到）');
assert(novai.includes('throw depthError(error)'), 'depthCapture 的失败走 depthError 翻译');

/* ---------- 2. runDepthCapture：先查状态、没下先弹窗 ---------- */
const runStart = genPanel.indexOf('async function runDepthCapture');
const runEnd = genPanel.indexOf('const depthEtaText');
assert(runStart > 0 && runEnd > runStart, 'runDepthCapture 与会话弹窗都在 GenPanel');
const runFn = genPanel.slice(runStart, runEnd);
assert(runFn.indexOf('be.depthModelStatus') < runFn.indexOf('be.depthCapture(src)'), '点下去先查模型状态，再跑深度捕捉');
assert(runFn.includes('if (st && st.runtime_ready === false)'), 'runtime_ready=false 先拦下');
assert(runFn.includes('缺少推理组件 onnxruntime，请更新到最新安装包'), 'runtime 缺失给安装包升级指引');
assert(runFn.includes('if (st && !st.downloaded)'), '模型没下载才弹下载窗');
assert(/openModal\(\(close\) => <DepthModelModal/.test(runFn), '没下载就弹 DepthModelModal');
assert(runFn.includes(', "mm")'), '复用 .modal.mm 磨砂弹窗（不新造皮肤）');
assert(/onReady=\{\(\) => \{ void runDepthCapture\(store, n\); \}\}/.test(runFn), '下载完自动接着跑深度捕捉');

/* ---------- 3. 弹窗：进度 / 速度 / ETA / 断点续传 / 重试 / 取消，零边框 ---------- */
const modalStart = genPanel.indexOf('function DepthModelModal(');
const modalEnd = genPanel.indexOf('/**\n * 套用原声');
assert(modalStart > 0 && modalEnd > modalStart, 'DepthModelModal 组件存在');
const modal = genPanel.slice(modalStart, modalEnd);
assert(modal.includes('<ModalHead title="本地深度模型" />'), '弹窗标题');
assert(modal.includes('className="mm-bar"') && modal.includes('className="mm-meta"'), '进度条 / 进度信息复用 .mm-*');
assert(modal.includes('已下载 ${gotMb} / ${sizeMb} MB'), '显示已下载 MB');
assert(modal.includes('MB/s'), '显示速度');
assert(modal.includes('depthEtaText'), '显示剩余时间');
assert(modal.includes('上次已下载 {gotMb} MB，这次会接着下'), '断点续传提示');
assert(modal.includes('data-k="depth-download"'), '有下载按钮（可断言的选择器）');
assert(modal.includes('store.backend.depthModelDownload!()'), '下载按钮调 depthModelDownload');
assert(modal.includes('store.backend.depthModelCancel?.(.)') || modal.includes('store.backend.depthModelCancel?.()'), '取消按钮调 depthModelCancel');
assert(modal.includes('已取消下载，下次会接着下'), '取消后告诉用户下次接着下');
assert(modal.includes('重试下载'), '失败后可重试');
assert(modal.includes('depthModelStatus!()'), '下载中轮询 status');
assert(modal.includes('beginExtract'), '下载完成走 beginExtract → onReady');
assert(modal.includes('约 {sizeMb} MB'), '文案说明模型体积（约 26 MB）');
// UI 硬规则：不画边框 / 发丝线，也不许在组件里塞一套新样式
assert(!/\bborder\b|\boutline\b|boxShadow|box-shadow|1px solid/.test(modal), '弹窗零边框零发丝线（层级只靠间距 / 底色 / 投影）');
assert(!modal.includes('<style'), '不在组件里新造样式，复用 editors.css 的 .mm-*');
assert(genPanel.includes('ModalHead, openModal, openPop'), 'GenPanel 走已有的弹窗宿主');
assert(!fs.existsSync(path.join(root, ui + 'editors/DepthModel.css')), '没有为深度模型另起一套弹窗样式文件');
// .mm-* 那套样式本身也是零边框：进度条靠软底，不靠描边
const mmBlock = editorsCss.slice(editorsCss.indexOf('/* ---------- 本地抠图模型下载弹窗 ---------- */'),
  editorsCss.indexOf('/* ---------- 编辑对话框外壳'));
assert(mmBlock.includes('.mm-bar'), '复用 editors.css 的 .mm-bar');
assert(mmBlock.includes('.mm-acts'), '复用 .mm-acts');
assert(!/border(-top|-bottom|-left|-right)?\s*:/.test(mmBlock), '.mm-* 样式里没有 border（零边框）');
assert(/\.cn-root \.modal\.mm\{[^}]*\}/.test(editorsCss), '沿用 .modal.mm 的弹窗宽度');

/* ---------- 4. 构建产物同步 ---------- */
assert(built.includes('"/api/video/depth-model/status"'), '构建产物里有新的 status 路由');
assert(built.includes('"/api/video/depth-model/download"'), '构建产物里有新的 download 路由');
assert(built.includes('本地深度模型'), '构建产物里有弹窗文案（说明 canvas.js 已重建）');
assert(built.includes('depth-download'), '构建产物里有下载按钮标记');

/* ---------- 5. 助手面板沿用现有卡片，没有新组件 ---------- */
assert(!genPanel.includes('DepthCaptureCard') && !genPanel.includes('function DepthResultCard'),
  '助手结果沿用现有卡片，没有为深度捕捉新做卡片组件');

console.log('test_novai_canvas_depth_model_download: ok');
