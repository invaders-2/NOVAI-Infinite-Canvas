/* ════════════════════════════════════════════════════════════════
   NOVAI · 图标常量（唯一真值源）
   ────────────────────────────────────────────────────────────────
   背景：
     static/vendor/js/lucide-subset.js 是精简子集（146 个图标），
     createIcons() 遇到子集里没有的名字会**静默跳过** —— 不报错、
     不渲染、不留痕迹，排查极难。本模块做三件事：

     1. ICONS —— 语义名 → lucide kebab 名的唯一映射。
        所有 data-icon="xxx" 走这里解析，换图标只改一处。

     2. EXTRA_ICONS —— 子集缺失、但项目里实际用到的 12 个图标的
        路径数据（从完整 lucide v1.16.0 提取，2.2KB），运行时补齐。

     3. 包裹 lucide.createIcons —— 自动解析 data-icon、注入补全
        图标、并在开发环境把仍渲染不出来的名字打到 console。
        因为所有页面都是调 lucide.createIcons()，包一层即可全局
        生效，无需改任何调用点。

   用法：
     HTML    <i data-icon="close"></i>                  （推荐）
     JS模板  NOVAI_ICONS.tag('close', 'w-4 h-4')
     兼容    <i data-lucide="x"></i>                    （仍工作）

   维护：新增图标先查 ICONS；若 lucide 子集缺该名，把路径数据
        加到 EXTRA_ICONS（可从 static/vendor/js/lucide.js 提取）。
   ════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    /* ── 1. 语义名 → lucide kebab 名 ─────────────────────────────
       约定：键用小驼峰语义名，值是 lucide 官方 kebab 名。
       新增图标在这里加一行，页面里用 data-icon="<键>"。 */
    var ICONS = {
        /* 通用 */
        close: 'x',
        check: 'check',
        plus: 'plus',
        minus: 'minus',
        send: 'send',
        search: 'search',
        settings: 'settings',
        trash: 'trash-2',
        copy: 'copy',
        download: 'download',
        upload: 'upload',
        refresh: 'refresh-cw',
        external: 'external-link',
        more: 'more-horizontal',
        eye: 'eye',
        lock: 'lock',
        key: 'key-round',
        save: 'save',
        pin: 'pin',
        info: 'info',
        link: 'link',
        history: 'history',

        /* 方向 / 展开收起 */
        chevronUp: 'chevron-up',
        chevronDown: 'chevron-down',
        chevronRight: 'chevron-right',
        chevronLeft: 'chevron-left',
        arrowUp: 'arrow-up',
        arrowRight: 'arrow-right',

        /* 聊天页 · 顶栏与侧栏 */
        newChat: 'plus',
        system: 'sliders-horizontal',
        prompt: 'sparkles',

        /* 聊天页 · composer 三件套 */
        model: 'boxes',
        resolution: 'ruler',
        think: 'sparkles',
        attach: 'paperclip',
        file: 'file',

        /* 聊天页 · 空态 / 消息 */
        chat: 'messages-square',
        empty: 'inbox',

        /* 空态工作台 deck 六宫格 */
        deckImage: 'image',
        deckWrite: 'pencil',
        deckCode: 'terminal',
        deckDoc: 'file-text',
        deckSearch: 'search',
        deckIdea: 'sparkles',

        /* 媒体 */
        image: 'image',
        video: 'video',
        play: 'play',
        pause: 'pause',
        stop: 'square',
        zap: 'zap',

        /* 画布 / 资产 */
        canvas: 'layout-dashboard',
        workflow: 'workflow',
        layers: 'layers',
        folder: 'folder-open',
        folderSearch: 'folder-search',
        folderOutput: 'folder-output',
        folderCog: 'folder-cog',
        grid: 'layout-grid',
        list: 'list',
        database: 'database',
        clock: 'clock-3',
        spinner: 'loader-circle',
        zoomIn: 'zoom-in',
        zoomOut: 'zoom-out',
        fit: 'maximize',
        cpu: 'cpu',
        cloud: 'cloud',
        monitor: 'monitor',
        terminal: 'terminal',

        /* API 设置 · 推荐分组 */
        blocks: 'blocks',
        badgePercent: 'badge-percent',

        /* ComfyUI · 工作流列表 */
        package: 'package',
        fileJson: 'file-json-2'
    };

    /* ── 2. lucide 子集缺失的图标（从完整 lucide v1.16.0 提取）────
       来源：static/vendor/js/lucide.js（401KB 完整库，仅构建时引用）。
       清单 = 全项目 data-lucide 盘点后与子集 146 名做差集得到。 */
    var EXTRA_ICONS = {
        ArrowRight: [["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]],
        BadgePercent: [["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],
        Blocks: [["path",{"d":"M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"}],["rect",{"x":"14","y":"2","width":"8","height":"8","rx":"1"}]],
        Clock3: [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6h4"}]],
        Database: [["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5V19A9 3 0 0 0 21 19V5"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}]],
        FileJson2: [["path",{"d":"M14 22h4a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v6"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M5 14a1 1 0 0 0-1 1v2a1 1 0 0 1-1 1 1 1 0 0 1 1 1v2a1 1 0 0 0 1 1"}],["path",{"d":"M9 22a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-2a1 1 0 0 0-1-1"}]],
        FolderCog: [["path",{"d":"M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3"}],["path",{"d":"m14.305 19.53.923-.382"}],["path",{"d":"m15.228 16.852-.923-.383"}],["path",{"d":"m16.852 15.228-.383-.923"}],["path",{"d":"m16.852 20.772-.383.924"}],["path",{"d":"m19.148 15.228.383-.923"}],["path",{"d":"m19.53 21.696-.382-.924"}],["path",{"d":"m20.772 16.852.924-.383"}],["path",{"d":"m20.772 19.148.924.383"}],["circle",{"cx":"18","cy":"18","r":"3"}]],
        FolderOutput: [["path",{"d":"M2 7.5V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1.5"}],["path",{"d":"M2 13h10"}],["path",{"d":"m5 10-3 3 3 3"}]],
        FolderSearch: [["path",{"d":"M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"}],["path",{"d":"m21 21-1.9-1.9"}],["circle",{"cx":"17","cy":"17","r":"3"}]],
        Inbox: [["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],
        LoaderCircle: [["path",{"d":"M21 12a9 9 0 1 1-6.219-8.56"}]],
        Minus: [["path",{"d":"M5 12h14"}]],
        Pause: [["rect",{"x":"14","y":"3","width":"5","height":"18","rx":"1"}],["rect",{"x":"5","y":"3","width":"5","height":"18","rx":"1"}]],
        Settings: [["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
        Video: [["path",{"d":"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"}],["rect",{"x":"2","y":"6","width":"14","height":"12","rx":"2"}]]
    };

    /* ── 3. 工具 ───────────────────────────────────────────────── */
    function kebabToPascal(n) {
        return String(n).replace(/(^|[-_])(\w)/g, function (_, __, c) { return c.toUpperCase(); });
    }

    /** 语义名 → lucide kebab 名（未收录则原样返回，兼容直接写 kebab） */
    function name(key) {
        return ICONS[key] || String(key || '');
    }

    /** 生成占位标签，供 JS 模板字符串里使用 */
    function tag(key, cls) {
        return '<i data-icon="' + key + '"' + (cls ? ' class="' + cls + '"' : '') + '></i>';
    }

    /** 把 [data-icon] 语义名解析成 [data-lucide] kebab 名 */
    function resolve(root) {
        var nodes = (root || document).querySelectorAll('[data-icon]');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var resolved = name(el.getAttribute('data-icon'));
            // 只在变化时改写：createIcons 每次都会把占位符 replaceChild 成
            // 新 <svg>，减少无谓的属性抖动
            if (el.getAttribute('data-lucide') !== resolved) {
                el.setAttribute('data-lucide', resolved);
            }
        }
    }

    /** 开发环境自检：找出仍然渲染不出来的图标名 */
    var reported = {};
    function audit(root) {
        if (!isDev()) return [];
        var nodes = (root || document).querySelectorAll('[data-lucide]');
        var bad = [];
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (String(el.tagName).toLowerCase() === 'svg') continue;
            if (el.querySelector('svg')) continue;
            var n = el.getAttribute('data-lucide');
            if (!n || el.getAttribute('data-icon-miss') === n) continue;
            el.setAttribute('data-icon-miss', n);
            bad.push(n);
        }
        for (var j = 0; j < bad.length; j++) {
            if (reported[bad[j]]) continue;
            reported[bad[j]] = true;
            console.warn('[icons] lucide 子集缺名，图标未渲染：' + bad[j] +
                ' —— 请把路径数据补进 static/js/shared/icons.js 的 EXTRA_ICONS');
        }
        return bad;
    }

    function isDev() {
        try {
            if (localStorage.getItem('novai_debug_icons') === '1') return true;
            var h = location.hostname;
            return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0';
        } catch (e) { return false; }
    }

    /* ── 4. 包裹 lucide.createIcons ──────────────────────────────
       所有页面都调 lucide.createIcons()，包一层即可全局生效：
         · 调用前解析 data-icon 语义名
         · 注入 EXTRA_ICONS（合并而非覆盖，兼容显式传 icons 的调用点）
         · 调用后开发环境自检 */
    function install() {
        var lucide = global.lucide;
        if (!lucide || typeof lucide.createIcons !== 'function') return false;
        if (lucide.__novaiIconsPatched) return true;

        var orig = lucide.createIcons.bind(lucide);
        var merged = null;
        function mergedIcons() {
            if (!merged) {
                merged = {};
                var base = lucide.icons || {};
                for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
                for (var e in EXTRA_ICONS) if (Object.prototype.hasOwnProperty.call(EXTRA_ICONS, e)) merged[e] = EXTRA_ICONS[e];
            }
            return merged;
        }

        lucide.createIcons = function (opts) {
            var o = {};
            if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
            o.icons = Object.assign({}, mergedIcons(), o.icons || {});
            try { resolve(document); } catch (e) {}
            var r = orig(o);
            try { audit(document); } catch (e) {}
            return r;
        };
        lucide.createIcons.__novaiPatched = true;
        lucide.__novaiIconsPatched = true;
        return true;
    }

    function boot() {
        if (install()) {
            // 补跑一次，处理本模块加载前就已经写在 DOM 里的图标
            try { resolve(document); global.lucide.createIcons(); } catch (e) {}
        } else if (!boot.__tries || boot.__tries < 60) {
            boot.__tries = (boot.__tries || 0) + 1;
            setTimeout(boot, 50);
        }
    }

    global.NOVAI_ICONS = {
        ICONS: ICONS,
        EXTRA_ICONS: EXTRA_ICONS,
        name: name,
        tag: tag,
        resolve: resolve,
        audit: audit,
        refresh: function (root) { try { resolve(root); global.lucide && global.lucide.createIcons(); audit(root); } catch (e) {} },
        report: function () { return audit(document); },
        _pascal: kebabToPascal
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
