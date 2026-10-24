/* NOVAI 智能画布实时协作（M4 客户端）
 *
 * 只在两个条件同时成立时启动：URL 带 ?id=<canvasId>，且 /api/auth/me 返回 auth_enabled===true。
 * auth-off 时不注入任何 DOM、不建任何连接（页面行为与旧版完全一致）。
 *
 * 服务端契约（/ws/canvas/{canvasId}，复用会话 cookie）：
 *   下行 hello / presence / cursor / snapshot / patch / error；上行 cursor / patch / request-snapshot / ping
 * 文档同步是 MVP 的 LWW：每 250ms 和上一快照比 nodes / connections / title，生成 add/remove/update 补丁。
 * 收到远端补丁时先置 suppress、应用完立刻重设基线，自己的 diff 不会把同一份改动再发回去。
 *
 * 状态读写全部走 smart-canvas.js 暴露的 window.SmartCanvasCollab（受限桥）：
 * 页面闭包里的 nodes/canvas/viewport 不直接暴露，避免两个脚本抢着改同一份状态。
 */
(function () {
    'use strict';

    if (window.NOVAI_COLLAB) return;

    var ROLE_TEXT = { owner: '所有者', admin: '管理员', editor: '可编辑', viewer: '只读' };
    var STATUS_TITLE = {
        connecting: '正在连接实时协作…',
        online: '已连接 · 实时协作',
        reconnecting: '连接断开，正在重连…',
        offline: '实时协作已断开'
    };
    var HEARTBEAT_MS = 4000;
    var CURSOR_THROTTLE_MS = 50;
    var DIFF_INTERVAL_MS = 250;
    var RECONNECT_MAX_MS = 30000;
    var AVATAR_LIMIT = 5;
    /* 与 server/collab.py 的 COLORS 同序：同一个人在手势头像 / 光标 / 成员面板里颜色一致 */
    var PALETTE = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];
    var PANEL_MIN_WIDTH = 360;
    var PANEL_GAP = 8;
    var PANEL_MARGIN = 12;
    var USERS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 19v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V19"/><circle cx="9" cy="7.4" r="3.4"/><path d="M22 19v-1.6a4 4 0 0 0-3-3.8"/><path d="M16.5 4.2a3.4 3.4 0 0 1 0 6.4"/></svg>';
    var CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
    var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 6.5"/></svg>';
    var EXPIRY_OPTIONS = [
        { days: 7, label: '7 天有效' },
        { days: 1, label: '1 天有效' },
        { days: 30, label: '30 天有效' },
        { days: 0, label: '永久有效' }
    ];
    var CREDITS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 6.8v10.4"/><path d="M15 9.4c-.6-.9-1.7-1.3-3-1.3-1.8 0-3.1.8-3.1 2.1 0 2.8 6.2 1.4 6.2 4.1 0 1.3-1.3 2.1-3.1 2.1-1.3 0-2.4-.4-3-1.3"/></svg>';

    var params = new URLSearchParams(location.search);
    var canvasId = params.get('id') || '';
    if (!canvasId) return;

    var bridge = null;
    var enabled = false;
    var ws = null;
    var reconnectTimer = 0;
    var reconnectAttempt = 0;
    var pingTimer = 0;
    var diffTimer = 0;
    var prevDoc = null;
    var suppress = false;
    var pendingSnapshot = null;
    var pendingSnapshotTries = 0;
    var lastReadOnlyToast = 0;
    var terminalToastShown = false;
    var permissionsCache = null;
    var panelEl = null;
    var panelOpen = false;
    var panelData = null;
    var shareOverlayEl = null;
    var shareModalEl = null;
    var shareModalOpen = false;
    var shareLink = null;
    var shareLinkLoaded = false;
    var shareLinkError = '';
    var shareCanManage = false;
    var shareMemberCount = 0;
    var shareBusy = false;
    var shareExpiryOpen = false;
    var sharePasswordOpen = false;
    var sharePasswordTouched = false;
    /* 后端 POST 是整份配置覆盖（password:null 会清空密码）。用户设置过的密码只在内存里记住，
       同一页面里改有效期/克隆开关时带上它，避免把刚设的密码冲掉。 */
    var shareKnownPassword = '';

    var state = {
        canvasId: canvasId,
        selfId: null,
        self: null,
        role: '',
        users: [],
        status: 'idle',
        revision: 0,
        joined: false,
        terminal: false,
        lastError: null,
        stats: { sentPatches: 0, receivedPatches: 0, sentCursors: 0, reconnects: 0 }
    };

    var hud = null;
    var avatarsEl = null;
    var memberCountEl = null;
    var statusEl = null;
    var shareBtn = null;
    var creditsBtn = null;
    var creditsNumEl = null;
    var creditsPop = null;
    var creditsPopOpen = false;
    var creditsData = null;
    var creditsReqToken = 0;
    var cursorLayer = null;
    var cursorRaf = 0;
    var remoteCursors = new Map();
    var lastCursorSent = 0;

    // ---------------------------------------------------------------- 基础工具

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function safeColor(value) {
        var color = String(value || '');
        return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#4E79A7';
    }

    function initial(name) {
        return String(name == null ? '?' : name).trim().slice(0, 1).toUpperCase() || '?';
    }

    function textColorOn(background) {
        var hex = safeColor(background).replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (ch) { return ch + ch; }).join('');
        if (hex.length >= 6) {
            var r = parseInt(hex.slice(0, 2), 16);
            var g = parseInt(hex.slice(2, 4), 16);
            var b = parseInt(hex.slice(4, 6), 16);
            var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return luminance > 0.62 ? '#111111' : '#ffffff';
        }
        return '#ffffff';
    }

    function apiJSON(url, options) {
        var opts = options || {};
        opts.credentials = 'same-origin';
        opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
        return fetch(url, opts).then(function (response) {
            if (!response.ok) return null;
            return response.json().catch(function () { return null; });
        }).catch(function () { return null; });
    }

    function fetchPermissions() {
        if (permissionsCache) return Promise.resolve(permissionsCache);
        return apiJSON('/api/canvases/' + encodeURIComponent(canvasId) + '/permissions').then(function (data) {
            if (data) permissionsCache = data;
            return data;
        });
    }

    function injectStyles() {
        if (document.getElementById('collab-style')) return;
        var style = document.createElement('style');
        style.id = 'collab-style';
        style.textContent = [
            '.collab-hud{display:flex;align-items:center;gap:6px;height:40px;padding:0 4px 0 8px;border-radius:999px;',
            'background:color-mix(in srgb, var(--panel) 80%, transparent);border:1px solid var(--border);',
            'backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);',
            'color:var(--text);font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);',
            'font-size:12px;box-shadow:0 8px 24px var(--shadow);-webkit-user-select:none;user-select:none;}',
            '.collab-hud--fixed{position:fixed;top:12px;right:130px;z-index:59;}',
            '.collab-avatars{display:flex;align-items:center;padding:3px 6px 3px 4px;margin-left:-4px;border-radius:999px;',
            'cursor:pointer;transition:background .14s ease;outline:none;}',
            '.collab-avatars:hover,.collab-avatars[aria-expanded="true"]{background:var(--soft,rgba(0,0,0,.06));}',
            '.collab-avatars:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            '.collab-avatar.has-image{background:var(--surface-2,#fafafa);overflow:hidden;}',
            '.collab-avatar img,.collab-member-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;}',
            '.collab-member-avatar.has-image{background:var(--surface-2,#fafafa);}',
            '.collab-avatar{position:relative;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;',
            'color:#fff;font-size:10px;font-weight:700;line-height:1;border:2px solid var(--panel);margin-left:-7px;',
            'text-shadow:0 1px 2px rgba(0,0,0,.35);cursor:inherit;flex:none;}',
            '.collab-avatar:first-child{margin-left:0;}',
            '.collab-avatar.is-self{box-shadow:0 0 0 2px var(--panel),0 0 0 3.5px var(--info,#0a84ff);}',
            /* tooltip 落在头像下方：贴顶时不至于被视口裁掉 */
            '.collab-avatar::after,.collab-more::after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 8px);bottom:auto;',
            'transform:translate(-50%,-4px);padding:4px 8px;border-radius:6px;background:var(--elevated,#1f1f1f);color:var(--text,#fff);',
            'border:1px solid var(--border-2);font-size:11px;font-weight:500;line-height:1.4;white-space:nowrap;',
            'text-shadow:none;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,transform .12s ease;z-index:90;}',
            '.collab-avatar:hover::after,.collab-more:hover::after{opacity:1;visibility:visible;transform:translate(-50%,0);}',
            '.collab-hud.is-panel-open .collab-avatar::after,.collab-hud.is-panel-open .collab-more::after{opacity:0;visibility:hidden;transform:translate(-50%,-4px);}',
            '.collab-more{position:relative;height:26px;min-width:26px;padding:0 5px;border-radius:999px;display:grid;place-items:center;',
            'background:var(--surface-2);border:2px solid var(--panel);color:var(--text-2);font-size:10px;font-weight:700;',
            'margin-left:-7px;cursor:default;flex:none;}',
            '.collab-member-count{font-size:11px;font-weight:600;color:var(--text-2);padding:0 2px;white-space:nowrap;}',
            '.collab-share{display:flex;align-items:center;gap:5px;height:30px;padding:0 10px;border:0;border-radius:999px;',
            'background:var(--surface-2);color:var(--text);font:inherit;font-size:11px;font-weight:600;cursor:pointer;',
            'transition:background .14s ease,transform .14s ease;flex:none;}',
            '.collab-share:hover{background:var(--soft,rgba(0,0,0,.06));transform:translateY(-1px);}',
            '.collab-share:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            '.collab-share svg{width:14px;height:14px;}',
            '.collab-status{width:18px;height:18px;display:grid;place-items:center;flex:none;}',
            '.collab-status-dot{width:8px;height:8px;border-radius:50%;background:#8e8e93;box-shadow:0 0 0 3px color-mix(in srgb, #8e8e93 22%, transparent);transition:background .2s ease,box-shadow .2s ease;}',
            '.collab-status[data-state="online"] .collab-status-dot{background:#30d158;box-shadow:0 0 0 3px color-mix(in srgb, #30d158 22%, transparent);}',
            '.collab-status[data-state="connecting"] .collab-status-dot,.collab-status[data-state="reconnecting"] .collab-status-dot{background:#ff9f0a;box-shadow:0 0 0 3px color-mix(in srgb, #ff9f0a 24%, transparent);animation:collab-pulse 1.1s ease-in-out infinite;}',
            '.collab-status[data-state="offline"] .collab-status-dot{background:#ff453a;box-shadow:0 0 0 3px color-mix(in srgb, #ff453a 22%, transparent);}',
            '@keyframes collab-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
            '.collab-cursor-layer{position:fixed;inset:0;z-index:58;pointer-events:none;overflow:hidden;}',
            '.collab-remote-cursor{position:absolute;left:0;top:0;width:0;height:0;color:#4E79A7;will-change:transform;',
            'filter:drop-shadow(0 2px 3px rgba(0,0,0,.28));transition:opacity .18s ease;}',
            '.collab-remote-cursor svg{position:absolute;left:0;top:0;width:18px;height:22px;display:block;}',
            '.collab-cursor-name{position:absolute;left:12px;top:16px;max-width:150px;overflow:hidden;text-overflow:ellipsis;',
            'white-space:nowrap;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;font-size:11px;font-weight:600;',
            'line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.22);text-shadow:0 1px 2px rgba(0,0,0,.4);}',
            '.collab-readonly-banner{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;',
            'gap:7px;height:32px;padding:0 14px;border-radius:999px;background:color-mix(in srgb, var(--panel) 84%, transparent);',
            'border:1px solid var(--border-2);box-shadow:var(--shadow-sm);color:var(--text-2);font-size:12px;font-weight:600;',
            'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);',
            'backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);pointer-events:none;}',
            '.collab-readonly-banner b{color:var(--text);font-weight:700;}',
            '.collab-readonly-banner svg{width:14px;height:14px;flex:none;}',
            '.collab-toasts{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:4000;display:flex;',
            'flex-direction:column;align-items:center;gap:8px;pointer-events:none;}',
            '.collab-toast{max-width:min(420px,calc(100vw - 40px));padding:9px 14px;border-radius:10px;',
            'background:var(--elevated,#fff);border:1px solid var(--border-2);box-shadow:var(--shadow-lg);color:var(--text);',
            'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);font-size:12px;',
            'line-height:1.5;opacity:0;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease;}',
            '.collab-toast.is-show{opacity:1;transform:translateY(0);}',
            '.collab-toast.is-error{border-color:var(--danger-border,rgba(255,59,48,.32));color:var(--danger-text,#d70015);}',
            /* 协作面板：右上 HUD 下方的紧凑 popover，不铺遮罩 */
            '.collab-panel{position:fixed;z-index:80;display:flex;flex-direction:column;box-sizing:border-box;width:380px;',
            'max-width:calc(100vw - 24px);max-height:min(520px,70vh);background:var(--elevated,#fff);color:var(--text);',
            'border:1px solid var(--border-2);border-radius:16px;box-shadow:var(--shadow-xl);overflow:hidden;',
            'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);font-size:12px;',
            'transform-origin:top right;animation:collab-panel-in .16s var(--ease-apple,cubic-bezier(.25,.1,.25,1));}',
            '.collab-panel[hidden]{display:none;}',
            '@keyframes collab-panel-in{from{opacity:0;transform:translateY(-6px) scale(.985);}to{opacity:1;transform:none;}}',
            '.collab-panel-head{display:flex;align-items:center;gap:9px;padding:12px 12px 10px 14px;border-bottom:1px solid var(--divider);flex:none;}',
            '.collab-panel-icon{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none;background:var(--surface-2);color:var(--text-2);}',
            '.collab-panel-icon svg{width:15px;height:15px;}',
            '.collab-panel-heading{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1;}',
            '.collab-panel-heading h2{margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em;color:var(--text);line-height:1.3;}',
            '.collab-panel-online{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2);white-space:nowrap;}',
            '.collab-panel-online::before{content:"";width:6px;height:6px;border-radius:50%;background:#30d158;box-shadow:0 0 0 2.5px color-mix(in srgb,#30d158 20%,transparent);flex:none;}',
            '.collab-panel-close{width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text-3);',
            'display:grid;place-items:center;cursor:pointer;flex:none;transition:background .14s ease,color .14s ease;}',
            '.collab-panel-close:hover{background:var(--soft);color:var(--text);}',
            '.collab-panel-close svg{width:14px;height:14px;}',
            '.collab-panel-members{padding:6px;overflow-y:auto;overscroll-behavior:contain;flex:1 1 auto;min-height:0;}',
            '.collab-member{display:flex;align-items:center;gap:8px;min-height:44px;padding:5px 6px;border-radius:10px;}',
            '.collab-member:hover{background:var(--soft);}',
            '.collab-member-avatar{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex:none;',
            'font-size:11px;font-weight:700;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,.32);}',
            '.collab-member-name{flex:1;min-width:0;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:500;',
            'color:var(--text);overflow:hidden;white-space:nowrap;}',
            '.collab-member-name>span:first-child{overflow:hidden;text-overflow:ellipsis;}',
            '.collab-member-you{flex:none;padding:1px 5px;border-radius:999px;background:var(--info-bg);color:var(--info-text);',
            'font-size:10px;font-weight:600;line-height:1.4;}',
            '.collab-member-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--text-3);opacity:.45;transition:background .16s ease,opacity .16s ease;}',
            '.collab-member-dot[data-online="1"]{background:#30d158;opacity:1;box-shadow:0 0 0 2px color-mix(in srgb,#30d158 20%,transparent);}',
            '.collab-role-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;flex:none;background:var(--surface-2);border:1px solid var(--border);}',
            '.collab-role-btn{height:22px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--text-2);',
            'font:inherit;font-size:11px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease;}',
            '.collab-role-btn:hover{background:var(--soft);color:var(--text);}',
            '.collab-role-btn.is-active{background:var(--accent);color:var(--accent-text);font-weight:600;}',
            '.collab-role-btn:disabled{cursor:progress;opacity:.6;}',
            '.collab-role-text{flex:none;font-size:11px;color:var(--text-2);white-space:nowrap;padding:0 2px;}',
            '.collab-member-remove{width:24px;height:24px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--text-3);',
            'display:grid;place-items:center;flex:none;cursor:pointer;opacity:.7;transition:background .14s ease,color .14s ease,opacity .14s ease;}',
            '.collab-member-remove:hover{background:var(--danger-bg);color:var(--danger-text);opacity:1;}',
            '.collab-member-remove:disabled{cursor:progress;opacity:.4;}',
            '.collab-member-remove svg{width:12px;height:12px;}',
            '.collab-panel-state{padding:17px 12px;text-align:center;font-size:12px;line-height:1.6;color:var(--text-3);}',
            '.collab-panel-state.is-error{color:var(--danger-text);}',
            '.collab-panel-empty{padding:6px 12px 14px;text-align:center;font-size:11px;line-height:1.6;color:var(--text-3);}',
            '.collab-panel-invite{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--divider);flex:none;}',
            '.collab-panel-invite[hidden]{display:none;}',
            '.collab-invite-input{flex:1;min-width:0;height:30px;padding:0 10px;box-sizing:border-box;border:1px solid transparent;border-radius:8px;',
            'background:var(--surface-2);color:var(--text);font:inherit;font-size:12px;outline:none;-webkit-appearance:none;appearance:none;}',
            '.collab-invite-input::placeholder{color:var(--text-3);opacity:1;}',
            '.collab-invite-input:focus{background:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%);}',
            '.collab-invite-btn{height:30px;padding:0 12px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);',
            'color:var(--accent-text);font:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .14s ease;}',
            '.collab-invite-btn:hover{background:var(--accent-hover);}',
            '.collab-invite-btn:disabled{cursor:progress;opacity:.7;}',
            '.collab-panel-note{margin:0;padding:0 14px 12px;font-size:11px;line-height:1.55;color:var(--text-3);flex:none;}',
            '.collab-panel-close:focus-visible,.collab-role-btn:focus-visible,.collab-member-remove:focus-visible,.collab-invite-btn:focus-visible,',
            '.collab-invite-input:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            'html.theme-dark body .collab-panel .collab-invite-input,html.studio-theme-dark body .collab-panel .collab-invite-input,',
            'body.theme-dark .collab-panel .collab-invite-input,body.studio-theme-dark .collab-panel .collab-invite-input{background-color:var(--surface-2) !important;}',
            'html.theme-dark body .collab-panel .collab-invite-input:focus,html.studio-theme-dark body .collab-panel .collab-invite-input:focus,',
            'body.theme-dark .collab-panel .collab-invite-input:focus,body.studio-theme-dark .collab-panel .collab-invite-input:focus{background-color:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%) !important;}',
            /* 分享弹窗（公开链接）：居中 modal，复用手势面板同一套令牌 */
            '.share-overlay{position:fixed;inset:0;z-index:3900;display:grid;place-items:center;padding:24px;box-sizing:border-box;',
            'background:rgba(0,0,0,.36);-webkit-backdrop-filter:blur(20px) saturate(140%);backdrop-filter:blur(20px) saturate(140%);',
            'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);animation:share-overlay-in .16s ease;}',
            '.share-overlay[hidden]{display:none;}',
            'html.theme-dark body .share-overlay,html.studio-theme-dark body .share-overlay,',
            'body.theme-dark .share-overlay,body.studio-theme-dark .share-overlay{background:rgba(0,0,0,.42);}',
            '@keyframes share-overlay-in{from{opacity:0;}to{opacity:1;}}',
            '@keyframes share-modal-in{from{opacity:0;transform:translateY(8px) scale(.99);}to{opacity:1;transform:none;}}',
            '.share-modal{width:100%;max-width:540px;max-height:min(86vh,720px);display:flex;flex-direction:column;overflow:hidden;',
            'background:var(--elevated,#fff);color:var(--text);border:1px solid var(--border-2);border-radius:16px;box-shadow:var(--shadow-xl);',
            'outline:none;animation:share-modal-in .16s var(--ease-apple,cubic-bezier(.25,.1,.25,1));}',
            '.share-modal-head{display:flex;align-items:flex-start;gap:12px;padding:20px 22px 14px;flex:none;}',
            '.share-modal-heading{flex:1;min-width:0;}',
            '.share-modal-heading h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--text);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.share-modal-sub{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--text-2);}',
            '.share-modal-close{width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text-3);',
            'display:grid;place-items:center;cursor:pointer;flex:none;margin-top:-2px;transition:background .14s ease,color .14s ease;}',
            '.share-modal-close:hover{background:var(--soft);color:var(--text);}',
            '.share-modal-close svg{width:14px;height:14px;}',
            '.share-modal-body{padding:0 22px 16px;overflow-y:auto;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:13px;}',
            /* 输入语言：无描边无阴影，只靠底色调档；聚焦只加深背景 */
            '.share-modal input{border:0 !important;outline:none !important;box-shadow:none !important;background:var(--surface-2);',
            'border-radius:var(--radius-md,8px);color:var(--text);font:inherit;font-size:12px;-webkit-appearance:none;appearance:none;',
            'caret-color:var(--text);transition:background .14s ease;}',
            '.share-modal input:focus,.share-modal input:focus-visible{border:0 !important;outline:none !important;box-shadow:none !important;',
            'background:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%);}',
            '.share-link-row{display:flex;align-items:center;gap:8px;}',
            '.share-link-input{flex:1;min-width:0;height:34px;padding:0 12px;box-sizing:border-box;text-overflow:ellipsis;}',
            '.share-link-input::placeholder{color:var(--text-3);opacity:1;}',
            '.share-link-copy{width:34px;height:34px;flex:none;display:grid;place-items:center;border:0;border-radius:var(--radius-md,8px);',
            'background:var(--surface-2);color:var(--text-2);cursor:pointer;transition:background .14s ease,color .14s ease;}',
            '.share-link-copy:hover{background:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%);color:var(--text);}',
            '.share-link-copy:disabled{opacity:.45;cursor:not-allowed;}',
            '.share-link-copy svg{width:15px;height:15px;}',
            '.share-link-hint{margin:-3px 0 0;font-size:11px;line-height:1.55;color:var(--text-3);}',
            '.share-link-hint[hidden]{display:none;}',
            '.share-link-hint.is-error{color:var(--danger-text);}',
            '.share-selects{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
            '.share-field{display:flex;flex-direction:column;gap:5px;min-width:0;position:relative;}',
            '.share-field-label{font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.02em;}',
            /* 下拉也走无框输入语言：靠底色区分，chevron 用伪元素自绘 */
            '.share-select{position:relative;width:100%;height:34px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 30px 0 12px;box-sizing:border-box;',
            'border:0 !important;outline:none !important;box-shadow:none !important;border-radius:var(--radius-md,8px);background:var(--surface-2);color:var(--text);',
            'font:inherit;font-size:12px;cursor:pointer;text-align:left;transition:background .14s ease;}',
            '.share-select span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.share-select::after{content:"";position:absolute;right:13px;top:50%;width:6px;height:6px;',
            'border-right:1.6px solid var(--text-3);border-bottom:1.6px solid var(--text-3);',
            'transform:translateY(-72%) rotate(45deg);pointer-events:none;}',
            '.share-select:hover:not(:disabled){background:color-mix(in srgb,var(--surface-2) 82%,var(--text) 8%);}',
            '.share-select:focus,.share-select:focus-visible{outline:none !important;box-shadow:none !important;background:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%);}',
            '.share-select.is-readonly,.share-select:disabled{opacity:1;cursor:default;color:var(--text-2);background:var(--surface-2);}',
            '.share-expiry{position:relative;}',
            '.share-expiry-menu{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:5;padding:4px;border-radius:10px;background:var(--elevated);',
            'border:1px solid var(--border-2);box-shadow:var(--shadow-lg);}',
            '.share-expiry-menu[hidden]{display:none;}',
            '.share-expiry-option{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;padding:0 9px;border:0;border-radius:7px;',
            'background:transparent;color:var(--text);font:inherit;font-size:12px;text-align:left;cursor:pointer;}',
            '.share-expiry-option:hover{background:var(--soft);}',
            '.share-expiry-option.is-active{color:var(--text);font-weight:600;}',
            '.share-expiry-option svg{width:13px;height:13px;color:var(--info,#0a84ff);}',
            '.share-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;}',
            '.share-switch-text{display:flex;flex-direction:column;gap:2px;min-width:0;}',
            '.share-switch-text b{font-size:12px;font-weight:600;color:var(--text);}',
            '.share-switch-text small{font-size:11px;line-height:1.45;color:var(--text-3);}',
            '.share-switch{position:relative;width:38px;height:22px;flex:none;padding:0;border:0;border-radius:999px;background:var(--surface-2);',
            'box-shadow:inset 0 0 0 1px var(--border-2);cursor:pointer;transition:background .16s ease,box-shadow .16s ease;}',
            '.share-switch span{position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:var(--surface);',
            'box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .16s var(--ease-apple,cubic-bezier(.25,.1,.25,1));}',
            '.share-switch[aria-checked="true"]{background:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);}',
            '.share-switch[aria-checked="true"] span{transform:translateX(16px);background:var(--accent-text);}',
            '.share-switch:disabled{opacity:.55;cursor:default;}',
            '.share-password-row[hidden]{display:none;}',
            '.share-password-input{width:100%;height:34px;padding:0 12px;box-sizing:border-box;}',
            '.share-password-input::placeholder{color:var(--text-3);opacity:1;}',
            '.share-invite{border-top:1px solid var(--divider);padding-top:13px;display:flex;flex-direction:column;gap:8px;}',
            '.share-invite[hidden]{display:none;}',
            '.share-invite-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--text);}',
            '.share-member-count{font-size:11px;font-weight:500;color:var(--text-3);}',
            '.share-invite-form{display:flex;gap:8px;}',
            '.share-invite-input{flex:1;min-width:0;height:34px;padding:0 11px;box-sizing:border-box;}',
            '.share-invite-input::placeholder{color:var(--text-3);opacity:1;}',
            '.share-invite-btn{height:34px;padding:0 14px;border:1px solid var(--accent);border-radius:9px;background:var(--accent);color:var(--accent-text);',
            'font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .14s ease;}',
            '.share-invite-btn:hover{background:var(--accent-hover);}',
            '.share-invite-btn:disabled{opacity:.65;cursor:progress;}',
            '.share-modal-foot{padding:14px 22px 18px;border-top:1px solid var(--divider);flex:none;}',
            '.share-modal-note{margin:0;font-size:11px;line-height:1.6;color:var(--text-3);}',
            '.share-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}',
            '.share-btn{height:34px;padding:0 16px;border-radius:9px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .14s ease,border-color .14s ease;}',
            '.share-btn-ghost{border:1px solid var(--border-2);background:transparent;color:var(--text);}',
            '.share-btn-ghost:hover{background:var(--soft);}',
            '.share-btn-primary{border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);}',
            '.share-btn-primary:hover{background:var(--accent-hover);}',
            '.share-btn:disabled{opacity:.55;cursor:not-allowed;}',
            '.share-modal-close:focus-visible,.share-link-copy:focus-visible,.share-expiry-option:focus-visible,',
            '.share-switch:focus-visible,.share-invite-btn:focus-visible,.share-btn:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            'html.theme-dark body .share-overlay .share-link-input,html.studio-theme-dark body .share-overlay .share-link-input,',
            'body.theme-dark .share-overlay .share-link-input,body.studio-theme-dark .share-overlay .share-link-input,',
            'html.theme-dark body .share-overlay .share-password-input,html.studio-theme-dark body .share-overlay .share-password-input,',
            'body.theme-dark .share-overlay .share-password-input,body.studio-theme-dark .share-overlay .share-password-input,',
            'html.theme-dark body .share-overlay .share-invite-input,html.studio-theme-dark body .share-overlay .share-invite-input,',
            'body.theme-dark .share-overlay .share-invite-input,body.studio-theme-dark .share-overlay .share-invite-input{background-color:var(--surface-2) !important;}',
            'html.theme-dark body .share-overlay .share-link-input:focus,html.studio-theme-dark body .share-overlay .share-link-input:focus,',
            'body.theme-dark .share-overlay .share-link-input:focus,body.studio-theme-dark .share-overlay .share-link-input:focus,',
            'html.theme-dark body .share-overlay .share-password-input:focus,html.studio-theme-dark body .share-overlay .share-password-input:focus,',
            'body.theme-dark .share-overlay .share-password-input:focus,body.studio-theme-dark .share-overlay .share-password-input:focus,',
            'html.theme-dark body .share-overlay .share-invite-input:focus,html.studio-theme-dark body .share-overlay .share-invite-input:focus,',
            'body.theme-dark .share-overlay .share-invite-input:focus,body.studio-theme-dark .share-overlay .share-invite-input:focus',
            '{background-color:color-mix(in srgb,var(--elevated) 90%,var(--text) 10%) !important;}',
            /* 积分胶囊 + popover：无描边，靠底色/投影分层（小弹层用近乎实底） */
            '.collab-credits{display:flex;align-items:center;gap:5px;height:30px;padding:0 10px 0 9px;border:0;border-radius:999px;',
            'background:var(--soft,rgba(0,0,0,.06));color:var(--text);font:600 12px/1 var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);',
            'cursor:pointer;flex:none;white-space:nowrap;transition:background .14s ease,transform .14s ease,color .14s ease;}',
            '.collab-credits:hover{background:var(--soft-2,rgba(0,0,0,.1));transform:translateY(-1px);}',
            '.collab-credits:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            '.collab-credits[aria-expanded="true"]{background:var(--soft-2,rgba(0,0,0,.1));}',
            '.collab-credits[hidden]{display:none;}',
            '.collab-credits>svg{width:14px;height:14px;flex:none;color:var(--text-2);}',
            '.collab-credits-num{font-variant-numeric:tabular-nums;}',
            '.collab-credits.is-empty{color:var(--danger-text,#d70015);}',
            '.collab-credits.is-empty>svg{color:currentColor;}',
            '.collab-credits-pop{position:fixed;z-index:81;width:276px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:13px 13px 10px;border:0;border-radius:16px;',
            'background:rgba(255,255,255,.96);color:var(--text,#1c1c1e);box-shadow:0 20px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.06);',
            'backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);',
            'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif);',
            'transform-origin:top right;animation:collab-credits-in .16s var(--ease-apple,cubic-bezier(.25,.1,.25,1));}',
            '.collab-credits-pop[hidden]{display:none;}',
            'html.theme-dark .collab-credits-pop,html.studio-theme-dark .collab-credits-pop,body.theme-dark .collab-credits-pop,body.studio-theme-dark .collab-credits-pop{background:rgba(24,24,24,.95);color:var(--text,#f5f5f7);}',
            '@keyframes collab-credits-in{from{opacity:0;transform:translateY(-6px) scale(.985);}to{opacity:1;transform:none;}}',
            '.collab-credits-head{display:flex;align-items:center;gap:10px;padding:1px 1px 11px;}',
            '.collab-credits-badge{width:28px;height:28px;flex:none;border-radius:9px;display:grid;place-items:center;background:var(--soft);color:var(--text);}',
            '.collab-credits-badge svg{width:16px;height:16px;}',
            '.collab-credits-figure{display:flex;flex-direction:column;gap:2px;min-width:0;}',
            '.collab-credits-figure b{font-size:20px;font-weight:650;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums;}',
            '.collab-credits-figure span{font-size:11px;color:var(--text-2);}',
            '.collab-credits-more{margin-left:auto;flex:none;font-size:11px;color:var(--text-2);text-decoration:none;padding:4px 7px;border-radius:8px;}',
            '.collab-credits-more:hover{background:var(--soft);color:var(--text);}',
            '.collab-credits-list{display:flex;flex-direction:column;max-height:196px;overflow-y:auto;overscroll-behavior:contain;}',
            '.collab-credits-row{display:flex;align-items:center;gap:10px;padding:5px 1px;font-size:12px;}',
            '.collab-credits-row-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2);}',
            '.collab-credits-row-amt{flex:none;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text);}',
            '.collab-credits-row-amt.up{color:#1f9d55;}',
            '.collab-credits-empty{padding:15px 4px 13px;text-align:center;font-size:12px;color:var(--text-3);}',
            '.collab-credits-foot{display:flex;align-items:center;gap:8px;padding-top:9px;}',
            '.collab-credits-note{flex:1;min-width:0;font-size:11px;color:var(--text-3);}',
            '.collab-credits-close{margin-left:auto;flex:none;height:28px;padding:0 13px;border:0;border-radius:999px;background:var(--soft);color:var(--text);',
            'font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .14s ease;}',
            '.collab-credits-close:hover{background:var(--soft-2,rgba(0,0,0,.1));}',
            '.collab-credits-close:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            '@media (max-width:900px){.collab-member-count{display:none;}.collab-share span{display:none;}.collab-share{padding:0 8px;}}',
            '@media (prefers-reduced-motion:reduce){.collab-status-dot{animation:none !important;}.collab-toast{transition:none;}.collab-panel{animation:none !important;}}'
        ].join('');
        document.head.appendChild(style);
    }

    function toast(message, kind) {
        var text = String(message == null ? '' : message).trim();
        if (!text) return;
        var host = document.getElementById('collab-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'collab-toasts';
            host.className = 'collab-toasts';
            document.body.appendChild(host);
        }
        var el = document.createElement('div');
        el.className = 'collab-toast' + (kind === 'error' ? ' is-error' : '');
        el.textContent = text;
        el.setAttribute('role', 'status');
        host.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('is-show'); });
        setTimeout(function () {
            el.classList.remove('is-show');
            setTimeout(function () { el.remove(); }, 220);
        }, 2600);
    }

    // ---------------------------------------------------------------- 顶部 HUD

    function mountHud() {
        if (hud) return;
        hud = document.createElement('div');
        hud.id = 'collab-hud';
        hud.className = 'collab-hud';
        hud.setAttribute('role', 'group');
        hud.setAttribute('aria-label', '实时协作');
        hud.innerHTML =
            '<div class="collab-avatars" id="collab-avatars" aria-label="在线成员"></div>' +
            '<span class="collab-member-count" id="collab-member-count">0 人</span>' +
            '<button class="collab-share" id="collab-share-btn" type="button" aria-haspopup="dialog" title="分享与成员管理" aria-label="分享与成员管理">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.7l6.8-4.1"/><path d="M8.6 13.3l6.8 4.1"/></svg>' +
            '<span>分享</span></button>' +
            '<button class="collab-credits" id="collab-credits-btn" type="button" hidden aria-haspopup="dialog" aria-expanded="false" title="我的积分" aria-label="我的积分">' +
            CREDITS_ICON + '<span class="collab-credits-num" id="collab-credits-num">–</span></button>' +
            '<span class="collab-status" id="collab-status" data-state="connecting" title="正在连接实时协作…" aria-label="正在连接实时协作…"><span class="collab-status-dot"></span></span>';
        /* 当前画布版把右上角旧按钮整排隐藏了（#canvasTopRight display:none），
           所以只有它真的可见时才挂进去，否则固定悬浮、自己避开右侧的用户胶囊。 */
        var host = document.getElementById('canvasTopRight');
        var hostVisible = false;
        if (host) {
            var style = window.getComputedStyle(host);
            hostVisible = style.display !== 'none' && style.visibility !== 'hidden' && host.offsetWidth > 0;
        }
        if (hostVisible) {
            host.insertBefore(hud, host.firstChild);
        } else {
            hud.classList.add('collab-hud--fixed');
            document.body.appendChild(hud);
        }
        hud.addEventListener('error', function (event) {
            var img = event.target;
            if (!img || img.tagName !== 'IMG') return;
            var box = img.parentNode;
            if (!box || !box.classList) return;
            if (!box.classList.contains('collab-avatar') && !box.classList.contains('collab-member-avatar')) return;
            box.classList.remove('has-image');
            box.textContent = initial(box.getAttribute('data-name')) || '?';
            if (img.parentNode) img.parentNode.removeChild(img);
        }, true);
        avatarsEl = hud.querySelector('#collab-avatars');
        memberCountEl = hud.querySelector('#collab-member-count');
        statusEl = hud.querySelector('#collab-status');
        shareBtn = hud.querySelector('#collab-share-btn');
        avatarsEl.setAttribute('role', 'button');
        avatarsEl.setAttribute('tabindex', '0');
        avatarsEl.setAttribute('aria-haspopup', 'dialog');
        avatarsEl.setAttribute('aria-expanded', 'false');
        avatarsEl.setAttribute('aria-label', '打开协作面板');
        avatarsEl.setAttribute('title', '查看协作成员');
        avatarsEl.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            togglePanel();
        });
        avatarsEl.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            event.preventDefault();
            event.stopPropagation();
            togglePanel();
        });
        shareBtn.setAttribute('aria-expanded', 'false');
        shareBtn.title = '分享画布';
        shareBtn.setAttribute('aria-label', '分享画布');
        shareBtn.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            toggleShareModal();
        });
        creditsBtn = hud.querySelector('#collab-credits-btn');
        creditsNumEl = hud.querySelector('#collab-credits-num');
        if (creditsBtn) {
            creditsBtn.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                toggleCreditsPop();
            });
        }
        document.addEventListener('novai-credits', onCreditsEvent);
        /* credits.js 先于本文件执行，这里补一次初值；之后只靠事件，不额外轮询 */
        applyCredits(window.NOVAI_CREDITS && window.NOVAI_CREDITS.state);
        updateFixedPosition();
        [250, 800, 1600, 3000].forEach(function (delay) { setTimeout(updateFixedPosition, delay); });
        window.addEventListener('resize', updateFixedPosition);
        schedulePillReposition();
    }

    /* 固定模式：贴在右上角用户胶囊左边。胶囊是异步注入的，注入前后各算一次。 */
    function updateFixedPosition() {
        if (!hud || !hud.classList.contains('collab-hud--fixed')) return;
        var right = 12;
        var pill = document.getElementById('nv-user-pill');
        if (pill) {
            var rect = pill.getBoundingClientRect();
            if (rect.width > 0) right = Math.max(12, Math.round(window.innerWidth - rect.left + 8));
        }
        hud.style.right = right + 'px';
        scheduleCreditsPosition();
    }

    function schedulePillReposition() {
        // user-menu.js 只在 resize 时重算右上角胶囊的 right；HUD 宽度变了要通知它躲开
        clearTimeout(schedulePillReposition.timer);
        schedulePillReposition.timer = setTimeout(function () {
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        }, 30);
    }

    // ---------------------------------------------------------------- 积分胶囊（数据来自 window.NOVAI_CREDITS）

    function fmtCredits(value) {
        var api = window.NOVAI_CREDITS;
        if (api && typeof api.format === 'function') return api.format(value);
        var num = Number(value);
        if (!isFinite(num)) return '0';
        var abs = Math.abs(num);
        if (abs > 0 && abs < 0.0001) return (num < 0 ? '-' : '') + '<0.0001';
        var rounded = Math.round(num * 10000) / 10000;
        if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
        return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    }

    function creditsAmount(delta) {
        var num = Number(delta) || 0;
        if (!num) return '0';
        return (num > 0 ? '+' : '−') + fmtCredits(Math.abs(num));
    }

    /* 流水备注：charge 的 note 是后端的 estimate / upstream:* 这类技术标记，不往界面搬 */
    function transactionLabel(tx) {
        var kind = String((tx && tx.kind) || '');
        var note = String((tx && tx.note) || '').trim();
        var technical = !note || /^(estimate|actual_cost|usage_tokens|upstream:)/i.test(note);
        if (kind === 'admin_adjust') return note || '管理员分配';
        if (kind === 'charge') return technical ? '生成扣费' : note;
        if (kind === 'refund') return technical ? '退款' : note;
        return technical ? '积分变动' : note;
    }

    function renderCreditsTransactions(list) {
        if (!creditsPop) return;
        var host = creditsPop.querySelector('#collab-credits-list');
        if (!host) return;
        var items = (list || []).slice(0, 5);
        if (!items.length) {
            host.innerHTML = '<div class="collab-credits-empty">还没有积分记录</div>';
            return;
        }
        host.dataset.ready = '1';
        host.innerHTML = items.map(function (tx) {
            var delta = Number(tx && tx.delta) || 0;
            return '<div class="collab-credits-row">' +
                '<span class="collab-credits-row-note" title="' + esc(transactionLabel(tx)) + '">' + esc(transactionLabel(tx)) + '</span>' +
                '<span class="collab-credits-row-amt' + (delta > 0 ? ' up' : '') + '">' + esc(creditsAmount(delta)) + '</span>' +
                '</div>';
        }).join('');
    }

    function renderCreditsBalance() {
        if (!creditsPop) return;
        var el = creditsPop.querySelector('#collab-credits-balance');
        if (!el) return;
        var value = creditsData ? creditsData.balance : (window.NOVAI_CREDITS && window.NOVAI_CREDITS.balance);
        el.textContent = fmtCredits(value);
    }

    function buildCreditsPop() {
        if (creditsPop) return creditsPop;
        creditsPop = document.createElement('div');
        creditsPop.id = 'collab-credits-pop';
        creditsPop.className = 'collab-credits-pop';
        creditsPop.setAttribute('role', 'dialog');
        creditsPop.setAttribute('aria-label', '我的积分');
        creditsPop.hidden = true;
        creditsPop.innerHTML =
            '<div class="collab-credits-head">' +
            '<span class="collab-credits-badge">' + CREDITS_ICON + '</span>' +
            '<span class="collab-credits-figure"><b id="collab-credits-balance">0</b><span>积分 · 管理员分配</span></span>' +
            '<a class="collab-credits-more" id="collab-credits-more" href="/account">账户</a>' +
            '</div>' +
            '<div class="collab-credits-list" id="collab-credits-list" aria-label="最近积分流水"></div>' +
            '<div class="collab-credits-foot">' +
            '<span class="collab-credits-note">生成时按实际用量扣除</span>' +
            '<button class="collab-credits-close" id="collab-credits-close" type="button">关闭</button>' +
            '</div>';
        document.body.appendChild(creditsPop);
        creditsPop.querySelector('#collab-credits-close').addEventListener('click', function () {
            closeCreditsPop(true);
        });
        return creditsPop;
    }

    function positionCreditsPop() {
        if (!creditsPop || !creditsPopOpen || !creditsBtn) return;
        var rect = creditsBtn.getBoundingClientRect();
        var width = creditsPop.offsetWidth || 276;
        var height = creditsPop.offsetHeight || 220;
        var left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
        var top = rect.bottom + 8;
        if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
        creditsPop.style.left = Math.round(left) + 'px';
        creditsPop.style.top = Math.round(top) + 'px';
    }

    function scheduleCreditsPosition() {
        if (creditsPopOpen) requestAnimationFrame(positionCreditsPop);
    }

    function loadCreditsTransactions() {
        if (!creditsPop) return;
        var host = creditsPop.querySelector('#collab-credits-list');
        if (host && !host.dataset.ready) host.innerHTML = '<div class="collab-credits-empty">加载中…</div>';
        var api = window.NOVAI_CREDITS;
        if (!api || typeof api.transactions !== 'function') {
            renderCreditsTransactions([]);
            return;
        }
        creditsReqToken += 1;
        var token = creditsReqToken;
        api.transactions(5).then(function (data) {
            if (token !== creditsReqToken || !creditsPopOpen) return;
            renderCreditsTransactions((data && data.transactions) || []);
        }).catch(function () {
            if (token === creditsReqToken && creditsPopOpen) renderCreditsTransactions([]);
        });
    }

    function onCreditsPointerDown(event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('#collab-credits-pop') || target.closest('#collab-credits-btn')) return;
        closeCreditsPop(false);
    }

    function onCreditsKeyDown(event) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        event.stopPropagation();
        closeCreditsPop(true);
    }

    function openCreditsPop() {
        buildCreditsPop();
        creditsPopOpen = true;
        creditsPop.hidden = false;
        if (creditsBtn) creditsBtn.setAttribute('aria-expanded', 'true');
        renderCreditsBalance();
        positionCreditsPop();
        loadCreditsTransactions();
        document.addEventListener('pointerdown', onCreditsPointerDown, true);
        document.addEventListener('keydown', onCreditsKeyDown, true);
        window.addEventListener('resize', positionCreditsPop);
    }

    function closeCreditsPop(returnFocus) {
        if (!creditsPop || !creditsPopOpen) return;
        creditsPopOpen = false;
        creditsPop.hidden = true;
        document.removeEventListener('pointerdown', onCreditsPointerDown, true);
        document.removeEventListener('keydown', onCreditsKeyDown, true);
        window.removeEventListener('resize', positionCreditsPop);
        if (creditsBtn) {
            creditsBtn.setAttribute('aria-expanded', 'false');
            if (returnFocus) creditsBtn.focus({ preventScroll: true });
        }
    }

    function toggleCreditsPop() {
        if (creditsPopOpen) closeCreditsPop(false);
        else openCreditsPop();
    }

    function applyCredits(detail) {
        if (!detail || detail.available !== true || detail.enabled === false) {
            creditsData = null;
            if (creditsPopOpen) closeCreditsPop(false);
            if (creditsBtn) creditsBtn.hidden = true;
            return;
        }
        creditsData = detail;
        var text = fmtCredits(detail.balance);
        if (creditsNumEl) creditsNumEl.textContent = text;
        if (creditsBtn) {
            creditsBtn.hidden = false;
            creditsBtn.classList.toggle('is-empty', Number(detail.balance) <= 0);
            creditsBtn.title = '我的积分：' + text;
            creditsBtn.setAttribute('aria-label', '我的积分：' + text);
        }
        renderCreditsBalance();
    }

    function onCreditsEvent(event) {
        applyCredits(event && event.detail ? event.detail : (window.NOVAI_CREDITS && window.NOVAI_CREDITS.state));
    }

    function setStatus(status, title) {
        state.status = status;
        if (!statusEl) return;
        statusEl.dataset.state = status;
        var text = title || STATUS_TITLE[status] || '';
        statusEl.title = text;
        statusEl.setAttribute('aria-label', text);
    }

    function findUser(userId) {
        for (var i = 0; i < state.users.length; i += 1) {
            if (String(state.users[i].id) === String(userId)) return state.users[i];
        }
        return null;
    }

    function avatarHtml(user) {
        var tip = String(user.username || '') + (String(user.id) === String(state.selfId) ? '（你）' : '') + ' · ' + (ROLE_TEXT[user.role] || user.role || '');
        var url = user && user.avatar_url ? String(user.avatar_url) : '';
        var inner = url ? '<img src="' + esc(url) + '" alt="">' : esc(initial(user.username));
        return '<span class="collab-avatar' + (String(user.id) === String(state.selfId) ? ' is-self' : '') + (url ? ' has-image' : '') + '"' +
            ' data-user-id="' + esc(user.id) + '" data-role="' + esc(user.role || '') + '"' +
            ' data-name="' + esc(user.username || '') + '"' +
            ' data-tip="' + esc(tip) + '" title="' + esc(tip) + '"' +
            ' style="background:' + esc(safeColor(user.color)) + '">' + inner + '</span>';
    }

    function renderUsers() {
        if (!avatarsEl) return;
        var users = Array.isArray(state.users) ? state.users : [];
        var shown = users.slice(0, AVATAR_LIMIT);
        var rest = users.slice(AVATAR_LIMIT);
        var html = shown.map(avatarHtml).join('');
        if (rest.length) {
            var names = rest.map(function (user) { return String(user.username || ''); }).join('、');
            html += '<span class="collab-more" data-tip="' + esc(names) + '" title="' + esc(names) + '">+' + rest.length + '</span>';
        }
        avatarsEl.innerHTML = html;
        avatarsEl.setAttribute('aria-label', '打开协作面板 · ' + users.length + ' 人在线');
        if (memberCountEl) {
            memberCountEl.textContent = users.length + ' 人';
            memberCountEl.title = '在线 ' + users.length + ' 人';
        }
        if (hud) hud.dataset.count = String(users.length);
        if (panelOpen) renderPanelMembers();
        schedulePillReposition();
    }

    function announcePresence(nextUsers) {
        if (!state.joined) return;
        var previous = new Map();
        state.users.forEach(function (user) { previous.set(String(user.id), user); });
        var next = new Map();
        (nextUsers || []).forEach(function (user) { next.set(String(user.id), user); });
        next.forEach(function (user, id) {
            if (previous.has(id) || id === String(state.selfId)) return;
            toast(String(user.username || '成员') + ' 加入了协作');
        });
        previous.forEach(function (user, id) {
            if (next.has(id) || id === String(state.selfId)) return;
            toast(String(user.username || '成员') + ' 离开了协作');
            removeRemoteCursor(id);
        });
    }

    // ---------------------------------------------------------------- 只读横幅 / 成员弹窗

    function showReadOnlyBanner(ownerName) {
        var banner = document.getElementById('collab-readonly-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'collab-readonly-banner';
            banner.className = 'collab-readonly-banner';
            banner.setAttribute('role', 'status');
            document.body.appendChild(banner);
        }
        banner.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
            '<span>只读 · 由 <b>' + esc(ownerName || '画布所有者') + '</b> 分享</span>';
    }

    function hideReadOnlyBanner() {
        var banner = document.getElementById('collab-readonly-banner');
        if (banner) banner.remove();
    }

    function applyRole() {
        var viewer = state.role === 'viewer';
        if (bridge && typeof bridge.setReadOnly === 'function') bridge.setReadOnly(viewer);
        if (hud) {
            hud.dataset.role = state.role || '';
            hud.title = '你的协作角色：' + (ROLE_TEXT[state.role] || state.role || '未知');
        }
        if (!viewer) {
            hideReadOnlyBanner();
            return;
        }
        showReadOnlyBanner('画布所有者');
        fetchPermissions().then(function (data) {
            if (state.role !== 'viewer') return;
            var owner = data && data.owner && data.owner.username;
            showReadOnlyBanner(owner || '画布所有者');
        });
    }

    // ---------------------------------------------------------------- 协作面板（右上 HUD 下方紧凑 popover）

    function colorForUser(userId) {
        var id = Math.floor(Number(userId));
        if (!isFinite(id) || id < 0) return PALETTE[0];
        return PALETTE[id % PALETTE.length];
    }

    function isOnline(userId) {
        return Boolean(findUser(userId));
    }

    function canManagePermissions(data) {
        return Boolean(data && (data.my_role === 'owner' || data.my_role === 'admin'));
    }

    function roleLabel(role) {
        if (role === 'owner') return '创建者';
        if (role === 'admin') return '管理员';
        if (role === 'editor') return '可编辑';
        return '仅查看';
    }

    function apiErrorText(status, body) {
        var detail = body && typeof body.detail === 'string' ? body.detail : '';
        if (detail) return detail;
        if (status === 404) return '用户不存在';
        if (status === 409) return '该用户已在成员列表中';
        if (status === 403) return '没有权限执行这个操作';
        if (status === 401) return '登录状态已过期';
        return '操作失败，请稍后重试';
    }

    function apiRequest(url, options) {
        var opts = options || {};
        opts.credentials = 'same-origin';
        opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
        return fetch(url, opts).then(function (response) {
            return response.text().then(function (text) {
                var body = {};
                try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {}; }
                if (response.ok) return body;
                var error = new Error(apiErrorText(response.status, body));
                error.status = response.status;
                throw error;
            });
        }, function () {
            throw new Error('网络异常，请检查连接后重试');
        });
    }

    function buildPanel() {
        if (panelEl) return panelEl;
        panelEl = document.createElement('div');
        panelEl.id = 'collab-panel';
        panelEl.className = 'collab-panel';
        panelEl.hidden = true;
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-labelledby', 'collab-panel-title');
        panelEl.setAttribute('tabindex', '-1');
        panelEl.innerHTML =
            '<div class="collab-panel-head">' +
            '<span class="collab-panel-icon" aria-hidden="true">' + USERS_ICON + '</span>' +
            '<div class="collab-panel-heading"><h2 id="collab-panel-title">协作</h2>' +
            '<span class="collab-panel-online" id="collab-panel-online" aria-live="polite">0 人在线</span></div>' +
            '<button class="collab-panel-close" type="button" title="关闭" aria-label="关闭协作面板">' + CLOSE_ICON + '</button>' +
            '</div>' +
            '<div class="collab-panel-members" id="collab-panel-members" role="list"></div>' +
            '<form class="collab-panel-invite" id="collab-panel-invite" hidden>' +
            '<input class="collab-invite-input" type="text" placeholder="输入用户名邀请" autocomplete="off" maxlength="32" aria-label="输入用户名邀请">' +
            '<button class="collab-invite-btn" type="submit">邀请</button>' +
            '</form>' +
            '<p class="collab-panel-note">仅创建者可修改角色与移除成员；每张画布上限 10 人。</p>';
        panelEl.querySelector('.collab-panel-close').addEventListener('click', function () { closePanel(true); });
        panelEl.querySelector('#collab-panel-invite').addEventListener('submit', onInviteSubmit);
        panelEl.querySelector('#collab-panel-members').addEventListener('click', onMemberListClick);
        document.body.appendChild(panelEl);
        return panelEl;
    }

    function memberRowHtml(member, canManage) {
        var online = isOnline(member.id);
        var self = String(member.id) === String(state.selfId);
        var presence = findUser(member.id);
        var color = safeColor(presence && presence.color ? presence.color : colorForUser(member.id));
        var roleCell;
        if (member.role === 'owner') {
            roleCell = '<span class="collab-role-text">创建者</span>';
        } else if (canManage) {
            roleCell = '<div class="collab-role-seg" role="group" aria-label="' + esc(member.name) + ' 的角色"' +
                ' data-uid="' + esc(member.id) + '" data-current="' + esc(member.role) + '">' +
                '<button type="button" class="collab-role-btn' + (member.role === 'editor' ? ' is-active' : '') + '"' +
                ' data-role="editor" aria-pressed="' + (member.role === 'editor' ? 'true' : 'false') + '">可编辑</button>' +
                '<button type="button" class="collab-role-btn' + (member.role === 'viewer' ? ' is-active' : '') + '"' +
                ' data-role="viewer" aria-pressed="' + (member.role === 'viewer' ? 'true' : 'false') + '">仅查看</button>' +
                '</div>';
        } else {
            roleCell = '<span class="collab-role-text">' + esc(roleLabel(member.role)) + '</span>';
        }
        var removeCell = (canManage && member.role !== 'owner')
            ? '<button class="collab-member-remove" type="button" data-uid="' + esc(member.id) + '"' +
              ' data-name="' + esc(member.name) + '" title="移除 ' + esc(member.name) + '" aria-label="移除 ' + esc(member.name) + '">' +
              REMOVE_ICON + '</button>'
            : '';
        var memberAvatarUrl = member.avatar_url ? String(member.avatar_url) : '';
        return '<div class="collab-member" role="listitem" data-uid="' + esc(member.id) + '" data-role="' + esc(member.role) + '">' +
            '<span class="collab-member-avatar' + (memberAvatarUrl ? ' has-image' : '') + '"' +
            ' data-name="' + esc(member.name) + '"' +
            ' style="background:' + esc(color) + ';color:' + esc(textColorOn(color)) + '">' +
            (memberAvatarUrl ? '<img src="' + esc(memberAvatarUrl) + '" alt="">' : esc(initial(member.name))) + '</span>' +
            '<span class="collab-member-name" title="' + esc(member.name) + '"><span>' + esc(member.name) + '</span>' +
            (self ? '<span class="collab-member-you">你</span>' : '') + '</span>' +
            '<span class="collab-member-dot" data-online="' + (online ? '1' : '0') + '"' +
            ' title="' + (online ? '在线' : '离线') + '" aria-label="' + (online ? '在线' : '离线') + '"></span>' +
            roleCell + removeCell + '</div>';
    }

    function memberRows(data) {
        var rows = [];
        if (!data) return rows;
        var owner = data.owner || {};
        var ownerId = owner.id == null || owner.id === '' ? '' : String(owner.id);
        if (ownerId) {
            rows.push(memberRowHtml({ id: ownerId, name: owner.username || '创建者', role: 'owner' }, canManagePermissions(data)));
        }
        var members = Array.isArray(data.members) ? data.members : [];
        members.forEach(function (member) {
            if (ownerId && String(member.user_id) === ownerId) return;
            rows.push(memberRowHtml({
                id: String(member.user_id),
                name: member.username || ('用户 #' + member.user_id),
                role: member.role === 'editor' ? 'editor' : 'viewer'
            }, canManagePermissions(data)));
        });
        return rows;
    }

    function renderPanelMembers() {
        if (!panelEl) return;
        var list = panelEl.querySelector('#collab-panel-members');
        var onlineEl = panelEl.querySelector('#collab-panel-online');
        var onlineCount = (state.users || []).length;
        if (onlineEl) onlineEl.textContent = onlineCount + ' 人在线';
        var data = panelData;
        var memberCount = data && Array.isArray(data.members) ? data.members.length : 0;
        if (list) {
            if (!data) {
                list.innerHTML = '<div class="collab-panel-state">正在读取协作成员…</div>';
            } else {
                var rows = memberRows(data);
                list.innerHTML = rows.join('') +
                    (memberCount === 0 ? '<div class="collab-panel-empty">目前只有你在画布上，邀请成员一起协作</div>' : '');
            }
        }
        var invite = panelEl.querySelector('#collab-panel-invite');
        if (invite) invite.hidden = !(data && canManagePermissions(data));
        schedulePanelPosition();
    }

    function applyPanelData(data) {
        if (!data) return;
        panelData = data;
        permissionsCache = data;
        renderPanelMembers();
    }

    function renderPanelError(message) {
        if (!panelEl) return;
        var list = panelEl.querySelector('#collab-panel-members');
        if (list) list.innerHTML = '<div class="collab-panel-state is-error">' + esc(message || '协作成员读取失败') + '</div>';
        var invite = panelEl.querySelector('#collab-panel-invite');
        if (invite) invite.hidden = true;
        schedulePanelPosition();
    }

    function loadPanelData() {
        panelData = null;
        renderPanelMembers();
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/permissions').then(function (data) {
            if (!panelOpen) return;
            applyPanelData(data);
        }, function (error) {
            if (!panelOpen) return;
            renderPanelError(error && error.message);
        });
    }

    function onMemberListClick(event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var roleBtn = target.closest('.collab-role-btn');
        if (roleBtn) { changeMemberRole(roleBtn); return; }
        var removeBtn = target.closest('.collab-member-remove');
        if (removeBtn) { removeMember(removeBtn); }
    }

    function changeMemberRole(button) {
        var group = button.closest('.collab-role-seg');
        if (!group || group.dataset.busy === '1') return;
        var role = button.dataset.role;
        var previous = group.dataset.current;
        if (!role || role === previous) return;
        group.dataset.busy = '1';
        group.querySelectorAll('.collab-role-btn').forEach(function (btn) { btn.disabled = true; });
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/members/' + encodeURIComponent(group.dataset.uid), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: role })
        }).then(function (body) {
            applyPanelData(body && body.permissions);
            toast('角色已更新为' + roleLabel(role));
        }, function (error) {
            delete group.dataset.busy;
            group.querySelectorAll('.collab-role-btn').forEach(function (btn) { btn.disabled = false; });
            toast(error && error.message || '修改角色失败', 'error');
        });
    }

    function removeMember(button) {
        var userId = button.dataset.uid;
        var name = button.dataset.name || '成员';
        if (!userId) return;
        button.disabled = true;
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/members/' + encodeURIComponent(userId), { method: 'DELETE' })
            .then(function (body) {
                applyPanelData(body && body.permissions);
                toast('已移除 ' + name);
            }, function (error) {
                button.disabled = false;
                toast(error && error.message || '移除失败', 'error');
            });
    }

    function onInviteSubmit(event) {
        event.preventDefault();
        var form = event.currentTarget;
        var input = form.querySelector('.collab-invite-input');
        var button = form.querySelector('.collab-invite-btn');
        var username = String(input && input.value || '').trim();
        if (!username) {
            toast('请输入用户名', 'error');
            if (input) input.focus();
            return;
        }
        if (button) button.disabled = true;
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, role: 'viewer' })
        }).then(function (body) {
            if (button) button.disabled = false;
            if (input) {
                input.value = '';
                input.focus();
            }
            applyPanelData(body && body.permissions);
            toast('已邀请 ' + username + '（仅查看）');
        }, function (error) {
            if (button) button.disabled = false;
            toast(error && error.message || '邀请失败', 'error');
        });
    }

    function positionPanel() {
        if (!panelEl || !panelOpen) return;
        var hudRect = hud && hud.getBoundingClientRect ? hud.getBoundingClientRect() : null;
        var width = panelEl.offsetWidth || PANEL_MIN_WIDTH;
        var height = panelEl.offsetHeight || 0;
        var maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
        /* 右边缘对齐右上 HUD（用户胶囊 / 分享所在的整条），再夹进视口，弹层永远不被裁切 */
        var anchorRight = hudRect && hudRect.width ? hudRect.right : window.innerWidth - PANEL_MARGIN;
        var left = Math.max(PANEL_MARGIN, Math.min(anchorRight - width, maxLeft));
        var top = (hudRect && hudRect.height ? hudRect.bottom : PANEL_MARGIN) + PANEL_GAP;
        var maxTop = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
        top = Math.max(PANEL_MARGIN, Math.min(top, maxTop));
        panelEl.style.left = Math.round(left) + 'px';
        panelEl.style.top = Math.round(top) + 'px';
    }

    function schedulePanelPosition() {
        if (!panelOpen) return;
        if (schedulePanelPosition.pending) return;
        schedulePanelPosition.pending = true;
        requestAnimationFrame(function () {
            schedulePanelPosition.pending = false;
            positionPanel();
        });
    }

    function updateTriggerState(open) {
        if (avatarsEl) avatarsEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (hud) hud.classList.toggle('is-panel-open', Boolean(open));
    }

    function onDocumentPointerDown(event) {
        var target = event.target;
        if (!target || !target.closest) { closePanel(false); return; }
        if (target.closest('#collab-panel') || target.closest('#collab-avatars') || target.closest('#collab-share-btn')) return;
        closePanel(false);
    }

    function onDocumentKeyDown(event) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
    }

    function openPanel() {
        if (!enabled || panelOpen) return;
        closeShareModal(false);
        panelOpen = true;
        buildPanel();
        panelEl.hidden = false;
        panelEl.classList.add('is-open');
        document.addEventListener('pointerdown', onDocumentPointerDown, true);
        document.addEventListener('keydown', onDocumentKeyDown, true);
        window.addEventListener('resize', positionPanel);
        window.addEventListener('scroll', positionPanel, true);
        updateTriggerState(true);
        positionPanel();
        loadPanelData();
    }

    function closePanel(returnFocus) {
        if (!panelOpen) return;
        panelOpen = false;
        document.removeEventListener('pointerdown', onDocumentPointerDown, true);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
        window.removeEventListener('resize', positionPanel);
        window.removeEventListener('scroll', positionPanel, true);
        if (panelEl) {
            panelEl.classList.remove('is-open');
            panelEl.hidden = true;
        }
        updateTriggerState(false);
        if (returnFocus && avatarsEl && avatarsEl.focus) avatarsEl.focus({ preventScroll: true });
    }

    function togglePanel() {
        if (panelOpen) closePanel(false);
        else openPanel();
    }

    // ---------------------------------------------------------------- 分享弹窗（公开链接）

    function canvasTitle() {
        var meta = bridge && typeof bridge.getCanvas === 'function' ? bridge.getCanvas() : null;
        return String((meta && meta.title) || document.title || '未命名画布');
    }

    function absoluteLink(url) {
        var value = String(url || '');
        if (!value) return '';
        try { return new URL(value, location.origin).href; } catch (e) { return value; }
    }

    function expiryLabel(days) {
        var value = Number(days);
        for (var i = 0; i < EXPIRY_OPTIONS.length; i += 1) {
            if (EXPIRY_OPTIONS[i].days === value) return EXPIRY_OPTIONS[i].label;
        }
        return '7 天有效';
    }

    function currentExpiryDays() {
        return shareLink ? Number(shareLink.expires_in_days) || 0 : 7;
    }

    function legacyCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        area.remove();
        if (!ok) throw new Error('copy failed');
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
        }
        return Promise.resolve().then(function () { return legacyCopy(text); });
    }

    function buildShareModal() {
        if (shareModalEl) return shareModalEl;
        shareOverlayEl = document.createElement('div');
        shareOverlayEl.id = 'share-overlay';
        shareOverlayEl.className = 'share-overlay';
        shareOverlayEl.hidden = true;
        shareOverlayEl.innerHTML =
            '<div class="share-modal" id="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-modal-title" tabindex="-1">' +
            '<div class="share-modal-head"><div class="share-modal-heading">' +
            '<h2 id="share-modal-title">分享</h2>' +
            '<p class="share-modal-sub">持有链接并登录后可以加入画布。创建者可随时修改权限或关闭链接。</p></div>' +
            '<button class="share-modal-close" type="button" aria-label="关闭分享" title="关闭">' + CLOSE_ICON + '</button></div>' +
            '<div class="share-modal-body">' +
            '<div class="share-link-row"><input class="share-link-input" type="text" readonly spellcheck="false" aria-label="分享链接" placeholder="正在创建链接…">' +
            '<button class="share-link-copy" type="button" title="复制链接" aria-label="复制链接">' + COPY_ICON + '</button></div>' +
            '<p class="share-link-hint" hidden></p>' +
            '<div class="share-selects">' +
            '<div class="share-field"><span class="share-field-label">权限</span>' +
            '<button class="share-select is-readonly" type="button" disabled aria-disabled="true"><span>持链接可查看</span></button></div>' +
            '<div class="share-field share-expiry"><span class="share-field-label">有效期</span>' +
            '<button class="share-select share-expiry-btn" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="share-expiry-label">7 天有效</span></button>' +
            '<div class="share-expiry-menu" role="listbox" aria-label="链接有效期" hidden>' +
            EXPIRY_OPTIONS.map(function (option) {
                return '<button class="share-expiry-option" type="button" role="option" data-days="' + option.days + '" aria-selected="false"><span>' + esc(option.label) + '</span></button>';
            }).join('') +
            '</div></div></div>' +
            '<div class="share-switch-row"><span class="share-switch-text"><b>需要密码访问</b><small>打开链接后需要输入密码</small></span>' +
            '<button class="share-switch share-password-switch" type="button" role="switch" aria-checked="false" aria-label="需要密码访问"><span></span></button></div>' +
            '<div class="share-password-row" hidden><input class="share-password-input" type="password" placeholder="设置访问密码" autocomplete="new-password" aria-label="访问密码"></div>' +
            '<div class="share-switch-row"><span class="share-switch-text"><b>允许克隆该画布</b><small>登录后可复制到自己的画布列表</small></span>' +
            '<button class="share-switch share-clone-switch" type="button" role="switch" aria-checked="false" aria-label="允许克隆该画布"><span></span></button></div>' +
            '<div class="share-invite" id="share-invite"><div class="share-invite-head"><span>邀请成员</span><span class="share-member-count" id="share-member-count">成员 1 / 10</span></div>' +
            '<form class="share-invite-form" id="share-invite-form"><input class="share-invite-input" type="text" placeholder="输入用户名邀请" autocomplete="off" maxlength="32" aria-label="输入用户名邀请">' +
            '<button class="share-invite-btn" type="submit">邀请</button></form></div>' +
            '</div>' +
            '<div class="share-modal-foot"><p class="share-modal-note">仅创建者可修改权限、移除成员和删除画布。当前画布上限 10 人。</p>' +
            '<div class="share-modal-actions"><button class="share-btn share-btn-ghost" data-action="share-close" type="button">关闭</button>' +
            '<button class="share-btn share-btn-primary" data-action="share-copy" type="button">复制链接</button></div></div>' +
            '</div>';
        document.body.appendChild(shareOverlayEl);
        shareModalEl = shareOverlayEl.querySelector('.share-modal');
        shareOverlayEl.addEventListener('click', function (event) {
            if (event.target === shareOverlayEl) { closeShareModal(true); return; }
            if (!event.target.closest || !event.target.closest('.share-expiry')) setExpiryMenu(false);
        });
        shareOverlayEl.querySelector('.share-modal-close').addEventListener('click', function () { closeShareModal(true); });
        shareOverlayEl.querySelector('[data-action="share-close"]').addEventListener('click', function () { closeShareModal(true); });
        shareOverlayEl.querySelector('[data-action="share-copy"]').addEventListener('click', copyShareLink);
        shareOverlayEl.querySelector('.share-link-copy').addEventListener('click', copyShareLink);
        shareOverlayEl.querySelector('.share-expiry-btn').addEventListener('click', function (event) {
            event.stopPropagation();
            if (shareBusy || !shareCanManage || !shareLink) return;
            setExpiryMenu(!shareExpiryOpen);
        });
        shareOverlayEl.querySelectorAll('.share-expiry-option').forEach(function (button) {
            button.addEventListener('click', function () {
                if (!shareCanManage || !shareLink || shareBusy) return;
                var days = Number(button.dataset.days);
                setExpiryMenu(false);
                if (days === currentExpiryDays()) return;
                saveShareConfig({ expires_in_days: days }, undefined, '有效期已更新为' + expiryLabel(days));
            });
        });
        shareOverlayEl.querySelector('.share-password-switch').addEventListener('click', onPasswordSwitch);
        var passwordInput = shareOverlayEl.querySelector('.share-password-input');
        passwordInput.addEventListener('input', function () { sharePasswordTouched = true; });
        passwordInput.addEventListener('blur', function () { submitPasswordDraft(true); });
        passwordInput.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submitPasswordDraft(false);
        });
        shareOverlayEl.querySelector('.share-clone-switch').addEventListener('click', function () {
            if (!shareCanManage || !shareLink || shareBusy) return;
            var next = !shareLink.allow_clone;
            saveShareConfig({ allow_clone: next }, undefined, next ? '已允许克隆该画布' : '已关闭克隆');
        });
        shareOverlayEl.querySelector('#share-invite-form').addEventListener('submit', onShareInviteSubmit);
        return shareModalEl;
    }

    function setExpiryMenu(open) {
        shareExpiryOpen = Boolean(open);
        if (!shareModalEl) return;
        var menu = shareModalEl.querySelector('.share-expiry-menu');
        var button = shareModalEl.querySelector('.share-expiry-btn');
        if (menu) menu.hidden = !shareExpiryOpen;
        if (button) button.setAttribute('aria-expanded', shareExpiryOpen ? 'true' : 'false');
    }

    function renderShareModal() {
        if (!shareModalEl) return;
        var can = shareCanManage;
        var busy = shareBusy;
        var link = shareLink;
        var hasLink = Boolean(link);
        var titleEl = shareModalEl.querySelector('#share-modal-title');
        if (titleEl) titleEl.textContent = '分享「' + canvasTitle() + '」';
        var linkInput = shareModalEl.querySelector('.share-link-input');
        if (linkInput) {
            linkInput.value = link ? absoluteLink(link.url) : (shareLinkLoaded ? '链接尚未创建' : '');
            linkInput.placeholder = !shareLinkLoaded ? '正在创建链接…' : (shareLinkError ? '链接不可用' : '链接尚未创建');
        }
        var copyButtons = shareModalEl.querySelectorAll('.share-link-copy, [data-action="share-copy"]');
        copyButtons.forEach(function (button) { button.disabled = !hasLink; });
        var hintEl = shareModalEl.querySelector('.share-link-hint');
        var hint = '';
        if (shareLinkError) hint = shareLinkError;
        else if (!can) hint = '只有创建者或管理员可以修改链接配置；你可以复制链接。';
        else if (busy) hint = '正在保存…';
        if (hintEl) {
            hintEl.hidden = !hint;
            hintEl.textContent = hint;
            hintEl.classList.toggle('is-error', Boolean(shareLinkError));
        }
        var expiryLabelEl = shareModalEl.querySelector('.share-expiry-label');
        if (expiryLabelEl) expiryLabelEl.textContent = expiryLabel(link ? link.expires_in_days : 7);
        var expiryButton = shareModalEl.querySelector('.share-expiry-btn');
        if (expiryButton) expiryButton.disabled = !can || !hasLink || busy;
        shareModalEl.querySelectorAll('.share-expiry-option').forEach(function (button) {
            var active = Boolean(link) && Number(button.dataset.days) === Number(link.expires_in_days);
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
            var mark = button.querySelector('svg');
            if (active && !mark) button.insertAdjacentHTML('beforeend', CHECK_ICON);
            else if (!active && mark) mark.remove();
        });
        var passwordOpen = Boolean((link && link.has_password) || sharePasswordOpen);
        var passwordSwitch = shareModalEl.querySelector('.share-password-switch');
        if (passwordSwitch) {
            passwordSwitch.setAttribute('aria-checked', passwordOpen ? 'true' : 'false');
            passwordSwitch.disabled = !can || !hasLink || busy;
        }
        var passwordRow = shareModalEl.querySelector('.share-password-row');
        if (passwordRow) passwordRow.hidden = !passwordOpen;
        var passwordInput = shareModalEl.querySelector('.share-password-input');
        if (passwordInput) {
            passwordInput.placeholder = link && link.has_password ? '已设置密码，输入新密码可替换' : '设置访问密码';
        }
        var cloneSwitch = shareModalEl.querySelector('.share-clone-switch');
        if (cloneSwitch) {
            cloneSwitch.setAttribute('aria-checked', link && link.allow_clone ? 'true' : 'false');
            cloneSwitch.disabled = !can || !hasLink || busy;
        }
        var invite = shareModalEl.querySelector('#share-invite');
        if (invite) invite.hidden = !can;
        var countEl = shareModalEl.querySelector('#share-member-count');
        if (countEl) countEl.textContent = '成员 ' + shareMemberCount + ' / 10';
        shareModalEl.classList.toggle('is-readonly', !can);
        if (shareExpiryOpen && (!can || !hasLink)) setExpiryMenu(false);
    }

    function maybeCreateShareLink() {
        if (!shareModalOpen || !shareCanManage || shareBusy || !shareLinkLoaded || shareLink) return;
        shareBusy = true;
        renderShareModal();
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expires_in_days: 7, password: null, allow_clone: false, role: 'viewer' })
        }).then(function (body) {
            if (!shareModalOpen) return;
            shareBusy = false;
            shareLink = body && body.link ? body.link : null;
            shareLinkError = shareLink ? '' : '链接创建失败，请稍后重试';
            renderShareModal();
        }, function (error) {
            if (!shareModalOpen) return;
            shareBusy = false;
            shareLinkError = error && error.message || '链接创建失败';
            renderShareModal();
            toast(shareLinkError, 'error');
        });
    }

    function loadShareModal() {
        shareLink = null;
        shareLinkLoaded = false;
        shareLinkError = '';
        shareCanManage = false;
        shareMemberCount = 0;
        shareBusy = true;
        sharePasswordOpen = false;
        sharePasswordTouched = false;
        setExpiryMenu(false);
        renderShareModal();
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/permissions').then(function (data) {
            if (!shareModalOpen) return;
            shareCanManage = canManagePermissions(data);
            shareMemberCount = ((data && data.owner && data.owner.id != null) ? 1 : 0) + (Array.isArray(data && data.members) ? data.members.length : 0);
            renderShareModal();
            maybeCreateShareLink();
        }, function () { /* 权限拿不到时保持只读，链接仍可复制 */ });
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link').then(function (body) {
            if (!shareModalOpen) return;
            shareLinkLoaded = true;
            shareBusy = false;
            shareLink = body && body.link ? body.link : null;
            if (!shareLink || !shareLink.has_password) shareKnownPassword = '';
            renderShareModal();
            maybeCreateShareLink();
        }, function (error) {
            if (!shareModalOpen) return;
            shareLinkLoaded = true;
            shareBusy = false;
            shareLinkError = error && error.status === 403
                ? '分享链接仅创建者或管理员可见'
                : (error && error.message || '分享链接读取失败，请稍后重试');
            renderShareModal();
        });
    }

    function saveShareConfig(changes, password, successToast) {
        if (!shareCanManage || !shareLink || shareBusy) return Promise.resolve(false);
        var hadPassword = Boolean(shareLink.has_password);
        /* 后端的 POST 是整份配置覆盖：password=null 会清空密码。所以能拿到旧密码时就带上，
           只改有效期/克隆开关不会把已设密码弄丢；拿不到（刷新后重开）才会丢，并在结果里明确提示。 */
        var passwordToSend = password !== undefined
            ? password
            : (hadPassword && shareKnownPassword ? shareKnownPassword : null);
        var payload = {
            expires_in_days: changes.expires_in_days != null ? changes.expires_in_days : currentExpiryDays(),
            allow_clone: changes.allow_clone != null ? changes.allow_clone : Boolean(shareLink.allow_clone),
            role: 'viewer',
            password: passwordToSend
        };
        shareBusy = true;
        renderShareModal();
        return apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/share-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (body) {
            shareBusy = false;
            shareLink = body && body.link ? body.link : shareLink;
            sharePasswordOpen = false;
            sharePasswordTouched = false;
            if (passwordToSend) shareKnownPassword = String(passwordToSend);
            if (!shareLink || !shareLink.has_password) shareKnownPassword = '';
            var input = shareModalEl.querySelector('.share-password-input');
            if (input) input.value = '';
            renderShareModal();
            if (password === undefined && hadPassword && !shareKnownPassword && !(shareLink && shareLink.has_password)) {
                toast('原访问密码已清除，如需保护请重新设置', 'error');
            } else if (successToast) {
                toast(successToast);
            }
            return true;
        }, function (error) {
            shareBusy = false;
            renderShareModal();
            toast(error && error.message || '保存失败，请稍后重试', 'error');
            return false;
        });
    }

    function onPasswordSwitch() {
        if (!shareCanManage || !shareLink || shareBusy) return;
        if (shareLink.has_password || sharePasswordOpen) {
            sharePasswordOpen = false;
            saveShareConfig({}, null, '已关闭密码访问');
            return;
        }
        sharePasswordOpen = true;
        sharePasswordTouched = false;
        renderShareModal();
        var input = shareModalEl.querySelector('.share-password-input');
        if (input) { input.value = ''; input.focus(); }
    }

    /* fromBlur=true 时，只是打开输入框还没输入就失焦（比如点了一下别处）不报错；
       回车或点复制才算明确要提交，才提示「请输入访问密码」。 */
    function submitPasswordDraft(fromBlur) {
        if (!sharePasswordOpen || !shareCanManage || shareBusy) return;
        var input = shareModalEl.querySelector('.share-password-input');
        var value = input ? input.value : '';
        if (!value) {
            if (shareLink && shareLink.has_password) return;
            if (fromBlur && !sharePasswordTouched) return;
            sharePasswordOpen = false;
            sharePasswordTouched = false;
            renderShareModal();
            toast('请输入访问密码', 'error');
            return;
        }
        if (value.length < 4) {
            toast('密码至少 4 位', 'error');
            return;
        }
        saveShareConfig({}, value, '已设置访问密码');
    }

    function copyShareLink() {
        if (!shareLink) {
            toast('链接尚未创建', 'error');
            return;
        }
        var passwordInput = shareModalEl && shareModalEl.querySelector('.share-password-input');
        var passwordRow = shareModalEl && shareModalEl.querySelector('.share-password-row');
        if (passwordRow && !passwordRow.hidden && passwordInput && !passwordInput.value && !(shareLink.has_password)) {
            passwordInput.focus();
            toast('请输入访问密码', 'error');
            return;
        }
        copyText(absoluteLink(shareLink.url)).then(function () {
            toast('链接已复制');
        }, function () {
            toast('复制失败，请手动选择链接', 'error');
        });
    }

    function onShareInviteSubmit(event) {
        event.preventDefault();
        var form = event.currentTarget;
        var input = form.querySelector('.share-invite-input');
        var button = form.querySelector('.share-invite-btn');
        var username = String(input && input.value || '').trim();
        if (!username) {
            toast('请输入用户名', 'error');
            if (input) input.focus();
            return;
        }
        if (button) button.disabled = true;
        apiRequest('/api/canvases/' + encodeURIComponent(canvasId) + '/members', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, role: 'viewer' })
        }).then(function (body) {
            if (button) button.disabled = false;
            if (input) { input.value = ''; input.focus(); }
            var data = body && body.permissions;
            if (data) {
                shareMemberCount = ((data.owner && data.owner.id != null) ? 1 : 0) + (Array.isArray(data.members) ? data.members.length : 0);
                permissionsCache = data;
            }
            renderShareModal();
            toast('已邀请 ' + username + '（仅查看）');
        }, function (error) {
            if (button) button.disabled = false;
            toast(error && error.message || '邀请失败，请稍后重试', 'error');
        });
    }

    function onShareModalKeyDown(event) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return;
        event.preventDefault();
        event.stopPropagation();
        if (shareExpiryOpen) { setExpiryMenu(false); return; }
        closeShareModal(true);
    }

    function openShareModal() {
        if (!enabled || shareModalOpen) return;
        closePanel(false);
        buildShareModal();
        shareModalOpen = true;
        shareOverlayEl.hidden = false;
        if (shareBtn) shareBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', onShareModalKeyDown, true);
        loadShareModal();
        requestAnimationFrame(function () {
            if (shareModalEl) shareModalEl.focus({ preventScroll: true });
        });
    }

    function closeShareModal(returnFocus) {
        if (!shareModalOpen) return;
        shareModalOpen = false;
        shareExpiryOpen = false;
        sharePasswordOpen = false;
        document.removeEventListener('keydown', onShareModalKeyDown, true);
        if (shareOverlayEl) shareOverlayEl.hidden = true;
        if (shareBtn) {
            shareBtn.setAttribute('aria-expanded', 'false');
            if (returnFocus) shareBtn.focus({ preventScroll: true });
        }
    }

    function toggleShareModal() {
        if (shareModalOpen) closeShareModal(false);
        else openShareModal();
    }

    function openShare() {
        openShareModal();
    }

    // ---------------------------------------------------------------- 远端光标

    function ensureCursorLayer() {
        if (cursorLayer) return cursorLayer;
        cursorLayer = document.createElement('div');
        cursorLayer.className = 'collab-cursor-layer';
        cursorLayer.setAttribute('aria-hidden', 'true');
        document.body.appendChild(cursorLayer);
        return cursorLayer;
    }

    function cursorAnimationTick() {
        cursorRaf = 0;
        if (!remoteCursors.size) return;
        var viewport = bridge.getViewport ? bridge.getViewport() : { x: 0, y: 0, scale: 1 };
        var shell = document.getElementById('shell');
        var rect = shell ? shell.getBoundingClientRect() : { left: 0, top: 0 };
        var now = Date.now();
        remoteCursors.forEach(function (entry, id) {
            if (now - entry.seenAt > 15000) { removeRemoteCursor(id); return; }
            var px = rect.left + Number(viewport.x || 0) + entry.x * Number(viewport.scale || 1);
            var py = rect.top + Number(viewport.y || 0) + entry.y * Number(viewport.scale || 1);
            entry.el.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
        });
        cursorRaf = requestAnimationFrame(cursorAnimationTick);
    }

    function ensureCursorLoop() {
        if (!cursorRaf) cursorRaf = requestAnimationFrame(cursorAnimationTick);
    }

    function upsertRemoteCursor(userId, x, y) {
        if (String(userId) === String(state.selfId)) return;
        var user = findUser(userId);
        if (!user) return;
        var entry = remoteCursors.get(String(userId));
        if (!entry) {
            var el = document.createElement('div');
            el.className = 'collab-remote-cursor';
            el.dataset.userId = String(userId);
            el.style.color = safeColor(user.color);
            el.innerHTML = '<svg viewBox="0 0 18 22" aria-hidden="true"><path d="M1 1l15 9-6.2 1.7L13.2 20 9.6 21.5 6 12.8 1 18V1z" fill="currentColor" stroke="rgba(255,255,255,.9)" stroke-width="1.1" stroke-linejoin="round"/></svg>' +
                '<span class="collab-cursor-name"><span></span></span>';
            entry = { el: el, x: 0, y: 0, seenAt: Date.now() };
            var nameBox = el.querySelector('.collab-cursor-name');
            if (nameBox) {
                nameBox.style.background = safeColor(user.color);
                nameBox.style.color = textColorOn(user.color);
            }
            var nameEl = el.querySelector('.collab-cursor-name span');
            if (nameEl) nameEl.textContent = String(user.username || '');
            ensureCursorLayer().appendChild(el);
            remoteCursors.set(String(userId), entry);
        }
        entry.x = Number(x) || 0;
        entry.y = Number(y) || 0;
        entry.seenAt = Date.now();
        entry.el.style.opacity = '1';
        ensureCursorLoop();
    }

    function removeRemoteCursor(userId) {
        var entry = remoteCursors.get(String(userId));
        if (!entry) return;
        entry.el.style.opacity = '0';
        var el = entry.el;
        setTimeout(function () { el.remove(); }, 220);
        remoteCursors.delete(String(userId));
    }

    function sendCursor(event) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        var now = Date.now();
        if (now - lastCursorSent < CURSOR_THROTTLE_MS) return;
        var target = event.target;
        if (target && target.closest && target.closest('input,textarea,select,[contenteditable="true"]')) return;
        var shell = document.getElementById('shell');
        var rect = shell ? shell.getBoundingClientRect() : { left: 0, top: 0 };
        var viewport = bridge.getViewport ? bridge.getViewport() : { x: 0, y: 0, scale: 1 };
        var scale = Number(viewport.scale) || 1;
        var x = (event.clientX - rect.left - Number(viewport.x || 0)) / scale;
        var y = (event.clientY - rect.top - Number(viewport.y || 0)) / scale;
        if (!isFinite(x) || !isFinite(y)) return;
        lastCursorSent = now;
        state.stats.sentCursors += 1;
        sendRaw({ type: 'cursor', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }

    // ---------------------------------------------------------------- WebSocket

    function wsUrl() {
        var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
        return scheme + location.host + '/ws/canvas/' + encodeURIComponent(canvasId);
    }

    function sendRaw(payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(payload));
            return true;
        } catch (e) {
            return false;
        }
    }

    function startPing() {
        stopPing();
        pingTimer = setInterval(function () {
            sendRaw({ type: 'ping' });
        }, HEARTBEAT_MS);
    }

    function stopPing() {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
    }

    function connect() {
        if (state.terminal) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = 0;
        if (!state.joined) setStatus('connecting');
        else setStatus('reconnecting');
        var socket;
        try {
            socket = new WebSocket(wsUrl());
        } catch (e) {
            scheduleReconnect();
            return;
        }
        ws = socket;
        socket.onopen = function () {
            if (ws !== socket) return;
            reconnectAttempt = 0;
            sendRaw({ type: 'request-snapshot' });
            startPing();
        };
        socket.onmessage = function (event) {
            if (ws !== socket) return;
            var message = null;
            try { message = JSON.parse(event.data); } catch (e) { return; }
            if (!message || typeof message !== 'object') return;
            handleMessage(message);
        };
        socket.onclose = function (event) {
            if (ws !== socket) return;
            ws = null;
            stopPing();
            onSocketClosed(event && event.code);
        };
        socket.onerror = function () { /* 浏览器随后一定会触发 close，统一在 onclose 里收尾 */ };
    }

    function scheduleReconnect() {
        if (state.terminal) return;
        clearTimeout(reconnectTimer);
        reconnectAttempt += 1;
        state.stats.reconnects += 1;
        var delay = Math.min(RECONNECT_MAX_MS, 1000 * Math.pow(2, Math.min(reconnectAttempt - 1, 5)));
        delay += Math.floor(Math.random() * 250);
        setStatus('reconnecting', '连接断开，正在重连（第 ' + reconnectAttempt + ' 次）…');
        reconnectTimer = setTimeout(connect, delay);
    }

    function stopTerminal(code, message) {
        state.terminal = true;
        clearTimeout(reconnectTimer);
        reconnectTimer = 0;
        stopPing();
        setStatus('offline');
        if (terminalToastShown) return;
        terminalToastShown = true;
        if (code === 4401) {
            toast('登录状态已失效，实时协作已断开', 'error');
        } else if (code === 4409) {
            toast(message || '协作房间已满（最多 10 人）', 'error');
        } else {
            toast(message || '没有这个画布的协作权限', 'error');
        }
    }

    function onSocketClosed(code) {
        if (state.terminal) { setStatus('offline'); return; }
        if (code === 4401 || code === 4403 || code === 4409) {
            stopTerminal(code, state.lastError && state.lastError.message);
            return;
        }
        scheduleReconnect();
    }

    function handleMessage(message) {
        switch (message.type) {
            case 'hello':
                handleHello(message);
                break;
            case 'presence':
                handlePresence(Array.isArray(message.users) ? message.users : []);
                break;
            case 'cursor':
                if (String(message.userId) === String(state.selfId)) return;
                upsertRemoteCursor(message.userId, message.x, message.y);
                break;
            case 'snapshot':
                handleSnapshot(message);
                break;
            case 'patch':
                handleRemotePatch(message);
                break;
            case 'error':
                handleError(message);
                break;
            default:
                break;
        }
    }

    function handleHello(message) {
        var wasJoined = state.joined;
        state.self = message.self || null;
        state.selfId = message.self ? String(message.self.id) : null;
        state.role = String(message.role || '');
        state.revision = Number(message.revision) || 0;
        var nextUsers = Array.isArray(message.users) ? message.users.slice() : [];
        if (!wasJoined) state.joined = true;
        announcePresence(nextUsers);
        state.users = nextUsers;
        applyRole();
        renderUsers();
        setStatus('online');
        prevDoc = captureDoc();
    }

    function handlePresence(users) {
        announcePresence(users);
        state.users = users;
        renderUsers();
    }

    function handleSnapshot(message) {
        var doc = message && message.doc;
        state.revision = Number(message.revision) || state.revision;
        if (!doc) return;
        if (!bridge || !bridge.isLoaded || !bridge.isLoaded()) {
            // 页面还在加载：先收着，等沙盘就绪且确实为空时再用（绝不覆盖用户已有内容）
            pendingSnapshot = doc;
            pendingSnapshotTries = 0;
            retryPendingSnapshot();
            return;
        }
        if (!bridge.isEmpty || !bridge.isEmpty()) { pendingSnapshot = null; return; }
        applySnapshotDoc(doc);
    }

    function retryPendingSnapshot() {
        if (!pendingSnapshot || pendingSnapshotTries > 20) { pendingSnapshot = null; return; }
        pendingSnapshotTries += 1;
        setTimeout(function () {
            if (!pendingSnapshot) return;
            if (!bridge || !bridge.isLoaded || !bridge.isLoaded()) { retryPendingSnapshot(); return; }
            var doc = pendingSnapshot;
            pendingSnapshot = null;
            if (!bridge.isEmpty || !bridge.isEmpty()) return;
            applySnapshotDoc(doc);
        }, 200);
    }

    function applySnapshotDoc(doc) {
        suppress = true;
        try {
            bridge.applySnapshot(doc);
        } finally {
            prevDoc = captureDoc();
            suppress = false;
        }
    }

    function handleRemotePatch(message) {
        if (message.from != null && String(message.from) === String(state.selfId)) return;
        state.revision = Number(message.revision) || state.revision;
        state.stats.receivedPatches += 1;
        suppress = true;
        try {
            bridge.applyPatch(message.patch);
        } finally {
            prevDoc = captureDoc();
            suppress = false;
        }
    }

    function handleError(message) {
        state.lastError = message;
        var code = String(message.code || '');
        if (code === 'READ_ONLY') {
            if (state.role === 'viewer') return;
            if (bridge && bridge.setReadOnly) bridge.setReadOnly(true);
            showReadOnlyBanner('画布所有者');
            toast('服务端返回只读权限，本地已切换为只读', 'error');
            return;
        }
        if (code === 'AUTH_REQUIRED' || code === 'FORBIDDEN' || code === 'ROOM_FULL') return; // close 处理统一提示，避免刷屏
        var now = Date.now();
        if (now - handleError.lastToast < 4000) return;
        handleError.lastToast = now;
        toast(message.message || ('协作服务返回错误：' + code), 'error');
    }

    // ---------------------------------------------------------------- 文档同步（LWW）

    function mapById(list) {
        var map = new Map();
        (Array.isArray(list) ? list : []).forEach(function (item) {
            if (item && item.id) map.set(String(item.id), item);
        });
        return map;
    }

    /* 旧画布的连线没有 id（形如 {from,to,kind}），协议里又要求用字符串 id 引用。
       对无 id 连线用「起点->终点::类型」这个稳定键代替：两端各自算出来的键一致，
       增删/改接都能按同一个键对上；有 id 的仍然优先用 id。 */
    function connectionKey(conn) {
        if (!conn) return '';
        if (conn.id != null && conn.id !== '') return String(conn.id);
        return String(conn.from || '') + '->' + String(conn.to || '') + '::' + String(conn.kind || 'flow');
    }

    function mapConnections(list) {
        var map = new Map();
        (Array.isArray(list) ? list : []).forEach(function (item) {
            if (!item) return;
            map.set(connectionKey(item), item);
        });
        return map;
    }

    function captureDoc() {
        if (!bridge || typeof bridge.isLoaded !== 'function' || !bridge.isLoaded()) return null;
        var doc = bridge.getDoc();
        if (!doc) return null;
        return {
            title: String(doc.title || ''),
            nodes: mapById(doc.nodes),
            connections: mapConnections(doc.connections)
        };
    }

    function sameValue(a, b) {
        if (a === b) return true;
        try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
    }

    function diffSection(previous, next) {
        var add = [];
        var remove = [];
        var update = [];
        next.forEach(function (item, id) {
            var old = previous.get(id);
            if (!old) { add.push(item); return; }
            var fields = {};
            var changed = false;
            var keys = {};
            Object.keys(old).forEach(function (key) { keys[key] = true; });
            Object.keys(item).forEach(function (key) { keys[key] = true; });
            Object.keys(keys).forEach(function (key) {
                if (key === 'id') return;
                if (sameValue(old[key], item[key])) return;
                fields[key] = item[key] === undefined ? null : item[key];
                changed = true;
            });
            if (changed) update.push({ id: id, fields: fields });
        });
        previous.forEach(function (item, id) {
            if (!next.has(id)) remove.push(id);
        });
        if (!add.length && !remove.length && !update.length) return null;
        return { add: add, remove: remove, update: update };
    }

    function buildPatch(previous, next) {
        var patch = {};
        if (previous.title !== next.title) patch.title = next.title;
        var nodesPatch = diffSection(previous.nodes, next.nodes);
        if (nodesPatch) patch.nodes = nodesPatch;
        var connectionsPatch = diffSection(previous.connections, next.connections);
        if (connectionsPatch) patch.connections = connectionsPatch;
        return Object.keys(patch).length ? patch : null;
    }

    function flushLocalChanges() {
        if (suppress) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!state.role || state.role === 'viewer') return;
        var next = captureDoc();
        if (!next) return;
        if (!prevDoc) { prevDoc = next; return; }
        var patch = buildPatch(prevDoc, next);
        if (!patch) return;
        if (sendRaw({ type: 'patch', patch: patch })) {
            state.stats.sentPatches += 1;
            prevDoc = next;
        }
    }

    // ---------------------------------------------------------------- 启动

    function start() {
        enabled = true;
        injectStyles();
        mountHud();
        ensureCursorLayer();
        setStatus('connecting');
        renderUsers();
        bridge.notifyReadOnly = function () {
            var now = Date.now();
            if (now - lastReadOnlyToast < 2500) return;
            lastReadOnlyToast = now;
            toast('只读模式：没有编辑权限', 'error');
        };
        window.addEventListener('pointermove', sendCursor, { passive: true });
        // viewer 连「选文件」都不该弹：所有上传入口最终都点 input[type=file]，捕获阶段直接拦掉
        document.addEventListener('click', function (event) {
            var target = event.target;
            if (!target || !target.matches || !target.matches('input[type="file"]')) return;
            if (!bridge.isReadOnly || !bridge.isReadOnly()) return;
            event.preventDefault();
            event.stopPropagation();
            bridge.notifyReadOnly();
        }, true);
        startDocSync();
        connect();
    }

    function startDocSync() {
        if (diffTimer) return;
        diffTimer = setInterval(flushLocalChanges, DIFF_INTERVAL_MS);
    }

    function waitForBridge(attempt) {
        if (window.SmartCanvasCollab && typeof window.SmartCanvasCollab.getDoc === 'function') {
            bridge = window.SmartCanvasCollab;
            start();
            return;
        }
        if (attempt > 150) return; // 页面脚本没起来就安静退出，不注入任何东西
        setTimeout(function () { waitForBridge(attempt + 1); }, 100);
    }

    function exposeForTests() {
        window.NOVAI_COLLAB = {
            get enabled() { return enabled; },
            get canvasId() { return canvasId; },
            get status() { return state.status; },
            get role() { return state.role; },
            get selfId() { return state.selfId; },
            get users() { return state.users.slice(); },
            get stats() { return Object.assign({}, state.stats); },
            get connected() { return Boolean(ws && ws.readyState === WebSocket.OPEN); },
            get panelOpen() { return panelOpen; },
            get panelData() { return panelData; },
            get shareModalOpen() { return shareModalOpen; },
            get shareLink() { return shareLink; },
            openShare: openShare,
            closeShare: function () { closeShareModal(false); closePanel(false); },
            _socket: function () { return ws; }
        };
    }

    function boot() {
        apiJSON('/api/auth/me').then(function (me) {
            if (!me || me.auth_enabled !== true) return;
            exposeForTests();
            waitForBridge(0);
        });
    }

    boot();
})();
