/*
 * 画布助手微应用桥接层（NVCA）
 * 职责：把 static/canvas-assistant/assistant-ui.js 挂进画布助手面板，并把 NOVAI 现有会话/动作接起来。
 * 原则：不改 agent 协议、不改后端；发送/停止/技能/引用全部复用 smart-canvas.js 的现有实现（隐藏的旧 DOM）。
 * 开关：localStorage.NOVAI_CANVAS_UI === 'legacy' 用旧面板，其它值（默认）用新面板。
 */
(function () {
    'use strict';

    var MODE_KEY = 'NOVAI_CANVAS_UI';
    var ASSET_VERSION = '1.0.136.1792859352';
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
            var role = textOf(roleEl);
            var isVideo = !!chip.querySelector('.chat-ctx-vthumb') || !!chip.querySelector('.chat-ctx-kind');
            return {
                id: match ? match[1] : 'ctx-' + index,
                name: textOf(nameEl) || '素材',
                role: role && role !== '角色' ? role : '',
                type: 'node',
                thumbUrl: img ? img.getAttribute('src') || '' : '',
                kind: isVideo ? 'video' : 'image'
            };
        });
    }
    function pushRefs() {
        if (mountedHandle) mountedHandle.setRefs(readRefs());
    }
    function readLegacySkill() {
        var chip = $('#chatSkillChip .chat-skill-chip');
        if (!chip || !chip.children.length) return null;
        var iconEl = chip.children[0];
        var nameEl = chip.children[1];
        return { icon: textOf(iconEl) || '✨', name: textOf(nameEl) };
    }
    function pushSkillState() {
        if (!mountedHandle) return;
        var chip = readLegacySkill();
        if (!chip) {
            selectedSkillId = null;
            mountedHandle.setSelectedSkill(null);
            return;
        }
        mountedHandle.setSelectedSkill(selectedSkillId);
    }
    function skillsFromCapabilities(data) {
        var list = data && Array.isArray(data.capabilities) ? data.capabilities : [];
        return list.filter(function (item) {
            return item && String(item.kind || '') === 'skill' && item.enabled !== false && String(item.id || '').trim();
        }).map(function (item) {
            return {
                id: String(item.id),
                name: String(item.name || item.id),
                icon: String(item.icon || '✨'),
                description: String(item.description || '')
            };
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
    function selectSkill(id) {
        var want = String(id || '');
        if (!want) return;
        var trigger = document.getElementById('chatSkillBtn');
        if (!trigger) { notice('技能入口还没准备好'); return; }
        skillPending = true;
        trigger.click();
        waitFor(function () {
            return document.querySelector('.chat-skill-option[data-skill-id="' + cssEscape(want) + '"]');
        }, 6000, 80).then(function (option) {
            skillPending = false;
            if (!option) { notice('没有找到这个技能'); return; }
            option.click();
            selectedSkillId = want;
            if (mountedHandle) mountedHandle.setSelectedSkill(want);
        });
    }
    function clearSkill() {
        var remove = $('#chatSkillChip .chat-skill-chip-remove');
        if (remove) remove.click();
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
            var pre = (selectedSkillId && !skillChip) ? ensureSkillApplied(1500) : Promise.resolve(true);
            return pre.then(function () {
                if (!setLegacyInput(value)) return false;
                if (typeof window.sendChatMessage !== 'function') {
                    notice('发送入口不可用，已回落旧面板');
                    return false;
                }
                var result = window.sendChatMessage();
                return Promise.resolve(result).then(function (ok) {
                    return ok !== false;
                });
            });
        },
        abort: function () {
            try { if (typeof window.abortAgentRun === 'function') window.abortAgentRun(); } catch (e) {}
            if (mountedHandle) mountedHandle.setRunning(false);
        },
        steer: steer,
        selectSkill: selectSkill,
        clearSkill: clearSkill,
        removeRef: removeRefById,
        clearRefs: function () {
            var clearBtn = $('#chatContext .chat-ctx-clear');
            if (clearBtn) clearBtn.click();
        },
        planAction: planAction,
        confirmAction: confirmAction,
        togglePlanConfirm: function (on) {
            var current = true;
            try { current = typeof window.agentPlanConfirmEnabled === 'function' ? !!window.agentPlanConfirmEnabled() : true; } catch (e) {}
            if (current !== !!on && typeof window.toggleAgentPlanConfirm === 'function') window.toggleAgentPlanConfirm();
            pushPlanConfirm();
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
            var pending = originalFetch.apply(window, arguments);
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
        if (skillChip) new MutationObserver(pushSkillState).observe(skillChip, { childList: true, subtree: true });
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
            root.addEventListener(type, function (event) { event.stopPropagation(); }, true);
        });
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
                pushSkillState();
                loadSkills();
                loadHistory();
            })
            .catch(function (error) {
                bridge.reason = 'asset-load-failed';
                bridge.error = String((error && error.message) || error);
                chatModal.classList.remove('nv-assistant-new');
                if (root.parentNode) root.parentNode.removeChild(root);
                console.error('[canvas-assistant] 微应用加载失败，已回退旧面板', error);
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
        if (!canvasId || !mountedHandle) return;
        originalFetch.call(window, '/api/agent/thread/' + encodeURIComponent(canvasId) + '?limit=60', { headers: { Accept: 'application/json' } })
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
