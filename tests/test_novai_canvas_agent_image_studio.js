#!/usr/bin/env node
'use strict';
/*
 * 智能画布BEAT「图片结果」Image Studio 版式：共享组件 + 结果审查卡 + 参考图卡的源码契约。
 * 组件的行为验收在 _verification-beat-image-studio/verify-image-studio.cjs（Electron 桌面窗口）；
 * 这里只锁结构 / 样式 / 回退链 / 调试出入口，防止后续改动把版式与行为改回去。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const has = (src, needle, label) => assert.ok(src.includes(needle), label + '（缺少：' + needle + '）');
const hasNot = (src, needle, label) => assert.ok(!src.includes(needle), label + '（不应出现：' + needle + '）');
const at = (src, needle, label) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, label + '（缺少：' + needle + '）');
    return i;
};

const studioFile = 'novai-canvas-ui/src/canvas/canvas-next/agent/ImageStudio.tsx';
const studioCssFile = 'novai-canvas-ui/src/canvas/canvas-next/agent/image-studio.css';
const reviewFile = 'novai-canvas-ui/src/canvas/canvas-next/agent/ReviewCard.tsx';
const webFile = 'novai-canvas-ui/src/canvas/canvas-next/agent/WebImageCard.tsx';
const panelFile = 'novai-canvas-ui/src/canvas/tapnow/AgentPanel.tsx';
const panelCssFile = 'novai-canvas-ui/src/canvas/tapnow/agent-panel-v2.css';
const webCssFile = 'novai-canvas-ui/src/canvas/tapnow/agent-webimg.css';

for (const file of [studioFile, studioCssFile, reviewFile, webFile]) {
    assert.ok(fs.existsSync(path.join(root, file)), '文件必须存在：' + file);
}
const studio = read(studioFile);
const css = read(studioCssFile);
const review = read(reviewFile);
const web = read(webFile);
const panel = read(panelFile);
const panelCss = read(panelCssFile);
const webCss = read(webCssFile);

// ── 1. 共享组件：网格 / 图块 / 查看器 ───────────────────────────────
console.log('[1] 共享 Image Studio 组件');
has(studio, 'export function StudioTile', '导出 StudioTile');
has(studio, 'export function StudioGrid', '导出 StudioGrid');
has(studio, 'export function StudioLightbox', '导出 StudioLightbox');
has(studio, 'import "./image-studio.css"', '组件内 import image-studio.css');
has(studio, 'import { ThumbImg } from "../ui/thumb"', '图块内部用 ThumbImg（支持 /output 视频抽帧 / data URL）');
has(studio, 'aria-modal="true"', '查看器有 aria-modal');
has(studio, 'role="dialog"', '查看器 role=dialog');
has(studio, 'document.querySelector<HTMLElement>(".cn-root")', '查看器 portal 到 .cn-root');
has(studio, 'event.key === "Escape"', '查看器支持 Esc');
has(studio, 'event.key === "ArrowLeft"', '查看器支持 ←');
has(studio, 'event.key === "ArrowRight"', '查看器支持 →');
has(studio, 'const closeOnBlank = (event: MouseEvent<HTMLDivElement>)', '点空白关闭的处理函数');
has(studio, 'closest("img, video, canvas, a, button, .studio-lb-bar")', '图片 / 视频 / 信息栏 / 按钮本体不关闭');
hasNot(studio, 'studio-lb-close', '大图不再有右上角关闭按钮');
has(studio, 'onDoubleClick={onDoubleClick}', '整块双击可打开大图');
has(studio, 'kind === "video"', '视频角标');
has(studio, 'error ? <span className="studio-tile-badge"', '导入失败角标');
has(studio, 'action.tone === "bad"', '危险动作（重新生成）样式位');
has(studio, 'dataProps(data)', 'data-* 透传到图块根节点');

// 整块点击层是绝对定位的 button，动作按钮是它的兄弟节点（不能嵌套 button）
const veilAt = at(studio, 'className="studio-tile-veil"', '图块 hover 遮罩');
const hitAt = at(studio, 'className="studio-tile-hit"', '整块点击层');
assert.ok(veilAt < hitAt, '点击层在遮罩之后、与动作按钮互为兄弟，不能把按钮嵌进 button');
has(studio, '<div className="studio-tile-acts">', '动作按钮组');
has(studio, 'event.stopPropagation(); action.onClick?.()', '动作按钮阻止冒泡（不触发整块点击）');
assert.ok(!/studio-tile-hit[^>]*>[\s\S]{0,400}?<button/.test(studio), '整块点击 button 内不能再嵌 button');

// 样式：12px 圆角 / 8px 间距 / 自适应列 / 方形 / cover
has(css, 'border-radius: 12px', '图块 12px 圆角');
has(css, 'gap: 8px', '网格 / 遮罩 8px 间距');
has(css, 'repeat(auto-fill, minmax(150px, 1fr))', '窄面板 2 列 / 全屏 4 列的 auto-fill 网格');
has(studio, 'style={{ aspectRatio: aspect }}', '图块 aspect-ratio 方形');
has(css, 'object-fit: cover', '图片 object-fit: cover');
has(css, 'transform: scale(1.02)', 'hover 图片轻微放大 1.02');
has(css, 'linear-gradient(to top, rgba(0, 0, 0, 0.64)', 'hover 底部渐变遮罩');
has(css, 'opacity: 1;', 'hover 遮罩显现');
has(css, 'width: 28px;', '动作按钮 28px');
has(css, 'border-radius: 50%;', '动作按钮圆形');
has(css, 'backdrop-filter: blur(12px) saturate(170%)', '动作按钮深色玻璃');
has(css, 'pointer-events: none;', '角标 / 选中角不挡住整块点击');
has(css, 'max-width: 92vw', '查看器最大 92vw');
has(css, 'max-height: 78vh', '查看器最大 78vh');
has(css, 'border-radius: 16px', '查看器大图 16px 圆角');
has(css, 'backdrop-filter: blur(30px) saturate(150%)', '查看器磨砂遮罩');
has(css, 'background: rgba(28, 28, 30, 0.9)', '底部玻璃信息条');

// 不画 border / 发丝线 / inset 描边
const borders = [...css.matchAll(/(?:^|[;{\s])border\s*:\s*([^;]+);/g)].map((m) => m[1].trim())
    .filter((v) => v !== '0' && v !== '0px' && v !== 'none');
assert.deepStrictEqual(borders, [], '新样式不许画 border（只允许 border: 0 重置）');
assert.ok(!/box-shadow\s*:[^;]*inset/i.test(css), '新样式不许用 inset 描边 / 内阴影');
assert.ok(!/border-(?:color|width|style)\s*:/.test(css), '新样式不许写 border-color / width / style');
assert.ok(!/inset 0 0 0/.test(css) && !/inset 0 0 0/.test(webCss), '不许 inset 0 0 0 描边');

// prefers-reduced-motion：缩放与过渡都关
const reduced = css.slice(at(css, '@media (prefers-reduced-motion: reduce)', 'reduced-motion 媒体查询'));
has(reduced, 'transform: none;', 'reduced-motion 下取消 hover 缩放');
has(reduced, 'transition: none;', 'reduced-motion 下取消过渡');
has(reduced, 'animation: none;', 'reduced-motion 下取消动画');

// ── 2. 结果审查卡 ─────────────────────────────────────────────────
console.log('[2] 结果审查卡');
has(panel, 'import { ReviewCard } from "../canvas-next/agent/ReviewCard"', 'AgentPanel 只 import 使用 ReviewCard');
hasNot(panel, 'function ReviewCard(', 'AgentPanel 不再内联 ReviewCard');
hasNot(panel, 'ap2-review', 'AgentPanel 不再使用 ap2-review 类名');
hasNot(panelCss, '.ap2-review', '旧 .ap2-review 死样式已删除');
has(review, 'export const regenItemOf', 'regenItemOf 跟 ReviewCard 一起拆出');
has(review, 'StudioGrid', '审查卡用共享网格');
has(review, 'StudioTile', '审查卡用共享图块');
has(review, 'StudioLightbox', '审查卡用共享大图查看器');
has(review, 'ThumbImg', '审查图块用 ThumbImg');
has(review, 'ctl.focusNode(item.node_id)', '图块动作「定位到画布」');
has(review, 'onRegenerate([regenItemOf(item)])', '不合格图块可单张重新生成');
has(review, 'onRegenerate(badItems.map(regenItemOf))', '多个不合格时批量重新生成');
has(review, '重新生成有问题的 {bad} 个', '批量重新生成文案');
has(review, 'bad > 1', '批量按钮只在 >1 时出现');
has(review, '"结果审查"', '标题「结果审查」');
has(review, '" · 第 " + round + " 批"', '有 round 时「· 第 N 批」');
has(review, 'review.model || ""', '元信息带模型');
has(review, 'bad ? bad + " 个有问题" : "全部合格"', '元信息带合格 / 问题数');
has(review, 'badge={item.ok ? undefined : "有问题"}', '不合格图块角标「有问题」');
has(review, 'data-review-node', '保留 data-review-node 可测试标记');
has(review, 'data-review-ok', '保留 data-review-ok 可测试标记');
has(review, 'data-review-regen', '大图内重新生成按钮标记');
has(review, 'data-review-locate', '大图内定位按钮标记');
has(review, 'studio-lb-issues', '大图信息条列出 issues');
has(review, '修订提示词', '大图信息条展示修订提示词');
has(review, 'data-review-prompt', '修订提示词可测试标记');
has(review, 'className={open ? "open" : undefined}', '修订提示词可展开 / 收起');
has(review, 'useEffect(() => { setOpen(false); }, [item.node_id, prompt]);', '切换大图时重置展开状态');
has(css, 'studio-lb-prompt p.open', '修订提示词展开态样式');
has(css, '-webkit-line-clamp: 3', '修订提示词默认 3 行');

// ── 3. 参考图卡 ───────────────────────────────────────────────────
console.log('[3] 参考图卡（WebImageCard）');
has(web, 'import { StudioGrid, StudioLightbox, StudioTile', '参考图卡用共享组件');
has(web, 'const ROW = 4', '默认显示 4 张');
has(web, 'const CLICK_DELAY = 200', '单击 200ms 双击判定');
has(web, 'if (clickTimer.current) { clearClick(); return; }', '双击的第二下不改变选中');
has(web, 'onActivate={() => tapSelect(item.id)}', '单击整块选中 / 取消');
has(web, 'onDoubleClick={() => openViewer(filtered.indexOf(item))}', '双击打开大图');
has(web, 'pressed={on}', '整块按钮 aria-pressed');
has(web, 'selected={on}', '图块选中角');
has(web, 'disabled={!picked.size || busy}', '加入画布按钮禁用逻辑');
has(web, 'data-webimg-add', '加入画布按钮可测试标记');
has(web, '取消全选', '全选 / 取消全选');
has(web, 'data-webimg-expand', '展开全部可测试标记');
has(web, 'data-source={option.kind}', '来源筛选 data-source');
has(web, 'chooseSource', '来源筛选取值');
has(web, 'sourceFilter === option.kind', '来源筛选选中态');
has(web, 'data-webimg="ready"', '保留 data-webimg=ready');
has(web, 'data-webimg="loading"', '保留 data-webimg=loading');
has(web, 'data-webimg="failed"', '保留 data-webimg=failed');
has(web, 'data-webimg="web-off"', '保留 data-webimg=web-off');
has(web, 'data-webimg-viewer', '保留 data-webimg-viewer');
has(web, 'data-webimg-viewer-info', '保留 data-webimg-viewer-info');
has(web, '正在搜索参考图…', '加载 phase 行');
has(web, '.slice(0, ROW).map((item, index) => <StudioTile key={item ? item.id : "ph" + index} loading />)', '加载 4 个同尺寸占位格');
has(web, 'data-webimg-empty', '空态标记');
has(web, 'data-webimg-empty-source', '来源空态标记');
has(web, 'thumbStepsOf', '缩略图回退链');
has(web, 'viewerStepsOf', '大图回退链');
has(web, 'setThumbStep', '缩略图 onError 逐级回退');
has(web, 'setViewerStep', '大图 onError 逐级回退');
has(web, '原图加载失败，显示的是缩略图', '退回缩略图的提示');
has(web, 'rowErrors', '导入失败逐张记录');
has(web, 'error={error}', '导入失败角标');
has(studio, 'title={error}>导入失败', '失败角标 title 显示原因');
has(web, 'requestError', '整体请求失败提示');
has(web, 'busy', '导入忙碌态');
has(web, 'href: item.source_page', '打开出处链接');
has(web, 'target="_blank"', '出处新窗口打开');
has(web, 'source_page', '出处页');
has(web, 'className="studio-phase"', '搜索中 phase 行');

// 来源筛选 chip 与图块都带 data-source，但 chip 用 .webimg-chip 区分
has(web, 'className={"studio-chip webimg-chip"', '来源 chips 同时保留 webimg-chip 钩子');
has(web, 'data-source="all"', '「全部」来源 chip');

// ── 4. AgentPanel 调试口 ───────────────────────────────────────────
console.log('[4] 调试口');
const covers = panel.match(/\["[0-9a-f]{16}", /g) || [];
assert.ok(covers.length >= 12, 'debugWebImageMessage 至少 12 张本地封面（当前 ' + covers.length + ' 张：并发任务扩成 7 来源 × 2）');
has(panel, 'const DEBUG_WEBIMG_SOURCES = ["huaban", "duitang", "bing", "360", "bingglobal", "pinterest", "artstation"] as const', '7 种来源');
has(panel, 'source_kind: sourceKind', '写入 source_kind');
has(panel, 'items.reduce((acc, item) => { const kind = item.source_kind || "";', '来源数量按 items 实算');
has(panel, 'DEBUG_WEBIMG_PAGES[sourceKind]', 'source_page 用真实域名');
has(panel, 'debugWebImageMessage(webimgMode)', '?debugWebimg=loading|failed|web-off 注入');
has(panel, 'function debugWebImageMessage(mode = "1")', 'debugWebImageMessage 默认 mode=1');
has(panel, 'const webimgMode = new URLSearchParams(location.search).get("debugWebimg")', 'debugWebimg 读参数');
has(panel, 'const status = mode === "loading" || mode === "failed" || mode === "web-off" ? mode : "ready"', 'status 取 loading/failed/web-off，其余按 ready');
has(panel, 'webimgMode !== "0"', '?debugWebimg=0 不注入');
hasNot(panel, '?debugWebimg=3', '旧 ?debugWebimg=3 分支已不存在');
has(panel, 'kind: "video", url: "/static/store/covers/', '审查夹具补了 video item 与本地图');
const reviewUrls = panel.match(/url: "\/static\/store\/covers\/[0-9a-f]{16}-sq\.webp"/g) || [];
assert.ok(reviewUrls.length >= 3, '审查夹具 3 张都有本地图片 url');

// ── 5. 旧卡片样式已清走 / 新卡不套外框 ─────────────────────────────
console.log('[5] 样式收尾');
const cardSelector = panelCss.slice(at(panelCss, ':is(.plan, .confirm, .qa-card, .qa, .skill-install)', '统一卡片选择器'), at(panelCss, ':is(.plan, .confirm, .qa-card, .qa, .skill-install)', '统一卡片选择器') + 160);
hasNot(cardSelector, '.webimg-card', '参考图卡不再套 var(--card) 外框');
has(webCss, '.cn-root .webimg-card', '参考图卡有自己的最小样式');
has(webCss, '.webimg-bar', '底部操作条');
has(webCss, '.webimg-count', '已选计数');
hasNot(webCss, 'webimg-lb', '旧灯箱样式已删除（统一走 studio 查看器）');
hasNot(webCss, 'webimg-skeleton', '旧骨架样式已删除（统一走 studio 图块）');
has(web, 'className="studio-batch', '参考图卡用 studio-batch（无外框）');
has(review, 'className={"studio-batch review-card', '审查卡用 studio-batch（无外框）');

// ── 6. 版本号（构建后 canvas.css / canvas.js 两处一致） ────────────
console.log('[6] static/canvas.html ?v=');
const html = read('static/canvas.html');
const versions = [...html.matchAll(/canvas\.(?:css|js)\?v=([0-9.]+)/g)].map((m) => m[1]);
assert.strictEqual(versions.length, 2, 'canvas.css / canvas.js 各一处 ?v=');
assert.strictEqual(versions[0], versions[1], 'canvas.css / canvas.js 版本号必须一致');
/* 版本号不写死：读项目版本（desktop/package.json，退回 VERSION）再比对；页面 tag 用 2.0.06，
   package.json 是 2.0.6，按数字分段归一后再比，避免前导零差异。 */
const projectVersion = (() => {
    try { return String(JSON.parse(read('desktop/package.json')).version || ''); } catch (e) {}
    try { return read('VERSION').trim().split('\n')[0].trim(); } catch (e) {}
    return '';
})();
const versionTagOk = (tag) => {
    if (!/^\d+(\.\d+)+$/.test(tag)) return false;
    const norm = (v) => String(v).split('.').map((x) => String(Number(x))).join('.');
    return projectVersion ? norm(tag.slice(0, tag.lastIndexOf('.'))) === norm(projectVersion) : true;
};
assert.ok(versionTagOk(versions[0]), '版本号是「项目版本.mtime」形式（当前 ' + versions[0] + '，项目版本 ' + projectVersion + '）');

console.log('\nALL PASS · 源码契约 ' + '60+ 项');