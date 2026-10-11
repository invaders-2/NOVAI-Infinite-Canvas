/* ════════════════════════════════════════════════════════════════
 * NOVAI 图片节点 · 专业调色面板（imageEditModal 的 adjust 模式）
 * 传统画布(canvas.html/canvas.js) 与 智能画布(smart-canvas.html/smart-canvas.js) 共用。
 * 渲染：image-adjust-engine.js（WebGL 自写着色器）。样式：css/image-adjust.css（iaj- 前缀）。
 * 对外接口与旧版一致：
 *   window.imageAdjustEnterMode / imageAdjustLeaveMode / applyImageAdjust / scheduleAdjustRender / imageAdjustIsAdjustMode
 *   window.imageAdjust（两端 js 提供）：currentSource() → {url,name,adjust?} / upload / addResult(file, fromAI, meta) / finish
 * 再次编辑：应用后新节点带 adjust = {v, source:{url,name}, params}；再进调色时从原图 + 这组参数继续。
 * ════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (!document.getElementById('cropImage')) return;
    const E = window.NovaAdjustEngine;
    if (!E) { console.warn('[image-adjust] 引擎未加载'); return; }

    const LS_PRESETS = 'novai_adjust_presets', LS_CLIP = 'novai_adjust_clipboard', LS_OPEN = 'novai_adjust_open';
    const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
    const clone = o => JSON.parse(JSON.stringify(o));
    const $ = (sel, root) => (root || document).querySelector(sel);
    const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    /* ── 线性图标 ── */
    const ICON = {
        chev: '<path d="m6 9 6 6 6-6"/>',
        eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
        eyeoff: '<path d="M9.9 4.24A9 9 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.16 3.19M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/>',
        reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
        undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
        wand: '<path d="m15 4-1 1M4 20l11-11M18 3l-1 1M21 6l-1 1M14 2v2M22 10h-2M20 14h-1"/><path d="m15 9-1-1"/>',
        split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
        side: '<rect x="2" y="5" width="9" height="14" rx="1.5"/><rect x="13" y="5" width="9" height="14" rx="1.5"/>',
        single: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
        paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
        pick: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
        target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'
    };
    const ic = (n, s) => `<svg class="iaj-ic" width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

    /* ── 预设（只写与中性值不同的参数）── */
    const C = (pts) => pts;
    const BUILTIN = [
        { name: '原图', p: {} },
        { name: '明亮通透', p: { exposure: 35, contrast: -10, highlights: -30, shadows: 35, whites: 15, clarity: 8, vibrance: 15, dehaze: 8 } },
        { name: '暖阳日系', p: { temp: 22, tint: 4, exposure: 20, contrast: -12, shadows: 25, vibrance: 10, saturation: -8, grade: { sh: { h: 40, s: 12, l: 6 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 45, s: 18, l: 0 }, gl: { h: 0, s: 0, l: 0 }, blend: 60, balance: 10 }, curve: { l: C([[0, 0.06], [0.5, 0.53], [1, 0.97]]), r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } } },
        { name: '冷调电影', p: { temp: -18, contrast: 18, highlights: -25, shadows: 10, saturation: -12, grade: { sh: { h: 205, s: 28, l: -4 }, mid: { h: 190, s: 8, l: 0 }, hi: { h: 40, s: 10, l: 0 }, gl: { h: 0, s: 0, l: 0 }, blend: 50, balance: -10 }, vignette: -20 } },
        { name: '青橙对比', p: { contrast: 20, vibrance: 18, hsl: { h: [0, -8, -12, 30, 0, -10, 0, 0], s: [0, 12, -10, -25, 10, 10, 0, 0], l: [0, 6, 0, -10, 0, -8, 0, 0] }, grade: { sh: { h: 190, s: 32, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 32, s: 26, l: 0 }, gl: { h: 0, s: 0, l: 0 }, blend: 55, balance: 0 } } },
        { name: '复古胶片', p: { temp: 12, contrast: -8, highlights: -20, saturation: -22, grain: 28, grainSize: 35, vignette: -24, curve: { l: C([[0, 0.1], [0.25, 0.27], [0.75, 0.76], [1, 0.92]]), r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: C([[0, 0.06], [1, 0.94]]) }, grade: { sh: { h: 30, s: 14, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 50, s: 12, l: 0 }, gl: { h: 0, s: 0, l: 0 }, blend: 50, balance: 0 } } },
        { name: '黑白经典', p: { saturation: -100, contrast: 25, clarity: 15, highlights: -15, shadows: 10, grain: 12, curve: { l: C([[0, 0.02], [0.3, 0.25], [0.7, 0.76], [1, 1]]), r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } } },
        { name: '柔光梦幻', p: { exposure: 18, contrast: -20, highlights: -10, shadows: 20, soft: 45, glow: 20, clarity: -18, vibrance: 8, temp: 6 } },
        { name: '鲜亮美食', p: { temp: 10, exposure: 12, contrast: 12, shadows: 15, vibrance: 30, saturation: 8, texture: 15, clarity: 10, hsl: { h: [0, 0, 0, 0, 0, 0, 0, 0], s: [8, 15, 10, 0, 0, 0, 0, 0], l: [0, 8, 6, 0, 0, 0, 0, 0] } } }
    ];
    function withPreset(pp, s) {
        const n = E.neutral(), out = E.neutral();
        const mix = (a, b) => Math.round(a + (b - a) * s);
        for (const k in pp) {
            const v = pp[k];
            if (typeof v === 'number') out[k] = mix(n[k], v);
            else if (k === 'curve') { for (const ch of ['l', 'r', 'g', 'b']) out.curve[ch] = (v[ch] || [[0, 0], [1, 1]]).map(([x, y]) => [x, x + (y - x) * s]); }
            else if (k === 'hsl') { for (const t of ['h', 's', 'l']) out.hsl[t] = (v[t] || n.hsl[t]).map(x => Math.round(x * s)); }
            else if (k === 'grade') { for (const r of ['sh', 'mid', 'hi', 'gl']) out.grade[r] = { h: v[r].h, s: Math.round(v[r].s * s), l: Math.round(v[r].l * s) }; out.grade.blend = v.blend; out.grade.balance = Math.round(v.balance * s); }
        }
        return out;
    }

    /* ── 状态 ── */
    const S = {
        active: false, eng: null, cv: null, img: null, origImg: null, srcUrl: '', srcName: 'image', reedit: false,
        params: E.neutral(), compare: 'single', splitX: 50, hold: false,
        hist: [], hidx: -1, commitTimer: 0, raf: 0, anaTimer: 0,
        preset: null, presetMine: false, strength: 80, presetTab: 'builtin',
        open: lsGet(LS_OPEN, { basic: true, presence: true }), curveCh: 'l', hslTab: 'h', gradeTab: '3',
        pick: null, built: false, curveSel: -1
    };

    /* ── 参数读写（路径形式 'grade.sh.l' / 'hsl.s.3'）── */
    function getP(path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), S.params); }
    function setP(path, v) {
        const ks = path.split('.'); let o = S.params;
        for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
        o[ks[ks.length - 1]] = v;
    }
    function defaultOf(path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), E.neutral()); }

    /* ═════════ 滑块组件 ═════════ */
    const SLIDERS = new Map(); /* path → {el, def} */
    function sliderHTML(path, label, min, max, opt) {
        opt = opt || {};
        const bip = min < 0;
        const track = opt.track ? ` style="background:${opt.track}"` : '';
        const lab = opt.dot ? `<i class="iaj-dot" style="background:${opt.dot}"></i>${label}` : label;
        return `<div class="iaj-sl${opt.colored ? ' colored' : ''}${opt.cls ? ' ' + opt.cls : ''}" data-path="${path}" data-min="${min}" data-max="${max}" data-fmt="${opt.fmt || ''}">
<span class="lb" title="双击复位">${lab}</span><span class="tr" tabindex="0" role="slider" aria-label="${esc(label)}"${track}>${bip ? '<i class="tk"></i>' : ''}${opt.track ? '' : '<i class="fl"></i>'}<i class="th"></i></span><input class="vl" spellcheck="false" aria-label="${esc(label)} 数值"></div>`;
    }
    function fmtVal(el, v) {
        const f = el.dataset.fmt, bip = Number(el.dataset.min) < 0;
        if (f === 'ev') return (v > 0 ? '+' : '') + (v / 100).toFixed(2);
        if (f === 'r') return (v / 10).toFixed(1);
        if (f === 'pct') return v + '%';
        return bip && v > 0 ? '+' + v : String(v);
    }
    function paintSlider(el) {
        const path = el.dataset.path, min = Number(el.dataset.min), max = Number(el.dataset.max);
        const v = path === '@strength' ? S.strength : getP(path);
        const pct = (v - min) / (max - min) * 100;
        const c = min < 0 ? (0 - min) / (max - min) * 100 : 0;
        const th = el.querySelector('.th'), fl = el.querySelector('.fl'), vl = el.querySelector('.vl'), tr = el.querySelector('.tr');
        th.style.left = pct + '%';
        if (fl) { const a = Math.min(c, pct), b = Math.max(c, pct); fl.style.left = a + '%'; fl.style.width = (b - a) + '%'; }
        if (document.activeElement !== vl) vl.value = fmtVal(el, v);
        tr.setAttribute('aria-valuenow', v);
        const def = path === '@strength' ? 80 : defaultOf(path);
        el.classList.toggle('on', v !== def);
    }
    function paintAllSliders(root) { (root || S.panel).querySelectorAll('.iaj-sl').forEach(paintSlider); }
    function setSliderValue(el, v, live) {
        const min = Number(el.dataset.min), max = Number(el.dataset.max);
        v = Math.round(clamp(v, min, max));
        const path = el.dataset.path;
        if (path === '@strength') { S.strength = v; applyPreset(S.preset, S.presetMine, true); }
        else { setP(path, v); afterChange(live); }
        paintSlider(el);
        onSliderSide(path);
    }
    function onSliderSide(path) {
        if (path.startsWith('grade.')) paintWheels();
    }
    function bindSliders(root) {
        root.querySelectorAll('.iaj-sl').forEach(el => {
            if (el._b) return; el._b = true;
            const tr = el.querySelector('.tr'), vl = el.querySelector('.vl');
            const min = Number(el.dataset.min), max = Number(el.dataset.max);
            const fromX = x => { const r = tr.getBoundingClientRect(); return min + clamp((x - r.left) / r.width, 0, 1) * (max - min); };
            let drag = false;
            tr.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = true; tr.setPointerCapture(e.pointerId); setSliderValue(el, fromX(e.clientX), true); e.preventDefault(); e.stopPropagation(); });
            tr.addEventListener('pointermove', e => { if (drag) setSliderValue(el, fromX(e.clientX), true); });
            const end = () => { if (drag) { drag = false; commit(); } };
            tr.addEventListener('pointerup', end); tr.addEventListener('pointercancel', end);
            const reset = () => { const path = el.dataset.path; setSliderValue(el, path === '@strength' ? 80 : defaultOf(path), false); commit(); };
            el.querySelector('.lb').addEventListener('dblclick', reset);
            tr.addEventListener('dblclick', reset);
            tr.addEventListener('keydown', e => {
                const step = e.shiftKey ? 10 : 1;
                const cur = el.dataset.path === '@strength' ? S.strength : getP(el.dataset.path);
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setSliderValue(el, cur + step, false); commitSoon(); e.preventDefault(); }
                if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setSliderValue(el, cur - step, false); commitSoon(); e.preventDefault(); }
            });
            vl.addEventListener('focus', () => vl.select());
            vl.addEventListener('keydown', e => { if (e.key === 'Enter') vl.blur(); if (e.key === 'Escape') { paintSlider(el); vl.blur(); } e.stopPropagation(); });
            vl.addEventListener('change', () => {
                let v = parseFloat(String(vl.value).replace('%', ''));
                if (isNaN(v)) { paintSlider(el); return; }
                if (el.dataset.fmt === 'ev') v *= 100; else if (el.dataset.fmt === 'r') v *= 10;
                setSliderValue(el, v, false); commit();
            });
            vl.addEventListener('blur', () => paintSlider(el));
            /* 在数值上横向拖动也能调（像专业软件的「拖动标签」） */
            let sx = 0, sv = 0, sdrag = false;
            el.querySelector('.lb').addEventListener('pointerdown', e => { if (e.button !== 0) return; sdrag = true; sx = e.clientX; sv = el.dataset.path === '@strength' ? S.strength : getP(el.dataset.path); e.currentTarget.setPointerCapture(e.pointerId); });
            el.querySelector('.lb').addEventListener('pointermove', e => { if (!sdrag) return; const d = (e.clientX - sx) * (max - min) / 240; if (Math.abs(e.clientX - sx) > 2) setSliderValue(el, sv + d, true); });
            el.querySelector('.lb').addEventListener('pointerup', () => { if (sdrag) { sdrag = false; commit(); } });
        });
    }

    /* ═════════ 历史 / 渲染调度 ═════════ */
    function afterChange(live) { if (!live) {} scheduleRender(); markPresetDirty(); paintModuleHints(); }
    function markPresetDirty() { /* 手动改参数后预设仍显示为选中，强度条只在刚套预设时有效 */ }
    function commit() {
        clearTimeout(S.commitTimer);
        const snap = JSON.stringify(S.params);
        if (S.hidx >= 0 && S.hist[S.hidx] === snap) return;
        S.hist = S.hist.slice(0, S.hidx + 1); S.hist.push(snap);
        if (S.hist.length > 120) S.hist.shift();
        S.hidx = S.hist.length - 1;
        paintHistoryBtns();
    }
    function commitSoon() { clearTimeout(S.commitTimer); S.commitTimer = setTimeout(commit, 350); }
    function undo() { if (S.hidx <= 0) return; S.hidx--; S.params = JSON.parse(S.hist[S.hidx]); refreshAll(); }
    function redo() { if (S.hidx >= S.hist.length - 1) return; S.hidx++; S.params = JSON.parse(S.hist[S.hidx]); refreshAll(); }
    function paintHistoryBtns() {
        if (!S.panel) return;
        $('[data-act=undo]', S.panel).disabled = S.hidx <= 0;
        $('[data-act=redo]', S.panel).disabled = S.hidx >= S.hist.length - 1;
    }
    function refreshAll() { paintAllSliders(); drawCurve(); paintWheels(); paintModules(); paintModuleHints(); paintHistoryBtns(); scheduleRender(); }

    function scheduleRender() {
        if (!S.active || S.raf) return;
        S.raf = requestAnimationFrame(() => {
            S.raf = 0;
            if (!S.eng) return;
            try { S.eng.render(S.params); } catch (e) { status('渲染失败：' + (e.message || e)); return; }
            if (S.compare === 'side') syncSide();
            clearTimeout(S.anaTimer);
            S.anaTimer = setTimeout(analyze, 90);
        });
    }

    /* ═════════ 直方图 ═════════ */
    function analyze() {
        if (!S.eng || !S.active) return;
        const h = S.eng.analyze(); S.lastHist = h;
        const cv = $('.iaj-hist canvas', S.panel); if (!cv) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const W = cv.clientWidth || 290, H = cv.clientHeight || 76;
        if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
        let mx = 1; for (const k of ['r', 'g', 'b']) for (let i = 3; i < 253; i++) mx = Math.max(mx, h[k][i]);
        const dark = isDark();
        const draw = (arr, fill) => {
            x.beginPath(); x.moveTo(0, H);
            for (let i = 0; i < 256; i++) { const a = (arr[Math.max(0, i - 1)] + arr[i] * 2 + arr[Math.min(255, i + 1)]) / 4; x.lineTo(i / 255 * W, H - Math.min(H, Math.sqrt(a / mx) * H * 0.94)); }
            x.lineTo(W, H); x.closePath(); x.fillStyle = fill; x.fill();
        };
        x.globalCompositeOperation = dark ? 'lighter' : 'multiply';
        draw(h.r, dark ? 'rgba(200,80,72,.55)' : 'rgba(220,96,86,.42)');
        draw(h.g, dark ? 'rgba(80,160,90,.5)' : 'rgba(96,176,104,.38)');
        draw(h.b, dark ? 'rgba(80,120,200,.55)' : 'rgba(92,128,210,.4)');
        x.globalCompositeOperation = 'source-over';
        draw(h.l, dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)');
        $('.iaj-clip.lo', S.panel).classList.toggle('on', h.clipLo);
        $('.iaj-clip.hi', S.panel).classList.toggle('on', h.clipHi);
        if (S.open.curve) drawCurve();
    }
    function isDark() {
        const d = document.documentElement, b = document.body;
        return /theme-dark/.test(d.className + ' ' + b.className) || d.dataset.theme === 'dark';
    }

    /* ═════════ 曲线 ═════════ */
    function curvePts() { return S.params.curve[S.curveCh]; }
    function drawCurve() {
        const cv = $('.iaj-curve canvas', S.panel); if (!cv) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const W = cv.clientWidth || 270, H = cv.clientHeight || 200;
        if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
        const cs = getComputedStyle(S.panel);
        const ink = cs.getPropertyValue('--iaj-ink').trim() || '#0a0a0a', sep = cs.getPropertyValue('--iaj-sep').trim(), ink4 = cs.getPropertyValue('--iaj-ink4').trim();
        const hh = S.lastHist;
        if (hh) {
            const arr = hh[S.curveCh];
            let mx = 1; for (let i = 3; i < 253; i++) mx = Math.max(mx, arr[i]);
            x.beginPath(); x.moveTo(0, H);
            for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(H, Math.sqrt(arr[i] / mx) * H * 0.9));
            x.lineTo(W, H); x.closePath(); x.fillStyle = cs.getPropertyValue('--iaj-fill3').trim() || 'rgba(0,0,0,.1)'; x.fill();
        }
        x.strokeStyle = sep; x.lineWidth = 1;
        for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(W * i / 4 + .5, 0); x.lineTo(W * i / 4 + .5, H); x.stroke(); x.beginPath(); x.moveTo(0, H * i / 4 + .5); x.lineTo(W, H * i / 4 + .5); x.stroke(); }
        x.setLineDash([2, 3]); x.strokeStyle = ink4; x.beginPath(); x.moveTo(0, H); x.lineTo(W, 0); x.stroke(); x.setLineDash([]);
        const col = { l: ink, r: '#c9584f', g: '#5f9a62', b: '#5a7fb8' }[S.curveCh];
        /* 其它通道的曲线淡淡画出来，方便看叠加关系 */
        for (const ch of ['r', 'g', 'b', 'l']) {
            if (ch === S.curveCh) continue;
            const pts = S.params.curve[ch];
            if (pts.every(p => Math.abs(p[0] - p[1]) < 0.002)) continue;
            const t = E.curveTable(pts);
            x.strokeStyle = { l: ink4, r: 'rgba(201,88,79,.45)', g: 'rgba(95,154,98,.45)', b: 'rgba(90,127,184,.45)' }[ch];
            x.lineWidth = 1; x.beginPath();
            for (let i = 0; i < 256; i++) { const px = i / 255 * W, py = H - t[i] * H; i ? x.lineTo(px, py) : x.moveTo(px, py); }
            x.stroke();
        }
        const t = E.curveTable(curvePts());
        x.strokeStyle = col; x.lineWidth = 1.6; x.beginPath();
        for (let i = 0; i < 256; i++) { const px = i / 255 * W, py = H - t[i] * H; i ? x.lineTo(px, py) : x.moveTo(px, py); }
        x.stroke();
        curvePts().forEach((p, i) => {
            x.beginPath(); x.arc(p[0] * W, H - p[1] * H, i === S.curveSel ? 4.5 : 3.6, 0, Math.PI * 2);
            x.fillStyle = i === S.curveSel ? col : (cs.getPropertyValue('--iaj-solid').trim() || '#fff'); x.fill();
            x.strokeStyle = col; x.lineWidth = 1.5; x.stroke();
        });
        const sel = curvePts()[S.curveSel];
        const info = $('.iaj-cvinfo', S.panel);
        if (info) info.innerHTML = sel ? `<span>输入 <b>${Math.round(sel[0] * 255)}</b></span><span>输出 <b>${Math.round(sel[1] * 255)}</b></span>` : '<span>点击曲线加点，拖动调整</span>';
    }

    function bindCurve() {
        const cv = $('.iaj-curve canvas', S.panel);
        let drag = -1;
        const pos = e => { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1), (e.clientY - r.top) / r.height]; };
        cv.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.stopPropagation(); e.preventDefault();
            const [px, py] = pos(e), pts = curvePts(), r = cv.getBoundingClientRect();
            let best = -1, bd = 10;
            pts.forEach((p, i) => { const d = Math.hypot((p[0] - px) * r.width, (p[1] - py) * r.height); if (d < bd) { bd = d; best = i; } });
            if (best < 0) {
                const t = E.curveTable(pts); const y = t[Math.round(px * 255)];
                pts.push([px, Math.abs(y - py) * r.height < 22 ? y : py]); pts.sort((a, b) => a[0] - b[0]);
                best = pts.findIndex(p => p[0] === px);
                scheduleRender();
            }
            drag = best; S.curveSel = best; cv.setPointerCapture(e.pointerId); drawCurve();
        });
        cv.addEventListener('pointermove', e => {
            if (drag < 0) return;
            const [px, py, ry] = pos(e), pts = curvePts(), end = drag === 0 || drag === pts.length - 1;
            /* 拖出框外（上下超出 18%）删除中间点 */
            if (!end && (ry < -0.18 || ry > 1.18)) { cv.classList.add('del'); } else cv.classList.remove('del');
            const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
            pts[drag] = [end ? pts[drag][0] : clamp(px, lo, hi), py];
            drawCurve(); scheduleRender(); paintModuleHints();
        });
        const up = e => {
            if (drag < 0) return;
            const pts = curvePts(), [, , ry] = pos(e), end = drag === 0 || drag === pts.length - 1;
            if (!end && (ry < -0.18 || ry > 1.18)) { pts.splice(drag, 1); S.curveSel = -1; }
            cv.classList.remove('del'); drag = -1; drawCurve(); scheduleRender(); commit(); paintModuleHints();
        };
        cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
        cv.addEventListener('dblclick', e => {
            e.stopPropagation();
            const [px, py] = pos(e), pts = curvePts(), r = cv.getBoundingClientRect();
            const hit = pts.findIndex((p, i) => i > 0 && i < pts.length - 1 && Math.hypot((p[0] - px) * r.width, (p[1] - py) * r.height) < 10);
            if (hit > 0) pts.splice(hit, 1); else S.params.curve[S.curveCh] = [[0, 0], [1, 1]];
            S.curveSel = -1; drawCurve(); scheduleRender(); commit(); paintModuleHints();
        });
    }
    const CURVE_PRESETS = {
        '线性': [[0, 0], [1, 1]],
        '中对比': [[0, 0], [0.25, 0.21], [0.75, 0.79], [1, 1]],
        '强对比': [[0, 0], [0.25, 0.16], [0.75, 0.85], [1, 1]],
        '褪色': [[0, 0.1], [0.3, 0.3], [0.75, 0.76], [1, 0.95]],
        '柔和': [[0, 0.04], [0.25, 0.29], [0.75, 0.72], [1, 0.97]]
    };

    /* ═════════ 色轮 ═════════ */
    const REGIONS = { sh: '阴影', mid: '中间调', hi: '高光', gl: '全局' };
    function wheelHTML(region, size) {
        return `<div class="iaj-wh" data-region="${region}"><div class="wc" style="width:${size}px;height:${size}px" title="拖动选色，双击复位"><i class="wx"></i><i class="wp"></i></div><span class="wn">${REGIONS[region]}</span>
${sliderHTML(`grade.${region}.l`, '明度', -100, 100, { cls: 'mini' })}</div>`;
    }
    function paintWheels() {
        if (!S.panel) return;
        S.panel.querySelectorAll('.iaj-wh').forEach(w => {
            const g = S.params.grade[w.dataset.region];
            const a = (g.h - 90) * Math.PI / 180, r = g.s / 100 * 0.5;
            const wp = w.querySelector('.wp');
            /* 0° 在正上方顺时针：与常见色轮一致（红在上偏右） */
            wp.style.left = (50 + Math.cos(a) * r * 100) + '%';
            wp.style.top = (50 + Math.sin(a) * r * 100) + '%';
            w.classList.toggle('on', g.s > 0 || g.l !== 0);
        });
        S.panel.querySelectorAll('.iaj-sl[data-path^="grade."]').forEach(paintSlider);
    }
    function bindWheels(root) {
        root.querySelectorAll('.iaj-wh .wc').forEach(wc => {
            if (wc._b) return; wc._b = true;
            const region = wc.closest('.iaj-wh').dataset.region;
            let drag = false;
            const set = e => {
                const r = wc.getBoundingClientRect();
                const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
                const dist = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
                let h = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (h < 0) h += 360;
                S.params.grade[region].h = Math.round(h) % 360;
                S.params.grade[region].s = Math.round(dist * 100);
                paintWheels(); scheduleRender(); paintModuleHints();
            };
            wc.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = true; wc.setPointerCapture(e.pointerId); set(e); e.preventDefault(); e.stopPropagation(); });
            wc.addEventListener('pointermove', e => { if (drag) set(e); });
            const up = () => { if (drag) { drag = false; commit(); } };
            wc.addEventListener('pointerup', up); wc.addEventListener('pointercancel', up);
            wc.addEventListener('dblclick', () => { S.params.grade[region].h = 0; S.params.grade[region].s = 0; paintWheels(); scheduleRender(); commit(); paintModuleHints(); });
        });
    }

    /* ═════════ 面板构建 ═════════ */
    const HUES = [['红', '#c45a50', 0], ['橙', '#c98348', 30], ['黄', '#c9b14d', 60], ['绿', '#6a9a5a', 120], ['青', '#57a3a3', 180], ['蓝', '#5577b3', 225], ['紫', '#8a65b0', 275], ['洋红', '#b45f95', 320]];
    const hueTrack = i => { const c = HUES[i][2]; return `linear-gradient(90deg,hsl(${c - 30},38%,56%),hsl(${c},42%,56%),hsl(${c + 30},38%,56%))`; };
    const satTrack = i => `linear-gradient(90deg,hsl(${HUES[i][2]},0%,58%),hsl(${HUES[i][2]},48%,54%))`;
    const lumTrack = i => `linear-gradient(90deg,hsl(${HUES[i][2]},30%,22%),hsl(${HUES[i][2]},34%,78%))`;
    const WB_T = 'linear-gradient(90deg,#6f8fb8,#cfcfca 50%,#d6a65a)';
    const WB_N = 'linear-gradient(90deg,#7fa37a,#cfcfca 50%,#b07aa8)';

    function moduleHTML(id, title, body) {
        return `<section class="iaj-md" data-mod="${id}"><header><span class="cv">${ic('chev', 14)}</span><span class="mt">${title}</span><span class="hint"></span>
<span class="ma"><button type="button" class="iaj-ib sm" data-mod-act="eye" title="显示 / 隐藏此组效果">${ic('eye', 14)}</button><button type="button" class="iaj-ib sm" data-mod-act="reset" title="重置此组">${ic('reset', 13)}</button></span></header><div class="mb">${body}</div></section>`;
    }
    const sub = t => `<div class="iaj-sub">${t}</div>`;

    function hslBody() {
        const tab = S.hslTab;
        const rows = (t, i) => sliderHTML(`hsl.${t}.${i}`, HUES[i][0], -100, 100, { dot: HUES[i][1], track: t === 'h' ? hueTrack(i) : t === 's' ? satTrack(i) : lumTrack(i), colored: true });
        if (tab === 'all') return HUES.map((h, i) => `<div class="iaj-hgrp"><div class="iaj-sub"><i class="iaj-dot" style="background:${h[1]}"></i>${h[0]}</div>${['h', 's', 'l'].map(t => sliderHTML(`hsl.${t}.${i}`, { h: '色相', s: '饱和度', l: '明度' }[t], -100, 100, { track: t === 'h' ? hueTrack(i) : t === 's' ? satTrack(i) : lumTrack(i), colored: true })).join('')}</div>`).join('');
        return HUES.map((h, i) => rows(tab, i)).join('');
    }
    function gradeBody() {
        const t = S.gradeTab;
        if (t === '3') return `<div class="iaj-wheels">${wheelHTML('mid', 116)}<div class="wrow">${wheelHTML('sh', 82)}${wheelHTML('hi', 82)}</div></div>`;
        return `<div class="iaj-wheels one">${wheelHTML(t, 150)}</div>${sliderHTML(`grade.${t}.h`, '色相', 0, 359, { track: 'linear-gradient(90deg,hsl(0,42%,56%),hsl(60,42%,56%),hsl(120,42%,56%),hsl(180,42%,56%),hsl(240,42%,56%),hsl(300,42%,56%),hsl(359,42%,56%))', colored: true })}${sliderHTML(`grade.${t}.s`, '饱和度', 0, 100)}`;
    }
    function buildPanel(wrap) {
        wrap.innerHTML = `
<div class="iaj-top">
  <div class="iaj-hist"><canvas></canvas><span class="iaj-clip lo" title="暗部剪切：有纯黑像素"></span><span class="iaj-clip hi" title="高光剪切：有过曝像素"></span></div>
  <div class="iaj-hmeta"><span class="rgb">R — G — B —</span><span class="sp"></span><span class="dim"></span></div>
  <div class="iaj-tools">
    <button type="button" class="iaj-pill" data-act="auto" title="自动白平衡 + 自动色阶">${ic('wand', 14)}自动</button>
    <span class="sp"></span>
    <button type="button" class="iaj-ib" data-act="undo" title="撤销（⌘Z）">${ic('undo', 15)}</button>
    <button type="button" class="iaj-ib" data-act="redo" title="重做（⇧⌘Z）">${ic('redo', 15)}</button>
    <button type="button" class="iaj-ib" data-act="copy" title="复制当前参数">${ic('copy', 15)}</button>
    <button type="button" class="iaj-ib" data-act="paste" title="粘贴参数">${ic('paste', 15)}</button>
    <button type="button" class="iaj-ib" data-act="resetAll" title="全部重置">${ic('reset', 15)}</button>
  </div>
  <div class="iaj-status" aria-live="polite"></div>
</div>
<div class="iaj-scroll">
  <div class="iaj-prs">
    <div class="prh"><span class="mt">预设</span><span class="iaj-seg mini" data-seg="presetTab"><b data-v="builtin">内置</b><b data-v="mine">我的</b></span><span class="sp"></span><button type="button" class="iaj-ib sm" data-act="savePreset" title="把当前参数存为预设">${ic('plus', 14)}</button></div>
    <div class="iaj-save" hidden><input class="iaj-in" maxlength="16" placeholder="预设名称"><button type="button" class="iaj-pill sm" data-act="savePresetOk">保存</button><button type="button" class="iaj-ib sm" data-act="savePresetCancel" title="取消">${ic('x', 13)}</button></div>
    <div class="prl"></div>
    <div class="amt">${sliderHTML('@strength', '强度', 0, 100, { fmt: 'pct' })}</div>
  </div>
  <div class="iaj-mods">
  ${moduleHTML('basic', '基础', sub('白平衡') + `<div class="iaj-wbrow"><span class="iaj-seg mini" data-seg="wb"><b data-v="shot">原照设置</b><b data-v="auto">自动</b><b data-v="custom">自定</b></span><button type="button" class="iaj-ib sm" data-act="pickWB" title="吸管：点图上应为中性灰的地方">${ic('pick', 14)}</button></div>`
            + sliderHTML('temp', '色温', -100, 100, { track: WB_T, colored: true }) + sliderHTML('tint', '色调', -100, 100, { track: WB_N, colored: true })
            + sub('影调') + sliderHTML('exposure', '曝光', -500, 500, { fmt: 'ev' }) + sliderHTML('contrast', '对比度', -100, 100) + sliderHTML('highlights', '高光', -100, 100)
            + sliderHTML('shadows', '阴影', -100, 100) + sliderHTML('whites', '白色', -100, 100) + sliderHTML('blacks', '黑色', -100, 100))}
  ${moduleHTML('presence', '质感', sliderHTML('texture', '纹理', -100, 100) + sliderHTML('clarity', '清晰度', -100, 100) + sliderHTML('dehaze', '去朦胧', -100, 100) + sliderHTML('vibrance', '自然饱和度', -100, 100) + sliderHTML('saturation', '饱和度', -100, 100))}
  ${moduleHTML('curve', '曲线', `<div class="iaj-chs"><span class="iaj-seg" data-seg="curveCh"><b data-v="l"><i class="iaj-cd lum"></i>亮度</b><b data-v="r"><i class="iaj-cd" style="background:#c9584f"></i>红</b><b data-v="g"><i class="iaj-cd" style="background:#5f9a62"></i>绿</b><b data-v="b"><i class="iaj-cd" style="background:#5a7fb8"></i>蓝</b></span></div>
<div class="iaj-curve"><canvas></canvas></div><div class="iaj-cvinfo"></div><div class="iaj-cvtip">点击加点 · 拖出框外删除 · 双击点删除，双击空白复位</div>
<div class="iaj-cpre">${Object.keys(CURVE_PRESETS).map(k => `<b data-curve-preset="${k}">${k}</b>`).join('')}</div>`)}
  ${moduleHTML('hsl', '颜色混合 HSL', `<div class="iaj-chs"><span class="iaj-seg" data-seg="hslTab"><b data-v="h">色相</b><b data-v="s">饱和度</b><b data-v="l">明度</b><b data-v="all">全部</b></span><button type="button" class="iaj-ib sm" data-act="pickHSL" title="在图上按住上下拖动，直接调整该颜色">${ic('target', 15)}</button></div><div class="iaj-hslbody"></div>`)}
  ${moduleHTML('grade', '色彩分级', `<div class="iaj-chs"><span class="iaj-seg" data-seg="gradeTab"><b data-v="3">三向</b><b data-v="sh">阴影</b><b data-v="mid">中间调</b><b data-v="hi">高光</b><b data-v="gl">全局</b></span></div><div class="iaj-gradebody"></div>${sliderHTML('grade.blend', '混合', 0, 100)}${sliderHTML('grade.balance', '平衡', -100, 100)}`)}
  ${moduleHTML('detail', '细节', sub('锐化') + sliderHTML('sharpen', '数量', 0, 150) + sliderHTML('sharpRadius', '半径', 5, 30, { fmt: 'r' }) + sliderHTML('sharpDetail', '细节', 0, 100) + sliderHTML('sharpMask', '蒙版', 0, 100)
            + sub('降噪') + sliderHTML('nrLuma', '明亮度', 0, 100) + sliderHTML('nrColor', '颜色', 0, 100))}
  ${moduleHTML('effects', '效果', sub('晕影') + sliderHTML('vignette', '数量', -100, 100) + sliderHTML('vigMid', '中点', 0, 100) + sliderHTML('vigFeather', '羽化', 0, 100)
            + sub('颗粒') + sliderHTML('grain', '数量', 0, 100) + sliderHTML('grainSize', '大小', 0, 100) + sliderHTML('grainRough', '粗糙度', 0, 100)
            + sub('光效') + sliderHTML('soft', '柔光', 0, 100) + sliderHTML('glow', '辉光', 0, 100))}
  </div>
</div>`;
        S.panel = wrap;
        renderHslBody(); renderGradeBody();
        bindSliders(wrap); bindCurve();
        /* 分段控件 */
        wrap.querySelectorAll('[data-seg]').forEach(seg => seg.addEventListener('click', e => {
            const b = e.target.closest('b[data-v]'); if (!b) return;
            const k = seg.dataset.seg, v = b.dataset.v;
            if (k === 'presetTab') { S.presetTab = v; renderPresets(); }
            else if (k === 'curveCh') { S.curveCh = v; S.curveSel = -1; drawCurve(); }
            else if (k === 'hslTab') { S.hslTab = v; renderHslBody(); }
            else if (k === 'gradeTab') { S.gradeTab = v; renderGradeBody(); }
            else if (k === 'wb') { setWbMode(v); }
            paintSegs();
        }));
        wrap.querySelectorAll('[data-curve-preset]').forEach(b => b.addEventListener('click', () => {
            S.params.curve[S.curveCh] = clone(CURVE_PRESETS[b.dataset.curvePreset]); S.curveSel = -1; drawCurve(); scheduleRender(); commit(); paintModuleHints();
        }));
        /* 模块折叠 / 隐藏 / 重置 */
        wrap.querySelectorAll('.iaj-md > header').forEach(h => h.addEventListener('click', e => {
            const md = h.parentElement, id = md.dataset.mod, act = e.target.closest('[data-mod-act]');
            if (act) {
                e.stopPropagation();
                if (act.dataset.modAct === 'eye') { S.params.off = Object.assign({}, S.params.off); S.params.off[id] = !S.params.off[id]; scheduleRender(); commit(); paintModules(); }
                else resetModule(id);
                return;
            }
            S.open[id] = !S.open[id]; lsSet(LS_OPEN, S.open); paintModules();
            if (id === 'curve' && S.open[id]) requestAnimationFrame(drawCurve);
        }));
        /* 顶部工具 */
        wrap.addEventListener('click', e => {
            const b = e.target.closest('[data-act]'); if (!b) return;
            const a = b.dataset.act;
            if (a === 'auto') doAuto();
            else if (a === 'undo') undo();
            else if (a === 'redo') redo();
            else if (a === 'copy') { lsSet(LS_CLIP, S.params); status('已复制当前参数'); }
            else if (a === 'paste') { const p = lsGet(LS_CLIP, null); if (!p) { status('还没有复制过参数'); return; } S.params = Object.assign(E.neutral(), p); refreshAll(); commit(); status('已粘贴参数'); }
            else if (a === 'resetAll') { S.params = E.neutral(); S.preset = null; renderPresets(); refreshAll(); commit(); status('已全部重置'); }
            else if (a === 'savePreset') { const box = $('.iaj-save', wrap); box.hidden = !box.hidden; if (!box.hidden) $('.iaj-in', box).focus(); }
            else if (a === 'savePresetCancel') $('.iaj-save', wrap).hidden = true;
            else if (a === 'savePresetOk') savePreset();
            else if (a === 'pickWB') setPick(S.pick === 'wb' ? null : 'wb');
            else if (a === 'pickHSL') setPick(S.pick === 'hsl' ? null : 'hsl');
        });
        $('.iaj-save .iaj-in', wrap).addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') savePreset(); if (e.key === 'Escape') $('.iaj-save', wrap).hidden = true; });
        paintSegs(); paintModules();
    }
    function renderHslBody() { const b = $('.iaj-hslbody', S.panel); b.innerHTML = hslBody(); bindSliders(b); paintAllSliders(b); }
    function renderGradeBody() { const b = $('.iaj-gradebody', S.panel); b.innerHTML = gradeBody(); bindSliders(b); bindWheels(b); paintAllSliders(b); paintWheels(); }
    function paintSegs() {
        const val = { presetTab: S.presetTab, curveCh: S.curveCh, hslTab: S.hslTab, gradeTab: S.gradeTab, wb: S.wbMode || 'shot' };
        S.panel.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('b[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === val[seg.dataset.seg])));
        S.panel.querySelector('[data-act=pickWB]').classList.toggle('on', S.pick === 'wb');
        S.panel.querySelector('[data-act=pickHSL]').classList.toggle('on', S.pick === 'hsl');
    }
    function paintModules() {
        const off = S.params.off || {};
        S.panel.querySelectorAll('.iaj-md').forEach(md => {
            const id = md.dataset.mod;
            md.classList.toggle('open', !!S.open[id]);
            md.classList.toggle('off', !!off[id]);
            const eye = md.querySelector('[data-mod-act=eye]'); eye.innerHTML = ic(off[id] ? 'eyeoff' : 'eye', 14);
        });
    }
    function moduleChanged(id) {
        const n = E.neutral();
        return E.MODULE_KEYS[id].some(k => JSON.stringify(S.params[k]) !== JSON.stringify(n[k]));
    }
    function paintModuleHints() {
        if (!S.panel) return;
        S.panel.querySelectorAll('.iaj-md').forEach(md => {
            const id = md.dataset.mod, off = (S.params.off || {})[id];
            md.querySelector('.hint').textContent = off ? '已隐藏' : (moduleChanged(id) ? '已调整' : '');
            md.classList.toggle('changed', moduleChanged(id));
        });
    }
    function resetModule(id) {
        const n = E.neutral();
        for (const k of E.MODULE_KEYS[id]) S.params[k] = clone(n[k]);
        if (id === 'basic') S.wbMode = 'shot';
        refreshAll(); commit(); paintSegs();
    }
    function status(t) {
        const el = S.panel && $('.iaj-status', S.panel); if (!el) return;
        el.textContent = t || ''; el.classList.toggle('show', !!t);
        clearTimeout(el._t); if (t) el._t = setTimeout(() => el.classList.remove('show'), 2600);
    }

    /* ═════════ 白平衡 / 自动 / 吸管 ═════════ */
    function setWbMode(v) {
        S.wbMode = v;
        if (v === 'shot') { S.params.temp = 0; S.params.tint = 0; }
        else if (v === 'auto') { const a = E.autoParams(S.origImg); S.params.temp = a.temp || 0; S.params.tint = a.tint || 0; }
        refreshAll(); commit();
    }
    function doAuto() {
        if (!S.origImg) return;
        const a = E.autoParams(S.origImg);
        Object.assign(S.params, a);
        S.wbMode = 'auto';
        refreshAll(); commit(); paintSegs(); status('已自动校正白平衡与色阶，可继续微调');
    }
    let srcProbe = null;
    function sampleOriginal(fx, fy) {
        if (!S.origImg) return null;
        if (!srcProbe) {
            const w = 400, h = Math.max(1, Math.round(400 * S.origImg.naturalHeight / S.origImg.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(S.origImg, 0, 0, w, h);
            srcProbe = { d: x.getImageData(0, 0, w, h).data, w, h };
        }
        const px = clamp(Math.floor(fx * srcProbe.w), 0, srcProbe.w - 1), py = clamp(Math.floor(fy * srcProbe.h), 0, srcProbe.h - 1);
        /* 3×3 平均，避免点到噪点 */
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = clamp(px + dx, 0, srcProbe.w - 1), y = clamp(py + dy, 0, srcProbe.h - 1), i = (y * srcProbe.w + x) * 4;
            r += srcProbe.d[i]; g += srcProbe.d[i + 1]; b += srcProbe.d[i + 2]; n++;
        }
        return [r / n, g / n, b / n];
    }
    function setPick(mode) {
        S.pick = mode;
        const holder = document.getElementById('cropCanvas');
        if (holder) holder.classList.toggle('iaj-picking', !!mode);
        paintSegs();
        if (mode === 'wb') status('点图上本该是灰色 / 白色的地方');
        else if (mode === 'hsl') status('在图上按住某种颜色上下拖动');
        else status('');
    }
    function relPos(e) {
        const el = S.cv; const r = el.getBoundingClientRect();
        return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
    }
    function bindStagePointer() {
        const holder = document.getElementById('cropCanvas');
        if (!holder || holder._iaj) return;
        holder._iaj = true;
        let hslDrag = null;
        holder.addEventListener('pointerdown', e => {
            if (!S.active || !S.pick || e.button !== 0) return;
            e.stopPropagation(); e.preventDefault();
            const [fx, fy] = relPos(e), rgb = sampleOriginal(fx, fy);
            if (!rgb) return;
            if (S.pick === 'wb') { Object.assign(S.params, E.wbFromSample(rgb)); S.wbMode = 'custom'; setPick(null); refreshAll(); commit(); status('已按取样点校正白平衡'); return; }
            const band = E.hueBandOf(rgb);
            if (band < 0) { status('这里接近无色，换个有颜色的地方'); return; }
            const t = S.hslTab === 'all' ? 's' : S.hslTab;
            hslDrag = { band, t, y: e.clientY, v: S.params.hsl[t][band] };
            holder.setPointerCapture(e.pointerId);
            status(`正在调整：${HUES[band][0]} · ${{ h: '色相', s: '饱和度', l: '明度' }[t]}`);
        }, true);
        holder.addEventListener('pointermove', e => {
            if (!S.active) return;
            if (hslDrag) {
                const v = clamp(Math.round(hslDrag.v + (hslDrag.y - e.clientY) * 0.6), -100, 100);
                S.params.hsl[hslDrag.t][hslDrag.band] = v;
                scheduleRender(); paintAllSliders($('.iaj-hslbody', S.panel)); paintModuleHints();
                return;
            }
            const [fx, fy] = relPos(e), c = S.eng && S.eng.sample(fx, fy);
            const m = S.panel && $('.iaj-hmeta .rgb', S.panel);
            if (m && c) m.textContent = `R ${c[0]}  G ${c[1]}  B ${c[2]}`;
        });
        const up = () => { if (hslDrag) { hslDrag = null; commit(); } };
        holder.addEventListener('pointerup', up); holder.addEventListener('pointercancel', up);
        holder.addEventListener('pointerleave', () => { const m = S.panel && $('.iaj-hmeta .rgb', S.panel); if (m) m.textContent = 'R — G — B —'; });
    }

    /* ═════════ 预设 ═════════ */
    let thumbCache = { key: '', items: {} };
    function presetThumbs(list) {
        if (!S.origImg) return {};
        const key = S.srcUrl;
        if (thumbCache.key !== key) thumbCache = { key, items: {} };
        const need = list.filter(p => !thumbCache.items[p.name + JSON.stringify(p.p)]);
        if (need.length) {
            try {
                const cv = document.createElement('canvas');
                const eng = E.create(cv);
                eng.setSource(S.origImg, 160, S.origImg.naturalWidth);
                for (const p of need) { eng.render(withPreset(p.p, 1)); thumbCache.items[p.name + JSON.stringify(p.p)] = cv.toDataURL('image/jpeg', 0.8); }
                eng.dispose();
            } catch (e) {}
        }
        const out = {}; for (const p of list) out[p.name] = thumbCache.items[p.name + JSON.stringify(p.p)] || '';
        return out;
    }
    function renderPresets() {
        const box = $('.prl', S.panel);
        const list = S.presetTab === 'builtin' ? BUILTIN : lsGet(LS_PRESETS, []);
        if (!list.length) { box.innerHTML = '<div class="iaj-empty">还没有自己的预设 · 调好后点右上角 + 保存</div>'; paintStrength(); return; }
        const th = presetThumbs(list);
        box.innerHTML = list.map((p, i) => `<button type="button" class="iaj-pr${S.preset === p.name && S.presetMine === (S.presetTab === 'mine') ? ' on' : ''}" data-i="${i}" title="${esc(p.name)}"><img src="${th[p.name]}" alt=""><span>${esc(p.name)}</span>${S.presetTab === 'mine' ? `<i class="del" data-del="${i}" title="删除">${ic('x', 11)}</i>` : ''}</button>`).join('');
        box.querySelectorAll('.iaj-pr').forEach(b => b.addEventListener('click', e => {
            const del = e.target.closest('[data-del]');
            if (del) { const arr = lsGet(LS_PRESETS, []); arr.splice(Number(del.dataset.del), 1); lsSet(LS_PRESETS, arr); renderPresets(); e.stopPropagation(); return; }
            const p = list[Number(b.dataset.i)];
            S.preset = p.name; S.presetMine = S.presetTab === 'mine'; S.strength = 100; if (!S.presetMine) S.strength = 80;
            if (p.name === '原图') S.strength = 100;
            applyPreset(p.name, S.presetMine, false); commit(); renderPresets();
        }));
        paintStrength();
    }
    function applyPreset(name, mine, fromStrength) {
        if (!name) return;
        const list = mine ? lsGet(LS_PRESETS, []) : BUILTIN;
        const p = list.find(x => x.name === name); if (!p) return;
        const keepOff = S.params.off;
        S.params = withPreset(p.p, S.strength / 100);
        S.params.off = keepOff || {};
        refreshAll();
        if (fromStrength) commitSoon();
    }
    function paintStrength() {
        const amt = $('.amt', S.panel);
        amt.classList.toggle('dis', !S.preset || S.preset === '原图');
        paintSlider($('.amt .iaj-sl', S.panel));
    }
    function savePreset() {
        const inp = $('.iaj-save .iaj-in', S.panel);
        const name = (inp.value || '').trim() || ('预设 ' + (lsGet(LS_PRESETS, []).length + 1));
        const n = E.neutral(), p = {};
        for (const k in S.params) if (k !== 'off' && JSON.stringify(S.params[k]) !== JSON.stringify(n[k])) p[k] = clone(S.params[k]);
        const arr = lsGet(LS_PRESETS, []).filter(x => x.name !== name);
        arr.unshift({ name, p }); lsSet(LS_PRESETS, arr.slice(0, 40));
        inp.value = ''; $('.iaj-save', S.panel).hidden = true;
        S.presetTab = 'mine'; S.preset = name; S.presetMine = true; S.strength = 100;
        paintSegs(); renderPresets(); status('已保存为「' + name + '」');
    }

    /* ═════════ 对比视图 ═════════ */
    function buildViewBar(col) {
        const bar = document.createElement('div');
        bar.className = 'iaj-vbar';
        bar.innerHTML = `<span class="iaj-seg mini" data-view><b data-v="single">${ic('single', 13)}单图</b><b data-v="split">${ic('split', 13)}拖动对比</b><b data-v="side">${ic('side', 13)}并排</b></span>
<button type="button" class="iaj-hold" title="按住查看原图（也可按住 \\ 键）">按住看原图</button><span class="sp"></span><span class="iaj-note"></span>`;
        col.insertBefore(bar, col.firstChild);
        /* 并排视图：独立一层盖在图片区上（左原图 / 右调整后），不去动编辑器自己的缩放层 */
        const side = document.createElement('div');
        side.className = 'iaj-sideview';
        side.innerHTML = '<div class="half"><img class="o" alt=""><span class="iaj-tag2">原图</span></div><div class="half"><canvas class="a"></canvas><span class="iaj-tag2">调整后</span></div>';
        col.appendChild(side);
        bar.querySelector('[data-view]').addEventListener('click', e => { const b = e.target.closest('b[data-v]'); if (b) setCompare(b.dataset.v); });
        const hold = bar.querySelector('.iaj-hold');
        hold.addEventListener('pointerdown', e => { setHold(true); hold.setPointerCapture(e.pointerId); });
        hold.addEventListener('pointerup', () => setHold(false));
        hold.addEventListener('pointercancel', () => setHold(false));
        return bar;
    }
    function setCompare(v) {
        S.compare = v;
        const holder = document.getElementById('cropCanvas');
        if (holder) holder.classList.toggle('iaj-split', v === 'split');
        const sv = $('.iaj-sideview'), stage = document.getElementById('imageEditStage');
        if (sv) sv.classList.toggle('on', v === 'side');
        if (stage) stage.style.visibility = v === 'side' ? 'hidden' : '';
        if (v === 'side') syncSide();
        const bar = $('.iaj-vbar'); if (bar) bar.querySelectorAll('[data-view] b').forEach(b => b.classList.toggle('on', b.dataset.v === v));
        updateCompare();
    }
    function syncSide() {
        const sv = $('.iaj-sideview'); if (!sv || !S.cv || !S.origImg) return;
        const o = sv.querySelector('img.o'); if (o.src !== S.origImg.src) o.src = S.origImg.src;
        const a = sv.querySelector('canvas.a');
        if (a.width !== S.cv.width || a.height !== S.cv.height) { a.width = S.cv.width; a.height = S.cv.height; }
        a.getContext('2d').drawImage(S.cv, 0, 0);
    }
    function setHold(on) { S.hold = on; if (S.cv) S.cv.style.visibility = on ? 'hidden' : ''; const l = $('.iaj-tag.r'); if (l) l.style.visibility = on ? 'hidden' : ''; }
    function ensureDivider() {
        const holder = document.getElementById('cropCanvas');
        if (!holder) return;
        let div = document.getElementById('adjustCompareDivider');
        if (!div) {
            div = document.createElement('div');
            div.id = 'adjustCompareDivider'; div.className = 'adjust-compare-divider iaj-divider';
            div.innerHTML = '<b></b>';
            holder.appendChild(div);
            let dragging = false;
            div.addEventListener('pointerdown', e => { dragging = true; div.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
            div.addEventListener('pointermove', e => {
                if (!dragging) return;
                const r = holder.getBoundingClientRect(); if (r.width < 1) return;
                S.splitX = clamp((e.clientX - r.left) / r.width, 0, 1) * 100; updateCompare();
            });
            div.addEventListener('pointerup', () => { dragging = false; }); div.addEventListener('pointercancel', () => { dragging = false; });
        }
        if (!holder.querySelector('.iaj-tag')) {
            holder.insertAdjacentHTML('beforeend', '<span class="iaj-tag l">原图</span><span class="iaj-tag r">调整后</span>');
        }
    }
    function updateCompare() {
        const div = document.getElementById('adjustCompareDivider');
        if (S.cv) S.cv.style.clipPath = S.compare === 'split' ? `inset(0 0 0 ${S.splitX}%)` : 'none';
        if (div) { div.style.left = S.splitX + '%'; div.style.display = S.compare === 'split' ? '' : 'none'; }
    }

    /* ═════════ 进入 / 离开 / 应用 ═════════ */
    function source() {
        const img = document.getElementById('cropImage');
        let s = { url: (img && img.src) || '', name: 'image' };
        if (window.imageAdjust && typeof window.imageAdjust.currentSource === 'function') { try { const x = window.imageAdjust.currentSource(); if (x && x.url) s = x; } catch (e) {} }
        return s;
    }
    function loadImage(url) {
        return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('原图加载失败')); im.src = url; });
    }
    async function enterAdjustMode() {
        const stage = document.getElementById('imageEditStage'), holder = document.getElementById('cropCanvas');
        if (!stage || !holder) return;
        /* 布局：[左列：视图条 + 图片区] [右侧面板] */
        let row = document.getElementById('imageAdjustRow');
        if (!row) {
            row = document.createElement('div'); row.id = 'imageAdjustRow'; row.className = 'adjust-row iaj-row';
            stage.parentNode.insertBefore(row, stage);
            const col = document.createElement('div'); col.className = 'iaj-col'; row.appendChild(col);
            col.appendChild(stage); buildViewBar(col);
        }
        let wrap = document.getElementById('imageAdjustTools');
        if (!wrap) { wrap = document.createElement('div'); wrap.id = 'imageAdjustTools'; }
        wrap.className = 'image-edit-tools image-adjust-tools iaj active';
        row.appendChild(wrap);
        if (!S.built || !wrap.querySelector('.iaj-top')) { buildPanel(wrap); S.built = true; }
        S.active = true;
        S.hist = []; S.hidx = -1; S.preset = null; S.strength = 80; S.curveSel = -1; S.wbMode = 'shot';
        setPick(null);
        const src = source();
        const adj = src.adjust && src.adjust.source && src.adjust.source.url ? src.adjust : null;
        S.reedit = !!adj;
        S.srcUrl = adj ? adj.source.url : src.url;
        S.srcName = (adj ? adj.source.name : src.name) || 'image';
        S.params = Object.assign(E.neutral(), adj ? clone(adj.params || {}) : {});
        srcProbe = null;
        /* 画布层：原图（对比用）在下，WebGL 结果在上 */
        let orig = document.getElementById('iajOrigImg');
        if (!orig) { orig = document.createElement('img'); orig.id = 'iajOrigImg'; orig.className = 'iaj-orig'; orig.alt = ''; orig.draggable = false; }
        holder.appendChild(orig);
        if (!S.cv) { S.cv = document.createElement('canvas'); S.cv.id = 'imageAdjustCanvas'; S.cv.className = 'image-edit-canvas-adjust iaj-canvas'; }
        holder.appendChild(S.cv);
        ensureDivider(); bindStagePointer(); setCompare('single'); setHold(false);
        const note = $('.iaj-vbar .iaj-note'); if (note) note.textContent = S.reedit ? '继续编辑上次的调色 · 基于原图' : '';
        try {
            S.origImg = await loadImage(S.srcUrl);
            if (!S.active) return;
            orig.src = S.origImg.src;
            if (!S.eng) S.eng = E.create(S.cv);
            S.eng.setSource(S.origImg, 1600, S.origImg.naturalWidth);
            const dim = $('.iaj-hmeta .dim', S.panel); if (dim) dim.textContent = `${S.origImg.naturalWidth} × ${S.origImg.naturalHeight}`;
        } catch (e) {
            status('调色不可用：' + (e && e.message ? e.message : e)); return;
        }
        thumbCache = { key: '', items: {} };
        renderPresets(); refreshAll(); commit(); paintSegs();
        requestAnimationFrame(drawCurve);
    }
    function leaveAdjustMode() {
        S.active = false; setPick(null); setHold(false);
        if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
        const holder = document.getElementById('cropCanvas');
        if (holder) { holder.classList.remove('iaj-side', 'iaj-split'); holder.querySelectorAll('.iaj-tag').forEach(t => t.remove()); }
        const stg = document.getElementById('imageEditStage'); if (stg) stg.style.visibility = '';
        ['adjustCompareDivider', 'iajOrigImg'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
        if (S.cv && S.cv.parentNode) S.cv.parentNode.removeChild(S.cv);
        const row = document.getElementById('imageAdjustRow');
        if (row && row.parentNode) {
            const st = document.getElementById('imageEditStage');
            if (st) row.parentNode.insertBefore(st, row);
            const tools = document.getElementById('imageAdjustTools'); if (tools) tools.classList.remove('active');
            row.remove();
            S.built = false;
        }
    }
    async function applyImageAdjust() {
        if (!S.active || !S.origImg) { status('当前不在调色模式'); return; }
        status('正在按原图分辨率生成…');
        const base = String(S.srcName || 'image').replace(/\.[^.]+$/, '').replace(/_adjust$/, '');
        let blob = null;
        try { blob = await E.exportBlob(S.origImg, S.params); } catch (e) { status('导出失败：' + (e && e.message ? e.message : e)); return; }
        if (!blob) { status('导出失败'); return; }
        const api = window.imageAdjust || {};
        const file = typeof api.upload === 'function' ? await api.upload(blob, base + '_adjust.png') : null;
        if (!file) { status('图片上传失败，未能生成调色节点'); return; }
        const meta = { adjust: { v: 2, source: { url: S.srcUrl, name: S.srcName }, params: clone(S.params) } };
        if (typeof api.addResult === 'function') await api.addResult(file, false, meta);
        if (typeof api.finish === 'function') api.finish();
    }

    /* ── 快捷键：⌘Z / ⇧⌘Z 撤销重做；按住 \ 看原图 ── */
    window.addEventListener('keydown', e => {
        if (!S.active) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) redo(); else undo(); }
        else if (e.key === '\\') { e.preventDefault(); e.stopImmediatePropagation(); setHold(true); }
        else if (e.key === 'Escape' && S.pick) { e.stopImmediatePropagation(); setPick(null); }
    }, true);
    window.addEventListener('keyup', e => { if (S.active && e.key === '\\') setHold(false); }, true);

    /* 编辑弹窗被关掉（应用后 finish / 点关闭 / Esc）时自动退出调色模式，释放状态 */
    (function watchModal() {
        const modal = document.getElementById('imageEditModal');
        if (!modal || typeof MutationObserver === 'undefined') return;
        new MutationObserver(() => { if (S.active && !modal.classList.contains('open')) leaveAdjustMode(); })
            .observe(modal, { attributes: true, attributeFilter: ['class', 'style'] });
    })();

    window.scheduleAdjustRender = function () { scheduleRender(); };
    window.imageAdjustEnterMode = enterAdjustMode;
    window.imageAdjustLeaveMode = leaveAdjustMode;
    window.applyImageAdjust = applyImageAdjust;
    window.imageAdjustIsAdjustMode = () => S.active;
    window.__iaj = S; /* 调试 / 自动化测试用 */
})();
