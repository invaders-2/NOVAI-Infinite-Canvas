/* NOVAI 画布权限弹窗（M3）
 *
 * 由 canvas-list.html 的「…」菜单调用：window.NOVAI_CANVAS_PERMS.open(canvas)
 * 数据接口：GET/POST /api/canvases/{id}/permissions|members
 * auth-off 时列表项没有 access_role，入口不会出现，本文件也不会被调用。
 */
(function () {
    'use strict';

    if (window.NOVAI_CANVAS_PERMS) return;

    var esc = function (str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    };
    var ROLE_LABEL = { viewer: '查看者', editor: '可编辑' };
    var MY_ROLE_LABEL = { owner: '所有者', admin: '管理员', editor: '可编辑', viewer: '只读' };
    var escHandler = null;

    function toast(text, isError) {
        var el = document.createElement('div');
        el.className = 'perm-toast' + (isError ? ' error' : '');
        el.textContent = text;
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('show'); });
        setTimeout(function () {
            el.classList.remove('show');
            setTimeout(function () { el.remove(); }, 200);
        }, 2400);
    }

    function close() {
        var overlay = document.querySelector('.perm-overlay');
        if (overlay) overlay.remove();
        if (escHandler) {
            document.removeEventListener('keydown', escHandler, true);
            escHandler = null;
        }
    }

    function roleLabel(role) { return ROLE_LABEL[role] || '查看者'; }

    function setSegRole(group, role) {
        if (!group || !ROLE_LABEL[role]) return;
        group.dataset.current = role;
        group.querySelectorAll('.perm-seg-btn').forEach(function (button) {
            var active = button.dataset.role === role;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function errorText(status, data) {
        var detail = data && typeof data.detail === 'string' ? data.detail : '';
        if (detail) return detail;
        if (status === 404) return '用户不存在';
        if (status === 409) return '该用户已在成员列表中';
        if (status === 403) return '没有权限执行这个操作';
        if (status === 401) return '登录状态已过期';
        return '操作失败，请稍后重试';
    }

    async function request(url, options) {
        var response = await fetch(url, options || {});
        var body = {};
        try { body = await response.json(); } catch (e) { }
        if (!response.ok) {
            var error = new Error(errorText(response.status, body));
            error.status = response.status;
            throw error;
        }
        return body;
    }

    function open(canvas) {
        close();
        var overlay = document.createElement('div');
        overlay.className = 'perm-overlay';
        overlay.innerHTML = '<div class="perm-modal"><div class="perm-loading">正在读取权限…</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) close();
        });
        escHandler = function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', escHandler, true);
        load(overlay, canvas);
    }

    async function load(overlay, canvas) {
        try {
            var data = await request('/api/canvases/' + encodeURIComponent(canvas.id) + '/permissions');
            render(overlay, canvas, data);
        } catch (error) {
            var modal = overlay.querySelector('.perm-modal');
            if (modal) {
                modal.innerHTML = '<div class="perm-error-state">' + esc(error.message || '权限读取失败') + '</div>';
            }
        }
    }

    function render(overlay, canvas, data) {
        var editable = data.my_role === 'owner' || data.my_role === 'admin';
        var members = Array.isArray(data.members) ? data.members : [];
        var ownerName = (data.owner && data.owner.username) || '未归属';
        var rows = members.length ? members.map(function (member) {
            var avatar = esc(String(member.username || '?').slice(0, 1).toUpperCase());
            var name = esc(member.username || ('用户#' + member.user_id));
            if (!editable) {
                return '<div class="perm-member" data-uid="' + member.user_id + '">' +
                    '<span class="perm-avatar">' + avatar + '</span>' +
                    '<span class="perm-name">' + name + '</span>' +
                    '<span class="perm-role-text">' + roleLabel(member.role) + '</span>' +
                    '</div>';
            }
            return '<div class="perm-member" data-uid="' + member.user_id + '">' +
                '<span class="perm-avatar">' + avatar + '</span>' +
                '<span class="perm-name">' + name + '</span>' +
                '<div class="perm-seg perm-role-seg" role="group" aria-label="' + name + ' 的角色" data-uid="' + member.user_id + '" data-current="' + esc(member.role) + '">' +
                '<button type="button" class="perm-seg-btn' + (member.role === 'viewer' ? ' is-active' : '') + '" data-role="viewer" aria-pressed="' + (member.role === 'viewer' ? 'true' : 'false') + '">查看者</button>' +
                '<button type="button" class="perm-seg-btn' + (member.role === 'editor' ? ' is-active' : '') + '" data-role="editor" aria-pressed="' + (member.role === 'editor' ? 'true' : 'false') + '">可编辑</button>' +
                '</div>' +
                '<button class="perm-remove" type="button" data-uid="' + member.user_id + '">移除</button>' +
                '</div>';
        }).join('') : '<div class="perm-empty">还没有共享成员</div>';

        overlay.innerHTML =
            '<div class="perm-modal" role="dialog" aria-modal="true" aria-labelledby="permTitle">' +
            '<div class="perm-head"><div><h2 id="permTitle">画布权限</h2><p>' + esc(canvas.title || '未命名画布') + '</p></div>' +
            '<button class="perm-close" type="button" aria-label="关闭">×</button></div>' +
            '<div class="perm-owner"><span>归属</span><b>' + esc(ownerName) + '</b>' +
            '<span class="perm-chip ' + esc(data.my_role || '') + '">你是 ' + (MY_ROLE_LABEL[data.my_role] || esc(data.my_role || '')) + '</span></div>' +
            '<div class="perm-section-title">成员 <span>' + members.length + '</span></div>' +
            '<div class="perm-members">' + rows + '</div>' +
            (editable
                ? '<form class="perm-add">' +
                    '<input class="perm-add-name" type="text" placeholder="输入用户名" autocomplete="off" maxlength="32" aria-label="要添加的用户名">' +
                    '<div class="perm-seg perm-add-seg" role="group" aria-label="添加成员的角色" data-current="viewer">' +
                    '<button type="button" class="perm-seg-btn is-active" data-role="viewer" aria-pressed="true">查看者</button>' +
                    '<button type="button" class="perm-seg-btn" data-role="editor" aria-pressed="false">可编辑</button>' +
                    '</div>' +
                    '<button class="perm-add-btn" type="submit">添加</button>' +
                  '</form>'
                : '') +
            '<div class="perm-hint">' + (editable
                ? '查看者只能打开画布；可编辑成员还能保存修改。移除后立即失效。'
                : '你可以查看这个画布，但只有所有者或管理员能修改权限。') + '</div>' +
            '</div>';

        var closeBtn = overlay.querySelector('.perm-close');
        if (closeBtn) closeBtn.onclick = close;

        if (!editable) {
            var closeOnly = overlay.querySelector('.perm-close');
            if (closeOnly) closeOnly.focus();
            return;
        }

        var form = overlay.querySelector('.perm-add');
        var input = overlay.querySelector('.perm-add-name');
        var addSeg = overlay.querySelector('.perm-add-seg');
        if (addSeg) {
            addSeg.querySelectorAll('.perm-seg-btn').forEach(function (button) {
                button.addEventListener('click', function () {
                    setSegRole(addSeg, button.dataset.role);
                });
            });
        }
        if (form) {
            form.addEventListener('submit', async function (event) {
                event.preventDefault();
                var username = String(input.value || '').trim();
                if (!username) {
                    toast('请输入用户名', true);
                    input.focus();
                    return;
                }
                try {
                    var body = await request('/api/canvases/' + encodeURIComponent(canvas.id) + '/members', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: username, role: (addSeg && addSeg.dataset.current) || 'viewer' })
                    });
                    toast('已添加成员 ' + username);
                    if (body.permissions) render(overlay, canvas, body.permissions);
                } catch (error) {
                    toast(error.message || '添加失败', true);
                }
            });
        }

        overlay.querySelectorAll('.perm-role-seg').forEach(function (group) {
            group.querySelectorAll('.perm-seg-btn').forEach(function (button) {
                button.addEventListener('click', async function () {
                    var role = button.dataset.role;
                    var previous = group.dataset.current;
                    if (!role || role === previous || group.dataset.busy === '1') return;
                    setSegRole(group, role);
                    group.dataset.busy = '1';
                    group.querySelectorAll('.perm-seg-btn').forEach(function (btn) { btn.disabled = true; });
                    try {
                        var body = await request('/api/canvases/' + encodeURIComponent(canvas.id) + '/members/' + encodeURIComponent(group.dataset.uid), {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role: role })
                        });
                        toast('角色已更新为' + roleLabel(role));
                        if (body.permissions) render(overlay, canvas, body.permissions);
                    } catch (error) {
                        setSegRole(group, previous);
                        toast(error.message || '修改失败', true);
                    } finally {
                        delete group.dataset.busy;
                        group.querySelectorAll('.perm-seg-btn').forEach(function (btn) { btn.disabled = false; });
                    }
                });
            });
        });

        overlay.querySelectorAll('.perm-remove').forEach(function (button) {
            button.addEventListener('click', async function () {
                var row = button.closest('.perm-member');
                var name = row ? (row.querySelector('.perm-name') || {}).textContent : '成员';
                try {
                    var body = await request('/api/canvases/' + encodeURIComponent(canvas.id) + '/members/' + encodeURIComponent(button.dataset.uid), {
                        method: 'DELETE'
                    });
                    toast('已移除 ' + (name || '成员'));
                    if (body.permissions) render(overlay, canvas, body.permissions);
                } catch (error) {
                    toast(error.message || '移除失败', true);
                }
            });
        });

        if (input) input.focus();
    }

    window.NOVAI_CANVAS_PERMS = { open: open, close: close };
})();
