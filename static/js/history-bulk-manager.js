(function(){
    'use strict';

    /* ---------------------------------------------------------------------
     * HistoryBulkManager
     * 历史图片批量管理：进入管理模式后可多选 / 全选 / 批量删除。
     * 5 个生成页面（在线生图 / 文生图 / 细节增强 / 图片编辑 / 角度控制）
     * 共用同一套契约：
     *   - 卡片含 [data-history-ts] 属性 与 id="history-{ts}"
     *   - 卡片 onclick 在 body.history-bulk-selecting 时提前 return
     *   - 删除走 POST /api/history/delete {timestamp}
     * 用法：window.HistoryBulkManager.attach({ masonry:'#masonry' })
     * ------------------------------------------------------------------- */

    var tr = function(key){ return window.NovaUtils ? NovaUtils.tr(key) : (window.StudioI18n ? window.StudioI18n.t(key) : key); };
    function fmt(key, vars){
        let s = tr(key);
        if(vars) Object.keys(vars).forEach(k => { s = s.replace('{' + k + '}', vars[k]); });
        return s;
    }

    function injectStyles(){
        if(document.getElementById('history-bulk-manager-css')) return;
        const style = document.createElement('style');
        style.id = 'history-bulk-manager-css';
        style.textContent = `
            .hbm-toolbar {
                display: flex; align-items: center; gap: 10px;
                margin-bottom: 20px; flex-wrap: wrap;
            }
            .hbm-toolbar .hbm-spacer { flex: 1; }
            .hbm-count {
                font-size: 11px; font-weight: 800; letter-spacing: .05em;
                color: #585858; text-transform: uppercase;
            }
            .hbm-btn {
                display: inline-flex; align-items: center; gap: 6px;
                height: 36px; padding: 0 16px; border-radius: 999px;
                border: 1px solid #d0d0d0; background: #fff; color: #1c1c1c;
                font-size: 11px; font-weight: 800; letter-spacing: .04em;
                text-transform: uppercase; cursor: pointer;
                transition: all .25s cubic-bezier(.4,0,.2,1); white-space: nowrap;
            }
            .hbm-btn:hover { border-color: #1c1c1c; transform: translateY(-1px); }
            .hbm-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
            .hbm-btn.hbm-primary { background: #1c1c1c; color: #fff; border-color: #1c1c1c; }
            .hbm-btn.hbm-danger { background: #dc2626; color: #fff; border-color: #dc2626; }
            .hbm-btn.hbm-danger:hover { background: #b91c1c; border-color: #b91c1c; }
            .hbm-hide { display: none !important; }

            /* 选择模式下的卡片浮层 */
            body.history-bulk-selecting [data-history-ts] {
                position: relative; cursor: pointer !important;
            }
            body.history-bulk-selecting [data-history-ts]::after {
                content: ''; position: absolute; top: 12px; left: 12px;
                width: 26px; height: 26px; border-radius: 50%;
                border: 2px solid #fff; background: rgba(28, 28, 28, .35);
                box-shadow: 0 2px 8px rgba(0,0,0,.25);
                z-index: 30; pointer-events: none;
                display: flex; align-items: center; justify-content: center;
                font-size: 14px; font-weight: 900; color: transparent;
                line-height: 1;
            }
            body.history-bulk-selecting [data-history-ts].hbm-selected::after {
                content: '\\2713'; background: #1c1c1c; border-color: #1c1c1c; color: #fff;
            }
            body.history-bulk-selecting [data-history-ts].hbm-selected {
                outline: 3px solid #1c1c1c; outline-offset: -3px;
            }

            /* 暗色主题 */
            .theme-dark .hbm-btn { background: #1c1c1c; color: #d0d0d0; border-color: rgba(132, 132, 132, .3); }
            .theme-dark .hbm-btn:hover { border-color: #d0d0d0; }
            .theme-dark .hbm-btn.hbm-primary { background: #d0d0d0; color: #1c1c1c; border-color: #d0d0d0; }
            .theme-dark .hbm-count { color: #848484; }
            .theme-dark body.history-bulk-selecting [data-history-ts].hbm-selected,
            body.theme-dark.history-bulk-selecting [data-history-ts].hbm-selected { outline-color: #d0d0d0; }
        `;
        document.head.appendChild(style);
    }

    function attach(opts){
        opts = opts || {};
        const masonrySel = opts.masonry || '#masonry';
        const masonry = document.querySelector(masonrySel);
        if(!masonry) return null;
        if(masonry.dataset.hbmAttached === '1') return masonry._hbm || null;
        masonry.dataset.hbmAttached = '1';

        injectStyles();

        let selecting = false;

        /* -------- 工具条（常驻：全选 / 删除所有 / 导出 / 完成） -------- */
        const bar = document.createElement('div');
        bar.className = 'hbm-toolbar';

        const spacer = document.createElement('div');
        spacer.className = 'hbm-spacer';

        const countEl = document.createElement('span');
        countEl.className = 'hbm-count';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'hbm-btn';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'hbm-btn hbm-danger';
        deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width:14px;height:14px"></i><span></span>';
        const deleteLabel = deleteBtn.querySelector('span');

        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'hbm-btn';
        exportBtn.innerHTML = '<i data-lucide="download" style="width:14px;height:14px"></i><span></span>';
        const exportLabel = exportBtn.querySelector('span');

        const exitBtn = document.createElement('button');
        exitBtn.type = 'button';
        exitBtn.className = 'hbm-btn hbm-primary';

        bar.append(spacer, countEl, selectAllBtn, deleteBtn, exportBtn, exitBtn);
        masonry.parentNode.insertBefore(bar, masonry);

        function cards(){
            return Array.from(masonry.querySelectorAll('[data-history-ts]'));
        }
        function selectedCards(){
            return cards().filter(c => c.classList.contains('hbm-selected'));
        }

        function refreshLabels(){
            const all = cards();
            const sel = selectedCards();
            countEl.textContent = fmt('bulk.selectedCount', { n: sel.length });
            const allSelected = all.length > 0 && sel.length === all.length;
            selectAllBtn.textContent = allSelected ? tr('bulk.deselectAll') : tr('bulk.selectAll');
            deleteLabel.textContent = tr('bulk.deleteAll');
            exportLabel.textContent = tr('bulk.export');
            const has = all.length > 0;
            selectAllBtn.disabled = !has;
            deleteBtn.disabled = !has;
            exportBtn.disabled = !has;
            exitBtn.disabled = !selecting;
            exitBtn.textContent = tr('bulk.exit');
            if(window.lucide && lucide.createIcons) lucide.createIcons();
        }

        function enter(){
            selecting = true;
            document.body.classList.add('history-bulk-selecting');
            refreshLabels();
        }
        function exit(){
            selecting = false;
            document.body.classList.remove('history-bulk-selecting');
            cards().forEach(c => c.classList.remove('hbm-selected'));
            refreshLabels();
        }

        exitBtn.addEventListener('click', () => { if(selecting) exit(); });

        selectAllBtn.addEventListener('click', () => {
            if(!selecting) enter();
            const all = cards();
            const allSelected = all.length > 0 && selectedCards().length === all.length;
            all.forEach(c => c.classList.toggle('hbm-selected', !allSelected));
            refreshLabels();
        });

        /* 选择模式下点击卡片 = 切换选中（捕获阶段拦截，避免触发卡片自身逻辑） */
        masonry.addEventListener('click', (e) => {
            if(!selecting) return;
            const card = e.target.closest('[data-history-ts]');
            if(!card || !masonry.contains(card)) return;
            e.preventDefault();
            e.stopPropagation();
            card.classList.toggle('hbm-selected');
            refreshLabels();
        }, true);

        async function doDeleteAll(){
            const all = cards();
            if(all.length === 0) return;
            if(!confirm(fmt('bulk.deleteAllConfirm', { n: all.length }))) return;

            deleteBtn.disabled = true;
            deleteLabel.textContent = tr('bulk.deleting');

            const results = await Promise.allSettled(all.map(card => {
                const ts = card.dataset.historyTs;
                return fetch('/api/history/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timestamp: ts })
                }).then(r => r.json()).then(res => {
                    if(res && res.success){ card.remove(); return true; }
                    throw new Error('delete failed');
                });
            }));

            const failed = results.filter(r => r.status === 'rejected').length;
            if(failed > 0) alert(failed + ' / ' + all.length + ' ✗');

            refreshLabels();
            if(cards().length === 0){ exit(); }
            else { deleteLabel.textContent = tr('bulk.deleteAll'); }
        }
        deleteBtn.addEventListener('click', doDeleteAll);

        /* 导出：优先导出选中的，未选中时导出全部 */
        async function doExport(){
            const all = cards();
            if(all.length === 0) return;
            const targets = selectedCards().length > 0 ? selectedCards() : all;

            exportBtn.disabled = true;
            const origin = exportLabel.textContent;
            exportLabel.textContent = tr('bulk.exporting');

            let ok = 0;
            for(const card of targets){
                const img = card.querySelector('img');
                if(!img || !img.src) continue;
                try{
                    const res = await fetch(img.src);
                    if(!res.ok) continue;
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const name = (img.src.split('/').pop().split('?')[0]) || ('novai-' + Date.now());
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = name;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 4000);
                    ok++;
                }catch(e){ /* 忽略单张失败 */ }
            }

            exportBtn.disabled = false;
            exportLabel.textContent = origin;
            if(ok === 0) alert(tr('bulk.exportFailed'));
        }
        exportBtn.addEventListener('click', doExport);

        /* 语言切换时刷新文案 */
        window.addEventListener('studio-lang-change', refreshLabels);

        refreshLabels();

        const api = { enter, exit, refresh: refreshLabels, isSelecting: () => selecting };
        masonry._hbm = api;
        return api;
    }

    window.HistoryBulkManager = { attach };
})();
