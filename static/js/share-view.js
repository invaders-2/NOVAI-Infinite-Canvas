/* NOVAI 公开分享页（/c/{token}）
 *
 * 契约（后端实现）：
 *   GET  /api/share/{token}        -> 200 {canvas,title,owner_username,allow_clone,role,authenticated,can_clone}
 *                                     401 {code:PASSWORD_REQUIRED} / 401 {code:AUTH_REQUIRED}
 *                                     410 EXPIRED / 404 NOT_FOUND
 *   POST /api/share/{token}/unlock {password} -> 200 / 403 BAD_PASSWORD
 *   POST /api/share/{token}/clone  -> 201 {canvas_id}
 *
 * 链接打开必须登录：拿到 AUTH_REQUIRED 直接跳 /login?next=/c/{token}，未登录不渲染任何画布内容。
 * 登录后后端会把当前用户加为 viewer，素材走现有 /assets 鉴权，这里只做只读渲染。
 */
(function () {
    'use strict';

    var token = (function () {
        var match = /^\/c\/([^/?#]+)/.exec(location.pathname);
        if (match && match[1]) return decodeURIComponent(match[1]);
        return new URLSearchParams(location.search).get('token') || '';
    })();

    var stage = document.getElementById('shareStage');
    var world = document.getElementById('shareWorld');
    var topBar = document.getElementById('shareTop');
    var foot = document.getElementById('shareFoot');
    var titleEl = document.getElementById('shareTitle');
    var ownerEl = document.getElementById('shareOwner');
    var cloneBtn = document.getElementById('shareCloneBtn');
    var stateEl = document.getElementById('shareState');
    var loadingEl = document.getElementById('shareLoading');
    var gateEl = document.getElementById('shareGate');
    var gateTitleEl = document.getElementById('shareGateTitle');
    var gateSubEl = document.getElementById('shareGateSub');
    var gateForm = document.getElementById('sharePasswordForm');
    var gateInput = document.getElementById('sharePasswordInput');
    var gateError = document.getElementById('shareGateError');
    var messageEl = document.getElementById('shareMessage');
    var messageTitleEl = document.getElementById('shareMessageTitle');
    var messageTextEl = document.getElementById('shareMessageText');
    var messageActionEl = document.getElementById('shareMessageAction');
    var toastEl = document.getElementById('shareToast');

    var view = { x: 0, y: 0, scale: 1 };
    var shareData = null;
    var rendered = [];
    var dragging = null;
    var cloneBusy = false;
    var toastTimer = 0;
    var emptyEl = null;
    var AVATAR_PALETTE = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function safeColor(value, fallback) {
        var color = String(value || '');
        return /^#[0-9a-f]{3,8}$/i.test(color) ? color : (fallback || AVATAR_PALETTE[0]);
    }

    function rgba(color, alpha) {
        var hex = safeColor(color).replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (ch) { return ch + ch; }).join('');
        if (hex.length < 6) return 'rgba(78,121,167,' + alpha + ')';
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function contrastOn(color) {
        var hex = safeColor(color).replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (ch) { return ch + ch; }).join('');
        if (hex.length < 6) return '#ffffff';
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.62 ? '#111111' : '#ffffff';
    }

    function mediaKind(item) {
        var kind = String(item && item.kind || '').toLowerCase();
        if (kind === 'video' || kind === 'audio' || kind === 'image') return kind;
        var url = String(item && item.url || '').split('?')[0].toLowerCase();
        if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(url)) return 'video';
        if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(url)) return 'audio';
        return 'image';
    }

    function mediaItems(node) {
        return (node.images || []).filter(function (item) { return item && item.url; });
    }

    function isMediaNode(node) {
        return !node.type || node.type === 'smart-image' || node.type === 'smart-video' || node.type === 'smart-audio';
    }

    function nodeBox(node) {
        var width = Number(node.w);
        var height = Number(node.h);
        if (isFinite(width) && width > 24 && isFinite(height) && height > 24) {
            return { w: Math.round(width), h: Math.round(height) };
        }
        var type = node.type || 'smart-image';
        if (type === 'smart-text') return { w: 316, h: 194 };
        if (type === 'smart-label') return { w: 150, h: 38 };
        if (type === 'smart-prompt') {
            return { w: 316, h: Math.max(150, Math.round(Number(node.autoH) || 180)) };
        }
        if (type === 'smart-group') return { w: 340, h: 286 };
        var items = mediaItems(node);
        var scale = Number(node.scale) > 0 ? Number(node.scale) : (items.length > 1 ? 0.8 : 2);
        if (!items.length) {
            return { w: Math.round(260 * scale), h: Math.round(180 * scale) };
        }
        if (items.length === 1) {
            var item = items[0];
            var kind = mediaKind(item);
            var naturalW = Number(item.natural_w);
            var naturalH = Number(item.natural_h);
            if (!naturalW && item.url) {
                var match = /\/(\d{2,5})x(\d{2,5})\./.exec(String(item.url));
                if (match) { naturalW = Number(match[1]); naturalH = Number(match[2]); }
            }
            if (!naturalW || !naturalH) return { w: Math.round(260 * scale), h: Math.round(180 * scale) };
            var maxW = (kind === 'audio' ? 288 : 260) * scale;
            var maxH = (kind === 'audio' ? 150 : 220) * scale;
            var fit = Math.min(maxW / naturalW, maxH / naturalH);
            return { w: Math.max(72, Math.round(naturalW * fit)), h: Math.max(72, Math.round(naturalH * fit)) };
        }
        var cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(items.length))));
        var rows = Math.ceil(items.length / cols);
        var thumb = Math.round(96 * scale);
        var cell = thumb + 8;
        return {
            w: Math.max(Math.round(226 * scale), cols * cell + 32),
            h: rows * cell - 8 + 32,
            cols: cols
        };
    }

    function audioIconHtml() {
        return '<span class="share-audio-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span>';
    }

    function mediaCellHtml(item, lazy) {
        var kind = mediaKind(item);
        var url = esc(item.url);
        if (kind === 'video') {
            return '<div class="share-media-cell"><video src="' + url + '" controls playsinline preload="metadata"></video></div>';
        }
        if (kind === 'audio') {
            return '<div class="share-media-cell">' + audioIconHtml() + '</div>';
        }
        return '<div class="share-media-cell"><img src="' + url + '" alt="" loading="' + (lazy ? 'lazy' : 'eager') + '" draggable="false"><span class="share-media-missing" hidden>图片加载失败</span></div>';
    }

    function mediaBodyHtml(node) {
        var items = mediaItems(node);
        var type = node.type || 'smart-image';
        if (!items.length) {
            return '<div class="share-audio-card"><span class="share-empty-text">空' + (type === 'smart-audio' ? '音频' : '节点') + '</span></div>';
        }
        if (type === 'smart-audio' || mediaKind(items[0]) === 'audio') {
            return '<div class="share-audio-card">' + audioIconHtml() +
                '<audio controls preload="metadata" src="' + esc(items[0].url) + '"></audio></div>';
        }
        if (items.length === 1) {
            return mediaCellHtml(items[0], false);
        }
        var cols = nodeBox(node).cols || 2;
        return '<div class="share-media-grid" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr));">' +
            items.map(function (item) { return mediaCellHtml(item, true); }).join('') + '</div>';
    }

    function labelBodyHtml(node) {
        var color = safeColor(node.labelColor);
        var solid = node.labelStyle === 'solid';
        var fg = contrastOn(color);
        var style = 'font-size:' + (Number(node.labelFontSize) || 13) + 'px;' +
            (solid ? 'background:' + color + ';color:' + fg + ';' : 'background:' + rgba(color, 0.16) + ';color:var(--share-text);') +
            '--label-accent:' + color + ';--label-fg:' + fg + ';';
        return '<div class="share-label-pill is-' + esc(node.labelStyle || 'none') + '" style="' + style + '">' +
            (node.labelDot ? '<span class="share-label-dot"></span>' : '') +
            '<span class="share-label-text">' + esc(node.text || '') + '</span></div>';
    }

    function promptText(node) {
        if (Array.isArray(node.promptItems) && node.promptItems.length) {
            return node.promptItems.map(function (item) { return String(item && item.text || item || ''); }).join('\n');
        }
        return String(node.text || node.prompt || '');
    }

    function nodeInnerHtml(node) {
        var type = node.type || 'smart-image';
        if (isMediaNode(node)) return mediaBodyHtml(node);
        if (type === 'smart-label') return labelBodyHtml(node);
        if (type === 'smart-text') {
            var text = String(node.text || '');
            return text
                ? '<div class="share-text">' + esc(text) + '</div>'
                : '<div class="share-text share-empty-text">空文本</div>';
        }
        if (type === 'smart-prompt') {
            var prompt = promptText(node);
            return '<div class="share-prompt-head">提示词</div>' +
                '<div class="share-prompt-text">' + (prompt ? esc(prompt) : '<span class="share-empty-text">还没有提示词</span>') + '</div>';
        }
        if (type === 'smart-group') {
            return '<div class="share-group-title">' + esc(node.title || node.alias || '分组') + '</div>';
        }
        var summary = promptText(node);
        return '<div class="share-generic-head">' + esc(node.type === 'smart-loop' ? 'Loop' : '节点') + '</div>' +
            '<div class="share-generic-text">' + esc(summary || node.title || '') + '</div>';
    }

    function nodeClassList(node) {
        var type = node.type || 'smart-image';
        var classes = ['share-node'];
        if (isMediaNode(node)) {
            classes.push('share-node--media');
            if (mediaItems(node).length <= 1) classes.push('is-single');
        } else if (type === 'smart-label') {
            classes.push('share-node--label');
        } else if (type === 'smart-text') {
            classes.push('share-node--text');
        } else if (type === 'smart-prompt') {
            classes.push('share-node--prompt');
        } else if (type === 'smart-group') {
            classes.push('share-node--group');
        } else {
            classes.push('share-node--generic');
        }
        return classes.join(' ');
    }

    function renderCanvas(canvas) {
        var nodes = Array.isArray(canvas.nodes) ? canvas.nodes.slice() : [];
        var connections = Array.isArray(canvas.connections) ? canvas.connections : [];
        world.innerHTML = '';
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'share-links');
        svg.setAttribute('aria-hidden', 'true');
        world.appendChild(svg);
        rendered = [];
        var byId = {};
        nodes.forEach(function (node) {
            if (!node || !node.id) return;
            var box = nodeBox(node);
            var div = document.createElement('div');
            div.className = nodeClassList(node);
            div.setAttribute('data-node-id', String(node.id));
            div.style.left = Math.round(Number(node.x) || 0) + 'px';
            div.style.top = Math.round(Number(node.y) || 0) + 'px';
            div.style.width = box.w + 'px';
            div.style.height = box.h + 'px';
            div.innerHTML = nodeInnerHtml(node);
            world.appendChild(div);
            var record = {
                x: Number(node.x) || 0,
                y: Number(node.y) || 0,
                w: box.w,
                h: box.h,
                el: div
            };
            rendered.push(record);
            byId[String(node.id)] = record;
        });
        var paths = [];
        connections.forEach(function (conn) {
            if (!conn) return;
            var from = byId[String(conn.from)];
            var to = byId[String(conn.to)];
            if (!from || !to) return;
            var x1 = from.x + from.w;
            var y1 = from.y + from.h / 2;
            var x2 = to.x;
            var y2 = to.y + to.h / 2;
            var bend = Math.max(26, Math.abs(x2 - x1) * 0.45);
            paths.push('<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
                ' C' + (x1 + bend).toFixed(1) + ' ' + y1.toFixed(1) + ' ' +
                (x2 - bend).toFixed(1) + ' ' + y2.toFixed(1) + ' ' +
                x2.toFixed(1) + ' ' + y2.toFixed(1) + '"/>');
        });
        svg.innerHTML = paths.join('');
        world.querySelectorAll('img').forEach(function (img) {
            img.addEventListener('error', function () {
                img.style.visibility = 'hidden';
                var miss = img.parentElement && img.parentElement.querySelector('.share-media-missing');
                if (miss) miss.hidden = false;
            }, { once: true });
        });
        if (emptyEl && emptyEl.parentElement) emptyEl.remove();
        emptyEl = null;
        if (!rendered.length) {
            emptyEl = document.createElement('div');
            emptyEl.className = 'share-empty-canvas';
            emptyEl.textContent = '这个画布还没有内容';
            stage.appendChild(emptyEl);
        }
    }

    function applyView() {
        world.style.transform = 'translate(' + view.x.toFixed(2) + 'px,' + view.y.toFixed(2) + 'px) scale(' + view.scale.toFixed(4) + ')';
    }

    function fitView() {
        if (!rendered.length) {
            view = { x: window.innerWidth / 2, y: window.innerHeight / 2, scale: 1 };
            applyView();
            return;
        }
        var minX = Infinity;
        var minY = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;
        rendered.forEach(function (node) {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + node.w);
            maxY = Math.max(maxY, node.y + node.h);
        });
        var contentW = Math.max(1, maxX - minX);
        var contentH = Math.max(1, maxY - minY);
        var availW = Math.max(200, window.innerWidth - 280);
        var availH = Math.max(180, window.innerHeight - 168);
        var scale = Math.min(availW / contentW, availH / contentH, 1.4);
        scale = Math.max(0.05, Math.min(scale, 3));
        view = {
            x: (window.innerWidth - contentW * scale) / 2 - minX * scale,
            y: 88 + (window.innerHeight - 88 - 52 - contentH * scale) / 2 - minY * scale,
            scale: scale
        };
        applyView();
    }

    function zoomAt(px, py, factor) {
        var next = Math.max(0.08, Math.min(4, view.scale * factor));
        var ratio = next / view.scale;
        view.x = px - (px - view.x) * ratio;
        view.y = py - (py - view.y) * ratio;
        view.scale = next;
        applyView();
    }

    function showToast(text, isError) {
        if (!toastEl) return;
        toastEl.textContent = String(text || '');
        toastEl.hidden = false;
        toastEl.classList.toggle('is-error', Boolean(isError));
        requestAnimationFrame(function () { toastEl.classList.add('is-show'); });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('is-show');
            setTimeout(function () { toastEl.hidden = true; }, 220);
        }, 2800);
    }

    function goLogin() {
        var next = '/c/' + encodeURIComponent(token);
        location.replace('/login?next=' + encodeURIComponent(next));
    }

    function hideState() {
        if (stateEl) stateEl.hidden = true;
    }

    function showLoading() {
        if (!stateEl) return;
        stateEl.hidden = false;
        loadingEl.hidden = false;
        gateEl.hidden = true;
        messageEl.hidden = true;
        topBar.hidden = true;
        foot.hidden = true;
    }

    function showPassword() {
        stateEl.hidden = false;
        loadingEl.hidden = true;
        gateEl.hidden = false;
        messageEl.hidden = true;
        topBar.hidden = true;
        foot.hidden = true;
        gateError.hidden = true;
        gateError.textContent = '';
        if (gateInput) {
            gateInput.value = '';
            setTimeout(function () { gateInput.focus(); }, 30);
        }
    }

    function showMessage(title, text, retry) {
        stateEl.hidden = false;
        loadingEl.hidden = true;
        gateEl.hidden = true;
        messageEl.hidden = false;
        topBar.hidden = true;
        foot.hidden = true;
        messageTitleEl.textContent = title;
        messageTextEl.textContent = text || '';
        if (retry) {
            messageActionEl.hidden = false;
            messageActionEl.textContent = '重新加载';
            messageActionEl.setAttribute('href', location.href);
        } else {
            messageActionEl.hidden = false;
            messageActionEl.textContent = '返回首页';
            messageActionEl.setAttribute('href', '/');
        }
    }

    function renderShare(data) {
        shareData = data || {};
        var canvas = shareData.canvas || {};
        var title = String(shareData.title || canvas.title || '未命名画布');
        titleEl.textContent = title;
        titleEl.title = title;
        document.title = title + ' · 分享 · NOVAI';
        ownerEl.textContent = String(shareData.owner_username || '画布创建者');
        cloneBtn.hidden = !(shareData.authenticated === true && shareData.allow_clone === true);
        renderCanvas(canvas);
        hideState();
        topBar.hidden = false;
        foot.hidden = false;
        /* 同步适配：节点尺寸不依赖图片加载，延迟 fit 会和用户刚滚轮缩放抢状态 */
        fitView();
    }

    function handleResponse(response) {
        return response.text().then(function (text) {
            var body = {};
            try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {}; }
            return { status: response.status, ok: response.ok, body: body };
        });
    }

    function loadShare() {
        if (!token) {
            showMessage('链接无效或已被关闭', '分享链接缺少必要参数。');
            return;
        }
        showLoading();
        fetch('/api/share/' + encodeURIComponent(token), {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        }).then(handleResponse).then(function (result) {
            if (result.status === 200) {
                renderShare(result.body);
                return;
            }
            if (result.status === 401) {
                var code = String(result.body && result.body.code || '');
                if (code === 'PASSWORD_REQUIRED') { showPassword(); return; }
                goLogin();
                return;
            }
            if (result.status === 410) {
                showMessage('链接已过期', '该分享链接已过期，请联系画布创建者重新生成。');
                return;
            }
            if (result.status === 404) {
                showMessage('链接无效或已被关闭', '请向画布创建者确认分享链接是否仍然有效。');
                return;
            }
            showMessage('加载失败', (result.body && result.body.detail) || '暂时无法打开这个分享链接，请稍后重试。', true);
        }).catch(function () {
            showMessage('网络异常', '请检查网络连接后重试。', true);
        });
    }

    function submitPassword() {
        var value = String(gateInput && gateInput.value || '');
        if (!value) {
            gateError.hidden = false;
            gateError.textContent = '请输入访问密码';
            if (gateInput) gateInput.focus();
            return;
        }
        var button = gateForm.querySelector('button');
        if (button) button.disabled = true;
        gateError.hidden = true;
        fetch('/api/share/' + encodeURIComponent(token) + '/unlock', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ password: value })
        }).then(handleResponse).then(function (result) {
            if (button) button.disabled = false;
            if (result.ok) { loadShare(); return; }
            if (result.status === 403) {
                gateError.hidden = false;
                gateError.textContent = '密码不正确，请重试';
                gateInput.value = '';
                gateInput.focus();
                return;
            }
            if (result.status === 410) {
                showMessage('链接已过期', '该分享链接已过期，请联系画布创建者重新生成。');
                return;
            }
            if (result.status === 401) { goLogin(); return; }
            gateError.hidden = false;
            gateError.textContent = (result.body && result.body.detail) || '验证失败，请稍后重试';
        }).catch(function () {
            if (button) button.disabled = false;
            gateError.hidden = false;
            gateError.textContent = '网络异常，请稍后重试';
        });
    }

    function cloneCanvas() {
        if (!shareData || shareData.allow_clone !== true || cloneBusy) return;
        if (shareData.authenticated !== true) { goLogin(); return; }
        cloneBusy = true;
        cloneBtn.disabled = true;
        cloneBtn.textContent = '正在克隆…';
        fetch('/api/share/' + encodeURIComponent(token) + '/clone', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        }).then(handleResponse).then(function (result) {
            cloneBusy = false;
            cloneBtn.disabled = false;
            cloneBtn.textContent = '克隆到我的画布';
            if (result.status === 201 && result.body && result.body.canvas_id) {
                location.href = '/static/smart-canvas.html?id=' + encodeURIComponent(result.body.canvas_id);
                return;
            }
            if (result.status === 401) { goLogin(); return; }
            if (result.status === 403) {
                showToast('该画布不允许克隆', true);
                return;
            }
            showToast((result.body && result.body.detail) || '克隆失败，请稍后重试', true);
        }).catch(function () {
            cloneBusy = false;
            cloneBtn.disabled = false;
            cloneBtn.textContent = '克隆到我的画布';
            showToast('网络异常，请稍后重试', true);
        });
    }

    stage.addEventListener('wheel', function (event) {
        event.preventDefault();
        var factor = Math.exp(-event.deltaY * 0.0012);
        zoomAt(event.clientX, event.clientY, factor);
    }, { passive: false });

    stage.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        var target = event.target;
        if (target && target.closest && target.closest('a,button,video,audio,input')) return;
        dragging = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y, id: event.pointerId };
        stage.classList.add('is-panning');
        try { stage.setPointerCapture(event.pointerId); } catch (e) {}
    });

    stage.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        view.x = dragging.ox + (event.clientX - dragging.x);
        view.y = dragging.oy + (event.clientY - dragging.y);
        applyView();
    });

    function endDrag(event) {
        if (!dragging) return;
        dragging = null;
        stage.classList.remove('is-panning');
        try { stage.releasePointerCapture(event.pointerId); } catch (e) {}
    }

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('dblclick', function (event) {
        if (event.target && event.target.closest && event.target.closest('a,button,video,audio,input')) return;
        fitView();
    });
    window.addEventListener('resize', function () { fitView(); });

    if (gateForm) gateForm.addEventListener('submit', function (event) {
        event.preventDefault();
        submitPassword();
    });
    if (cloneBtn) cloneBtn.addEventListener('click', cloneCanvas);

    loadShare();
})();
