// NOVAI shared media helpers — unified from 8 pairs of canvas*/smart* parallel functions.
// Both canvas.js and smart-canvas.js had identical media URL, preview, and video helpers
// with different prefixes. This module provides a single canonical implementation.
// The legacy prefixed wrappers (canvasPreviewImgHtml, smartPreviewImgHtml, etc.) are
// kept as thin aliases that delegate to these shared functions during transition.
(function(){
    'use strict';

    /* ── URL resolution ── */

    // Extract the original (non-proxied) URL from a media-preview or download-output proxy URL.
    function originalMediaUrl(url){
        const raw = String(url || '');
        if(!raw) return '';
        try {
            const parsed = new URL(raw, window.location.origin);
            if(parsed.pathname === '/api/media-preview'){
                return parsed.searchParams.get('url') || raw;
            }
        } catch(e) {}
        return raw;
    }

    // Also support item objects (smart-canvas pattern): {url, name, ...}
    function originalMediaUrlFromItem(itemOrUrl){
        const raw = typeof itemOrUrl === 'string' ? itemOrUrl : (itemOrUrl?.url || '');
        return originalMediaUrl(String(raw || ''));
    }

    // Extract filename from URL path.
    function fileNameFromUrl(url){
        try {
            const parsed = new URL(String(url || ''), window.location.href);
            return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
        } catch(e) {
            return decodeURIComponent(String(url || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '');
        }
    }

    // Build a proxy URL for CORS-cross-origin images (download-output endpoint).
    function proxiedMediaUrl(url, name=''){
        const raw = originalMediaUrl(url);
        if(!raw || raw.startsWith('/assets/') || raw.startsWith('/output/') || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
        if(!/^https?:\/\//i.test(raw)) return raw;
        const filename = name || fileNameFromUrl(raw) || 'preview';
        return `/api/download-output?inline=1&url=${encodeURIComponent(raw)}&name=${encodeURIComponent(filename)}`;
    }

    // proxiedMediaUrl that accepts item objects.
    function proxiedMediaUrlFromItem(itemOrUrl, name=''){
        const url = originalMediaUrlFromItem(itemOrUrl);
        if(!url || url.startsWith('/assets/') || url.startsWith('/output/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
        if(!/^https?:\/\//i.test(url)) return url;
        const filename = name || (typeof itemOrUrl === 'object' ? (itemOrUrl.name || '') : '') || fileNameFromUrl(url) || 'preview';
        return `/api/download-output?inline=1&url=${encodeURIComponent(url)}&name=${encodeURIComponent(filename)}`;
    }

    // Choose display URL: local paths stay local, remote URLs get proxied.
    function displayMediaUrl(url, name=''){
        const raw = originalMediaUrl(url);
        return /^https?:\/\//i.test(raw) ? proxiedMediaUrl(raw, name) : raw;
    }

    // displayMediaUrl that accepts item objects.
    function displayMediaUrlFromItem(itemOrUrl, name=''){
        const url = originalMediaUrlFromItem(itemOrUrl);
        return /^https?:\/\//i.test(url) ? proxiedMediaUrlFromItem(itemOrUrl, name) : url;
    }

    // Build a media-preview (thumbnail) URL for local assets.
    function mediaPreviewUrl(url, size=512){
        const raw = originalMediaUrl(url);
        if(!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
        if(!raw.startsWith('/output/') && !raw.startsWith('/assets/')) return displayMediaUrl(raw);
        if(!/\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|avi|mkv|flv)(\?|#|$)/i.test(raw)) return raw;
        const width = Math.max(64, Math.min(2048, Math.round(Number(size) || 512)));
        return `/api/media-preview?w=${width}&url=${encodeURIComponent(raw)}`;
    }

    // mediaPreviewUrl that accepts item objects.
    function mediaPreviewUrlFromItem(itemOrUrl, size=512){
        const raw = originalMediaUrlFromItem(itemOrUrl);
        if(!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return displayMediaUrlFromItem(itemOrUrl);
        if(!raw.startsWith('/output/') && !raw.startsWith('/assets/')) return displayMediaUrlFromItem(itemOrUrl);
        if(!/\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|avi|mkv)(\?|#|$)/i.test(raw)) return displayMediaUrlFromItem(itemOrUrl);
        const width = Math.max(64, Math.min(2048, Math.round(Number(size) || 512)));
        return `/api/media-preview?w=${width}&url=${encodeURIComponent(raw)}`;
    }

    /* ── Preview HTML generators ── */

    const { escapeHtml, escapeAttr } = window.NovaUtils;

    function previewImgHtml(url, size=512, attrs=''){
        const original = originalMediaUrl(url);
        const preview  = mediaPreviewUrl(original, size);
        return `<img loading="lazy" decoding="async" src="${escapeAttr(preview)}" data-preview-src="${escapeAttr(preview)}" data-original-src="${escapeAttr(original)}" data-url="${escapeAttr(original)}"${attrs ? ` ${attrs}` : ''}>`;
    }

    // previewImgHtml that accepts item objects (smart-canvas pattern).
    function previewImgHtmlFromItem(itemOrUrl, size=512, attrs=''){
        const original = originalMediaUrlFromItem(itemOrUrl);
        const preview  = mediaPreviewUrlFromItem(itemOrUrl, size);
        return `<img src="${escapeHtml(preview)}" data-preview-src="${escapeAttr(preview)}" data-original-src="${escapeAttr(original)}"${attrs ? ` ${attrs}` : ''}>`;
    }

    // Load original image dimensions (width, height).
    function loadImageDimensions(url){
        const src = String(url || '');
        if(!src || /^data:/i.test(src) || /^blob:/i.test(src)) return Promise.resolve(null);
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function videoPreviewHtml(url, size=512, attrs=''){
        const original = originalMediaUrl(url);
        const preview  = mediaPreviewUrl(original, size);
        return `<img loading="lazy" decoding="async" src="${escapeAttr(preview)}" data-preview-src="${escapeAttr(preview)}" data-original-src="${escapeAttr(original)}" data-url="${escapeAttr(original)}" data-preview-kind="video"${attrs ? ` ${attrs}` : ''}>`;
    }

    function videoPreviewHtmlFromItem(itemOrUrl, size=512, attrs=''){
        const original = originalMediaUrlFromItem(itemOrUrl);
        const preview  = mediaPreviewUrlFromItem(itemOrUrl, size);
        return `<img src="${escapeHtml(preview)}" data-preview-src="${escapeAttr(preview)}" data-original-src="${escapeAttr(original)}" data-url="${escapeAttr(original)}" data-preview-kind="video"${attrs ? ` ${attrs}` : ''}>`;
    }

    function videoFallbackHtml(url, attrs=''){
        const original = originalMediaUrl(url);
        const src = displayMediaUrl(original);
        // 复刻上游：fallback 裸 video 也挂原生 controls（#t=0.5 显示首帧，原生条可播放）
        return `<video src="${escapeAttr(src)}#t=0.5" data-url="${escapeAttr(original)}" muted preload="metadata" playsinline disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback" controls${attrs ? ` ${attrs}` : ''}></video>`;
    }

    function videoFallbackHtmlFromItem(url, attrs=''){
        const original = originalMediaUrlFromItem(url);
        const src = displayMediaUrlFromItem({ url: original });
        return `<video src="${escapeHtml(src)}#t=0.5" data-url="${escapeAttr(original)}" muted preload="metadata" playsinline disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback" controls${attrs ? ` ${attrs}` : ''}></video>`;
    }

    function videoPlayerHtml(url, attrs=''){
        const original = originalMediaUrl(url);
        const src = displayMediaUrl(original);
        // 复刻上游：video 挂原生 controls（WebKit/WKWebView 均渲染原生控制条），
        // 自绘控制条保留为兜底——CSS 里 .has-native-controls 时隐藏自绘条，避免双控件。
        return `<div class="smart-video-player has-native-controls" data-url="${escapeAttr(original)}">
      <video src="${escapeAttr(src)}" data-url="${escapeAttr(original)}" autoplay playsinline preload="metadata" disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback" controls${attrs ? ` ${attrs}` : ''}></video>
      <div class="smart-video-controls">
        <button class="svc-btn svc-play" type="button" title="播放/暂停"><i data-lucide="pause"></i></button>
        <div class="svc-progress"><div class="svc-progress-bg"><div class="svc-progress-fill"></div></div><div class="svc-time">0:00 / 0:00</div></div>
        <button class="svc-btn svc-fullscreen" type="button" title="全屏"><i data-lucide="maximize"></i></button>
      </div>
    </div>`;
    }

    function videoPlayerHtmlFromItem(url, attrs=''){
        const original = originalMediaUrlFromItem(url);
        const src = displayMediaUrlFromItem({ url: original });
        return `<div class="smart-video-player has-native-controls" data-url="${escapeAttr(original)}">
      <video src="${escapeHtml(src)}" data-url="${escapeAttr(original)}" data-inline-video-active="1" autoplay playsinline preload="metadata" disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback" controls${attrs ? ` ${attrs}` : ''}></video>
      <div class="smart-video-controls">
        <button class="svc-btn svc-play" type="button" title="播放/暂停"><i data-lucide="pause"></i></button>
        <div class="svc-progress"><div class="svc-progress-bg"><div class="svc-progress-fill"></div></div><div class="svc-time">0:00 / 0:00</div></div>
        <button class="svc-btn svc-fullscreen" type="button" title="全屏"><i data-lucide="maximize"></i></button>
      </div>
    </div>`;
    }

    /* ── RunningHub field helpers ── */

    // 自绘视频控制条初始化：WKWebView（桌面端 pywebview）不渲染 video 原生 controls，
    // 由 HTML 结构 .smart-video-player 提供播放/暂停、进度、全屏控件，这里绑定事件。
    // 供 smart-canvas.js / canvas.js 共用（挂 window，页面内重复定义以先加载者为准）。
    function initSmartVideoControls(playerEl, video){
        if(!playerEl || !video || playerEl.dataset.svcBound) return;
        playerEl.dataset.svcBound = '1';
        const playBtn = playerEl.querySelector('.svc-play');
        const fullBtn = playerEl.querySelector('.svc-fullscreen');
        const fillEl = playerEl.querySelector('.svc-progress-fill');
        const timeEl = playerEl.querySelector('.svc-time');
        const fmt = s => {
            if(!Number.isFinite(s) || s < 0) s = 0;
            const m = Math.floor(s / 60), sec = Math.floor(s % 60);
            return `${m}:${String(sec).padStart(2, '0')}`;
        };
        const refreshIcon = () => {
            if(!playBtn) return;
            const icon = playBtn.querySelector('i');
            if(!icon) return;
            const name = video.paused ? 'play' : 'pause';
            if(icon.getAttribute('data-lucide') !== name){
                icon.setAttribute('data-lucide', name);
                try { if(window.lucide) lucide.createIcons({attrs:{'data-lucide':name}}); } catch(_) {}
            }
        };
        const updateProgress = () => {
            const d = video.duration || 0;
            const c = video.currentTime || 0;
            if(fillEl) fillEl.style.width = d > 0 ? `${Math.min(100, (c / d) * 100)}%` : '0%';
            if(timeEl) timeEl.textContent = `${fmt(c)} / ${fmt(d)}`;
        };
        const toggle = () => {
            if(video.paused){
                // 桌面端 WKWebView 对带声音视频的 play() 可能拒绝（autoplay 策略），
                // 失败后自动降级为静音播放，保证画面能动（用户可再点全屏/进度）。
                video.play?.().catch(() => {
                    try { video.muted = true; video.play?.().catch(() => {}); } catch(_) {}
                });
            } else {
                video.pause();
            }
            refreshIcon();
        };
        // 用 mousedown + click 双绑定：WKWebView 里 click 有时被吞（触摸模拟/拖动拦截），
        // 但 mousedown 里 preventDefault 会取消用户手势激活状态，导致 video.play() 被拒，
        // 所以 mousedown 只 stopPropagation（防节点拖动），实际播放动作留给 click 手势。
        if(playBtn){
            let lastFire = 0;
            const guard = e => { e.stopPropagation(); };
            const fire = e => {
                e.preventDefault(); e.stopPropagation();
                const now = Date.now();
                if(now - lastFire < 200) return;
                lastFire = now;
                toggle();
            };
            playBtn.addEventListener('mousedown', guard);
            playBtn.addEventListener('click', fire);
        }
        if(video){
            const syncPlayingClass = () => { try { playerEl.classList.toggle('playing', !video.paused); } catch(_) {} };
            video.addEventListener('play', () => { refreshIcon(); syncPlayingClass(); });
            video.addEventListener('pause', () => { refreshIcon(); syncPlayingClass(); });
            video.addEventListener('timeupdate', updateProgress);
            video.addEventListener('loadedmetadata', updateProgress);
            video.addEventListener('ended', () => { refreshIcon(); syncPlayingClass(); });
            // video 本体点击也切换播放/暂停（WKWebView 下原生点击无反应，需自处理）
            let lastVideoTap = 0;
            video.addEventListener('mousedown', e => {
                // 只拦冒泡防节点拖动；不能 preventDefault（会取消用户手势激活，play() 被拒）
                e.stopPropagation();
            });
            video.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                const now = Date.now();
                if(now - lastVideoTap < 250) return;
                lastVideoTap = now;
                toggle();
            });
            syncPlayingClass();
        }
        const seek = (e) => {
            const bar = e.currentTarget;
            const rect = bar.getBoundingClientRect();
            const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
            const d = video.duration || 0;
            if(d > 0){ try { video.currentTime = ratio * d; } catch(_) {} }
            updateProgress();
        };
        playerEl.querySelectorAll('.svc-progress-bg').forEach(bar => {
            const seek = e => {
                e.preventDefault(); e.stopPropagation();
                const rect = bar.getBoundingClientRect();
                const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
                const d = video.duration || 0;
                if(d > 0){ try { video.currentTime = ratio * d; } catch(_) {} }
                updateProgress();
            };
            bar.addEventListener('mousedown', e => e.stopPropagation());
            bar.addEventListener('click', seek);
        });
        if(fullBtn){
            const exitCssFullscreen = () => {
                try {
                    playerEl.classList.remove('svc-css-fullscreen');
                    document.body.classList.remove('svc-fullscreen-active');
                    // 归还节点：画布 world 带 transform，fixed 定位相对 transform 容器而非视口，
                    // 全屏时播放器挂到 body（真正铺满视口），退出后放回原位，否则节点布局丢失。
                    const parent = playerEl._svcFsParent;
                    if(parent){
                        const next = playerEl._svcFsNextSibling;
                        playerEl._svcFsParent = null;
                        playerEl._svcFsNextSibling = null;
                        try { if(next) next.before(playerEl); else parent.appendChild(playerEl); }
                        catch(_) { try { parent.appendChild(playerEl); } catch(_) {} }
                    }
                } catch(_) {}
            };
            const cssFullscreen = () => {
                try {
                    if(playerEl.parentElement !== document.body){
                        playerEl._svcFsParent = playerEl.parentElement;
                        playerEl._svcFsNextSibling = playerEl.nextSibling;
                        document.body.appendChild(playerEl);
                    }
                    playerEl.classList.add('svc-css-fullscreen');
                    document.body.classList.add('svc-fullscreen-active');
                } catch(_) {}
            };
            const requestFS = () => {
                try {
                    if(playerEl.classList.contains('svc-css-fullscreen')){
                        // 退出 CSS 全屏
                        exitCssFullscreen();
                        return;
                    }
                    // 优先原生全屏；但 WKWebView（桌面端 pywebview）的 requestFullscreen 可能静默失败——
                    // API 存在但不生效、promise 不 reject 也不触发 fullscreenchange，导致"点全屏无反应"。
                    // 对策：发起请求后 350ms 内未进入原生全屏（无 fullscreenchange）即判定失败 → CSS 降级铺满视口。
                    if(document.fullscreenElement){
                        document.exitFullscreen?.();
                        return;
                    }
                    let fsTimer = setTimeout(cssFullscreen, 350);
                    const cancelTimer = () => { clearTimeout(fsTimer); };
                    const onFsChange = () => cancelTimer();
                    document.addEventListener('fullscreenchange', onFsChange, {once:true});
                    document.addEventListener('webkitfullscreenchange', onFsChange, {once:true});
                    try {
                        if(playerEl.requestFullscreen){
                            const p = playerEl.requestFullscreen();
                            if(p && typeof p.catch === 'function') p.catch(() => { cancelTimer(); cssFullscreen(); });
                        } else if(playerEl.webkitRequestFullscreen){
                            playerEl.webkitRequestFullscreen();
                        } else if(video.webkitEnterFullscreen){
                            video.webkitEnterFullscreen();
                        } else {
                            cancelTimer();
                            cssFullscreen();
                        }
                    } catch(_) { cancelTimer(); cssFullscreen(); }
                } catch(_) { cssFullscreen(); }
            };
            const fire = e => { e.preventDefault(); e.stopPropagation(); requestFS(); };
            fullBtn.addEventListener('mousedown', e => e.stopPropagation());
            fullBtn.addEventListener('click', fire);
        }
        refreshIcon();
        updateProgress();
    }
    if(typeof window !== 'undefined') window.initSmartVideoControls = initSmartVideoControls;

    // Determine the logical kind of a RunningHub field (image, video, audio, slider, number, boolean, text).
    function rhFieldKind(field){
        const type = String(field?.fieldType || '').trim().toUpperCase();
        if(type === 'IMAGE') return 'image';
        if(type === 'VIDEO') return 'video';
        if(type === 'AUDIO') return 'audio';
        if(type === 'SLIDER') return 'slider';
        if(['NUMBER','FLOAT','INTEGER','INT'].includes(type)) return 'number';
        if(['BOOLEAN','BOOL'].includes(type)) return 'boolean';
        const key = `${field?.fieldName || ''} ${field?.fieldValue || ''}`.toLowerCase();
        if(/\b(image|img|mask|photo|picture)\b/.test(key) || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(key)) return 'image';
        if(/\b(video|movie|mp4)\b/.test(key) || /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(key)) return 'video';
        if(/\b(audio|sound|music|voice)\b/.test(key) || /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i.test(key)) return 'audio';
        return 'text';
    }

    // Determine the role of a RunningHub field (image, video, audio, number, slider, boolean, prompt, text).
    function rhFieldRole(field){
        const kind = rhFieldKind(field);
        if(['image','video','audio','number','slider','boolean'].includes(kind)) return kind;
        const text = `${field?.fieldName || ''} ${field?.label || ''} ${field?.group || ''}`.toLowerCase();
        if(/prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向/.test(text)) return 'prompt';
        return 'text';
    }

    // Filter RunningHub fields: prefer enabled=true ones; fall back to all if none are explicitly enabled.
    function rhUsableFields(fields){
        const list = Array.isArray(fields) ? fields : [];
        if(!list.length) return [];
        const enabled = list.filter(f => f.enabled === true);
        return enabled.length ? enabled : list;
    }

    /* ── expose ── */
    window.NovaMedia = {
        originalMediaUrl, originalMediaUrlFromItem,
        fileNameFromUrl,
        proxiedMediaUrl, proxiedMediaUrlFromItem,
        displayMediaUrl, displayMediaUrlFromItem,
        mediaPreviewUrl, mediaPreviewUrlFromItem,
        previewImgHtml, previewImgHtmlFromItem,
        loadImageDimensions,
        videoPreviewHtml, videoPreviewHtmlFromItem,
        videoFallbackHtml, videoFallbackHtmlFromItem,
        videoPlayerHtml, videoPlayerHtmlFromItem,
        rhFieldKind, rhFieldRole, rhUsableFields
    };
})();
