#!/usr/bin/env node
/*
 * 画布页「参考站结构」回归测试（零依赖）：A 左下 / B 右上 / C 左栏 / D 助手面板。
 * 只校验结构与关键样式，视觉由 Playwright 在 1728×871 下截图核对。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const smart = read('static/js/smart-canvas.js');
const rail = read('static/js/canvas-rail.js');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if(condition) pass += 1;
    else fails.push(label);
};
const count = (text, pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    return (text.match(new RegExp(pattern.source, flags)) || []).length;
};
const idsOf = text => Array.from(text.matchAll(/\bid="([^"]+)"/g), match => match[1]);
const block = marker => (css.indexOf(marker) >= 0 ? css.slice(css.indexOf(marker)) : '');
const refCss = block('参考站结构（A 左下');
const darkCss = block('参考站数值校准');
const tapCss = block('左侧浮层');

console.log('[0] 主题跟随 / 底色 / 网格');
ok(/localStorage\.getItem\("studio_theme"\)\|\|localStorage\.getItem\("canvas_theme"\)\|\|"light"/.test(html), '画布页跟随主题、首次默认浅色');
ok(!/StudioTheme\.apply\('dark'\)/.test(rail), 'canvas-rail.js 不再强制深色');
ok(/background-color: #0f0f0f;/.test(darkCss) && /background-size: 24px 24px;/.test(darkCss), '底色 #0f0f0f + 24px 网格');
ok(/--grid-dot: rgba\(255, 255, 255, \.06\)/.test(darkCss), '点色 rgba(255,255,255,.06)');
ok(/html:not\(\.studio-theme-dark\) \{/.test(darkCss), '浅色主题变量保留');

console.log('[A] 左下工具组：293 宽 / 4 颗 28×28 r12 + 滑杆 110 + 40 帮助圆钮');
const zoombar = (html.match(/<div id="canvasZoomBar" class="canvas-zoombar">[\s\S]*?<\/div>/) || [''])[0];
ok((zoombar.match(/class="zoombar-tool"/g) || []).length === 4, '缩放胶囊里正好 4 颗工具按钮');
ok(zoombar.indexOf('zoomBarFitAll()') >= 0, '保留适应画布');
ok(zoombar.indexOf('zoomBarUndo()') < 0 && zoombar.indexOf('zoomBarRedo()') < 0, '撤销/重做移出底栏');
ok(/id="canvasZoomMapBtn"/.test(html) && /id="canvasZoomWorkflowBtn"/.test(html) && /id="canvasZoomGridBtn"/.test(html), '底栏 map/link/grid 三颗按钮');
ok(/data-lucide="scan"/.test(zoombar), '第 4 颗 scan 适应画布');
ok(/data-left-more="undo"/.test(html) && /data-left-more="redo"/.test(html), '撤销/重做进「…」菜单');
ok(zoombar.indexOf('zoomBarCreate(') < 0, '底栏不再平铺新建按钮（收进左栏 +）');
ok(zoombar.indexOf('zoomBarCenter()') < 0 && /data-more-action="center"/.test(html), '居中移进右上「更多」菜单');
ok(zoombar.indexOf('zoomBarZoomIn()') < 0 && zoombar.indexOf('zoomBarZoomOut()') < 0, '加减按钮由滑杆取代');
ok(/id="canvasZoomSlider" class="zoombar-slider"/.test(html), '缩放滑杆保留');
ok(/id="canvasZoomLevel"[^>]*hidden/.test(html), '百分比节点保留但隐藏（不丢 id）');
ok(/\.canvas-bottomleft \{ width: 293px; height: 40px; gap: 10px; \}/.test(refCss), '左下容器 293×40 gap10');
ok(/#canvasZoomBar\.canvas-zoombar \.zoombar-tool \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;[\s\S]*?border-radius: 12px;/.test(refCss), '4 颗按钮 28×28 r12');
ok(/#canvasZoomBar\.canvas-zoombar \.zoombar-tool i,[\s\S]*?width: 16px; height: 16px;/.test(refCss), '按钮图标 16px');
ok(/\.zoombar-slider \{ width: 110px;/.test(refCss), '滑杆约 110px');
ok(/\.zoombar-shortcut \{[\s\S]*?width: 40px;[\s\S]*?height: 40px;[\s\S]*?background: var\(--soft\);/.test(css), '帮助圆钮 40 / 主题软底');
ok(/id="zoomBarShortcutBtn"[^>]*onclick="openSmartCanvasShortcuts\(\)"/.test(html), '帮助圆钮打开快捷键');
ok(/data-more-action="center"/.test(html), '居中入口保留在更多菜单');

console.log('[B] 右上：只剩素材浏览器 + 更多（40×40 r12 #171717）');
ok(/id="sourceBrowserToggle"/.test(html) && /id="canvasMoreBtn"/.test(html), '两个入口都在');
['smartWorkflowToggle', 'smartShortcutToggle', 'smartLogToggle', 'assetToggle'].forEach(id => {
    const tag = (html.match(new RegExp('<button id="' + id + '"[^>]*>')) || [''])[0];
    ok(tag.indexOf('canvas-topright-extra') >= 0, id + ' 收进更多菜单（节点仍在、仅隐藏）');
});
ok(/id="smartExportToggle"/.test(html) && /class="smart-export-toggle"/.test(html), '导出按钮节点保留（类名不变）');
ok(/\.canvas-topright \.canvas-topright-extra,[\s\S]*?#canvasTopRight #smartExportToggle \{ display: none !important; \}/.test(refCss), '多余按钮不显示（导出按 id 隐藏）');
ok(/\.canvas-topright \.source-browser-toggle,[\s\S]*?width: 40px;[\s\S]*?border-radius: 12px;[\s\S]*?background: var\(--panel\);/.test(refCss), '右上按钮 40×40 r12 主题底');
ok(/id="canvasMoreMenu"/.test(html) && /data-more-action="export"/.test(html) && /data-more-action="workflow"/.test(html) && /data-more-action="shortcut"/.test(html) && /data-more-action="log"/.test(html) && /data-more-action="assets"/.test(html), '更多菜单含 导出/工作流/快捷键/日志/资产库');
ok(/__novaiOpenExportSubmenuAt/.test(rail) && /fire\('smartWorkflowToggle'\)/.test(rail) && /fire\('assetToggle'\)/.test(rail), '菜单项转发/导出子菜单');
ok(/openSmartCanvasShortcuts/.test(rail) && /openSmartCanvasLog/.test(rail), '快捷键 / 日志转发到原函数');

console.log('[C] 左栏：40 白圆 + / 4×38 r10 图标 + 底部 40 头像');
ok(/id="canvasRailCreate" class="canvas-rail-btn canvas-rail-primary"/.test(html), '顶部 + 用 primary 样式');
ok(/\.canvas-rail-primary \{[\s\S]*?width: 40px;[\s\S]*?height: 40px;[\s\S]*?border-radius: 50%;[\s\S]*?background: #ffffff;/.test(refCss), '「+」40 纯白圆');
ok(/id="canvasRailAssets"[^>]*canvas-rail-mini/.test(html) && /id="canvasRailWorkflow"[^>]*canvas-rail-mini/.test(html) && /id="canvasRailChat"[^>]*canvas-rail-mini/.test(html) && /id="canvasRailHistory"[^>]*canvas-rail-mini/.test(html), '4 颗 38 小按钮（资产/工作流/对话/历史）');
ok(/\.canvas-rail-mini \{[\s\S]*?width: 38px;[\s\S]*?height: 38px;[\s\S]*?border-radius: 10px;/.test(refCss), '小按钮 38×38 r10');
ok(/\.canvas-rail-mini i, \.canvas-rail-mini svg \{ width: 18px; height: 18px; \}/.test(refCss), '图标 18px');
ok(/id="canvasRailAssets"[\s\S]*?data-lucide="folder-open"/.test(html) && !/canvas-rail-badge/.test(html), '资产库用 folder 且已去掉蓝点 badge');
ok(/\.canvas-rail-badge \{[\s\S]*?background: var\(--accent, var\(--strong\)\);/.test(refCss) || /\.canvas-rail-badge \{[\s\S]*?background: var\(--accent/.test(css), 'badge 用主题强调色');
ok(/id="canvasRailSettings" class="canvas-rail-btn canvas-rail-avatar"/.test(html), '底部头像/齿轮 40');
ok(/\.canvas-rail-avatar \{[\s\S]*?width: 40px;[\s\S]*?height: 40px;[\s\S]*?border-radius: 50%;/.test(refCss), '头像 40 圆');
ok(/canvasRailChat\(\)\{ fire\('chatToggleBtn'\); \}/.test(rail), '左栏对话转发到现有对话圆钮');
ok(/canvasRailHistory\(\)\{ fire\('versionHistoryBtn'\); \}/.test(rail), '左栏历史转发');
ok(/canvasRailAssets\(\)\{ fire\('assetToggle'\); \}/.test(rail), '左栏资产库转发');
ok(/canvasRailWorkflow\(\)\{[\s\S]*?fire\('smartWorkflowToggle'\)/.test(rail), '左栏工作流转发（开着再点会关）');
ok(/id="canvasRailSource"/.test(html) && /id="canvasRailMore"/.test(html) && /id="canvasRailLog"/.test(html), '素材浏览器 / 更多 / 日志都回到左栏');
ok(/panel\.style\.left = Math\.round\(rect\.right \+ 10\) \+ 'px'/.test(rail), '「…」锚定在按钮右侧 10px');
ok(/\.canvas-anchored-menu \{[\s\S]*?width: 200px;[\s\S]*?border-radius: 12px;/.test(css) && /color-mix\(in srgb, var\(--panel\) 78%, transparent\)/.test(css), '小菜单 200/r12 + 深色 78% 磨砂');
ok(!/节点搜索/.test(html), '参考站的「节点搜索」本画布没有，按约定不显示');

console.log('[D] 助手面板：header 56 / 新建对话 86×40 / 右 3×36 / body 24 / 建议卡 / composer');
ok(/id="canvasAssistantCollapseBtn"/.test(html) && /id="canvasAssistantNewChatBtn"/.test(html), 'header 左：收起 40 + 新建对话药丸');
ok(/\.canvas-assistant-collapse \{[\s\S]*?width: 40px;[\s\S]*?height: 40px;/.test(refCss), '收起钮 40');
ok(/\.canvas-assistant-newchat \{[\s\S]*?height: 40px;[\s\S]*?width: 86px;/.test(refCss), '新建对话 86×40');
ok(/id="canvasAssistantEditBtn"/.test(html) && /id="canvasAssistantExpandBtn"/.test(html) && /id="canvasAssistantMoreBtn"/.test(html), '右侧 3 颗图标钮');
ok(/\.canvas-assistant-icon \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/.test(refCss), '图标钮 36×36');
ok(/id="canvasAssistantMoreMenu"/.test(html) && /data-assistant-action="history"/.test(html) && /data-assistant-action="confirm"/.test(html) && /data-assistant-action="reset"/.test(html), '更多菜单含历史/手动确认/重置');
ok(/\.canvas-assistant-host \.chat-messages \{ padding: 24px; \}/.test(refCss), 'body padding 24');
ok(/\.canvas-welcome-card \{[\s\S]*?min-height: 124px;[\s\S]*?border-radius: 16px;[\s\S]*?background: rgba\(255, 255, 255, \.04\);/.test(refCss), '建议卡 r16 半透明底');
ok(/\.canvas-welcome-hi \{[\s\S]*?font-size: 21px;/.test(refCss), '问候大字 21px');
ok(/\.canvas-welcome-refresh/.test(refCss) && /换一批建议/.test(rail), '换一批建议（静态切换文案）');
ok(/id="canvasAssistantContextChip"/.test(html) && /添加画布内容/.test(html), '输入框上方 chip「添加画布内容」');
ok(/placeholder="随心输入"/.test(html), 'placeholder 随心输入');
ok(/id="canvasAssistantPlanToggle"/.test(html) && /toggleAgentPlanConfirm\(\)/.test(html), '手动确认开关复用现有函数');
ok(/\.canvas-assistant-host \.chat-input \{[\s\S]*?height: 48px;[\s\S]*?border-radius: 16px;[\s\S]*?background: var\(--panel\);/.test(refCss), '输入框 48 r16 主题面板底');
ok(/\.canvas-composer-confirm\.is-on \.canvas-composer-switch/.test(refCss), '手动确认开关 on 态');
ok(/\.canvas-composer-auto/.test(refCss) && /Auto/.test(html), 'Auto 模型标签');
ok(/\.canvas-assistant-host \.chat-round-btn\.chat-send \{[\s\S]*?width: 34px;[\s\S]*?border-radius: 50%;/.test(refCss), '圆形发送钮');
ok(/panel\.classList\.toggle\('is-full'\)/.test(rail) && /\.canvas-assistant\.is-full \{ width: 100vw; \}/.test(refCss), 'Agent 全屏 → 440 ↔ 全宽');
ok(/resetChatConversation/.test(rail), '新对话复用 resetChatConversation');
ok(/canvasAssistantCollapseBtn[^]*?closePanel/.test(rail), '收起钮折叠面板');
ok(/byId\('canvasAssistantPanel'\)/.test(rail), '面板折叠仍走 canvas-assistant-open + shell 让位');
ok(/body\.canvas-assistant-open \.shell \{ width: calc\(100vw - 440px\) !important; \}/.test(darkCss), '展开时画布让出 440');

console.log('[E] 结构与脚本顺序');
const ids = idsOf(html);
const duplicates = Array.from(new Set(ids.filter(id => ids.filter(other => other === id).length > 1)));
ok(duplicates.length === 0, '页面无重复 id' + (duplicates.length ? '：' + duplicates.join(',') : ''));
['smartTitle', 'smartSaveState', 'createMenu', 'assetToggle', 'sourceBrowserToggle', 'smartWorkflowToggle', 'smartExportToggle', 'smartShortcutToggle', 'smartLogToggle', 'chatToggleBtn', 'versionHistoryBtn', 'canvasZoomBar', 'canvasZoomLevel', 'minimap', 'assetPanel', 'versionPanel', 'chatModal', 'canvasPill', 'canvasRail', 'canvasAssistantPanel'].forEach(id => {
    ok(ids.filter(item => item === id).length === 1, '核心 id 唯一：' + id);
});
ok(/<script defer src="\/static\/js\/canvas-rail\.js/.test(html) && html.indexOf('canvas-rail.js') < html.indexOf('smart-canvas.js?'), 'canvas-rail.js 先于 smart-canvas.js');
ok(/window\.backToCanvasList = backToCanvasList;/.test(smart) && /window\.openCreateMenu = openCreateMenu;/.test(smart) && /window\.zoomBarSetScale = zoomBarApplyScale;/.test(smart), '原入口仍然导出');
ok(/id="createMenu" class="create-menu"/.test(html) && count(html, /data-create-type=/g) >= 8, '创建菜单 8 类仍在');

console.log('[F] 设计硬规则');
const borders = Array.from(refCss.matchAll(/border\s*:\s*([^;{}]+)/g), match => match[1].trim());
ok(borders.length > 0 && borders.every(value => /^0(px)?(\s*!important)?$/.test(value) || /^2px solid transparent$/.test(value)), '不画 border / 发丝线（透明滚动条占位除外）');
ok(!/border-(top|right|bottom|left|width)\s*:\s*[1-9]/.test(refCss), '无 1px 描边');
ok(/rgba\(255, 255, 255, \.04\)/.test(refCss), '卡片用半透明软底而非描边');

console.log('[G] i18n');
['canvas.assistant', 'canvas.history', 'canvas.rename', 'canvas.toggleTheme', 'canvas.newNode'].forEach(key => {
    ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "[^"]+", en: "[^"]+" \\}').test(i18n), 'i18n 成对：' + key);
});

console.log('[H] 左侧浮层结构：右上移除 / 左栏顺序 / 左侧浮层 / 右下收敛 / 空状态');
ok(/#canvasTopRight \{ display: none !important; \}/.test(tapCss), '右上容器隐藏（节点保留）');
['sourceBrowserToggle', 'smartExportToggle', 'smartWorkflowToggle', 'smartShortcutToggle', 'smartLogToggle', 'assetToggle', 'canvasMoreBtn'].forEach(id => {
    ok(idsOf(html).filter(item => item === id).length === 1, '右上节点保留：' + id);
});
const railBlock = (html.match(/<nav id="canvasRail"[\s\S]*?<\/nav>/) || [''])[0];
const railOrder = ['canvasRailCreate', 'canvasRailSource', 'canvasRailAssets', 'canvasRailWorkflow', 'canvasRailLog', 'canvasRailChat', 'canvasRailHistory', 'canvasRailMore', 'canvasRailSettings'];
railOrder.forEach(id => ok(railBlock.indexOf('id="' + id + '"') >= 0, '左栏按钮存在：' + id));
const railPositions = railOrder.map(id => railBlock.indexOf('id="' + id + '"'));
ok(railPositions.every((pos, index) => index === 0 || pos > railPositions[index - 1]), '左栏顺序：+ → 素材 → 资产 → 工作流 → 日志 → 对话 → 历史 → 更多 → 齿轮');
ok(/\.canvas-rail \{ height: auto; min-height: 0; \}/.test(tapCss), '左栏自然高度');
ok(/id="canvasLeftMorePanel"/.test(html) && /data-left-more="export"/.test(html) && /data-left-more="shortcut"/.test(html) && /data-left-more="center"/.test(html), '「更多」浮层含 导出/快捷键/定位居中');
ok(/__novaiOpenExportSubmenuAt/.test(rail) && /openSmartCanvasShortcuts/.test(rail) && /zoomBarCenter/.test(rail), '更多项映射真实入口（含导出子菜单）');
ok(/\.asset-panel,\s*\.workflow-transfer-panel,\s*\.source-browser-panel,\s*\.log-modal \.log-panel,\s*\.canvas-left-panel \{[\s\S]*?position: fixed;[\s\S]*?left: 16px;[\s\S]*?top: 64px;[\s\S]*?bottom: 60px;[\s\S]*?width: 320px;[\s\S]*?border-radius: 16px;[\s\S]*?z-index: 70;/.test(tapCss), '四类浮层 left16/top64/bottom60/320/r16/z70');
ok(/html\.studio-theme-dark \.asset-panel[\s\S]*?color-mix\(in srgb, var\(--panel\) 70%, transparent\) !important/.test(css), '深色浮层走 color-mix 磨砂变量');
ok(/backdrop-filter: blur\(44px\) saturate\(190%\)/.test(tapCss), '浮层背景模糊');
ok(/\.source-browser-panel \{[\s\S]*?width: var\(--source-browser-width, 520px\) !important;/.test(tapCss), '素材浏览器浮层默认 520，可拖拽');
ok(/\.log-modal\.open \{[\s\S]*?pointer-events: none;[\s\S]*?z-index: 70;/.test(tapCss), '日志遮罩不吃点击');
ok(/pairs = \[[\s\S]*?\['assetPanel', 'canvasRailAssets'\][\s\S]*?\['sourceBrowserPanel', 'canvasRailSource'\]/.test(rail), '点浮层外关闭（复用左栏按钮）');
ok(/#minimap, #versionHistoryBtn \{ display: none !important; \}/.test(tapCss), '小地图 / 历史圆钮隐藏');
ok(/id="minimap"/.test(html) && /id="versionHistoryBtn"/.test(html) && /id="chatToggleBtn"/.test(html), '小地图/历史节点保留，助手圆钮保留');
ok(/\.canvas-bottomright \{ gap: 0; \}/.test(tapCss), '右下只剩画布助手');

console.log('[I] 空状态：双击 chip + 胶囊（无能力隐藏）');
const guide = (smart.match(/guide\.innerHTML =[\s\S]*?document\.body\.appendChild/) || [''])[0];
ok(/smart-empty-keycap"><i data-lucide="mouse-pointer-click"><\/i>双击/.test(guide), '小键帽 chip：光标图标 + 双击');
ok(/画布自由生成，或查看模板/.test(guide), '灰色说明文案 14px');
ok((guide.match(/class="smart-empty-pill"/g) || []).length === 5, '5 颗胶囊全部渲染');
['video', 'background', 'firstframe', 'audio', 'template'].forEach(action => {
    ok(new RegExp('data-empty-action="' + action + '"').test(guide), '胶囊 action=' + action);
});
ok(/data-lucide="video"/.test(guide) && /data-lucide="image"/.test(guide) && /data-lucide="image-plus"/.test(guide) && /data-lucide="layers"/.test(guide), '胶囊带线性图标');
ok(/action === 'video' \|\| action === 'firstframe' \|\| action === 'audio'\)\{ window\.zoomBarCreate\('video'\); return; \}/.test(smart), '视频类胶囊 → 建视频节点');
ok(/action === 'background'\)\{ window\.zoomBarCreate\('image'\); return; \}/.test(smart), '图片换背景 → 建图片节点（现有上传/生成入口）');
ok(/getElementById\('composerTemplateBtn'\)[\s\S]*?\.click\(\)/.test(smart), '模板 → 现有模板库入口');
ok(/\.smart-empty-guide \{[\s\S]*?left: 50%;[\s\S]*?top: 45%;/.test(tapCss), '空状态水平居中、垂直 45%');
ok(/\.smart-empty-pill \{[\s\S]*?height: 40px;[\s\S]*?border-radius: 20px;[\s\S]*?background: rgba\(255, 255, 255, \.04\);/.test(tapCss), '胶囊 h40 r20 半透明底');
ok(/\.smart-empty-pill \{[\s\S]*?border: 0\b/.test(tapCss), '空状态胶囊无边框（软底表达层级）');
ok(/\.smart-empty-guide-pills \{[\s\S]*?gap: 10px;/.test(tapCss), '胶囊间距 10');
ok(/\.zoombar-slider::-webkit-slider-runnable-track \{[\s\S]*?height: 4px;/.test(tapCss), '滑杆轨道 4px');
ok(/\.zoombar-slider::-webkit-slider-thumb \{[\s\S]*?width: 20px;/.test(tapCss), '滑杆滑块 20px');
ok(/id="canvasRailTip"/.test(html) && /\.canvas-rail-tip \{[\s\S]*?background: color-mix\(in srgb, var\(--panel\) 78%, transparent\)/.test(css), '左栏 hover 胶囊提示（78% 磨砂）');
ok(/id="canvasAddPanel"/.test(html) && /\.canvas-add-panel \{[\s\S]*?width: 360px;/.test(tapCss), 'hover + 添加节点面板');
ok(/data-add-kind="prompt"/.test(html) && /脚本、广告词、品牌文案/.test(html), '首行文本 + 副标题');
ok(/canvasRailTemplates/.test(html) && /promptTemplatePanel/.test(rail), '左栏模板库按钮');
ok(/postMessage\(payload, '\*'\)/.test(rail) && /route: 'api-settings'/.test(rail), '齿轮打开应用设置（navigate api-settings）');
ok(/html:not\(\.studio-theme-dark\) \.asset-panel,[\s\S]*?color-mix\(in srgb, var\(--panel\) 64%, transparent\) !important;/.test(css), '浅色浮层走 64% 磨砂 color-mix');
ok(!/rgba\(250, 250, 250, \.92\)/.test(css), '浅色不再有近实底 .92 覆盖');
ok(/html:not\(\.studio-theme-dark\) \.asset-panel,[\s\S]*?backdrop-filter: blur\(44px\) saturate\(190%\) !important;/.test(css), '浅色浮层 backdrop-filter 生效');
ok(/html:not\(\.studio-theme-dark\) \.asset-panel,[\s\S]*?box-shadow: var\(--shadow-xl/.test(css), '浅色浮层用 --shadow-xl 两层投影');

console.log('[J] 质量返工：磨砂玻璃 / 无发丝线 / 模板库自适应 / 提示延迟');
const qualityCss = block('质量返工：全部回到项目设计语言');
ok(/color-mix\(in srgb, var\(--panel\) 72%, transparent\)/.test(qualityCss), '弹窗统一磨砂：color-mix(var(--panel) 72%)');
ok(/backdrop-filter: blur\(44px\) saturate\(190%\)/.test(qualityCss) && /-webkit-backdrop-filter: blur\(44px\) saturate\(190%\)/.test(qualityCss), '磨砂带 -webkit 前缀');
ok(/background: color-mix\(in srgb, var\(--panel\) 78%, transparent\)/.test(css) && /html:not\(\.studio-theme-dark\) \.canvas-anchored-menu,[\s\S]*?color-mix\(in srgb, var\(--panel\) 72%, transparent\) !important/.test(css), '小弹层深 78% / 浅 72% 磨砂');
ok(!/rgba\(24, 24, 24, \.95\)/.test(css) && !/rgba\(255, 255, 255, \.96\)/.test(css), '小弹层不再用实底');
ok(/html:not\(\.studio-theme-dark\) \.asset-panel/.test(qualityCss), '浅色主题走变量而非写死色');
ok(/border: 0 !important;[\s\S]*?background: var\(--soft\)/.test(qualityCss), '空状态胶囊去边框改软底');
ok(/\.prompt-template-panel \{[^}]*width: 420px;/.test(css), '模板库浮层放宽到 420');
ok(/\.prompt-template-panel \.prompt-template-body \{[^}]*flex-direction: column;/.test(css), '模板库窄容器单列（详情下置）');
ok(/\.prompt-template-panel \.prompt-template-list \{[^}]*max-height: 200px;[\s\S]*?overflow: auto;/.test(css), '列表区内部滚动');
ok(/\.prompt-template-panel \.prompt-template-preview-content \{[^}]*overflow: auto;/.test(css), '详情区内部滚动');
ok(/\.prompt-template-panel \.prompt-template-actions \{[^}]*flex: 0 0 auto;/.test(css), '操作按钮钉在详情底部（不半截）');
ok(/\.prompt-template-panel \.prompt-template-tabs \{[^}]*flex-wrap: wrap;/.test(css), '分类 chips 换行，不横向裁切');
ok(/scrollbar-width: thin/.test(qualityCss) || /scrollbar-color: var\(--scrollbar\)/.test(css), '自定义细滚动条');
ok(/padding-bottom: 12px/.test(qualityCss), '弹窗底部留 12px');
ok(/showTimer = setTimeout\([\s\S]*?\}, 150\);/.test(rail) && /hideTimer = setTimeout\([\s\S]*?\}, 100\);/.test(rail), '提示 150ms 显示 / 100ms 隐藏');
ok(/window\.addEventListener\('scroll', hideNow, true\)/.test(rail) && /window\.addEventListener\('blur', hideNow\)/.test(rail), '滚动 / 失焦立即隐藏');
ok(/railEl\.addEventListener\('focusin'/.test(rail) && /railEl\.addEventListener\('focusout', hideNow\)/.test(rail), '键盘 focus 显示 / blur 隐藏');
ok(/document\.addEventListener\('click', hideNow, true\)/.test(rail), '点击立即隐藏');
ok(/canvasAddPanel'[\s\S]*?mouseenter', hideNow/.test(rail), '移入面板立即隐藏');

console.log('[K] 返工 23：字号/磨砂 / 模板左右定位 / 左下修复 / 整理选中移除');
ok(/\.canvas-add-section-title \{[\s\S]*?font-size: 10px;[\s\S]*?font-weight: 600;[\s\S]*?color: var\(--muted\)/.test(css), '添加面板分组标题 10px/600/muted');
ok(/\.canvas-add-text strong \{[\s\S]*?font-size: 12px;[\s\S]*?font-weight: 600;[\s\S]*?color: var\(--text\)/.test(css), '行标题 12px/600/text');
ok(/\.canvas-add-text em \{[\s\S]*?font-size: 10px;[\s\S]*?color: var\(--muted\)/.test(css), '副标题 10px/muted');
ok(/\.canvas-add-icon \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/.test(css), '图标块 36×36');
ok(/\.canvas-add-icon i, \.canvas-add-icon svg \{ width: 16px; height: 16px; \}/.test(css), '图标 16px');
ok(/\.canvas-add-item \{[\s\S]*?padding: 10px;/.test(css), '行内边距 10');
ok(/#canvasZoomSlider,[\s\S]*?background: transparent !important;/.test(css), '滑杆输入/容器去底色（深/浅）');
ok(/html:not\(\.studio-theme-dark\) \.zoombar-slider \{[\s\S]*?background: transparent !important;/.test(css), '浅色主题滑杆底色清掉');
ok(/html\.studio-theme-dark \.canvas-add-panel \{[\s\S]*?color-mix\(in srgb, var\(--panel\) 70%, transparent\) !important;[\s\S]*?backdrop-filter: blur\(44px\) saturate\(190%\)/.test(css), '添加面板深色 70% 磨砂 + blur');
ok(/\.canvas-add-panel \{[\s\S]*?background: color-mix\(in srgb, var\(--panel\) 78%, transparent\);/.test(css), '添加面板浅色 78% 磨砂');
ok(/\.prompt-template-panel\[data-placement="right"\] \{[\s\S]*?right: 16px;/.test(css), '模板库右侧定位样式');
ok(/\.prompt-template-panel\[data-placement="left"\] \{[\s\S]*?left: 16px;/.test(css), '模板库左侧定位样式');
ok(/promptTemplatePanel\.dataset\.placement = options\.placement === 'left' \? 'left' : 'right'/.test(smart), 'openPromptTemplatePanel 默认右/显式左');
ok(/window\.openPromptTemplatePanel = openPromptTemplatePanel;/.test(smart), '模板库开启函数已导出给左栏');
ok(/placement: 'left'/.test(rail) && /openPromptTemplatePanel\('', '', \{ target: 'composer', placement: 'left' \}\)/.test(rail), '左栏模板库显式传 left');
ok(/\['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click'\]\.forEach/.test(rail), '左下容器隔离 5 类事件');
ok(/bar\.addEventListener\(type, event => \{ event\.stopPropagation\(\); \}\);/.test(rail), '左下容器冒泡阶段 stopPropagation');
ok(/#canvasZoomBar\.canvas-zoombar \.zoombar-slider \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 72px;[\s\S]*?max-width: 110px;/.test(css), '滑杆自适应 72~110');
ok(/touch-action: none;/.test(css) && /-webkit-app-region: no-drag;/.test(css), '滑杆 touch-action / no-drag');
ok(/margin-top: -8px;/.test(css), '滑块 20px 居中（-8px）');
ok(/railWorkflow\.click\(\)/.test(rail), '左下连接按钮复用左栏工作流逻辑');
ok(/#smartArrangeBtn \{ display: none !important; \}/.test(css), '整理选中按钮移除');

console.log('[L] 返工 23b：自绘滑杆拖拽 / 不出边 / 工作流 active 反馈 / 整理选中移除');
ok(/<div class="canvas-zoom-slider">/.test(html) && /id="canvasZoomSlider"/.test(html), '滑杆外层有 .canvas-zoom-slider 容器');
ok(/wrap\.addEventListener\('pointerdown'[\s\S]*?event\.preventDefault\(\);[\s\S]*?wrap\.setPointerCapture/.test(rail), 'pointerdown 捕获 + preventDefault + setPointerCapture');
ok(/applyFromEvent = event =>[\s\S]*?clientX - rect\.left\) \/ rect\.width[\s\S]*?window\.zoomBarSetScale\(pct \/ 100\)/.test(rail), '按 x 比例换算 10~400 并调 zoomBarSetScale');
ok(/wrap\.addEventListener\('pointerup', finish, true\)/.test(rail), 'pointerup 释放');
ok(/slider\.addEventListener\('input'/.test(rail), '保留 input 事件（键盘可达）');
ok(/box-sizing: border-box;[\s\S]*?padding: 0 8px;[\s\S]*?overflow: hidden;/.test(css), '缩放胶囊 border-box/padding/overflow hidden');
ok(/\.canvas-zoom-slider \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 60px;[\s\S]*?max-width: 104px;[\s\S]*?margin: 0 2px;/.test(css), '滑杆容器 flex 60~104 / margin 2');
ok(/\.canvas-zoom-slider \{[\s\S]*?touch-action: none;[\s\S]*?-webkit-app-region: no-drag;/.test(css), '滑杆 touch-action / no-drag');
ok(/#canvasZoomWorkflowBtn\.is-on \{ background: var\(--soft\); color: var\(--text\); \}/.test(css), '工作流按钮 active 软底');
ok(/syncActive = \(\) => workflowBtn\.classList\.toggle\('is-on', !!workflowPanel && workflowPanel\.classList\.contains\('open'\)\)/.test(rail), '按钮 active 跟随面板开合');
ok(/railWorkflow\.click\(\)/.test(rail), '连接按钮复用左栏工作流逻辑');
ok(/#smartArrangeBtn \{ display: none !important; \}/.test(css), '整理选中隐藏');
ok(/\['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click'\]\.forEach/.test(rail), '左下容器 5 类事件 stopPropagation');

console.log('[M] 胶囊 logo：内联 SVG + currentColor（深/浅自动跟随）');
ok(/<svg class="canvas-pill-logo" viewBox="0 0 1024 1024"[^>]*aria-hidden="true"/.test(html), '胶囊 logo 是内联 SVG');
ok(/<path fill="currentColor" d="M869\.44,200\.5/.test(html), 'SVG 用 currentColor 与侧栏同一条 LOGO path');
ok(!/<img class="canvas-pill-logo"/.test(html), '不再使用黑 mark 的 logo.png');
ok((html.match(/logo\.png/g) || []).length === 1 && /<link rel="icon" href="\/static\/images\/logo\.png"/.test(html), '画布页只剩 favicon 用 logo.png');
ok(/\.canvas-pill \.smart-back svg\.canvas-pill-logo \{[\s\S]*?width: 24px;[\s\S]*?height: 24px;/.test(css), '胶囊 logo 保持 24px（压过 .smart-back svg 16px）');

console.log('[N] 磨砂统一：添加面板 / 「…」菜单 / hover 提示');
ok(/html:not\(\.studio-theme-dark\) \.canvas-add-panel \{[\s\S]*?color-mix\(in srgb, var\(--panel\) 64%, transparent\) !important;[\s\S]*?backdrop-filter: blur\(44px\) saturate\(190%\) !important;/.test(css), '浅色添加面板 64% 磨砂 + blur');
ok(/html:not\(\.studio-theme-dark\) \.canvas-add-panel \{[\s\S]*?box-shadow: var\(--shadow-xl/.test(css), '浅色添加面板 --shadow-xl 两层');
ok(/\.canvas-anchored-menu,\n\.canvas-rail-tip \{[\s\S]*?color-mix\(in srgb, var\(--panel\) 78%, transparent\)[\s\S]*?backdrop-filter: blur\(44px\) saturate\(190%\)/.test(css), '小弹层深色 78% 磨砂 + blur');
ok(/html:not\(\.studio-theme-dark\) \.canvas-anchored-menu,[\s\S]*?color-mix\(in srgb, var\(--panel\) 72%, transparent\) !important;[\s\S]*?backdrop-filter: blur\(44px\) saturate\(190%\) !important;/.test(css), '小弹层浅色 72% 磨砂 + blur');
ok(!/background: #fafafa/.test(css) || !/canvas-add-panel|canvas-anchored-menu|canvas-rail-tip/.test(css.split('background: #fafafa')[0].slice(-120)), '弹层不再用 #fafafa 实底');

console.log('[O] 导出子菜单：锚定「更多」面板右侧 8px');
ok(/id="smartExportMenu" class="smart-export-menu"/.test(html) && /data-export-format="png"/.test(html) && /data-export-format="svg"/.test(html), '导出菜单与两个格式项保留');
ok(/btn\.onclick = event => \{[\s\S]*?exportSmartCanvasImage\(btn\.dataset\.exportFormat\)/.test(smart), '两个导出项的原点击逻辑未动');
ok(/window\.__novaiOpenExportSubmenuAt = openAt/.test(rail), '左栏定义 openExportSubmenuAt');
ok(/let left = panelRect\.right \+ 8;/.test(rail), '优先锚定「更多」面板右侧 8px');
ok(/left = panelRect\.left - 8 - menuRect\.width;/.test(rail), '右侧空间不足翻到左侧');
ok(/menu\.style\.left = Math\.round\(left\) \+ 'px';[\s\S]*?menu\.style\.top = Math\.round\(top\) \+ 'px';/.test(rail), '打开时设置固定 left/top');
ok(/item\.addEventListener\('click', \(\) => setTimeout\(close, 0\)\)/.test(rail), '点任一导出项后关闭子菜单');
ok(/if\(event\.key === 'Escape' && menu\.classList\.contains\('open'\)\) close\(\);/.test(rail), 'Esc 关闭导出子菜单');
ok(/__novaiExportSubmenuOpen/.test(rail) && /__novaiCloseExportSubmenu/.test(rail), '再点「导出」关闭子菜单');
ok(/#smartExportMenu\.smart-export-menu \{[\s\S]*?position: fixed !important;[\s\S]*?top: auto;[\s\S]*?right: auto;[\s\S]*?left: auto;/.test(css), '导出菜单脱离旧的右上角定位（top/right 由 JS inline 覆盖）');
ok(/#smartExportMenu\.smart-export-menu \{[\s\S]*?background: color-mix\(in srgb, var\(--panel\) 78%, transparent\)/.test(css), '深色 78% 磨砂');
ok(/html:not\(\.studio-theme-dark\) #smartExportMenu\.smart-export-menu \{[\s\S]*?color-mix\(in srgb, var\(--panel\) 72%, transparent\)/.test(css), '浅色 72% 磨砂');
ok(/#smartExportMenu\.smart-export-menu \.smart-export-item \{[\s\S]*?height: 36px;/.test(css), '导出项行高 36');

console.log('[P] 在线提示词库入口/结构');
ok(/id="onlinePromptEntry"[^>]*data-i18n="smart\.onlineLibrary"/.test(html), '模板库面板里有「在线提示词库」入口');
ok(/id="onlinePromptPanel"[^>]*hidden/.test(html) && /id="onlinePromptSearch"/.test(html) && /id="onlinePromptList"/.test(html) && /id="onlinePromptDetail"/.test(html), '在线模式容器/搜索/列表/详情节点齐全');
ok(html.indexOf('online-prompt-library.js') > 0 && html.indexOf('online-prompt-library.js') < html.indexOf('smart-canvas.js?'), 'online-prompt-library.js 在 smart-canvas 前加载');
ok(/#promptTemplatePanel\.is-online #promptTemplateBody \{ display: none !important; \}/.test(css), '在线模式隐藏本地模板列表');
ok(/\.online-prompt-card-top strong \{[\s\S]*?font-size: 13px;[\s\S]*?font-weight: 600;/.test(css) && /\.online-prompt-remark \{[\s\S]*?font-size: 11px;/.test(css), '卡片 title 13/600、remark 11');
ok(/\.online-prompt-text \{[\s\S]*?font-family: ui-monospace/.test(css), '详情 prompt 等宽字体');
ok(/window\.applyPromptTextToCanvas = applyPromptTextToCanvas;/.test(smart), '在线库复用应用逻辑（导出 applyPromptTextToCanvas）');

console.log('[Q] 在线库分类筛选');
ok(/id="onlinePromptChips"[^>]*role="group"/.test(html), '搜索框下方有分类 chips 容器');
ok(/\.online-prompt-chips \{[\s\S]*?flex-wrap: wrap;[\s\S]*?gap: 6px;/.test(css), 'chips 可换行、间距 6');
ok(/\.online-prompt-chip \{[\s\S]*?height: 24px;[\s\S]*?border-radius: var\(--radius-full\);[\s\S]*?font-size: 10\.5px;/.test(css), 'chip 24 高/full 圆角/10.5px');
ok(/\.online-prompt-chip\.is-active \{ background: var\(--soft\); color: var\(--text\); font-weight: 600; \}/.test(css), '选中 chip 软底 + 600');
ok(/if \(opts\.tag\) params\.set\('tag', String\(opts\.tag\)\);/.test(read('static/js/online-prompt-library.js')), '请求 URL 支持可选 tag');
ok(/CATEGORIES_ENDPOINT = '\/api\/prompt-library\/online\/categories'/.test(read('static/js/online-prompt-library.js')), 'categories 接口地址');
ok(/function selectTag\(key\)[\s\S]*?if \(next === state\.activeTag\) next = null;/.test(read('static/js/online-prompt-library.js')), '再点同一分类取消');
ok((i18n.match(/"smart\.onlineTag\.[a-z]+": \{ zh: "[^"]+", en: "[^"]+" \}/g) || []).length >= 33, '33 个分类中英对照 key（含 7 个虚拟分类）');
ok(/id="onlinePromptSearchHint"/.test(html), '搜索提示行节点存在');
ok(/\.online-prompt-hint \{[\s\S]*?font-size: 10\.5px;/.test(css), '提示行 10.5px 小字');
ok(/function formatSearchHint\(matchMode, expandedTerms\)/.test(read('static/js/online-prompt-library.js')), '智能搜索提示格式化函数');
ok(/没有精确匹配，已扩展搜索：\{terms\}/.test(i18n) && /以下为相关内容/.test(i18n), 'expanded/fuzzy 提示 i18n');
ok(/"smart\.onlineTag\.ecommerce": \{ zh: "电商", en: "E-commerce" \}/.test(i18n), '电商分类中英标签');
ok(/"smart\.onlineCurated": \{ zh: "精选", en: "Curated" \}/.test(i18n), '精选中英标签');
ok(/\.online-prompt-curated \{[\s\S]*?border-radius: var\(--radius-full\);[\s\S]*?font-size: 10px;/.test(css), '精选标签样式');
ok(/function isLocalItem\(item\)/.test(read('static/js/online-prompt-library.js')) && /data-online-source/.test(read('static/js/online-prompt-library.js')), 'local 判定与来源分支');

console.log('[R] 在线库刷新 / 更新时间');
ok(/id="onlinePromptUpdatedAt"/.test(html) && /id="onlinePromptRefresh"[^>]*data-i18n-title="smart\.onlineRefresh"/.test(html), '更新时间文字 + 刷新按钮存在');
ok(/\.online-prompt-refresh \{[\s\S]*?width: 24px;[\s\S]*?height: 24px;[\s\S]*?border-radius: var\(--radius-full\);/.test(css), '刷新按钮 24×24 圆形');
ok(/\.online-prompt-refresh\.is-refreshing svg \{ animation: onlinePromptSpin/.test(css), '刷新时图标转圈');
ok(/function formatUpdatedAt\(ageSeconds, stale\)/.test(read('static/js/online-prompt-library.js')), '更新时间格式化函数');
ok(/if \(opts\.refresh\) params\.set\('refresh', 'true'\);/.test(read('static/js/online-prompt-library.js')), '请求支持 refresh=true');
ok(/if \(state\.activeTag && !categories\.some\(function \(cat\) \{ return cat\.key === state\.activeTag; \}\)\)/.test(read('static/js/online-prompt-library.js')), '刷新后分类不存在回退全部');
['smart.onlineRefresh','smart.onlineUpdatedPrefix','smart.onlineJustNow','smart.onlineMinutesAgo','smart.onlineHoursAgo','smart.onlineStale'].forEach(key => {
    ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "[^"]+", en: "[^"]+" \\}').test(i18n), 'i18n 成对：' + key);
});

console.log('[S] 左栏字号统一 / 面板左上角按钮 / 素材浏览器尺寸与自定义来源');
ok(/#canvasRailTip \{ font-size: 12px; font-weight: 600; \}/.test(css), '左栏 hover 提示 12px/600');
ok(/\.asset-title,\n\.workflow-transfer-title,\n\.log-title,\n\.prompt-template-head strong,\n\.source-browser-title,\n\.canvas-more-head span \{ font-size: 13px !important; font-weight: 600 !important;/.test(css), '左栏弹窗标题统一 13/600');
ok(/id="canvasMoreClose"/.test(html) && /id="smartWorkflowCloseBtn"/.test(html), '更多/工作流有统一关闭按钮');
ok(/#assetCloseBtn,[\s\S]*?#canvasMoreClose,[\s\S]*?width: 30px !important;[\s\S]*?height: 30px !important;[\s\S]*?position: absolute !important;[\s\S]*?left: 8px !important;/.test(css), '关闭按钮统一 30px、面板左上角');
ok(/id="sourceBrowserCustomBar"/.test(html) && /data-source-key="custom"/.test(html), '素材浏览器有自定义来源 tab/地址栏');
ok(/id="sourceBrowserBottomResize"/.test(html) && /PANEL_MIN_HEIGHT = 400/.test(read('static/js/source-browser.js')), '底边高度拖拽 + 最小 400');
ok(/\.source-browser-panel \{\n    top: 8px;[\s\S]*?height: var\(--source-browser-height/.test(css), '素材浏览器高度可调');
ok(/id="onlinePromptDetail"/.test(html) && /\.online-prompt-detail\[hidden\] \{ display: none !important; \}/.test(css) && /online-prompt-detail-close/.test(read('static/js/online-prompt-library.js')), '在线库详情默认隐藏 + 关闭按钮');
ok(!/canvas-rail-badge/.test(html), '资产库无黑点 badge');

console.log('[T] 在线素材改名 / 网页缩放 / 右下角大小手柄 / 返回「<」');
ok(/"source\.panelTitle": \{ zh: "在线素材", en: "Online assets" \}/.test(i18n), '「在线素材」中英 i18n');
ok(/id="canvasRailSource"[^>]*title="在线素材"[^>]*aria-label="在线素材"/.test(html), '左栏 tooltip 改名在线素材');
ok(/id="sourceBrowserPanel"[^>]*aria-label="在线素材"/.test(html) && /source-browser-title[\s\S]*?在线素材/.test(html), '面板标题/aria 改名在线素材');
ok(/id="sourceBrowserZoom"/.test(html) && /id="sourceBrowserZoomPercent"/.test(html) && /id="sourceBrowserZoomReset"/.test(html), '缩放控件 − 100% + 重置');
ok(/\.source-browser-zoom\[hidden\] \{ display: none !important; \}/.test(css), '无 IPC 时缩放控件隐藏（浏览器降级）');
ok(/source_zoom|set_source_zoom/.test(read('static/js/source-browser.js')), '缩放走主进程 source-zoom IPC');
ok(/id="sourceBrowserCornerResize"/.test(html) && /\.source-browser-resize-corner \{[\s\S]*?width: 20px;[\s\S]*?height: 20px;[\s\S]*?nwse-resize/.test(css), '右下角 20×20 斜线手柄');
ok(/PANEL_MIN_HEIGHT = 400/.test(read('static/js/source-browser.js')) && /Math\.min\(1200/.test(read('static/js/source-browser.js')), '大小上限 min(90vh,1200)');
ok(/id="sourceBrowserCloseBtn"[\s\S]{0,200}?data-lucide="x"/.test(html), '在线素材关闭图标为 ×');
['assetCloseBtn','smartWorkflowCloseBtn','promptTemplateClose','canvasMoreClose'].forEach(id => {
    ok(new RegExp('id="' + id + '"[\\s\\S]{0,260}?data-lucide="chevron-left"').test(html), '返回图标统一 chevron-left：' + id);
});
ok(/log-head[\s\S]*?data-lucide="chevron-left"/.test(html), '日志返回图标 chevron-left');
ok(/setEntryLabel\(t\('smart\.onlineBack'/.test(read('static/js/online-prompt-library.js')), '在线库返回本地库换成「<」图标');

console.log('[U] 右下角把手图标 / 面板事件隔离');
ok(/id="sourceBrowserCornerResize"[\s\S]*?source-browser-corner-icon[\s\S]*?<path d="M5 14 H14 V5"[\s\S]*?<path d="M9 14 H14 V9"/.test(html), '把手为 16×16 两条 L 形短线 SVG');
ok(/\.source-browser-resize-corner \{[\s\S]*?opacity: \.55;[\s\S]*?\.source-browser-resize-corner:hover \{ opacity: \.9; \}/.test(css), '把手 muted/.55，hover .9');
ok(/\.source-browser-resize-corner \{[\s\S]*?background: transparent;/.test(css), '把手无底色');
ok(/\.source-browser-resize-corner \{\s*right: 8px;\s*bottom: 8px;\s*\}/.test(css), '把手右下内缩 8px（避开圆角）');
ok(/bindPanelEventIsolation/.test(read('static/js/canvas-rail.js')) && /const types = \['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'\]/.test(read('static/js/canvas-rail.js')), '面板级事件隔离含 dblclick');
['assetPanel','smartWorkflowTransferModal','smartLogModal','canvasLeftMorePanel','sourceBrowserPanel','promptTemplatePanel'].forEach(id => {
    ok(new RegExp("'" + id + "'").test(read('static/js/canvas-rail.js')), '事件隔离覆盖：' + id);
});

console.log('[V] 在线素材浮层形态');
ok(html.includes('id="sourceBrowserPanel"'), '旧面板节点保留（id 不删）');
ok(/\.source-browser-panel \{[\s\S]*?left: 16px !important;[\s\S]*?top: 64px !important;[\s\S]*?width: var\(--source-browser-width, 520px\) !important;[\s\S]*?height: var\(--source-browser-height, calc\(100vh - 124px\)\) !important;[\s\S]*?border-radius: 24px !important;/.test(css), '浮层 left16/top64/默认520/可拖尺寸/圆角24');
ok(/\.source-browser-panel \.source-browser-stage \{[\s\S]*?left: 12px !important;[\s\S]*?right: 12px !important;[\s\S]*?top: 12px !important;[\s\S]*?bottom: 12px !important;/.test(css), '页面区域四周内缩 12');
ok(/\.source-browser-panel:not\(\.is-fallback\) \.source-browser-head,[\s\S]*?\.source-browser-tabs,[\s\S]*?\.source-browser-foot,[\s\S]*?\.source-browser-custom \{[\s\S]*?display: none !important;/.test(css), '桌面形态隐藏旧 header/tabs/footer/custom');
ok(/\.source-browser-panel\.is-fallback \.source-browser-stage \{ top: 64px !important; \}/.test(css), '降级时给最小 header 留位');
ok(/const FULLSCREEN_MODE = false/.test(read('static/js/source-browser.js')) && !/classList\.add\('source-fullscreen'\)/.test(read('static/js/source-browser.js').replace(/if\(FULLSCREEN_MODE\)[\s\S]*?\}/g,'')), '不添加 body.source-fullscreen');
console.log('[W] 在线素材网页铺满布局');
ok(/\.source-browser-panel \.source-browser-head,[\s\S]*?\.source-browser-panel:not\(\.is-fallback\) \.source-browser-head,[\s\S]*?display: none !important;/.test(css), '旧 header 隐藏');
ok(/\.source-browser-panel \.source-browser-tabs,[\s\S]*?\.source-browser-panel:not\(\.is-fallback\) \.source-browser-tabs,[\s\S]*?display: none !important;/.test(css), '旧 tabs 隐藏');
ok(/\.source-browser-panel \.source-browser-stage,[\s\S]*?\.source-browser-panel\.is-fallback \.source-browser-stage \{[\s\S]*?left: 12px !important;[\s\S]*?right: 12px !important;[\s\S]*?top: 12px !important;[\s\S]*?bottom: 12px !important;/.test(css), '网页区四周内缩 12，无安全区');
ok(/const FULLSCREEN_MODE = false/.test(read('static/js/source-browser.js')) && /novai:source-view-closed/.test(read('static/js/source-browser.js')), '浮层 + 注入 × 事件别名');
ok(/id="sourceBrowserCloseBtn"[\s\S]{0,200}?data-lucide="x"/.test(html), '旧节点保留（关闭按钮仍在 DOM）');

console.log('[X] 左栏更多面板');
ok(/#canvasLeftMorePanel \.canvas-more-head \{ display: none !important; \}/.test(css), '更多面板 header 隐藏（节点保留）');
ok(/#canvasLeftMorePanel \{ padding-top: 10px !important; \}/.test(css), '更多面板顶部留 10px');
ok(/\(html\.match\(\/data-left-more=\/g\) \|\| \[\]\)\.length === 5/.test(html) || (html.match(/data-left-more=/g) || []).length === 5, '更多面板保留 5 个菜单项');
ok(/id="canvasMoreClose"/.test(html) && /class="canvas-more-head"/.test(html), 'header/返回键节点保留在 DOM');
ok(/#canvasLeftMorePanel :where\(button, span\) \{ font-size: 12px; \}/.test(css), '菜单项字号样式不变');

console.log('');
console.log('画布页布局回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(label => console.log('  ✗ ' + label));
if(fails.length) process.exit(1);
