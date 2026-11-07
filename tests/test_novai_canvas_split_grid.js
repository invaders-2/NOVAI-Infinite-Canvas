#!/usr/bin/env node
'use strict';
/**
 * 智能画布BEAT（canvas-next）图片节点「更多」菜单里的「快速切分」：
 * 一整行菜单项 + 8×8 网格子浮层 —— 浮层挂在「更多」菜单内部（父菜单保持展开），
 * 贴在「快速切分」这一行右侧、顶部与行对齐；悬停预览「列×行」，点击按所选列×行切分。
 * 只读源码 / 构建产物做断言，不需要跑浏览器。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ui = 'novai-canvas-ui/src/canvas/canvas-next/ui';

/* ---------- 菜单行 + 父菜单保持展开 ---------- */
const reg = read(ui + '/editors/registry.tsx');
assert(reg.includes('function MoreMenu('), '「更多」菜单内容收进 MoreMenu 组件');
assert(reg.includes('if (kind === "more" && anchor) return openPop(anchor, (close) => <MoreMenu ctl={ctl} id={id} n={n} close={close} />, "down", "left", "split-menu-pop");'), '「更多」弹层带 split-menu-pop 类，内容交给 MoreMenu');
assert(!/openPop\([^)]*SplitGrid/.test(reg), '网格不再用 openPop 开二级弹层（那会顶掉父菜单）');
assert(reg.includes('data-k="split-menu"'), '菜单里有「快速切分」这一行（data-k="split-menu"）');
const rowStart = reg.indexOf('data-k="split-menu"');
const row = reg.slice(rowStart - 500, rowStart + 900);
assert(row.includes('className={"mi split-menu" + (fly.key === "split" ? " on" : "")}'), '整行沿用 .mi 风格，展开时加 .on');
assert(row.includes('aria-expanded={fly.key === "split"}'), '行带 aria-expanded');
assert(row.includes('快速切分'), '行内文字是「快速切分」');
assert(/<Icon name="(grid|split)" size="s" \/>快速切分/.test(row), '左侧是线性 split / grid 图标');
assert(!reg.includes('split-quick') && !row.includes('data-k={"split-" + k}'), '行里不再有 2×2 / 3×3 / 4×4 快捷值');
assert(!reg.includes('split-2') && !reg.includes('split-3') && !reg.includes('split-4'), '源码里没有 split-2 / split-3 / split-4');
assert(!reg.includes('split(ctl, id, k, k)'), '不再有快捷值的正方形切分调用');
assert(row.includes('<Icon name="right" size="s" className="chev" />'), '行末是线性 chevron-right（只剩 图标 + 文字 + ›）');
assert(row.includes('onPointerEnter={(e) => fly.open("split", e.currentTarget)}') && row.includes('onPointerLeave={fly.hideSoon}') && row.includes('onFocus={(e) => fly.open("split", e.currentTarget)}'), '悬停 / 聚焦行就打开浮层（不用点击）');
assert(row.includes('onClick={(e) => fly.open("split", e.currentTarget)}'), '点行同样打开（触屏兜底），不会 toggle 掉刚悬停打开的浮层');
assert(row.includes('if (e.key === "Enter" || e.key === " ")'), '行支持 Enter / Space');
assert(reg.includes('window.setTimeout(() => setKey(null), 140)'), '离开行 / 浮层后 140ms 再关闭');
assert(reg.includes('onPointerEnter={fly.clearHide} onPointerLeave={fly.hideSoon}'), '进入浮层取消这次关闭，离开浮层再关');
assert(reg.includes('useEffect(() => clearHide, [])'), '卸载时清掉延时关闭的定时器');

/* ---------- 切换意图：已有浮层时换行要停留 200ms，斜穿相邻行不抢浮层 ---------- */
assert(reg.includes('const switchT = useRef<number | null>(null);'), '有一个「待切换」定时器');
assert(reg.includes('if (key == null) { rowEl.current = el; setKey(k); return; }'), '没有浮层时首次打开仍然即时（悬停即弹出）');
assert(reg.includes('if (key === k) return;'), '同一行重复悬停不重切');
assert(reg.includes('switchT.current = window.setTimeout(() => { switchT.current = null; rowEl.current = el; setKey(k); }, 200);'), '换行只记 200ms 悬停意图，停留够久才真的切');
assert(reg.includes('if (switchT.current != null) { window.clearTimeout(switchT.current); switchT.current = null; }'), '进浮层 / 离开行时把待切换定时器一起清掉');
{
  const hook = reg.slice(reg.indexOf('function useMenuFlyout()'), reg.indexOf('function MoreMenu('));
  assert.strictEqual((hook.match(/window\.setTimeout/g) || []).length, 3, 'hook 里只有三个定时器：待切换 200 / 延时关 140 / 入场后重测 260');
  assert(/switchT\.current = window\.setTimeout\([\s\S]{0,120}?, 200\);/.test(hook), '切换定时器是 200ms');
  assert(hook.includes('hideT.current = window.setTimeout(() => setKey(null), 140)'), '延时关闭仍是 140ms');
}

/* ---------- 「旋转」行：同一套悬停子菜单，在「抠图」后、「快速切分」前 ---------- */
assert(reg.includes('data-k="rotate-menu"'), '菜单里有「旋转」这一行（data-k="rotate-menu"）');
const rotStart = reg.indexOf('data-k="rotate-menu"');
const rot = reg.slice(rotStart - 500, rotStart + 900);
assert(rot.includes('className={"mi rotate-menu" + (fly.key === "rotate" ? " on" : "")}'), '旋转行沿用 .mi 风格，展开时加 .on');
assert(rot.includes('aria-expanded={fly.key === "rotate"}'), '旋转行带 aria-expanded');
assert(rot.includes('<Icon name="undo" size="s" />旋转'), '旋转行是 undo 图标 + 「旋转」文字');
assert(rot.includes('<Icon name="right" size="s" className="chev" />'), '旋转行末是线性 chevron-right');
assert(rot.includes('onPointerEnter={(e) => fly.open("rotate", e.currentTarget)}') && rot.includes('onFocus={(e) => fly.open("rotate", e.currentTarget)}'), '悬停 / 聚焦旋转行打开子菜单');
assert(rot.includes('onClick={(e) => fly.open("rotate", e.currentTarget)}'), '点旋转行同样打开（触屏兜底）');
assert(reg.indexOf('data-k="cutout"') < reg.indexOf('data-k="rotate-menu"') && reg.indexOf('data-k="rotate-menu"') < reg.indexOf('data-k="split-menu"'), '「旋转」排在「抠图」之后、「快速切分」之前');
assert(!reg.includes('<div className="mh">旋转与翻转</div>'), '旧的「旋转与翻转」小节标题已删除');
assert(!reg.includes('data-k={"tf-" + op}'), '旧的 4 个常驻 .seg 按钮（tf-*）已删除');

/* ---------- 旋转子菜单：4 项 → transformImage ---------- */
assert(reg.includes('className="rotate-flyout"'), '旋转子菜单是 .rotate-flyout');
assert(reg.includes('data-k="rotate-flyout"'), '旋转浮层带 data-k="rotate-flyout"');
for (const k of ['rotate-ccw', 'rotate-cw', 'rotate-fh', 'rotate-fv']) assert(reg.includes(k), '旋转子菜单有 ' + k);
assert(reg.includes('([["ccw", "左旋 90°", "rotate-ccw"], ["cw", "右旋 90°", "rotate-cw"], ["fh", "水平翻转", "rotate-fh"], ["fv", "垂直翻转", "rotate-fv"]] as const)'), '4 个选项：左旋 / 右旋 / 水平翻转 / 垂直翻转');
assert(reg.includes('<button key={op} className="mi" data-k={k} onClick={() => { close(); void transformImage(store, id, op); }}>{label}</button>'), '点子项：关菜单 + transformImage(store, id, op)');

/* ---------- 共用 hook：定位 / 开合只写一份 ---------- */
assert(reg.includes('function useMenuFlyout()'), '定位与开合抽成 useMenuFlyout 共用 hook');
assert(reg.includes('type FlyKey = "rotate" | "split" | "enhance";'), 'hook 用单值 key 管理「同一时刻只开一个」（旋转 / 切分 / 增强）');
assert(reg.includes('const [key, setKey] = useState<FlyKey | null>(null);'), 'key 单值 → 悬停另一行自动切换');
assert.strictEqual((reg.match(/const pr = pop\.getBoundingClientRect/g) || []).length, 1, 'measure 代码只写一份（没有复制两份定位）');
assert.strictEqual((reg.match(/style={flyStyle}/g) || []).length, 3, '三个子浮层共用同一个 flyStyle');

/* ---------- 子浮层：挂在菜单里，贴行右侧 ---------- */
assert(reg.includes('className="split-flyout"'), '浮层是 .split-flyout（不再是独立的 #pop.split-pop）');
assert(!reg.includes('className="sg-panel"'), 'SplitGrid 不再自己套面板外壳（面板样式归 .split-flyout）');
assert(reg.includes('data-k="split-grid"') && reg.includes('data-testid="split-flyout"'), '浮层带 data-k / data-testid');
assert(reg.includes('const rowEl = useRef<HTMLElement | null>(null);'), '当前行的元素由 hook 记下（悬停另一行会换）');
assert(reg.includes('useLayoutEffect(() => {'), '位置用 useLayoutEffect 量');
assert(reg.includes('const pop = row.closest("#pop");'), '以 #pop 为定位基准');
assert(reg.includes('const pr = pop.getBoundingClientRect(), rr = row.getBoundingClientRect();'), '按 #pop 与行的实测矩形定位');
assert(reg.includes('const margin = 8, gap = 8, fw = el.offsetWidth, fh = el.offsetHeight;'), '左右 gap 8、视口 margin 8，按浮层自身宽高算');
assert(reg.includes('const top = clamp(rr.top - pr.top, margin - pr.top, Math.max(margin - pr.top, innerHeight - margin - fh - pr.top));'), 'top = 行顶部相对 #pop 的偏移，并 clamp 进视口（下方不够就上移）');
assert(reg.includes('const toRight = pr.width + gap;'), '默认贴菜单面板右缘 + 8（距面板边缘 8px，不贴行）');
assert(reg.includes('const flip = pr.left + toRight + fw > innerWidth - margin && pr.left - gap - fw >= margin;'), '右侧放不下就翻到菜单左侧');
assert(reg.includes('? { top, right: pr.width + gap }'), '翻到左侧时同样距面板边缘 8px');
assert(reg.includes('const flyStyle: React.CSSProperties = {'), '定位结果转成共用的一份 flyStyle');
assert(reg.includes('top: fly.pos?.top ?? 0, visibility: fly.pos ? undefined : "hidden"'), '定位前先隐藏，避免首帧闪现');
assert(reg.includes('...(fly.pos?.right != null ? { right: fly.pos.right } : { left: fly.pos?.left ?? 0 })'), '翻左侧时改用 right 偏移');
assert(reg.includes('window.addEventListener("resize", measure)'), '窗口尺寸变化重新定位');
assert(reg.includes('new ResizeObserver(measure)'), '浮层尺寸变化重新定位');

/* ---------- 8×8 网格 ---------- */
assert(reg.includes('const SPLIT_MAX = 8'), '网格上限 8（8 列 × 8 行）');
assert(reg.includes('for (let r = 1; r <= SPLIT_MAX; r++) for (let c = 1; c <= SPLIT_MAX; c++)'), '双层循环铺满 8×8 = 64 格');
assert(reg.includes('useState({ cols: 1, rows: 1 })'), '默认选中 1×1');
assert(reg.includes('onPointerEnter={() => setPick({ cols: c, rows: r })}'), '鼠标悬停写入 {cols, rows}');
assert(reg.includes('(c <= pick.cols && r <= pick.rows ? " on" : "")'), '左上角 cols×rows 区域高亮');
assert(reg.includes('data-c={c} data-r={r}'), '格子带 data-c / data-r（方便 e2e）');
assert(reg.includes('aria-label={`${c} 列 × ${r} 行`}'), '格子 aria-label 是「N 列 × M 行」');
assert(reg.includes('data-k="split-label">{pick.cols}×{pick.rows}</div>'), '下方标签显示「列×行」');
assert(reg.includes('onClick={() => { close(); void split(ctl, id, c, r); }}'), '点格子先关整个菜单，再按所选列×行切分');

/* ---------- split 泛化成 cols × rows ---------- */
assert(reg.includes('async function split(ctl: Ctl, id: string, cols: number, rows: number)'), 'split 签名是 (ctl, id, cols, rows)');
const spStart = reg.indexOf('async function split(');
const sp = reg.slice(spStart, reg.indexOf('* 视频截帧', spStart));
assert(sp.includes('const W = im.naturalWidth / c0, H = im.naturalHeight / r0'), '按列 / 行取 cell 宽高');
assert(sp.includes('n.x + n.w + 80 + c * (cw + ') && sp.includes('n.y + r * (ch(cw) + '), '新节点按 cols 列 × rows 行排开（80 起始 + 按列 / 行间距，具体数值可变）');
assert(sp.includes('const title = `${genOf(n).title} ${r + 1}-${c + 1}`'), '标题沿用「原题 行-列」');
assert(sp.includes('edges.push({ id: uid("e"), from: n.id, to: t.id })'), '每张都连到原图');
assert(sp.includes('张（${c0} 列 × ${r0} 行），每张都连到原图'), 'toast 说明张数与列×行');
assert(sp.includes('这张图还没有画面'), '无画面给提示，不抛错');
assert(sp.includes('.catch(() => null)'), '图片读取失败走提示，不抛错');

/* ---------- 样式：写进 editors.css ---------- */
const css = read(ui + '/editors/editors.css');
assert(/\.cn-root \.mi\.split-menu,\.cn-root \.mi\.rotate-menu,\.cn-root \.mi\.enhance-menu\{[^}]*white-space:nowrap/.test(css), 'editors.css 里「快速切分」「旋转」「增强」三行共用一套行样式（不换行）');
assert(css.includes('.cn-root #pop.split-menu-pop{overflow:visible;}'), '菜单弹层放开 overflow，浮层不会被裁');
assert(css.includes('.cn-root #pop.split-menu-pop .mi.split-menu.on,.cn-root #pop.split-menu-pop .mi.rotate-menu.on,.cn-root #pop.split-menu-pop .mi.enhance-menu.on{background:color-mix(in srgb,var(--fg) 10%,transparent);'), '展开时整行软底高亮 + 文字提亮（三行共用）');
assert(css.includes('.cn-root #pop.split-menu-pop .mi.split-menu.on:after,.cn-root #pop.split-menu-pop .mi.rotate-menu.on:after,.cn-root #pop.split-menu-pop .mi.enhance-menu.on:after{content:none;}'), '停用 .mi.on 自带的勾选标记');
const fly = (css.match(/\.cn-root \.split-flyout,\.cn-root \.rotate-flyout\{[^}]*\}/) || [''])[0];
assert(fly, 'editors.css 有共用的浮层外壳（.split-flyout / .rotate-flyout）');
assert(/position:absolute/.test(fly) && /z-index:2/.test(fly), '浮层 absolute 且层级高于菜单');
assert(/border-radius:16px/.test(fly), '浮层圆角 16');
assert(/background:rgba\(24,24,24,\.95\)/.test(fly), '小弹层用近乎不透明实底（深色 .95）');
assert(/backdrop-filter:none/.test(fly), '近实底不再依赖磨砂');
assert(!/border:/.test(fly), '面板不画边框');
assert(!/inset 0 0 0 1px/.test(fly), '面板不用 1px 发丝描边');
assert(css.includes('.cn-root[data-theme="light"] .split-flyout,.cn-root[data-theme="light"] .rotate-flyout{background:rgba(255,255,255,.96)'), '浅色主题同样是近不透明实底');
const splitPanel = (css.match(/\.cn-root \.split-flyout\{[^}]*\}/) || [''])[0];
assert(/padding:16px/.test(splitPanel), '快速切分面板内边距 16（尺寸没变）');
// 共用外壳那条选择器里也含 ".cn-root .rotate-flyout{"，这里锚到行首才是独立宽度规则
const rotPanel = (css.match(/(?:^|\n)\.cn-root \.rotate-flyout\{[^}]*\}/) || [''])[0];
assert(rotPanel, 'editors.css 有 .rotate-flyout 面板');
assert(/min-width:168px/.test(rotPanel) && /max-width:190px/.test(rotPanel) && /padding:6px/.test(rotPanel), '旋转子菜单宽 168–190、内边距 6');
const cells = (css.match(/\.split-flyout \.sg-cells\{[^}]*\}/) || [''])[0];
assert(/grid-template-columns:repeat\(8,22px\)/.test(cells) && /gap:9px/.test(cells), '8 列 × 22px 方块、间距 9');
assert(!/repeat\(8,32px\)/.test(css) && !/gap:16px/.test(cells), '旧的 32px / 16 间距已换掉');
const cell = (css.match(/\.split-flyout \.sg-c\{[^}]*\}/) || [''])[0];
assert(/width:22px/.test(cell) && /height:22px/.test(cell) && /border-radius:6px/.test(cell), '格子 22×22、圆角 6');
assert(/box-shadow:inset 0 0 0 1px color-mix\(in srgb,var\(--fg\) 14%,transparent\)/.test(cell), '未选中格子有淡描边');
const on = (css.match(/\.split-flyout \.sg-c\.on\{[^}]*\}/) || [''])[0];
assert(/background:color-mix\(in srgb,var\(--fg\)/.test(on), '高亮实底由 --fg 经 color-mix 推出（深浅主题都成立）');
assert(/box-shadow:inset 0 0 0 1\.5px color-mix\(in srgb,var\(--fg\)/.test(on), '选中是亮 1.5px 内描边（图形例外）');
assert(/\.split-flyout \.sg-label\{[^}]*margin-top:12px/.test(css) && /\.split-flyout \.sg-label\{[^}]*font-size:18px/.test(css) && /\.split-flyout \.sg-label\{[^}]*font-weight:640/.test(css), '标签 18px / 640 / 上间距 12');
assert(!css.includes('.mi.split-menu .k'), '快捷值相关的 .k 样式已删除');
assert(!css.includes('#pop.split-pop'), '旧的面板选择器 #pop.split-pop 已迁到 .split-flyout');
assert(!read(ui + '/canvas-next.css').includes('split-flyout') && !read(ui + '/canvas-next.css').includes('split-menu-pop'), '没有动 canvas-next.css');

/* ---------- 构建产物 ---------- */
const built = read('static/novai-canvas/canvas.js');
assert(built.includes('快速切分'), '构建产物里有「快速切分」');
assert(built.includes('split-flyout') && built.includes('split-menu-pop') && built.includes('split-grid') && built.includes('split-label'), '构建产物里有浮层 / 菜单类名与 data-k');
assert(built.includes('这张图还没有画面'), '构建产物里有「没有画面」提示');
assert(built.includes('每张都连到原图'), '构建产物里有切分 toast');
const builtCss = read('static/novai-canvas/canvas.css');
assert(builtCss.includes('.cn-root .split-flyout{'), '构建产物 CSS 带 .split-flyout 面板');
assert(builtCss.includes('#pop.split-menu-pop'), '构建产物 CSS 带 #pop.split-menu-pop');
assert(builtCss.includes('repeat(8,22px)'), '构建产物 CSS 带 8 列 22px 网格');
assert(built.includes('rotate-flyout') && built.includes('rotate-menu'), '构建产物里有两个子浮层 / 两行');
assert(built.includes('左旋 90°') && built.includes('rotate-ccw') && built.includes('rotate-fv'), '构建产物里有旋转子菜单');
assert(builtCss.includes('.cn-root .rotate-flyout{') && builtCss.includes('min-width:168px'), '构建产物 CSS 带 .rotate-flyout 宽度');
assert(/\.split-flyout \.sg-c\.on\{[^}]*color-mix/.test(builtCss), '构建产物 CSS 带高亮 color-mix');

console.log('[PASS] 图片节点「快速切分」：菜单行 + 菜单内 8×8 网格浮层（父菜单保留 / 贴行右侧）/ 悬停预览 / 列×行切分 / 样式 / 构建产物');
