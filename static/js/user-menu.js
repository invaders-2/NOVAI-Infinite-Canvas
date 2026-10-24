/* NOVAI 用户菜单（C 端）：右上角胶囊 + 我的账户 / 修改密码 / 管理后台 / 退出登录。
 *
 * 设计约束：
 * - 注入式：不改页面结构，auth 关闭（/api/auth/me 没有 auth_enabled:true）时什么都不渲染；
 * - 跟随 marvis 令牌与明暗主题，不引 CDN；
 * - 键盘可用：Esc 关面板/弹窗、Enter 提交、Tab 焦点不跑出弹窗、:focus-visible 有描边；
 * - 右上角已有固定按钮（如 index 的 .stage-actions）时自动向左错开。
 */
(function () {
    'use strict';

    if (window.__novaiUserMenuLoaded) return;
    window.__novaiUserMenuLoaded = true;

    var ROLE_TEXT = { admin: '管理员', team: '团队', user: '普通用户' };
    var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    var user = null;
    var root = null;
    var pill = null;
    var panel = null;
    var modal = null;
    var toastBox = null;
    var closeTimer = null;
    var isOpen = false;
    var isModalOpen = false;
    var openedByHover = false;
    var railMode = false;

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'className') node.className = attrs[key];
            else if (key === 'text') node.textContent = attrs[key];
            else if (key === 'html') node.innerHTML = attrs[key];
            else node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) {
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    }

    function css() {
        return [
            '.nv-um-root{position:fixed;top:12px;right:12px;z-index:2147481000;font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif);color:var(--text,#0a0a0a);-webkit-user-select:none;user-select:none;}',
            '.nv-um-pill{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px 0 4px;border-radius:999px;border:1px solid var(--border-2,rgba(0,0,0,.12));background:var(--surface,#fff);box-shadow:var(--shadow-sm,0 1px 3px rgba(0,0,0,.06));cursor:pointer;color:inherit;font:inherit;font-size:12px;font-weight:500;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease;}',
            '.nv-um-pill:hover{background:var(--surface-2,#fafafa);border-color:var(--border-strong,rgba(0,0,0,.2));}',
            '.nv-um-pill:focus-visible,.nv-um-item:focus-visible,.nv-um-btn:focus-visible,.nv-um-field input:focus-visible{outline:2px solid var(--info,#0a84ff);outline-offset:2px;}',
            '.nv-um-avatar{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--accent,#171717);color:var(--accent-text,#fafafa);font-size:11px;font-weight:600;line-height:1;text-transform:uppercase;flex:none;overflow:hidden;}',
            '.nv-um-avatar img,.nv-um-head-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;}',
            '.nv-um-avatar.has-image,.nv-um-head-avatar.has-image{background:var(--surface-2,#fafafa);}',
            '.nv-um-rail-btn .nv-um-avatar{width:32px;height:32px;font-size:12px;}',
            '.nv-um-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.nv-um-chevron{width:12px;height:12px;color:var(--text-3,#8a8a8a);transition:transform .15s ease;flex:none;}',
            '.nv-um-pill[aria-expanded="true"] .nv-um-chevron{transform:rotate(180deg);}',
            '.nv-um-rail-btn{width:40px;height:40px;padding:0;border:1px solid var(--border-2,rgba(0,0,0,.12));border-radius:50%;background:var(--surface-2,#fafafa);color:var(--text,#0a0a0a);display:grid;place-items:center;font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s ease,border-color .15s ease;}',
            '.nv-um-rail-btn:hover{background:var(--soft,rgba(0,0,0,.04));}',
            '.nv-um-rail-btn[aria-expanded="true"]{background:var(--elevated,#fff);border-color:var(--border-strong,rgba(0,0,0,.2));}',
            '.nv-um-panel.nv-um-panel-rail{position:fixed;left:0;top:0;right:auto;bottom:auto;z-index:2147481000;max-height:calc(100vh - 24px);overflow:auto;}',
            '.nv-um-panel{position:absolute;top:calc(100% + 8px);right:0;min-width:232px;padding:6px;background:var(--surface,#fff);border:1px solid var(--border,rgba(0,0,0,.06));border-radius:12px;box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.08));display:none;animation:nv-um-in .14s cubic-bezier(.25,.1,.25,1);}',
            '.nv-um-panel[data-open="true"]{display:block;}',
            '@keyframes nv-um-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
            '.nv-um-head{display:flex;align-items:center;gap:10px;padding:9px 10px 10px;border-bottom:1px solid var(--divider,rgba(0,0,0,.06));margin-bottom:5px;}',
            '.nv-um-head-avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--accent,#171717);color:var(--accent-text,#fafafa);font-size:12px;font-weight:600;text-transform:uppercase;flex:none;overflow:hidden;}',
            '.nv-um-head-main{min-width:0;flex:1;}',
            '.nv-um-head-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.nv-um-head-role{font-size:11px;color:var(--text-2,#737373);margin-top:3px;}',
            '.nv-um-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;}',
            '.nv-um-item:hover{background:var(--soft,rgba(0,0,0,.04));}',
            '.nv-um-item.nv-um-danger{color:var(--danger-text,#d70015);}',
            '.nv-um-item.nv-um-danger:hover{background:var(--danger-bg,rgba(255,59,48,.12));}',
            '.nv-um-item svg{width:14px;height:14px;flex:none;opacity:.8;}',
            '.nv-um-backdrop{position:fixed;inset:0;z-index:2147481100;display:grid;place-items:center;padding:24px;background:var(--scrim,rgba(0,0,0,.38));}',
            '.nv-um-backdrop[hidden]{display:none;}',
            '.nv-um-modal{width:100%;max-width:372px;background:var(--surface,#fff);border:1px solid var(--border,rgba(0,0,0,.06));border-radius:16px;box-shadow:var(--shadow-xl,0 24px 64px rgba(0,0,0,.12));padding:24px;}',
            '.nv-um-modal h2{margin:0 0 4px;font-size:16px;font-weight:600;letter-spacing:-.01em;}',
            '.nv-um-modal p.nv-um-sub{margin:0 0 16px;font-size:12px;color:var(--text-2,#737373);line-height:1.6;}',
            '.nv-um-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;font-size:11px;color:var(--text-2,#737373);}',
            '.nv-um-field input{height:38px;padding:0 11px;border:1px solid var(--border-2,rgba(0,0,0,.12));border-radius:8px;background:var(--surface-2,#fafafa);color:var(--text,#0a0a0a);font:inherit;font-size:13px;outline:none;}',
            '.nv-um-field input:focus{border-color:var(--border-strong,rgba(0,0,0,.2));box-shadow:0 0 0 3px var(--accent-subtle,rgba(10,10,10,.08));}',
            '.nv-um-error{display:none;margin:0 0 12px;padding:8px 10px;border-radius:7px;background:var(--danger-bg,rgba(255,59,48,.12));border:1px solid var(--danger-border,rgba(255,59,48,.3));color:var(--danger-text,#d70015);font-size:12px;line-height:1.5;}',
            '.nv-um-error[data-show="true"]{display:block;}',
            '.nv-um-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;}',
            '.nv-um-btn{height:34px;padding:0 14px;border-radius:8px;border:1px solid var(--border-2,rgba(0,0,0,.12));background:var(--surface,#fff);color:inherit;font:inherit;font-size:12px;font-weight:500;cursor:pointer;}',
            '.nv-um-btn:hover{background:var(--soft,rgba(0,0,0,.04));}',
            '.nv-um-btn.nv-um-primary{background:var(--accent,#171717);border-color:var(--accent,#171717);color:var(--accent-text,#fafafa);}',
            '.nv-um-btn.nv-um-primary:hover{background:var(--accent-hover,#2b2b2b);}',
            '.nv-um-btn:disabled{opacity:.55;cursor:not-allowed;}',
            '.nv-um-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,8px);z-index:2147481200;max-width:min(420px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;background:var(--elevated,#fff);border:1px solid var(--border-2,rgba(0,0,0,.12));box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.08));color:var(--text,#0a0a0a);font-size:12px;opacity:0;pointer-events:none;transition:opacity .15s ease,transform .15s ease;}',
            '.nv-um-toast[data-show="true"]{opacity:1;transform:translate(-50%,0);}',
            '@media (prefers-reduced-motion:reduce){.nv-um-panel,.nv-um-toast{animation:none;transition:none;}}'
        ].join('\n');
    }

    function injectStyles() {
        if (document.getElementById('nv-user-menu-style')) return;
        var style = el('style', { id: 'nv-user-menu-style', type: 'text/css', text: css() });
        document.head.appendChild(style);
    }

    var ICONS = {
        key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M17 6l3 3"/></svg>',
        user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c.9-3.4 3.9-5.5 7.5-5.5s6.6 2.1 7.5 5.5"/></svg>',
        shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/></svg>',
        logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
        chevron: '<svg class="nv-um-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5 8 10.5l4-4"/></svg>'
    };

    function initial(name) {
        return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
    }

    /* 头像节点：me.avatar_url 有就显示图片，图片挂了回退首字（不抛错） */
    function avatarNode(className, user) {
        var url = user && user.avatar_url ? String(user.avatar_url) : '';
        var box = el('span', { className: className + (url ? ' has-image' : '') });
        if (url) {
            var img = el('img', { src: url, alt: '' });
            img.addEventListener('error', function () {
                box.classList.remove('has-image');
                box.textContent = initial(user && user.username);
                if (img.parentNode) img.parentNode.removeChild(img);
            });
            box.appendChild(img);
        } else {
            box.textContent = initial(user && user.username);
        }
        return box;
    }

    function build() {
        var rail = document.getElementById('canvasRail');
        var settings = document.getElementById('canvasRailSettings');
        railMode = !!(rail && settings);
        if (railMode) {
            pill = el('button', {
                id: 'nv-user-rail-pill',
                className: 'canvas-rail-btn nv-um-rail-btn',
                type: 'button',
                'aria-haspopup': 'menu',
                'aria-expanded': 'false',
                'aria-controls': 'nv-user-panel',
                'aria-label': '账户菜单：' + user.username,
                title: user.username + ' · ' + (ROLE_TEXT[user.role] || user.role)
            }, []);
            pill.appendChild(avatarNode('nv-um-avatar', user));
            rail.insertBefore(pill, settings);
        } else {
            var avatar = avatarNode('nv-um-avatar', user);
            var name = el('span', { className: 'nv-um-name', text: user.username });
            pill = el('button', {
                id: 'nv-user-pill',
                className: 'nv-um-pill',
                type: 'button',
                'aria-haspopup': 'menu',
                'aria-expanded': 'false',
                'aria-controls': 'nv-user-panel',
                title: user.username + ' · ' + (ROLE_TEXT[user.role] || user.role)
            }, [avatar, name]);
            pill.insertAdjacentHTML('beforeend', ICONS.chevron);
        }

        var head = el('div', { className: 'nv-um-head' }, [
            avatarNode('nv-um-head-avatar', user),
            el('div', { className: 'nv-um-head-main' }, [
                el('div', { className: 'nv-um-head-name', text: user.username }),
                el('div', { className: 'nv-um-head-role', text: ROLE_TEXT[user.role] || user.role || '普通用户' })
            ])
        ]);

        var accountItem = el('button', { className: 'nv-um-item', type: 'button', role: 'menuitem', 'data-action': 'account' });
        accountItem.innerHTML = ICONS.user + '<span>我的账户</span>';

        var passwordItem = el('button', { className: 'nv-um-item', type: 'button', role: 'menuitem', 'data-action': 'password' });
        passwordItem.innerHTML = ICONS.key + '<span>修改密码</span>';

        var items = [accountItem, passwordItem];
        if (user.role === 'admin') {
            var adminItem = el('button', { className: 'nv-um-item', type: 'button', role: 'menuitem', 'data-action': 'admin' });
            adminItem.innerHTML = ICONS.shield + '<span>管理后台</span>';
            items.push(adminItem);
        }
        var logoutItem = el('button', { className: 'nv-um-item nv-um-danger', type: 'button', role: 'menuitem', 'data-action': 'logout' });
        logoutItem.innerHTML = ICONS.logout + '<span>退出登录</span>';
        items.push(logoutItem);

        panel = el('div', {
            id: 'nv-user-panel',
            className: 'nv-um-panel' + (railMode ? ' nv-um-panel-rail' : ''),
            role: 'menu',
            'data-open': 'false',
            'aria-label': '用户菜单'
        }, [head].concat(items));
        if (railMode) {
            root = panel;
            return panel;
        }
        root = el('div', { className: 'nv-um-root' }, [pill, panel]);
        return root;
    }

    function positionRailPanel() {
        if (!railMode || !panel || !pill) return;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        var rect = pill.getBoundingClientRect();
        var width = panel.offsetWidth;
        var height = panel.offsetHeight;
        var left = Math.min(rect.right + 10, window.innerWidth - width - 12);
        var top = Math.min(Math.max(12, rect.top), window.innerHeight - height - 12);
        panel.style.left = Math.max(12, Math.round(left)) + 'px';
        panel.style.top = Math.max(12, Math.round(top)) + 'px';
    }

    function openPanel(byHover) {
        if (!root || isModalOpen) return;
        clearTimeout(closeTimer);
        if (!isOpen) openedByHover = !!byHover;
        isOpen = true;
        panel.setAttribute('data-open', 'true');
        pill.setAttribute('aria-expanded', 'true');
        if (railMode) positionRailPanel();
    }

    function closePanel(restoreFocus) {
        if (!root) return;
        isOpen = false;
        panel.setAttribute('data-open', 'false');
        pill.setAttribute('aria-expanded', 'false');
        if (restoreFocus) pill.focus();
    }

    function scheduleClose() {
        if (isModalOpen) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { closePanel(false); }, 260);
    }

    function buildModal() {
        var error = el('div', { className: 'nv-um-error', role: 'alert', 'data-show': 'false' });
        var oldInput = el('input', { id: 'nv-um-old', type: 'password', autocomplete: 'current-password', placeholder: '当前密码', maxlength: '128' });
        var newInput = el('input', { id: 'nv-um-new', type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位', maxlength: '128' });
        var confirmInput = el('input', { id: 'nv-um-confirm', type: 'password', autocomplete: 'new-password', placeholder: '再输入一次', maxlength: '128' });
        var submit = el('button', { className: 'nv-um-btn nv-um-primary', type: 'submit', text: '保存新密码' });
        var cancel = el('button', { className: 'nv-um-btn', type: 'button', 'data-action': 'close-modal', text: '取消' });
        var form = el('form', { id: 'nv-um-form', novalidate: 'novalidate' }, [
            el('label', { className: 'nv-um-field' }, [el('span', { text: '旧密码' }), oldInput]),
            el('label', { className: 'nv-um-field' }, [el('span', { text: '新密码' }), newInput]),
            el('label', { className: 'nv-um-field' }, [el('span', { text: '确认新密码' }), confirmInput]),
            error,
            el('div', { className: 'nv-um-actions' }, [cancel, submit])
        ]);
        var card = el('div', { className: 'nv-um-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'nv-um-title' }, [
            el('h2', { id: 'nv-um-title', text: '修改密码' }),
            el('p', { className: 'nv-um-sub', text: '修改成功后，当前设备保持登录，其它设备需要重新登录。' }),
            form
        ]);
        modal = el('div', { className: 'nv-um-backdrop', hidden: 'hidden' }, [card]);
        return { backdrop: modal, form: form, oldInput: oldInput, newInput: newInput, confirmInput: confirmInput, error: error, submit: submit };
    }

    function showError(message) {
        modal.error.textContent = message;
        modal.error.setAttribute('data-show', 'true');
    }

    function clearError() {
        modal.error.textContent = '';
        modal.error.setAttribute('data-show', 'false');
    }

    function openModal() {
        if (!modal) return;
        closePanel(false);
        isModalOpen = true;
        clearError();
        modal.form.reset();
        modal.backdrop.hidden = false;
        // 同步聚焦：定时器会让“打开后焦点是否进入弹窗”的验收/辅助技术拿不到焦点
        modal.oldInput.focus();
        if (document.activeElement !== modal.oldInput) {
            setTimeout(function () { modal.oldInput.focus(); }, 0);
        }
    }

    function closeModal(restoreFocus) {
        if (!modal) return;
        isModalOpen = false;
        modal.backdrop.hidden = true;
        clearError();
        modal.submit.disabled = false;
        modal.submit.textContent = '保存新密码';
        if (restoreFocus !== false && pill) pill.focus();
    }

    function toast(message, isError) {
        if (!toastBox) {
            toastBox = el('div', { className: 'nv-um-toast', role: 'status', 'aria-live': 'polite' });
            document.body.appendChild(toastBox);
        }
        toastBox.textContent = message;
        toastBox.style.borderColor = isError ? 'var(--danger-border, rgba(255,59,48,.3))' : '';
        toastBox.style.color = isError ? 'var(--danger-text, #d70015)' : '';
        toastBox.setAttribute('data-show', 'true');
        clearTimeout(toastBox.__timer);
        toastBox.__timer = setTimeout(function () { toastBox.setAttribute('data-show', 'false'); }, 3200);
    }

    function messageFor(error) {
        var code = error && error.code;
        if (code === 'bad_credentials') return '旧密码不正确';
        if (code === 'invalid_password' || code === 'weak_password') return '新密码需为 8-128 个字符';
        if (code === 'unauthorized') return '登录状态已过期，请重新登录';
        if (code === 'rate_limited') return (error.detail && String(error.detail)) || '操作太频繁，请稍后再试';
        return (error && error.detail && String(error.detail)) || '修改失败，请稍后重试';
    }

    function submitPassword(event) {
        event.preventDefault();
        clearError();
        var oldValue = modal.oldInput.value;
        var newValue = modal.newInput.value;
        var confirmValue = modal.confirmInput.value;
        if (!oldValue || !newValue) {
            showError('请填写旧密码和新密码');
            return;
        }
        if (newValue.length < 8 || newValue.length > 128) {
            showError('新密码需为 8-128 个字符');
            return;
        }
        if (newValue !== confirmValue) {
            showError('两次输入的新密码不一致');
            return;
        }
        modal.submit.disabled = true;
        modal.submit.textContent = '保存中…';
        fetch('/api/auth/password', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ old_password: oldValue, new_password: newValue })
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok) {
                    var error = new Error('change failed');
                    error.code = data && data.code;
                    error.detail = data && data.detail;
                    throw error;
                }
                return data;
            });
        }).then(function () {
            closeModal();
            toast('密码已修改，其它设备已退出');
        }).catch(function (error) {
            showError(messageFor(error));
            modal.submit.disabled = false;
            modal.submit.textContent = '保存新密码';
        });
    }

    function logout() {
        if (pill) pill.disabled = true;
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .catch(function () { })
            .then(function () { location.replace('/login'); });
    }

    function trapTab(event) {
        if (!isModalOpen) return;
        var nodes = modal.card.querySelectorAll(FOCUSABLE);
        if (!nodes.length) return;
        var first = nodes[0];
        var last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function avoidOverlap() {
        if (!root) return;
        var offset = 12;
        var selectors = ['.stage-actions', '.canvas-topbar-right', '#canvasTopRight', '.smart-top-right', '.top-actions'];
        for (var i = 0; i < selectors.length; i += 1) {
            var node = document.querySelector(selectors[i]);
            if (!node) continue;
            var rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top < 80 && rect.right > window.innerWidth * 0.6) {
                offset = Math.max(offset, Math.round(window.innerWidth - rect.left + 8));
                break;
            }
        }
        root.style.right = offset + 'px';
    }

    function bind() {
        pill.addEventListener('click', function (event) {
            event.stopPropagation();
            if (isOpen && !openedByHover) {
                closePanel(false);
            } else {
                openPanel(false);
                openedByHover = false;
            }
        });
        if (!railMode) {
            root.addEventListener('mouseenter', function () { openPanel(true); });
            root.addEventListener('mouseleave', scheduleClose);
        }
        panel.addEventListener('click', function (event) {
            var action = event.target.closest('[data-action]');
            if (!action) return;
            var name = action.getAttribute('data-action');
            if (name === 'account') location.assign('/account');
            else if (name === 'password') openModal();
            else if (name === 'admin') window.open('/admin', '_blank', 'noopener');
            else if (name === 'logout') logout();
        });

        var parts = buildModal();
        modal = parts;
        modal.card = modal.backdrop.firstChild;
        document.body.appendChild(modal.backdrop);
        modal.form.addEventListener('submit', submitPassword);
        modal.backdrop.addEventListener('click', function (event) {
            if (event.target === modal.backdrop) closeModal();
        });
        modal.card.addEventListener('click', function (event) {
            var action = event.target.closest('[data-action="close-modal"]');
            if (action) closeModal();
        });

        document.addEventListener('click', function (event) {
            if (!root || isModalOpen) return;
            if (!root.contains(event.target) && !(railMode && pill.contains(event.target))) closePanel(false);
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                if (isModalOpen) {
                    event.preventDefault();
                    closeModal();
                } else if (isOpen) {
                    event.preventDefault();
                    closePanel(true);
                }
                return;
            }
            if (event.key === 'Tab') trapTab(event);
        });
        window.addEventListener('resize', function () {
            if (railMode) {
                if (isOpen) positionRailPanel();
            } else {
                avoidOverlap();
            }
        });
    }

    fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (response) { return response.json().catch(function () { return {}; }); })
        .then(function (data) {
            if (!data || data.auth_enabled !== true || !data.username) return;
            user = data;
            injectStyles();
            document.body.appendChild(build());
            bind();
            if (!railMode) avoidOverlap();
        })
        .catch(function () { /* auth 探测失败就静默：不渲染，不影响页面 */ });
})();
