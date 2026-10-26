/*
 * 画布助手微应用桥接层（NVCA）
 * 职责：把 static/canvas-assistant/assistant-ui.js 挂进画布助手面板，并把 NOVAI 现有会话/动作接起来。
 * 原则：不改 agent 协议、不改后端；发送/停止/技能/引用全部复用 smart-canvas.js 的现有实现（隐藏的旧 DOM）。
 * 开关：localStorage.NOVAI_CANVAS_UI === 'legacy' 用旧面板，其它值（默认）用新面板。
 */
(function () {
    'use strict';

    var MODE_KEY = 'NOVAI_CANVAS_UI';
    var ASSET_VERSION = '1.0.137.1792978986';
    var ROOT_ID = 'novaiCanvasAssistantRoot';
    var mode = 'new';
    try { mode = localStorage.getItem(MODE_KEY) === 'legacy' ? 'legacy' : 'new'; } catch (e) {}

    var bridge = {
        mode: mode,
        version: 1,
        ready: false,
        handle: null,
        api: null,
        root: null,
        reason: '',
        logs: []
    };
    window.NovaiCanvasAssistantBridge = bridge;

    if (mode === 'legacy') {
        bridge.reason = 'legacy-mode';
        return;
    }

    var mountedHandle = null;
    var pendingSeedHints = [];
    var seedCapture = null;
    var seedStarted = false;
    var seedSendInFlight = false;
    var configProvidersCache = null;
    var pendingRunSkillRef = '';
    var pickedRefs = [];
    var pickModeActive = false;
    var selectedSkillId = null;
    var skillPending = false;
    var artifactTimer = 0;
    var artifactBaseline = {};
    var artifactItems = [];
    var artifactPolls = 0;
    var lastRunUrl = '';
    var canvasId = '';
    try { canvasId = new URLSearchParams(location.search).get('id') || ''; } catch (e) {}

    /* ── 小工具 ─────────────────────────────────────────────── */
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    }
    function textOf(el) { return el ? String(el.textContent || '').trim() : ''; }
    function cssEscape(value) {
        var raw = String(value == null ? '' : value);
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
        return raw.replace(/["\\\]\[#.:>+~*^$|()]/g, '\\$&');
    }
    function waitFor(fn, timeout, interval) {
        return new Promise(function (resolve) {
            var limit = Number(timeout) || 4000;
            var step = Number(interval) || 60;
            var startedAt = Date.now();
            (function tick() {
                var value = null;
                try { value = fn(); } catch (e) { value = null; }
                if (value) return resolve(value);
                if (Date.now() - startedAt >= limit) return resolve(null);
                setTimeout(tick, step);
            })();
        });
    }
    function log(text, detail) {
        try {
            bridge.logs.push({ at: Date.now(), text: String(text), detail: detail === undefined ? '' : String(detail) });
            if (bridge.logs.length > 60) bridge.logs.shift();
            console.log('[nvca] ' + text + (detail === undefined ? '' : ' :: ' + detail));
        } catch (e) {}
    }
    function notice(text, kind) {
        if (!text) return;
        if (mountedHandle) mountedHandle.notifySystem(String(text), kind || 'info');
    }
    /* 微应用没起来时也不能静默：先弹页面 toast，等微应用起来后再补一条系统消息 */
    function hintVisible(text, kind) {
        if (!text) return;
        if (mountedHandle) {
            try { mountedHandle.notifySystem(String(text), kind || 'warn'); } catch (e) {}
            return;
        }
        pendingSeedHints.push({ text: String(text), kind: kind || 'warn' });
        toastFallback(text);
    }
    function flushSeedHints() {
        if (!mountedHandle || !pendingSeedHints.length) return;
        var queued = pendingSeedHints.splice(0);
        queued.forEach(function (item) {
            try { mountedHandle.notifySystem(item.text, item.kind); } catch (e) {}
        });
    }

    /* 应用市场 brief 的种子：{v:1, agent, autoSend:true, skillRef}。
       旧面板的 openHomeSeedAgent 只认 autoSend；这里先抓一份内存副本，再把落盘的 autoSend 关掉，
       避免旧面板和我们各发一次；nodes/toast 等字段保持不动，旧逻辑照常铺画布。 */
    function captureHomeSeed() {
        if (!canvasId) return;
        var key = 'novai_canvas_seed:' + canvasId;
        var raw = null;
        try { raw = localStorage.getItem(key); } catch (e) { return; }
        if (!raw) return;
        var seed = null;
        try { seed = JSON.parse(raw); } catch (e) { return; }
        if (!seed || typeof seed !== 'object') return;
        var text = String(seed.agent || '').trim();
        if (!text) return;
        seedCapture = {
            key: key,
            text: text,
            skillRef: String(seed.skillRef || '').trim(),
            autoSend: seed.autoSend === true
        };
        if (!seedCapture.autoSend) return;
        try {
            /* 旧面板看到 seed.agent 就会走 openHomeSeedAgent；把 agent/autoSend 摘掉，
               既避免重复发送，也不会冒出「自动发送失败」的旧 note。nodes/toast 等字段保持不动。 */
            seed.autoSend = false;
            delete seed.agent;
            delete seed.skillRef;
            localStorage.setItem(key, JSON.stringify(seed));
        } catch (e) {}
        log('seed', 'captured autoSend skill=' + (seedCapture.skillRef || '-'));
    }
    captureHomeSeed();

    function ensurePanelOpen() {
        try {
            var panel = document.getElementById('canvasAssistantPanel');
            var chat = document.getElementById('chatModal');
            if (panel && !panel.classList.contains('open')) {
                var rail = document.getElementById('canvasRailChat');
                if (rail) { rail.click(); return; }
                if (typeof window.toggleChatPanel === 'function') window.toggleChatPanel();
                return;
            }
            if (chat && !chat.classList.contains('open') && typeof window.toggleChatPanel === 'function') {
                window.toggleChatPanel();
            }
        } catch (e) {}
    }

    /* 外部统一入口：window.NovaiCanvasAssistantBridge.seedAutoSend({text, skillRef}) -> Promise<boolean> */
    bridge.seedAutoSend = function (options) {
        var opts = (options && typeof options === 'object') ? options : {};
        var text = String(opts.text == null ? '' : opts.text).trim();
        var skillRef = String(opts.skillRef == null ? '' : opts.skillRef).trim();
        if (!text) {
            hintVisible('自动发送缺少内容', 'error');
            return Promise.resolve(false);
        }
        /* 自动发送要让用户看得见：面板没开就先打开（旧面板的 openHomeSeedAgent 也这么干） */
        ensurePanelOpen();
        return waitFor(function () { return mountedHandle; }, 3000, 100).then(function (handle) {
            if (!handle || typeof handle.seedAutoSend !== 'function') {
                hintVisible('画布助手还没准备好，自动发送没有执行', 'warn');
                log('seed', 'ui not ready');
                return false;
            }
            seedSendInFlight = true;
            return Promise.resolve(handle.seedAutoSend({ text: text, skillRef: skillRef }))
                .then(function (ok) {
                    seedSendInFlight = false;
                    log('seed', ok ? 'auto send ok' : 'auto send failed');
                    return ok !== false;
                }, function (error) {
                    seedSendInFlight = false;
                    hintVisible('自动发送失败：' + ((error && error.message) || '未知错误'), 'error');
                    return false;
                });
        });
    };

    function startCapturedSeed() {
        if (seedStarted) return;
        seedStarted = true;
        var captured = seedCapture;
        seedCapture = null;
        if (!captured || !captured.autoSend) return;
        window.setTimeout(function () {
            bridge.seedAutoSend({ text: captured.text, skillRef: captured.skillRef });
        }, 120);
    }

    /* ── SSE 解析（与 smart-canvas.js 内联实现同语义，跨 chunk 半行 / 心跳 / 空行分发） ── */
    function createSseParser(onEvent) {
        var buf = '', evName = '', evId = '', dataLines = [];
        function dispatch() {
            if (!dataLines.length) { evName = ''; evId = ''; return; }
            var raw = dataLines.join('\n');
            dataLines = [];
            var name = evName || 'message';
            var id = evId || undefined;
            evName = '';
            evId = '';
            var payload;
            try { payload = JSON.parse(raw); } catch (e) { payload = { __raw: raw }; }
            onEvent(name, payload, id);
        }
        function handleLine(line) {
            if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
            if (!line) { dispatch(); return; }
            if (line.charAt(0) === ':') return;
            var idx = line.indexOf(':');
            var field = idx === -1 ? line : line.slice(0, idx);
            var value = idx === -1 ? '' : line.slice(idx + 1);
            if (value.charAt(0) === ' ') value = value.slice(1);
            if (field === 'event') evName = value;
            else if (field === 'data') dataLines.push(value);
            else if (field === 'id') evId = value;
        }
        return {
            push: function (chunk) {
                buf += chunk;
                var idx;
                while ((idx = buf.indexOf('\n')) !== -1) {
                    handleLine(buf.slice(0, idx));
                    buf = buf.slice(idx + 1);
                }
            },
            flush: function () {
                if (buf) { handleLine(buf); buf = ''; }
                dispatch();
            }
        };
    }

    /* ── 会话事件 → 微应用 ─────────────────────────────────── */
    function handleStreamEvent(name, data, id) {
        if (!mountedHandle) return;
        var payload = (data && typeof data === 'object') ? data : {};
        try { mountedHandle.pushEvent({ id: id, type: name, data: payload }); } catch (e) {}
        if (name === 'run_start') startArtifactWatch();
        if (name === 'step_result') collectArtifactsFromOps(payload.canvas_ops);
        if (name === 'done' || name === 'error') finishArtifactWatch();
    }

    function pumpStream(stream) {
        if (!stream || typeof stream.getReader !== 'function') return;
        var reader = stream.getReader();
        var decoder = new TextDecoder('utf-8');
        var parser = createSseParser(handleStreamEvent);
        (function read() {
            reader.read().then(function (chunk) {
                if (chunk.done) {
                    try { parser.push(decoder.decode()); parser.flush(); } catch (e) {}
                    return;
                }
                try { parser.push(decoder.decode(chunk.value, { stream: true })); } catch (e) {}
                read();
            }).catch(function () {});
        })();
    }

    /* ── 产物：优先吃 step_result 里的 canvas_ops，再轮询画布快照补异步生成 ── */
    function docNodes() {
        try {
            var api = window.SmartCanvasCollab;
            var doc = api && typeof api.getDoc === 'function' ? api.getDoc() : null;
            return doc && Array.isArray(doc.nodes) ? doc.nodes : [];
        } catch (e) { return []; }
    }
    function mediaOf(node) {
        if (!node || !Array.isArray(node.images)) return [];
        return node.images.filter(function (img) {
            return img && img.url && /^(https?:|data:|\/)/.test(String(img.url));
        });
    }
    function pushArtifact(item) {
        if (!item || !item.url) return false;
        if (artifactItems.some(function (it) { return it.url === item.url; })) return false;
        artifactItems.unshift(item);
        if (artifactItems.length > 9) artifactItems.length = 9;
        return true;
    }
    function flushArtifacts() {
        if (mountedHandle) mountedHandle.setArtifacts(artifactItems.slice());
    }
    function collectArtifactsFromOps(ops) {
        if (!ops || !Array.isArray(ops.nodes_upsert)) return;
        var changed = false;
        ops.nodes_upsert.forEach(function (raw) {
            var media = mediaOf(raw);
            if (!media.length) return;
            var last = media[media.length - 1];
            var kind = String(last.kind || raw.type || '').indexOf('video') !== -1 ? 'video' : 'image';
            changed = pushArtifact({
                id: String(raw.id || last.url),
                kind: kind,
                url: String(last.url),
                thumb: String(last.preview || last.thumb || last.url),
                title: String(raw.title || raw.alias || (kind === 'video' ? '视频' : '图片'))
            }) || changed;
        });
        if (changed) flushArtifacts();
    }
    function snapshotUrls() {
        var map = {};
        docNodes().forEach(function (node) {
            mediaOf(node).forEach(function (img) {
                map[String(img.url)] = {
                    id: String(node.id || img.url),
                    kind: String(img.kind || node.type || '').indexOf('video') !== -1 ? 'video' : 'image',
                    url: String(img.url),
                    thumb: String(img.preview || img.thumb || img.url),
                    title: String(node.title || node.alias || '')
                };
            });
        });
        return map;
    }
    function pollArtifacts() {
        var now = snapshotUrls();
        var changed = false;
        Object.keys(now).forEach(function (url) {
            if (artifactBaseline[url]) return;
            changed = pushArtifact(now[url]) || changed;
        });
        if (changed) flushArtifacts();
    }
    function startArtifactWatch() {
        artifactBaseline = snapshotUrls();
        artifactItems = [];
        flushArtifacts();
        artifactPolls = 0;
        if (artifactTimer) clearInterval(artifactTimer);
        artifactTimer = setInterval(pollArtifacts, 2500);
    }
    function finishArtifactWatch() {
        if (artifactTimer) clearInterval(artifactTimer);
        artifactTimer = 0;
        pollArtifacts();
        /* 生成任务是异步的：结束后再补几次快照，把刚落下来的图收进产物卡片 */
        artifactPolls = 0;
        artifactTimer = setInterval(function () {
            artifactPolls += 1;
            pollArtifacts();
            if (artifactPolls >= 4) {
                clearInterval(artifactTimer);
                artifactTimer = 0;
            }
        }, 3000);
    }

    /* ── 旧 DOM 镜像：引用 chip / 技能 chip / 运行态 / 上下文占用 ── */
    function readRefs() {
        return $all('#chatContext .chat-ctx-chip').map(function (chip, index) {
            var img = chip.querySelector('img');
            var roleEl = chip.querySelector('.chat-ctx-role');
            var nameEl = chip.querySelector('.chat-ctx-name');
            var removeEl = chip.querySelector('.chat-ctx-remove');
            var onclick = removeEl ? String(removeEl.getAttribute('onclick') || '') : '';
            var match = /removeChatRef\('([^']*)'\)/.exec(onclick);
            var refId = match ? match[1] : 'ctx-' + index;
            var role = textOf(roleEl);
            var isVideo = !!chip.querySelector('.chat-ctx-vthumb') || !!chip.querySelector('.chat-ctx-kind');
            return {
                id: refId,
                name: textOf(nameEl) || '素材',
                role: role && role !== '角色' ? role : '',
                type: 'node',
                thumbUrl: img ? img.getAttribute('src') || '' : '',
                kind: isVideo ? 'video' : 'image'
            };
        });
    }
    function pickedNodeRef(id) {
        var list = [];
        try { list = docNodes(); } catch (e) {}
        var node = list.filter(function (item) { return String(item.id) === String(id); })[0];
        if (!node) return null;
        var images = (node.images || []).map(function (img) {
            var kind = img.kind || 'image';
            var url = String(img.url || '');
            return { url: url, preview: String(img.preview || img.thumbnail || url), kind: kind };
        }).filter(function (img) { return img.url; });
        var first = images[0] || {};
        return {
            id: String(node.id),
            name: String(node.alias || node.title || node.type || '画布节点').slice(0, 40),
            role: null,
            type: 'node',
            thumbUrl: String(first.preview || first.url || ''),
            kind: images[0] && images[0].kind === 'video' ? 'video' : 'image',
            images: images
        };
    }
    function mergeRefs() {
        var list = readRefs();
        pickedRefs.forEach(function (ref) {
            if (!list.some(function (item) { return String(item.id) === String(ref.id); })) list.push(ref);
        });
        return list;
    }
    function pushRefs() {
        if (mountedHandle) mountedHandle.setRefs(mergeRefs());
    }
    function addPickedNode(id) {
        var ref = pickedNodeRef(id);
        if (!ref) return false;
        if (pickedRefs.some(function (item) { return String(item.id) === String(ref.id); })) return true;
        pickedRefs.push(ref);
        pushRefs();
        log('pick', 'add ' + ref.name);
        return true;
    }
    function onPickClick(event) {
        if (!pickModeActive) return;
        var el = event.target && event.target.closest ? event.target.closest('.image-node') : null;
        if (!el) return;
        event.preventDefault();
        event.stopPropagation();
        var id = el.getAttribute('data-id') || '';
        if (id) addPickedNode(id);
    }
    function enterPickMode() {
        pickModeActive = true;
        document.body.classList.add('nvca-pick-mode');
        document.addEventListener('click', onPickClick, true);
        pushRefs();
        log('pick', 'enter');
    }
    function exitPickMode() {
        pickModeActive = false;
        document.body.classList.remove('nvca-pick-mode');
        document.removeEventListener('click', onPickClick, true);
        pushRefs();
        log('pick', 'exit');
    }
    function captureCanvas() {
        var world = document.getElementById('world');
        var lib = window.htmlToImage;
        if (!world) return Promise.resolve(false);
        if (!lib || typeof lib.toPng !== 'function') {
            notice('截图库未加载，请强制刷新页面后重试');
            return Promise.resolve(false);
        }
        var now = new Date();
        var name = '画布截图 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + '.png';
        return lib.toPng(world, {
            cacheBust: true,
            skipFonts: true,
            imagePlaceholder: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4fPkyAAT2AnqzAEMqAAAAAElFTkSuQmCC',
            onImageErrorHandler: function () { return true; },
            pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
            backgroundColor: (document.body && getComputedStyle(document.body).backgroundColor) || '#ffffff'
        }).then(function (dataUrl) {
            var ref = {
                id: 'upload_capture_' + Date.now(),
                name: name,
                role: null,
                type: 'upload',
                upload: true,
                thumbUrl: dataUrl,
                kind: 'image',
                images: [{ url: dataUrl, preview: dataUrl, kind: 'image', name: name }]
            };
            pickedRefs.push(ref);
            pushRefs();
            log('capture', 'ok');
            return true;
        }).catch(function (error) {
            log('capture', 'failed ' + String((error && error.message) || error));
            notice('截图失败，请重试');
            return false;
        });
    }

    function pushPlanConfirm() {
        if (!mountedHandle) return;
        var on = true;
        try { on = typeof window.agentPlanConfirmEnabled === 'function' ? !!window.agentPlanConfirmEnabled() : true; } catch (e) {}
        mountedHandle.setPlanConfirm(on);
    }
    function pushContextUsage() {
        if (!mountedHandle) return;
        var el = document.getElementById('canvasContextUsage');
        if (!el || el.hidden) { mountedHandle.setContextUsage(null); return; }
        var text = textOf(el);
        var percent = /([\d.]+)\s*%/.exec(text);
        if (percent) { mountedHandle.setContextUsage({ percentage: Number(percent[1]) }); return; }
        mountedHandle.setContextUsage(null);
    }
    function syncRunningFromLegacy() {
        if (!mountedHandle) return;
        var btn = document.getElementById('chatSendBtn');
        var running = !!(btn && btn.classList.contains('is-running'));
        mountedHandle.setRunning(running);
    }

    /* ── 对旧 DOM 的动作（全部走现有实现） ── */
    function setLegacyInput(text) {
        var input = document.getElementById('chatInput');
        if (!input) return false;
        input.value = String(text == null ? '' : text);
        input.style.height = 'auto';
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        return true;
    }
    function ensureSkillApplied(timeout) {
        return waitFor(function () { return $('#chatSkillChip .chat-skill-chip'); }, timeout || 1200, 50);
    }
    function removeRefById(id) {
        var before = pickedRefs.length;
        pickedRefs = pickedRefs.filter(function (ref) { return String(ref.id) !== String(id); });
        if (pickedRefs.length !== before) {
            pushRefs();
            return;
        }
        var chip = $all('#chatContext .chat-ctx-chip').filter(function (row) {
            var removeEl = row.querySelector('.chat-ctx-remove');
            var onclick = removeEl ? String(removeEl.getAttribute('onclick') || '') : '';
            return onclick.indexOf("'" + id + "'") !== -1 || onclick.indexOf('"' + id + '"') !== -1;
        })[0];
        if (!chip) return;
        var btn = chip.querySelector('.chat-ctx-remove');
        if (btn) btn.click();
    }
    function lastPlanCard() {
        var cards = $all('#chatMessages .agent-plan-card');
        for (var i = cards.length - 1; i >= 0; i -= 1) {
            var state = String(cards[i].getAttribute('data-plan-state') || '');
            if (state === 'cancelled' || state === 'adjusted' || state === 'applied_cancelled') continue;
            return cards[i];
        }
        return null;
    }
    function planAction(action) {
        waitFor(lastPlanCard, 3000, 80).then(function (card) {
            if (!card) { log('planAction: no card'); notice('没有找到可操作的方案卡，稍后再试'); return; }
            var btn = card.querySelector('[data-act="' + action + '"]');
            if (!btn) { log('planAction: no button', action); notice('这版方案不支持这个操作'); return; }
            if (btn.disabled) { log('planAction: disabled', action); notice('这一步现在不能操作'); return; }
            log('planAction: click', action);
            btn.click();
        });
    }
    function confirmAction(yes) {
        waitFor(function () { return $('#chatMessages .agent-confirm-card:not(.is-resolved)'); }, 3000, 80).then(function (card) {
            if (!card) { notice('没有等待确认的步骤'); return; }
            var btn = card.querySelector('[data-act="' + (yes ? 'yes' : 'no') + '"]');
            if (btn) btn.click();
        });
    }
    function undoRun(runId) {
        if (!runId) return Promise.resolve({ ok: false, message: '缺少 run_id' });
        return originalFetch.call(window, '/api/agent/undo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ run_id: String(runId) })
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok) {
                    return { ok: false, message: String((data && (data.detail || data.message)) || ('HTTP ' + response.status)) };
                }
                return { ok: true, message: String((data && data.message) || '已撤销本次修改') };
            });
        }).catch(function (error) {
            return { ok: false, message: String((error && error.message) || '撤销失败') };
        });
    }
    function approveStep(step, instruction) {
        if (!step || !step.tool) return Promise.resolve(false);
        if (typeof window.runAgentStream !== 'function') return Promise.resolve(false);
        var args = step.args && typeof step.args === 'object' ? step.args : {};
        var payload = { tool: String(step.tool), args: args, description: String(step.description || '') };
        return waitFor(function () {
            var busy = false;
            try {
                busy = !!(mountedHandle && mountedHandle.store && mountedHandle.store.env && mountedHandle.store.env.running);
            } catch (e) {}
            return busy ? null : true;
        }, 30000, 120).then(function () {
            var bubble = document.createElement('div');
            var result = window.runAgentStream(String(instruction || '执行已确认的步骤'), bubble, { approved_steps: [payload] });
            return Promise.resolve(result).then(function (res) {
                return !(res && res.failed);
            }).catch(function () { return false; });
        }).catch(function () {
            notice('助手还在执行，等这一轮结束再确认');
            return false;
        });
    }
    function ensureChatModelReady(timeout) {
        return waitFor(function () {
            var select = document.getElementById('chatModelSelect');
            if (!select || !select.options || !select.options.length) return null;
            return select.value ? select : null;
        }, timeout || 4000, 100);
    }
    function loadConfigProviders() {
        if (configProvidersCache) return Promise.resolve(configProvidersCache);
        if (typeof originalFetch !== 'function') return Promise.resolve([]);
        return originalFetch.call(window, '/api/config', { headers: { Accept: 'application/json' } })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                configProvidersCache = (data && Array.isArray(data.api_providers)) ? data.api_providers : [];
                return configProvidersCache;
            })
            .catch(function () { return []; });
    }
    /* 首次打开时 initChatModel 可能挑到没配 Key 的平台（例如默认的 ModelScope）：
       自动发送前优先选一个有 Key、且有对话模型的平台，仍然走页面自己的模型下拉/change 通路。 */
    function primeChatModelForSeed() {
        var select = document.getElementById('chatModelSelect');
        if (!select || !select.options || !select.options.length) return Promise.resolve(false);
        return loadConfigProviders().then(function (providers) {
            if (!providers || !providers.length) return false;
            var current = select.selectedOptions && select.selectedOptions[0];
            var currentProvider = current ? String(current.getAttribute('data-provider') || '') : '';
            var currentCfg = providers.filter(function (item) { return String(item.id) === currentProvider; })[0];
            if (currentCfg && currentCfg.has_key) return false;
            var options = Array.prototype.slice.call(select.options);
            var candidates = providers.filter(function (item) { return item.enabled !== false && item.has_key; });
            for (var i = 0; i < candidates.length; i += 1) {
                var provider = candidates[i];
                var models = provider.chat_models || [];
                var pick = null;
                if (models.length) {
                    for (var j = 0; j < options.length; j += 1) {
                        if (String(options[j].getAttribute('data-provider')) === String(provider.id)
                            && models.indexOf(options[j].value) !== -1) { pick = options[j]; break; }
                    }
                } else {
                    pick = options.filter(function (option) {
                        return String(option.getAttribute('data-provider')) === String(provider.id);
                    })[0] || null;
                }
                if (!pick) continue;
                select.value = pick.value;
                try { select.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
                log('seed', 'prime model ' + provider.id + '/' + pick.value);
                return true;
            }
            return false;
        }).catch(function () { return false; });
    }
    function pushComposerState() {
        if (!mountedHandle || typeof mountedHandle.setComposerState !== 'function') return;
        loadConfigProviders().then(function (providers) {
            var select = document.getElementById('chatModelSelect');
            var current = select && select.selectedOptions ? select.selectedOptions[0] : null;
            var models = [];
            (providers || []).forEach(function (provider) {
                if (!provider || provider.enabled === false) return;
                (provider.chat_models || []).forEach(function (model) {
                    var value = String(model || '').trim();
                    if (!value) return;
                    models.push({
                        value: value,
                        provider: String(provider.id || ''),
                        providerName: String(provider.name || provider.id || '')
                    });
                });
            });
            /* /api/config 没有列出的自定义平台，用旧下拉里已有的项兜底 */
            if (select) {
                Array.prototype.slice.call(select.options).forEach(function (option) {
                    if (!option.value) return;
                    var providerId = String(option.getAttribute('data-provider') || '');
                    var exists = models.some(function (item) {
                        return item.value === option.value && item.provider === providerId;
                    });
                    if (!exists) {
                        models.push({ value: option.value, provider: providerId, providerName: providerId || '当前' });
                    }
                });
            }
            var providerSelect = document.getElementById('agentImageProviderSelect');
            var imageProviders = providerSelect
                ? Array.prototype.slice.call(providerSelect.options).filter(function (option) { return option.value; }).map(function (option) {
                    return { value: option.value, label: textOf(option) || option.value };
                })
                : [];
            var planConfirm = true;
            try { planConfirm = typeof window.agentPlanConfirmEnabled === 'function' ? !!window.agentPlanConfirmEnabled() : true; } catch (e) {}
            mountedHandle.setComposerState({
                models: models,
                model: select ? String(select.value || '') : '',
                provider: current ? String(current.getAttribute('data-provider') || '') : '',
                imageProviders: imageProviders,
                imageProvider: providerSelect ? String(providerSelect.value || '') : '',
                planConfirm: planConfirm
            });
        });
    }
    function setChatModel(model, provider) {
        var select = document.getElementById('chatModelSelect');
        if (!select) return;
        var want = String(model || '');
        var providerId = String(provider || '');
        if (!want) return;
        var option = null;
        Array.prototype.slice.call(select.options).forEach(function (item) {
            if (item.value !== want) return;
            if (providerId && String(item.getAttribute('data-provider') || '') !== providerId) return;
            option = item;
        });
        if (!option) {
            option = document.createElement('option');
            option.value = want;
            option.textContent = want;
            if (providerId) option.setAttribute('data-provider', providerId);
            select.appendChild(option);
        }
        select.selectedIndex = Array.prototype.indexOf.call(select.options, option);
        try { select.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        log('composer', 'model ' + providerId + '/' + want);
        pushComposerState();
    }
    function setImageProvider(value) {
        var select = document.getElementById('agentImageProviderSelect');
        if (!select) return;
        var want = String(value || '');
        if (want && !Array.prototype.slice.call(select.options).some(function (option) { return option.value === want; })) return;
        select.value = want;
        try { select.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        log('composer', 'image provider ' + (want || 'auto'));
        pushComposerState();
    }
    function addSelectedRefs() {
        pushRefs();
        var count = $all('#chatContext .chat-ctx-chip').length;
        if (count) return Promise.resolve(count);
        var selected = $all('.image-node.selected');
        if (!selected.length) return Promise.resolve(0);
        var chat = document.getElementById('chatModal');
        if (!chat || typeof window.toggleChatPanel !== 'function') return Promise.resolve(0);
        /* 画布 Cmd+框选只更新 selectedIds，不会调 syncChatContext；关再开一次面板会走
           toggleChatPanel 里的同步逻辑，把选中的节点全部灌进引用条（不改旧代码）。 */
        var settle = function () {
            pushRefs();
            return $all('#chatContext .chat-ctx-chip').length;
        };
        return new Promise(function (resolve) {
            if (chat.classList.contains('open')) {
                window.toggleChatPanel();
                window.setTimeout(function () {
                    window.toggleChatPanel();
                    window.setTimeout(function () { resolve(settle()); }, 160);
                }, 40);
            } else {
                window.toggleChatPanel();
                window.setTimeout(function () { resolve(settle()); }, 200);
            }
        });
    }
    function pickUpload() {
        var btn = document.getElementById('chatUploadBtn');
        if (btn) btn.click();
    }
    function selectSkill(id) {
        var want = String(id || '');
        if (!want) return Promise.resolve(false);
        var trigger = document.getElementById('chatSkillBtn');
        if (!trigger) { notice('技能入口还没准备好'); return Promise.resolve(false); }
        skillPending = true;
        trigger.click();
        return waitFor(function () {
            return document.querySelector('.chat-skill-option[data-skill-id="' + cssEscape(want) + '"]');
        }, 6000, 80).then(function (option) {
            skillPending = false;
            if (!option) { notice('没有找到这个技能'); return false; }
            option.click();
            selectedSkillId = want;
            if (mountedHandle) mountedHandle.setSelectedSkill(want);
            return true;
        });
    }
    function applySkillRef(ref) {
        var value = String(ref || '').trim();
        if (!value) return;
        /* store:<id> 不在能力列表里：不走旧技能选择器，改成下一次 /api/agent/run 请求体带 skill_ref */
        pendingRunSkillRef = value;
        selectedSkillId = value;
        log('skillRef', value);
    }
    function clearSkill() {
        var remove = $('#chatSkillChip .chat-skill-chip-remove');
        if (remove) remove.click();
        pendingRunSkillRef = '';
        selectedSkillId = null;
        if (mountedHandle) mountedHandle.setSelectedSkill(null);
    }
    function steer(text) {
        if (!setLegacyInput(text)) return;
        waitFor(function () {
            var btn = document.getElementById('chatSteerBtn');
            return btn && btn.style.display !== 'none' && !btn.disabled ? btn : null;
        }, 1200, 60).then(function (btn) {
            if (!btn) { notice('运行已经结束，这条按普通消息发送'); return; }
            btn.click();
        });
    }

    function toastFallback(text) {
        try {
            var toastEl = document.getElementById('toast');
            if (!toastEl) return;
            toastEl.textContent = String(text);
            toastEl.classList.add('show');
            setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
        } catch (e) {}
    }

    /* ── 宿主 API（微应用唯一的动作出口） ── */
    var hostApi = {
        send: function (text) {
            var value = String(text == null ? '' : text).trim();
            if (!value) return Promise.resolve(false);
            var skillChip = $('#chatSkillChip .chat-skill-chip');
            var pre = ensureChatModelReady(4000)
                .then(function () { return seedSendInFlight ? primeChatModelForSeed() : false; })
                .then(function () {
                    return (selectedSkillId && !pendingRunSkillRef && !skillChip) ? ensureSkillApplied(1500) : true;
                });
            return pre.then(function () {
                if (!setLegacyInput(value)) return false;
                if (typeof window.sendChatMessage !== 'function') {
                    notice('发送入口不可用，已回落旧面板');
                    return false;
                }
                var result;
                try { result = window.sendChatMessage(); } catch (e) { return false; }
                /* sendChatMessage 的 promise 要等整轮结束才 resolve：只等 800ms 判断有没有「立刻失败」 */
                return new Promise(function (resolve) {
                    var settled = false;
                    var timer = window.setTimeout(function () {
                        if (settled) return;
                        settled = true;
                        resolve(true);
                    }, 800);
                    Promise.resolve(result).then(function (ok) {
                        if (settled) return;
                        settled = true;
                        window.clearTimeout(timer);
                        resolve(ok !== false);
                    }).catch(function () {
                        if (settled) return;
                        settled = true;
                        window.clearTimeout(timer);
                        resolve(false);
                    });
                });
            });
        },
        abort: function () {
            try { if (typeof window.abortAgentRun === 'function') window.abortAgentRun(); } catch (e) {}
            if (mountedHandle) mountedHandle.setRunning(false);
        },
        steer: steer,
        selectSkill: selectSkill,
        applySkillRef: applySkillRef,
        setChatModel: setChatModel,
        setImageProvider: setImageProvider,
        enterPickMode: enterPickMode,
        exitPickMode: exitPickMode,
        captureCanvas: captureCanvas,
        addSelectedRefs: addSelectedRefs,
        pickUpload: pickUpload,
        clearSkill: clearSkill,
        removeRef: removeRefById,
        clearRefs: function () {
            var clearBtn = $('#chatContext .chat-ctx-clear');
            if (clearBtn) clearBtn.click();
        },
        planAction: planAction,
        confirmAction: confirmAction,
        approveStep: approveStep,
        undoRun: undoRun,
        togglePlanConfirm: function (on) {
            var current = true;
            try { current = typeof window.agentPlanConfirmEnabled === 'function' ? !!window.agentPlanConfirmEnabled() : true; } catch (e) {}
            if (current !== !!on && typeof window.toggleAgentPlanConfirm === 'function') window.toggleAgentPlanConfirm();
            pushPlanConfirm();
            pushComposerState();
        },
        openHistory: function () {
            var btn = $('.chat-history-btn');
            if (btn) btn.click();
        },
        openNode: function (id) {
            /* 画布没有对外暴露「选中/定位节点」的函数，这里只把节点名提示出来 */
            var node = docNodes().filter(function (n) { return String(n.id) === String(id); })[0];
            if (node) toastFallback('在画布上找到：' + String(node.title || node.alias || id));
        },
        toast: toastFallback
    };

    /* ── fetch 拦截：给 /api/agent/run 的 SSE 分一路给微应用（旧面板照常消费另一路） ── */
    var originalFetch = window.fetch;
    function urlOf(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return '';
    }
    function methodOf(input, init) {
        return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    }
    if (typeof originalFetch === 'function') {
        window.fetch = function (input, init) {
            var url = urlOf(input);
            var method = methodOf(input, init);
            var isRun = method === 'POST' && /\/api\/agent\/run(?:\?|$)/.test(url);
            var isResume = method === 'GET' && /\/api\/agent\/runs\/[^/?#]+\/stream/.test(url);
            var isSteer = method === 'POST' && /\/api\/agent\/runs\/[^/?#]+\/steer/.test(url);
            var isThread = method === 'GET' && /\/api\/agent\/thread\/[^/?#]+/.test(url);
            var isCapabilities = method === 'GET' && /\/api\/capabilities(?:\?|$)/.test(url);
            var isUndo = method === 'POST' && /\/api\/agent\/undo(?:\?|$)/.test(url);
            var requestInput = input;
            var requestInit = init;
            if (isRun && init && typeof init.body === 'string') {
                try {
                    var runBody = JSON.parse(init.body);
                    if (pickedRefs.length) {
                        var focus = runBody.focus && typeof runBody.focus === 'object' ? runBody.focus : {};
                        var refs = Array.isArray(focus.references) ? focus.references.slice() : [];
                        var images = Array.isArray(focus.reference_images) ? focus.reference_images.slice() : [];
                        pickedRefs.forEach(function (ref) {
                            if (!refs.some(function (item) { return String(item.id) === String(ref.id); })) {
                                refs.push({ id: ref.id, name: ref.name, role: null, source: ref.upload ? 'upload' : 'node' });
                            }
                            (ref.images || []).forEach(function (img) {
                                if (img.url && images.indexOf(img.url) === -1) images.push(img.url);
                            });
                        });
                        focus.references = refs;
                        focus.reference_images = images;
                        runBody.focus = focus;
                    }
                    if (pendingRunSkillRef) {
                        /* 应用市场 brief 的 store:<id>：只在这一轮注入 skill_ref，不额外带 skill_id */
                        runBody.skill_ref = pendingRunSkillRef;
                        delete runBody.skill_id;
                        log('skillRef', 'injected ' + pendingRunSkillRef);
                        pendingRunSkillRef = '';
                    } else {
                        /* 技能入口已删除：普通发送一律不携带技能字段 */
                        delete runBody.skill_id;
                        delete runBody.skill_ref;
                    }
                    requestInit = {};
                    for (var initKey in init) {
                        if (Object.prototype.hasOwnProperty.call(init, initKey)) requestInit[initKey] = init[initKey];
                    }
                    requestInit.body = JSON.stringify(runBody);
                } catch (e) { log('skillRef', 'prepare failed'); }
            }
            var pending = originalFetch.call(window, requestInput, requestInit);
            if (!isRun && !isResume && !isSteer && !isThread && !isCapabilities && !isUndo) return pending;
            return pending.then(function (response) {
                try {
                    if ((isRun || isResume) && response && response.ok && response.body && typeof response.body.tee === 'function') {
                        if (isRun) lastRunUrl = url;
                        var pair = response.body.tee();
                        pumpStream(pair[1]);
                        return new Response(pair[0], {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                    if (isThread && response && response.ok && typeof response.clone === 'function') {
                        response.clone().json().then(function (data) {
                            if (mountedHandle && data && Array.isArray(data.messages)) mountedHandle.setHistory(data.messages);
                        }).catch(function () {});
                    }
                    if (isCapabilities && response && response.ok && typeof response.clone === 'function') {
                        response.clone().json().then(function (data) {
                            if (mountedHandle) mountedHandle.setSkills(skillsFromCapabilities(data));
                        }).catch(function () {});
                    }
                    if (isSteer && response && mountedHandle) {
                        if (response.status === 409) notice('运行已结束，这条没插进去');
                        else if (response.status === 404) notice('这轮运行已过期，无法插话');
                        else if (response.ok) notice('已加入，下一轮生效');
                    }
                    if (isUndo && response && response.ok) {
                        artifactItems = [];
                        if (mountedHandle) {
                            mountedHandle.setArtifacts([]);
                            mountedHandle.notifyRunSummary('已撤销本轮改动');
                        }
                    }
                } catch (e) {}
                return response;
            });
        };
    }

    /* ── 隐藏旧消息区/输入区，挂载新面板 ── */
    function injectStyle() {
        if (document.getElementById('novaiCanvasAssistantStyle')) return;
        var style = document.createElement('style');
        style.id = 'novaiCanvasAssistantStyle';
        style.textContent = [
            '.nv-assistant-new .chat-messages,',
            '.nv-assistant-new .chat-composer,',
            '.nv-assistant-new .chat-resize { display:none !important; }',
            '.nv-assistant-new #' + ROOT_ID + ' { flex:1; min-height:0; display:flex; flex-direction:column; }',
            'body .chat-skill-picker { display:none !important; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    function loadAsset(tag, attrs) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement(tag);
            Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
            el.onload = function () { resolve(el); };
            el.onerror = function () { reject(new Error('load failed: ' + attrs.href + attrs.src)); };
            document.head.appendChild(el);
        });
    }

    function observeLegacy() {
        var chatContext = document.getElementById('chatContext');
        if (chatContext) new MutationObserver(pushRefs).observe(chatContext, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        var skillChip = document.getElementById('chatSkillChip');
        var sendBtn = document.getElementById('chatSendBtn');
        if (sendBtn) new MutationObserver(syncRunningFromLegacy).observe(sendBtn, { attributes: true, attributeFilter: ['class', 'title'] });
        var usage = document.getElementById('canvasContextUsage');
        if (usage) new MutationObserver(pushContextUsage).observe(usage, { childList: true, attributes: true, attributeFilter: ['hidden'] });
        var messages = document.getElementById('chatMessages');
        if (messages) {
            new MutationObserver(function (records) {
                records.forEach(function (record) {
                    Array.prototype.forEach.call(record.addedNodes || [], function (node) {
                        if (!node || node.nodeType !== 1) return;
                        if (node.classList && node.classList.contains('chat-msg') && node.classList.contains('system')) {
                            var bubble = node.querySelector('.chat-bubble');
                            notice(textOf(bubble));
                        }
                    });
                });
            }).observe(messages, { childList: true });
        }
        ['#canvasAssistantNewChatBtn', '#canvasAssistantEditBtn', '.chat-reset-btn'].forEach(function (sel) {
            var el = $(sel);
            if (!el) return;
            el.addEventListener('click', function () {
                setTimeout(function () { if (mountedHandle) mountedHandle.clearHistory(); }, 40);
            }, true);
        });
        var moreMenu = document.getElementById('canvasAssistantMoreMenu');
        if (moreMenu) {
            moreMenu.addEventListener('click', function (event) {
                var item = event.target && event.target.closest ? event.target.closest('[data-assistant-action]') : null;
                if (!item) return;
                if (item.getAttribute('data-assistant-action') === 'reset' && mountedHandle) {
                    setTimeout(function () { mountedHandle.clearHistory(); }, 40);
                }
            });
        }
    }

    /* 画布的 shell.onmousedown / wheel 接管了整块画布：不挡住的话点输入框拿不到焦点、滚消息会缩放画布。
       捕获阶段在微应用根上 stopPropagation，只挡冒泡到 shell/document 的路径，不动 React/Base UI 自己的监听。 */
    function guardPanelEvents(root) {
        ['mousedown', 'pointerdown', 'dblclick', 'wheel', 'contextmenu', 'touchstart'].forEach(function (type) {
            root.addEventListener(type, function (event) {
                /* 4px 拖拽手柄要同时拿到 pointerdown 和 mousedown，不能被这层守卫吞掉 */
                if (event.target && event.target.closest && event.target.closest('.nvca-tap-resize')) return;
                event.stopPropagation();
            }, true);
        });
        /* click 用冒泡阶段挡：canvas 的 shell.onclick 会「点空白清选中」，不清的话点一下 composer
           就会把选中的节点取消、引用 chips 跟着消失；冒泡阶段 stopPropagation 不影响同节点上的 React 委托。 */
        root.addEventListener('click', function (event) { event.stopPropagation(); }, false);
    }

    function boot() {
        var chatModal = document.getElementById('chatModal');
        var host = document.getElementById('canvasAssistantHost');
        var chatInput = document.getElementById('chatInput');
        if (!chatModal || !chatInput) {
            bridge.reason = 'missing-legacy-panel';
            return;
        }
        if (document.getElementById(ROOT_ID)) return;
        injectStyle();
        var root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'nvca-mount';
        root.setAttribute('data-nvca-mounted', 'pending');
        chatModal.insertBefore(root, chatModal.firstChild);
        chatModal.classList.add('nv-assistant-new');
        bridge.root = root;

        guardPanelEvents(root);
        observeLegacy();
        pushPlanConfirm();

        loadAsset('link', { rel: 'stylesheet', href: '/static/canvas-assistant/assistant-ui.css?v=' + ASSET_VERSION });
        loadAsset('script', { src: '/static/canvas-assistant/assistant-ui.js?v=' + ASSET_VERSION })
            .then(function () {
                var lib = window.NovaiCanvasAssistant;
                if (!lib || typeof lib.mount !== 'function') throw new Error('mount missing');
                mountedHandle = lib.mount(root, hostApi);
                bridge.handle = mountedHandle;
                bridge.store = mountedHandle.store;
                bridge.ready = true;
                root.setAttribute('data-nvca-mounted', 'ready');
                pushRefs();
                pushPlanConfirm();
                pushContextUsage();
                syncRunningFromLegacy();
                pushComposerState();
                observeComposerSelects();
                /* 必须先让历史回来再触发自动发送，否则历史 setHistory 会把刚推入的用户消息覆盖掉 */
                loadHistory().then(function () {
                    flushSeedHints();
                    startCapturedSeed();
                });
            })
            .catch(function (error) {
                bridge.reason = 'asset-load-failed';
                bridge.error = String((error && error.message) || error);
                chatModal.classList.remove('nv-assistant-new');
                if (root.parentNode) root.parentNode.removeChild(root);
                if (seedCapture && seedCapture.autoSend) {
                    toastFallback('画布助手加载失败，自动发送没有执行');
                    try {
                        var restore = JSON.parse(localStorage.getItem(seedCapture.key) || '{}');
                        restore.agent = seedCapture.text;
                        restore.skillRef = seedCapture.skillRef;
                        restore.autoSend = false;
                        localStorage.setItem(seedCapture.key, JSON.stringify(restore));
                    } catch (e) {}
                }
                console.error('[canvas-assistant] 微应用加载失败，已回退旧面板', error);
            });
    }

    function observeComposerSelects() {
        var modelSelect = document.getElementById('chatModelSelect');
        var providerSelect = document.getElementById('agentImageProviderSelect');
        [modelSelect, providerSelect].forEach(function (select) {
            if (!select) return;
            select.addEventListener('change', pushComposerState);
            new MutationObserver(pushComposerState).observe(select, { childList: true });
        });
    }

    function loadSkills() {
        originalFetch.call(window, '/api/capabilities', { headers: { Accept: 'application/json' } })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                if (mountedHandle && data) mountedHandle.setSkills(skillsFromCapabilities(data));
            })
            .catch(function () {});
    }

    function loadHistory() {
        if (!canvasId || !mountedHandle) return Promise.resolve();
        return originalFetch.call(window, '/api/agent/thread/' + encodeURIComponent(canvasId) + '?limit=60', { headers: { Accept: 'application/json' } })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                if (mountedHandle && data && Array.isArray(data.messages)) mountedHandle.setHistory(data.messages);
            })
            .catch(function () {});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
