/* NOVAI 积分（credit）全局客户端
 *
 * 数据面：GET /api/credits/me、/api/credits/transactions、/api/credits/price，SSE /api/credits/stream。
 * UI 面：本文件只维护全局状态 + 事件 + 底部提示条，各页面自己画（画布胶囊在 collab.js、
 *        v2 侧栏在 web/src/shell/Sidebar.vue、账户页 / 管理后台在各自 html 里）。
 *
 * 对外（window.NOVAI_CREDITS）：
 *   balance / available / enabled / state      当前状态（余额、是否启用、单价、档位）
 *   refresh()                                  重新拉 /api/credits/me（SSE 断了或页面重新可见时用）
 *   quote(params)                              估价（带 60s 缓存），返回 /api/credits/price 的响应
 *   transactions(limit)                        最近流水
 *   format(value)                              余额展示格式（保留 1 位、整数不带 .0）
 *   toast(message, options)                    统一提示条（预计 / 已扣 / 退款 / 不足）
 *   subscribe(fn)                              订阅状态变化，返回取消函数
 *
 * 事件（document）：
 *   novai-credits              余额 / 启用状态变化（detail = state）
 *   novai-credits-estimate     生成请求发出前：本次预计消耗
 *   novai-credits-spent        生成完成：实际扣除
 *   novai-credits-refund       失败退款
 *   novai-credits-insufficient 402 余额不足
 *
 * 生成链路拦截：包一层 window.fetch。识别生成类请求 → 先从 /api/credits/price 估价并提示，
 * 请求完成后用响应里的 credits 字段提示实际扣除；不改任何生成函数的业务逻辑。
 * 任务式生成（/api/tasks/{id}、/api/canvas-image-tasks/{id} 轮询）在响应里出现 credits 时补提示。
 *
 * auth-off / 401：静默 —— 不渲染、不开 SSE、不再重试，页面行为与没有积分功能时一致。
 */
(function () {
    'use strict';

    if (window.NOVAI_CREDITS) return;

    var API = {
        me: '/api/credits/me',
        transactions: '/api/credits/transactions',
        price: '/api/credits/price',
        stream: '/api/credits/stream'
    };
    var QUOTE_TTL_MS = 60 * 1000;
    var QUOTE_WAIT_MS = 700;
    var TOAST_HOST_ID = 'credits-toasts';
    var TOAST_STYLE_ID = 'credits-toast-style';
    var MAX_TOASTS = 3;
    var STREAM_SETTLE_WAIT_MS = 3000;

    var rawFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

    var state = {
        loaded: false,
        available: false,      /* 拿到过 /api/credits/me 且登录已开启 */
        enabled: true,         /* 后端是否真的在扣费（NOVAI_CREDITS_DISABLED / auth-off 时 false） */
        denied: false,         /* 401 / auth-off：静默，不再请求 */
        balance: 0,
        unit: 'credit',
        usdPerCredit: 0.1,
        markup: 1.3,
        tier: 'gold'
    };

    var sse = null;
    var sseFailures = 0;
    var sseReconnectTimer = 0;
    var quoteCache = Object.create(null);
    var seenCredits = Object.create(null);
    var subscribers = [];
    var lastQuote = null;

    // ---------------------------------------------------------------- 基础工具

    function number(value) {
        var num = Number(value);
        return isFinite(num) ? num : null;
    }

    function round(value, digits) {
        var factor = Math.pow(10, digits || 6);
        return Math.round(Number(value || 0) * factor) / factor;
    }

    /* 积分展示统一口径：固定 2 位小数（后端按 0.01 步进）：0.01 / 0.09 / 1.30 / 100.00。 */
    function format(value) {
        var num = number(value);
        if (num === null) return '0.00';
        return num.toFixed(2);
    }

    function formatUsd(value) {
        var num = number(value);
        if (num === null) return '$0.00';
        var rounded = Math.round(num * 100) / 100;
        if (rounded === 0 && num !== 0) return (num < 0 ? '-' : '') + '<$0.01';
        return (num < 0 ? '-$' : '$') + Math.abs(rounded).toFixed(2);
    }

    function detail() {
        return {
            loaded: state.loaded,
            available: state.available,
            enabled: state.enabled,
            balance: state.balance,
            unit: state.unit,
            usd_per_credit: state.usdPerCredit,
            markup: state.markup,
            tier: state.tier,
            formatted: format(state.balance),
            usd: round(state.balance * state.usdPerCredit, 4)
        };
    }

    function emit(name, payload) {
        try {
            document.dispatchEvent(new CustomEvent(name, { detail: payload }));
        } catch (error) {
            /* 老浏览器没有 CustomEvent 构造器：不影响功能 */
        }
    }

    function notify() {
        var payload = detail();
        emit('novai-credits', payload);
        subscribers.slice().forEach(function (fn) {
            try { fn(payload); } catch (error) { /* 订阅方自己的异常不能影响全局 */ }
        });
    }

    function parseJSON(text) {
        try { return JSON.parse(text); } catch (error) { return null; }
    }

    function apiGet(url) {
        if (!rawFetch) return Promise.resolve(null);
        return rawFetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        }).catch(function () { return null; });
    }

    function deny() {
        state.available = false;
        state.denied = true;
        closeStream();
    }

    function applyBalance(value) {
        var next = number(value);
        if (next === null) return false;
        var changed = !state.loaded || Math.abs(next - state.balance) > 1e-6;
        state.balance = round(next, 6);
        state.loaded = true;
        if (changed) notify();
        return changed;
    }

    // ---------------------------------------------------------------- 数据

    function ingestMe(data) {
        if (!data || typeof data !== 'object') return false;
        if (typeof data.balance === 'undefined') return false;
        if (data.auth_enabled === false) {
            deny();
            return false;
        }
        state.available = true;
        state.loaded = true;
        state.enabled = data.enabled !== false;
        state.unit = String(data.unit || state.unit || 'credit');
        state.usdPerCredit = number(data.usd_per_credit) === null ? state.usdPerCredit : number(data.usd_per_credit);
        state.markup = number(data.markup) === null ? state.markup : number(data.markup);
        state.tier = String(data.tier || state.tier || 'gold');
        state.balance = round(number(data.balance) || 0, 6);
        notify();
        return true;
    }

    function load() {
        if (state.denied) return Promise.resolve(null);
        return apiGet(API.me).then(function (response) {
            if (!response) return null;
            if (response.status === 401 || response.status === 403) {
                deny();
                return null;
            }
            if (!response.ok) return null;   /* 老后端 / 暂不可用：静默，不渲染 */
            return response.json().catch(function () { return null; }).then(function (data) {
                if (!ingestMe(data)) return null;
                openStream();
                return detail();
            });
        });
    }

    function refresh() {
        return load();
    }

    function transactions(limit) {
        var size = Math.max(1, Math.min(200, Math.round(number(limit) || 50)));
        if (state.denied) return Promise.resolve({ balance: state.balance, transactions: [] });
        return apiGet(API.transactions + '?limit=' + size).then(function (response) {
            if (!response) return { balance: state.balance, transactions: [] };
            if (response.status === 401 || response.status === 403) {
                deny();
                return { balance: state.balance, transactions: [] };
            }
            if (!response.ok) return { balance: state.balance, transactions: [] };
            return response.json().catch(function () { return null; }).then(function (data) {
                var list = data && Array.isArray(data.transactions) ? data.transactions : [];
                if (data && typeof data.balance !== 'undefined') applyBalance(data.balance);
                return { balance: state.balance, transactions: list, enabled: !data || data.enabled !== false };
            });
        });
    }

    // ---------------------------------------------------------------- SSE

    function parseStreamEvent(raw) {
        if (!raw) return null;
        var text = String(raw).trim();
        if (text === '[DONE]') return null;
        return parseJSON(text);
    }

    function openStream() {
        if (sse || state.denied || !state.available) return;
        if (typeof window.EventSource === 'undefined') return;
        try {
            sse = new EventSource(API.stream);
        } catch (error) {
            sse = null;
            return;
        }
        sse.onopen = function () {
            sseFailures = 0;
        };
        sse.onmessage = function (event) {
            var payload = parseStreamEvent(event && event.data);
            if (!payload) return;
            sseFailures = 0;
            if (payload.type === 'balance') {
                applyBalance(payload.balance);
            } else if (payload.type === 'credits_disabled') {
                state.enabled = false;
                notify();
            }
        };
        sse.onerror = function () {
            /* EventSource 自己会重连（默认 3s）。连续失败太多就自己接管，避免长时间断线时刷屏。 */
            sseFailures += 1;
            if (sseFailures === 4) refresh();
            if (sseFailures === 10) {
                closeStream();
                scheduleStreamReconnect();
            }
        };
    }

    function closeStream() {
        if (!sse) return;
        try {
            sse.onerror = null;
            sse.onmessage = null;
            sse.onopen = null;
            sse.close();
        } catch (error) { /* 已经关掉了 */ }
        sse = null;
    }

    function scheduleStreamReconnect() {
        clearTimeout(sseReconnectTimer);
        if (state.denied || !state.available) return;
        sseReconnectTimer = setTimeout(function () {
            sseReconnectTimer = 0;
            openStream();
        }, 30000);
    }

    // ---------------------------------------------------------------- 估价

    function quoteKey(params) {
        var source = params || {};
        var parts = [];
        ['kind', 'model', 'width', 'height', 'duration', 'quality', 'rows', 'size', 'tokens_in', 'tokens_out'].forEach(function (key) {
            var value = source[key];
            if (value === undefined || value === null || value === '' || value === 0) return;
            parts.push(key + '=' + String(value));
        });
        return parts.join('&');
    }

    function quote(params) {
        var source = params || {};
        var key = quoteKey(source);
        if (!key) return Promise.resolve(null);
        var cached = quoteCache[key];
        if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return Promise.resolve(cached.value);
        if (!state.available || !state.enabled) return Promise.resolve(null);
        var query = key.split('&').map(function (pair) {
            var index = pair.indexOf('=');
            return encodeURIComponent(pair.slice(0, index)) + '=' + encodeURIComponent(pair.slice(index + 1));
        }).join('&');
        return apiGet(API.price + '?' + query).then(function (response) {
            if (!response || !response.ok) return null;
            return response.json().catch(function () { return null; }).then(function (data) {
                if (!data || typeof data.price === 'undefined') return null;
                quoteCache[key] = { at: Date.now(), value: data };
                return data;
            });
        });
    }

    // ---------------------------------------------------------------- 提示条

    function ensureToastHost() {
        if (!document.body) return null;
        var host = document.getElementById(TOAST_HOST_ID);
        if (!host) {
            host = document.createElement('div');
            host.id = TOAST_HOST_ID;
            host.className = 'credits-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        if (!document.getElementById(TOAST_STYLE_ID)) {
            var style = document.createElement('style');
            style.id = TOAST_STYLE_ID;
            style.textContent = [
                '.credits-toasts{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:5000;',
                'display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;',
                'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);}',
                '.credits-toast{display:inline-flex;align-items:center;gap:8px;max-width:min(440px,calc(100vw - 32px));',
                'padding:8px 14px;border-radius:999px;border:0;background:rgba(255,255,255,.96);color:#1c1c1e;',
                'box-shadow:0 12px 32px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.06);',
                'font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.01em;white-space:nowrap;',
                'overflow:hidden;text-overflow:ellipsis;opacity:0;transform:translateY(-6px);',
                'transition:opacity .16s ease,transform .16s ease;',
                'backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);}',
                '.credits-toast.is-show{opacity:1;transform:translateY(0);}',
                '.credits-toast.is-leaving{opacity:0;transform:translateY(-6px);}',
                '.credits-toast-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#8e8e93;}',
                '.credits-toast[data-tone="estimate"] .credits-toast-dot{background:#8e8e93;}',
                '.credits-toast[data-tone="spent"] .credits-toast-dot{background:#30a46c;}',
                '.credits-toast[data-tone="refund"] .credits-toast-dot,.credits-toast[data-tone="warn"] .credits-toast-dot{background:#f5a623;}',
                '.credits-toast[data-tone="error"] .credits-toast-dot{background:#d70015;}',
                '.credits-toast[data-tone="error"]{color:#d70015;}',
                'html.theme-dark .credits-toast,html.studio-theme-dark .credits-toast{background:rgba(24,24,24,.95);color:#f5f5f7;}',
                'html.theme-dark .credits-toast[data-tone="error"],html.studio-theme-dark .credits-toast[data-tone="error"]{color:#ff6961;}',
                'html.theme-dark .credits-toast[data-tone="spent"] .credits-toast-dot,html.studio-theme-dark .credits-toast[data-tone="spent"] .credits-toast-dot{background:#3dd68c;}',
                '@media (prefers-reduced-motion: reduce){.credits-toast{transition:none;}}'
            ].join('');
            (document.head || document.documentElement).appendChild(style);
        }
        return host;
    }

    function showToast(message, options) {
        var text = String(message == null ? '' : message).trim();
        if (!text) return null;
        var opts = options || {};
        var host = ensureToastHost();
        if (!host) return null;
        var key = opts.key ? String(opts.key) : '';
        var tone = opts.tone || 'estimate';
        var node = key ? host.querySelector('[data-key="' + key.replace(/"/g, '') + '"]') : null;
        if (node) {
            var label = node.querySelector('.credits-toast-text');
            if (label) label.textContent = text;
            node.setAttribute('data-tone', tone);
            clearTimeout(node.__creditsTimer);
            node.__creditsTimer = setTimeout(function () { hideToast(node); }, opts.duration || 3600);
            return node;
        }
        if (!key) {
            Array.prototype.slice.call(host.querySelectorAll('[data-key=""]')).forEach(hideToast);
        }
        while (host.children.length >= MAX_TOASTS) hideToast(host.firstElementChild);
        node = document.createElement('div');
        node.className = 'credits-toast';
        node.setAttribute('data-tone', tone);
        node.setAttribute('data-key', key);
        node.setAttribute('data-credits-toast', '1');
        node.innerHTML = '<i class="credits-toast-dot" aria-hidden="true"></i><span class="credits-toast-text"></span>';
        node.querySelector('.credits-toast-text').textContent = text;
        host.appendChild(node);
        requestAnimationFrame(function () { node.classList.add('is-show'); });
        node.__creditsTimer = setTimeout(function () { hideToast(node); }, opts.duration || 3600);
        return node;
    }

    function hideToast(node) {
        if (!node || !node.parentNode) return;
        clearTimeout(node.__creditsTimer);
        node.classList.remove('is-show');
        node.classList.add('is-leaving');
        setTimeout(function () {
            if (node.parentNode) node.remove();
        }, 200);
    }

    function clearToasts() {
        var host = document.getElementById(TOAST_HOST_ID);
        if (!host) return;
        Array.prototype.slice.call(host.children).forEach(hideToast);
    }

    // ---------------------------------------------------------------- 生成链路拦截

    var GENERATION_RULES = [
        { re: /^\/api\/(?:canvas-llm|canvas-llm\/stream|chat|chat\/stream|chat\/agent|chat\/agent\/stream)(?:\/|$)/i, kind: 'text' },
        /* 音频智能切分本质是一次文本 LLM 调用（后端按 text 计费），先于 audio 规则匹配 */
        { re: /^\/api\/canvas-audio-split(?:\/|$)/i, kind: 'text' },
        { re: /^\/api\/(?:canvas-audio|canvas-tts|audio|audio-tts|music|tts)(?:\/|$)/i, kind: 'audio' },
        { re: /^\/api\/(?:canvas-video|video)(?:\/|$)/i, kind: 'video' },
        { re: /^\/api\/(?:canvas-image-tasks|canvas-comfy-tasks|online-image|generate|ms\/generate|angle\/generate)(?:\/|$)/i, kind: 'image' },
        { re: /^\/api\/(?:canvas-table|table|table-generate)(?:\/|$)/i, kind: 'table' },
        /* Agent 一次跑很多步、没有单一价目：只提示后付费，不报价 */
        { re: /^\/api\/agent\/run(?:\/|$)/i, kind: 'agent' },
        { re: /^\/generate$/i, kind: 'image' }
    ];
    var TASK_POLL_RE = /^\/api\/(?:tasks|canvas-image-tasks|image-task-query|canvas-comfy-tasks)(?:\/|$)/i;

    function pathOf(url) {
        var text = String(url || '');
        if (!text) return '';
        try {
            var parsed = new URL(text, location.href);
            if (parsed.origin !== location.origin) return '';
            return parsed.pathname;
        } catch (error) {
            return '';
        }
    }

    function textValue(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function sizeDims(size) {
        var match = /(\d{2,5})\s*[x*×]\s*(\d{2,5})/i.exec(String(size || ''));
        if (!match) return null;
        var width = Number(match[1]);
        var height = Number(match[2]);
        if (!width || !height) return null;
        return { width: width, height: height };
    }

    function estimateParams(kind, body) {
        var params = { kind: kind };
        var model = textValue(body.model || body.model_id || body.ms_model || body.video_model || body.videoModel || body.gen_model);
        if (model) params.model = model;
        var size = textValue(body.size || body.resolution || '');
        var dims = sizeDims(size) || { width: number(body.width), height: number(body.height) };
        if (dims && dims.width) params.width = Math.round(dims.width);
        if (dims && dims.height) params.height = Math.round(dims.height);
        if (size && !params.width && kind === 'image') params.size = size;
        if (!params.height && kind === 'video') {
            /* 视频常传 "1080p"：按后端口径取高度档位 */
            var resolution = textValue(body.resolution || '');
            var height = /(\d{3,4})/.exec(resolution);
            if (height) params.height = Number(height[1]);
        }
        var duration = number(body.duration) || number(body.length) || number(body.seconds) || number(body.videoDuration) || number(body.duration_sec);
        if (duration) params.duration = duration;
        var quality = textValue(body.quality);
        if (quality && quality !== 'auto') params.quality = quality;
        var rows = number(body.rows) || number(body.n) || number(body.count) || number(body.videoCount) || 1;
        if (rows > 1) params.rows = Math.max(1, Math.round(rows));
        if (kind === 'text') {
            var prompt = textValue(body.message || body.prompt || body.text || body.input || '');
            if (!prompt && Array.isArray(body.messages)) {
                prompt = body.messages.map(function (message) {
                    return message && typeof message === 'object' ? textValue(message.content) : '';
                }).join(' ');
            }
            var tokensIn = Math.max(0, Math.round(prompt.length / 4));
            if (tokensIn) params.tokens_in = tokensIn;
            var maxTokens = number(body.max_tokens);
            if (maxTokens > 0) params.tokens_out = Math.round(maxTokens);
        }
        return params;
    }

    function classifyGeneration(url, method, body) {
        if (String(method || 'GET').toUpperCase() !== 'POST') return null;
        var path = pathOf(url);
        if (!path) return null;
        for (var i = 0; i < GENERATION_RULES.length; i += 1) {
            if (!GENERATION_RULES[i].re.test(path)) continue;
            var payload = null;
            if (typeof body === 'string') payload = parseJSON(body);
            if (!payload || typeof payload !== 'object') return null;
            return { kind: GENERATION_RULES[i].kind, path: path, params: estimateParams(GENERATION_RULES[i].kind, payload) };
        }
        return null;
    }

    function isTaskPoll(url, method) {
        if (String(method || 'GET').toUpperCase() !== 'GET') return false;
        var path = pathOf(url);
        return Boolean(path && TASK_POLL_RE.test(path));
    }

    function jsonResponse(response) {
        var type = String((response.headers && response.headers.get('content-type')) || '').toLowerCase();
        return type.indexOf('json') >= 0;
    }

    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* 后付费：现在所有生成类型都是后付费（价目接口 mode=postpaid / postpaid=true，price=0，estimated_price 给参考价）。
       老后端（没有 mode、price>0）仍按预扣展示，避免误报。 */
    function isPostpaid(quoteData) {
        if (!quoteData) return true;
        if (quoteData.postpaid === true) return true;
        if (quoteData.postpaid === false) return false;
        var mode = String(quoteData.mode || quoteData.pricing_mode || '').toLowerCase();
        if (mode) return mode === 'postpaid';
        var price = number(quoteData.price);
        return price === null || price === 0;
    }

    /* 后付费参考价：优先 estimated_price，其次 price（有些后端直接把估价放 price） */
    function estimatedPrice(quoteData) {
        if (!quoteData) return null;
        var value = number(quoteData.estimated_price);
        if (value !== null && value > 0) return value;
        var price = number(quoteData.price);
        return price !== null && price > 0 ? price : null;
    }

    /* 返回 true = 后付费（调用方据此决定 402 / 失败文案） */
    function showEstimate(quoteData, gen) {
        if (isPostpaid(quoteData)) {
            var estimate = estimatedPrice(quoteData);
            lastQuote = {
                at: Date.now(),
                price: estimate === null ? 0 : estimate,
                estimated_price: estimate,
                kind: gen.kind,
                params: gen.params,
                quote: quoteData,
                postpaid: true
            };
            var message = '生成后按实际用量扣费';
            if (estimate !== null) message += ' · 预计约 ' + format(estimate) + ' 积分';
            showToast(message, { tone: 'estimate', key: 'estimate', duration: 4600 });
            emit('novai-credits-estimate', {
                price: null, estimated_price: estimate, postpaid: true,
                kind: gen.kind, model: gen.params.model || '', quote: quoteData
            });
            return true;
        }
        if (!quoteData || typeof quoteData.price === 'undefined') return false;
        var price = number(quoteData.price) || 0;
        lastQuote = { at: Date.now(), price: price, kind: gen.kind, params: gen.params, quote: quoteData };
        showToast('本次预计消耗 ' + format(price) + ' 积分', { tone: 'estimate', key: 'estimate', duration: 4200 });
        emit('novai-credits-estimate', { price: price, postpaid: false, kind: gen.kind, model: gen.params.model || '', quote: quoteData });
        return false;
    }

    function creditsFromResponse(data) {
        if (!data || typeof data !== 'object') return null;
        var credits = data.credits;
        if (credits && typeof credits === 'object' && typeof credits.price !== 'undefined') return credits;
        return null;
    }

    function reportCredits(credits, source) {
        if (!credits) return false;
        if (typeof credits.balance_after !== 'undefined') applyBalance(credits.balance_after);
        var price = number(credits.price) || 0;
        var key = [credits.charge_id || '', credits.status || '', Math.round(price * 100), Math.round((number(credits.balance_after) || 0) * 100)].join('|');
        if (seenCredits[key]) return false;
        seenCredits[key] = true;
        var balance = number(credits.balance_after);
        if (String(credits.status || '') === 'refunded' || (price < 0 && source !== 'stream')) {
            showToast('生成失败，积分已退回' + (balance === null ? '' : ' · 余额 ' + format(balance)), { tone: 'refund', key: 'estimate', duration: 5000 });
            emit('novai-credits-refund', { price: Math.abs(price), balance: balance, source: source });
            return true;
        }
        var message = price > 0
            ? '已扣 ' + format(price) + ' 积分' + (balance === null ? '' : ' · 余额 ' + format(balance))
            : '本次消耗 0 积分' + (balance === null ? '' : ' · 余额 ' + format(balance));
        showToast(message, { tone: 'spent', key: 'estimate', duration: 4600 });
        emit('novai-credits-spent', { price: price, balance: balance, source: source || 'response' });
        return true;
    }

    /* 欠费上限：后付费发起时 balance + 0.01 < 预计价 才 402（契约 CREDIT_OVERDRAFT_LIMIT=0.01） */
    var OVERDRAFT_LIMIT = 0.01;

    function reportInsufficient(payload, gen) {
        var data = payload || {};
        var price = number(data.estimate);
        if ((price === null || price <= 0) && lastQuote) {
            price = number(lastQuote.estimated_price);
            if (price === null || price <= 0) price = number(lastQuote.price);
        }
        var balance = number(data.balance);
        if (balance === null) balance = state.balance;
        if (typeof data.balance !== 'undefined') applyBalance(data.balance);
        refresh();
        var limit = number(data.overdraft_limit);
        if (limit === null) limit = OVERDRAFT_LIMIT;
        var message = '积分不足';
        if (price !== null && price > 0) {
            message += '：本次预计 ' + format(price) + ' 积分，当前 ' + format(balance) + ' 积分（可欠费 ' + format(limit) + ' 积分）';
        } else {
            message += '（可欠费 ' + format(limit) + ' 积分）';
        }
        showToast(message, { tone: 'error', key: 'estimate', duration: 6000 });
        emit('novai-credits-insufficient', {
            price: price, balance: balance, message: message, limited: true,
            kind: gen ? gen.kind : ''
        });
    }

    function reportFailure(gen, postpaid) {
        if (!state.available || !state.enabled) return;
        if (postpaid) {
            showToast('生成失败，未产生扣费', { tone: 'warn', key: 'estimate', duration: 4200 });
            emit('novai-credits-refund', { price: 0, balance: state.balance, source: 'failure', kind: gen ? gen.kind : '', postpaid: true });
            return;
        }
        showToast('生成失败，预扣积分将自动退回', { tone: 'warn', key: 'estimate', duration: 4200 });
        emit('novai-credits-refund', { price: lastQuote && lastQuote.price ? lastQuote.price : 0, balance: state.balance, source: 'failure', kind: gen ? gen.kind : '' });
    }

    /* 流式响应要等「流结束」才知道结算了多少：把 body 分流成两路，一路原样返回给调用方，
       另一路只用来判断结束。返回新 Response（保留 status/headers）而不是改 body ——
       这样调用方仍然可以 .body.getReader() / .text() / .ok，行为不变。 */
    function watchStream(response, before, gen) {
        try {
            var body = response.body;
            if (!body || typeof body.tee !== 'function') return response;
            var pair = body.tee();
            var reader = pair[1].getReader();
            var replaced = new Response(pair[0], {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
            var settle = function (failed) {
                wait(400).then(function () {
                    var deadline = Date.now() + STREAM_SETTLE_WAIT_MS;
                    var check = function () {
                        var delta = round(before - state.balance, 6);
                        if (delta > 0.00005) {
                            reportCredits({ price: delta, balance_after: state.balance, status: 'settled', charge_id: 'stream:' + (gen.path || '') }, 'stream');
                            return;
                        }
                        if (delta < -0.00005) {
                            reportCredits({ price: Math.abs(delta), balance_after: state.balance, status: 'refunded', charge_id: 'stream-refund:' + (gen.path || '') }, 'stream');
                            return;
                        }
                        if (Date.now() < deadline) {
                            setTimeout(check, 250);
                            return;
                        }
                        if (failed) reportFailure(gen);
                    };
                    check();
                });
            };
            var pump = function () {
                reader.read().then(function (chunk) {
                    if (chunk.done) { settle(false); return; }
                    pump();
                }, function () { settle(true); });
            };
            pump();
            return replaced;
        } catch (error) {
            /* 任何意外都不干预原始响应（流式是本项目的核心链路） */
            return response;
        }
    }

    function inspectResponse(response, before, gen, postpaid) {
        if (!response) return response;
        if (response.status === 402) {
            var copy = response.clone();
            copy.json().then(function (payload) { reportInsufficient(payload, gen); })
                .catch(function () { reportInsufficient(null, gen); });
            return response;
        }
        if (!response.ok) {
            if (response.status === 409 || response.status === 404 || response.status === 405) return response; /* 流式不支持，调用方会自动退回 */
            reportFailure(gen, postpaid);
            return response;
        }
        var type = String((response.headers && response.headers.get('content-type')) || '').toLowerCase();
        if (type.indexOf('text/event-stream') >= 0) {
            return watchStream(response, before, gen);
        }
        if (!jsonResponse(response)) return response;
        response.clone().json().then(function (data) {
            var credits = creditsFromResponse(data);
            if (credits) reportCredits(credits, 'response');
        }).catch(function () { /* 不是 JSON：忽略 */ });
        return response;
    }

    function interceptFetch() {
        if (!rawFetch || rawFetch.__novaiCreditsWrapped) return;
        var wrapped = function (input, init) {
            var args = arguments;
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
            if (state.denied || !state.available) return rawFetch.apply(window, args);
            var gen = classifyGeneration(url, method, init && init.body);
            if (!gen) {
                if (isTaskPoll(url, method)) {
                    return rawFetch.apply(window, args).then(function (response) {
                        if (!response || !response.ok || !jsonResponse(response)) return response;
                        response.clone().json().then(function (data) {
                            reportCredits(creditsFromResponse(data), 'task');
                        }).catch(function () { /* 忽略 */ });
                        return response;
                    });
                }
                return rawFetch.apply(window, args);
            }
            var before = state.balance;
            if (gen.kind === 'agent') {
                /* Agent 没有单价：不报价，只提示后付费 */
                showEstimate(null, gen);
                return rawFetch.apply(window, args).then(function (response) {
                    return inspectResponse(response, before, gen, true);
                }, function (error) {
                    reportFailure(gen, true);
                    throw error;
                });
            }
            var quoted = quote(gen.params);
            var gate = Promise.race([quoted, wait(QUOTE_WAIT_MS)]);
            return gate.then(function (quoteData) {
                var postpaid = showEstimate(quoteData, gen) === true;
                return rawFetch.apply(window, args).then(function (response) {
                    return inspectResponse(response, before, gen, postpaid);
                }, function (error) {
                    reportFailure(gen, postpaid);
                    throw error;
                });
            });
        };
        wrapped.__novaiCreditsWrapped = true;
        window.fetch = wrapped;
    }

    // ---------------------------------------------------------------- 生命周期

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        if (state.loaded) {
            try { fn(detail()); } catch (error) { /* 忽略 */ }
        }
        return function () {
            var index = subscribers.indexOf(fn);
            if (index >= 0) subscribers.splice(index, 1);
        };
    }

    function onVisible() {
        if (document.visibilityState === 'hidden') return;
        if (!state.loaded) return;
        if (sse && sse.readyState !== 2) return;   /* 2 = CLOSED */
        openStream();
    }

    function boot() {
        interceptFetch();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', function () { if (state.available) openStream(); });
        load();
    }

    window.NOVAI_CREDITS = {
        get balance() { return state.balance; },
        get available() { return state.available; },
        get enabled() { return state.enabled; },
        get loaded() { return state.loaded; },
        get unit() { return state.unit; },
        get state() { return detail(); },
        get lastQuote() { return lastQuote; },
        refresh: refresh,
        quote: quote,
        quoteKey: quoteKey,
        transactions: transactions,
        format: format,
        formatUsd: formatUsd,
        toast: showToast,
        clearToasts: clearToasts,
        subscribe: subscribe,
        usdPerCredit: function () { return state.usdPerCredit; },
        __debug: function () {
            return {
                denied: state.denied,
                available: state.available,
                enabled: state.enabled,
                loaded: state.loaded,
                balance: state.balance,
                sse: sse ? sse.readyState : -1,
                sseFailures: sseFailures,
                quotes: Object.keys(quoteCache).length,
                seen: Object.keys(seenCredits).length
            };
        }
    };

    boot();
})();
