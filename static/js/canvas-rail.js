/* 画布页新版悬浮布局的交互胶水（只做控件编排，不改画布/节点逻辑）。
   - 左上胶囊：点开小菜单（重命名 / 返回画布列表），重命名复用 #smartTitle 的既有就地编辑，返回走 window.backToCanvasList；
   - 左侧竖栏：不复制 id，按钮点击后触发右上角/底部已有的按钮（事件仍由 smart-canvas.js 绑定），
     「+」走 window.openCreateMenu（与双击菜单同一个入口）；
   - 齿轮：打开应用设置（navigate api-settings），画布主题跟随应用主题。 */
(function(){
    'use strict';

    function byId(id){
        return document.getElementById(id);
    }

    function fire(targetId){
        const el = byId(targetId);
        if(!el) return;
        if(typeof el.click === 'function') el.click();
    }

    /* ── 左上胶囊菜单 ── */
    (function bindCanvasPill(){
        const pill = byId('canvasPill');
        const menu = byId('canvasPillMenu');
        if(!pill || !menu) return;
        const chevron = byId('canvasPillMenuBtn');
        const setOpen = open => {
            menu.hidden = !open;
            pill.classList.toggle('is-open', open);
            if(chevron) chevron.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        const isOpen = () => !menu.hidden;
        pill.addEventListener('click', event => {
            if(event.target.closest('#canvasPillMenu')) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(!isOpen());
        });
        menu.addEventListener('click', event => {
            const item = event.target.closest('[data-pill-action]');
            if(!item) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            const action = item.dataset.pillAction;
            if(action === 'back'){
                if(typeof window.backToCanvasList === 'function') window.backToCanvasList();
                return;
            }
            if(action === 'rename'){
                const title = byId('smartTitle');
                if(title && typeof title.click === 'function') title.click();
            }
        });
        document.addEventListener('click', event => {
            if(!isOpen()) return;
            if(pill.contains(event.target)) return;
            setOpen(false);
        });
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && isOpen()) setOpen(false);
        });
    })();

    /* ── 左侧竖栏：全部转发到现有按钮，保持原事件绑定 ── */
    (function bindCanvasRail(){
        const actions = {
            canvasRailCreate(){
                const btn = byId('canvasRailCreate');
                if(typeof window.openCreateMenu !== 'function' || !btn) return;
                const rect = btn.getBoundingClientRect();
                window.openCreateMenu({ clientX: rect.right + 12, clientY: rect.top + 12 });
            },
            canvasRailSource(){ fire('sourceBrowserToggle'); },
            canvasRailAssets(){ fire('assetToggle'); },
            canvasRailWorkflow(){
                const panel = byId('smartWorkflowTransferModal');
                if(panel && panel.classList.contains('open')){
                    if(typeof window.closeSmartWorkflowTransferModal === 'function') window.closeSmartWorkflowTransferModal();
                    return;
                }
                fire('smartWorkflowToggle');
            },
            canvasRailLog(){
                const panel = byId('smartLogModal');
                if(panel && panel.classList.contains('open')){
                    if(typeof window.closeSmartCanvasLog === 'function') window.closeSmartCanvasLog();
                    return;
                }
                fire('smartLogToggle');
            },
            canvasRailChat(){ fire('chatToggleBtn'); },
            canvasRailHistory(){ fire('versionHistoryBtn'); },
            canvasRailTemplates(){
                const panel = byId('canvasTemplatesPanel');
                if(panel && !panel.hidden){
                    if(typeof window.toggleCanvasTemplatesPanel === 'function') window.toggleCanvasTemplatesPanel();
                    else panel.hidden = true;
                    return;
                }
                if(typeof window.toggleCanvasTemplatesPanel === 'function') window.toggleCanvasTemplatesPanel({ placement: 'left' });
            },
            canvasRailSettings(){
                /* 打开应用设置：外壳监听 navigate → api-settings（不是页面时打开设置弹窗） */
                const payload = { type: 'navigate', route: 'api-settings' };
                try {
                    if(window.parent && window.parent !== window){
                        window.parent.postMessage(payload, '*');
                        return;
                    }
                } catch(_) {}
                try {
                    const api = window.pywebview && window.pywebview.api;
                    if(api && typeof api.navigate === 'function'){ api.navigate('api-settings'); return; }
                } catch(_) {}
                console.info('[source-browser] 设置入口：外壳未接入 navigate，postMessage 已发出', payload);
            }
        };
        Object.keys(actions).forEach(id => {
            const btn = byId(id);
            if(!btn) return;
            btn.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                actions[id]();
            });
        });
    })();

    /* ── 右侧助手面板：把现有 #chatModal（连同它的消息/输入区）整体搬进面板宿主，
       不动任何 id / onclick；默认折叠，点「对话」圆钮或其它入口打开时自动同步。 ── */
    (function bindAssistantPanel(){
        const panel = byId('canvasAssistantPanel');
        const host = byId('canvasAssistantHost');
        const chat = byId('chatModal');
        const trigger = byId('chatToggleBtn');
        if(!panel || !host || !chat) return;
        chat.removeAttribute('style');
        chat.classList.add('is-docked');
        host.appendChild(chat);
        const sync = () => {
            const open = panel.classList.contains('open');
            document.body.classList.toggle('canvas-assistant-open', open);
            panel.setAttribute('aria-hidden', open ? 'false' : 'true');
            window.dispatchEvent(new Event('resize'));
        };
        const openPanel = () => {
            panel.classList.add('open');
            sync();
            if(!chat.classList.contains('open') && typeof window.toggleChatPanel === 'function') window.toggleChatPanel();
        };
        const closePanel = () => {
            panel.classList.remove('open');
            sync();
        };
        const togglePanel = () => (panel.classList.contains('open') ? closePanel() : openPanel());
        if(trigger){
            /* 捕获阶段截住内联 onclick=toggleChatPanel()，改为展开/收起助手面板 */
            trigger.addEventListener('click', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                togglePanel();
            }, true);
        }
        new MutationObserver(() => {
            if(chat.classList.contains('open')) openPanel();
            else closePanel();
        }).observe(chat, { attributes: true, attributeFilter: ['class'] });
        /* header：左 收起 + 新建对话药丸；右 新对话 / Agent 全屏 / 更多选项 */
        const collapseBtn = byId('canvasAssistantCollapseBtn');
        if(collapseBtn) collapseBtn.addEventListener('click', closePanel);
        const newChat = () => {
            if(typeof window.resetChatConversation === 'function') window.resetChatConversation();
            const input = byId('chatInput');
            if(input) input.focus();
        };
        const newChatPill = byId('canvasAssistantNewChatBtn');
        if(newChatPill) newChatPill.addEventListener('click', newChat);
        const editBtn = byId('canvasAssistantEditBtn');
        if(editBtn) editBtn.addEventListener('click', newChat);
        const expandBtn = byId('canvasAssistantExpandBtn');
        if(expandBtn) expandBtn.addEventListener('click', event => {
            event.preventDefault();
            panel.classList.toggle('is-full');
            expandBtn.classList.toggle('is-on', panel.classList.contains('is-full'));
            sync();
        });
        const moreBtn = byId('canvasAssistantMoreBtn');
        const moreMenu = byId('canvasAssistantMoreMenu');
        const setMoreOpen = open => {
            if(!moreMenu) return;
            moreMenu.hidden = !open;
            if(moreBtn) moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        if(moreBtn) moreBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setMoreOpen(moreMenu ? moreMenu.hidden : false);
        });
        if(moreMenu) moreMenu.addEventListener('click', event => {
            const item = event.target.closest('[data-assistant-action]');
            if(!item) return;
            event.preventDefault();
            event.stopPropagation();
            setMoreOpen(false);
            const action = item.dataset.assistantAction;
            if(action === 'history' && typeof window.toggleAgentHistoryPanel === 'function') window.toggleAgentHistoryPanel();
            else if(action === 'confirm' && typeof window.toggleAgentPlanConfirm === 'function') window.toggleAgentPlanConfirm();
            else if(action === 'reset') newChat();
            else if(action === 'close') closePanel();
            syncPlan();
        });
        document.addEventListener('click', event => {
            if(!moreMenu || moreMenu.hidden) return;
            if(moreBtn && moreBtn.contains(event.target)) return;
            if(moreMenu.contains(event.target)) return;
            setMoreOpen(false);
        });
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && moreMenu && !moreMenu.hidden) setMoreOpen(false);
        });
        /* composer 的「手动确认」开关：状态跟着现有 agentPlanConfirmEnabled 走 */
        const planBtn = byId('canvasAssistantPlanToggle');
        const syncPlan = () => {
            if(!planBtn) return;
            const on = typeof window.agentPlanConfirmEnabled === 'function' ? window.agentPlanConfirmEnabled() : false;
            planBtn.classList.toggle('is-on', on);
            planBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        if(planBtn) planBtn.addEventListener('click', () => {
            if(typeof window.toggleAgentPlanConfirm === 'function') window.toggleAgentPlanConfirm();
            setTimeout(syncPlan, 0);
        });
        syncPlan();
        const chip = byId('canvasAssistantContextChip');
        if(chip) chip.addEventListener('click', () => { const input = byId('chatInput'); if(input) input.focus(); });
        sync();
    })();

    /* ── 右上「更多」下拉：把导出/工作流/快捷键/日志/资产库/定位居中收进菜单，按钮节点仍在（只是隐藏） ── */
    (function bindCanvasMoreMenu(){
        const btn = byId('canvasMoreBtn');
        const menu = byId('canvasMoreMenu');
        if(!btn || !menu) return;
        const setOpen = open => {
            menu.hidden = !open;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            btn.classList.toggle('is-open', open);
        };
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(menu.hidden);
        });
        menu.addEventListener('click', event => {
            const item = event.target.closest('[data-more-action]');
            if(!item) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            const action = item.dataset.moreAction;
            if(action === 'export') fire('smartExportToggle');
            else if(action === 'workflow') fire('smartWorkflowToggle');
            else if(action === 'shortcut' && typeof window.openSmartCanvasShortcuts === 'function') window.openSmartCanvasShortcuts();
            else if(action === 'log' && typeof window.openSmartCanvasLog === 'function') window.openSmartCanvasLog();
            else if(action === 'assets') fire('assetToggle');
            else if(action === 'center' && typeof window.zoomBarCenter === 'function') window.zoomBarCenter();
        });
        document.addEventListener('click', event => {
            if(menu.hidden) return;
            if(btn.contains(event.target) || menu.contains(event.target)) return;
            setOpen(false);
        });
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && !menu.hidden) setOpen(false);
        });
    })();

    /* ── 助手欢迎态：把现有 .chat-welcome 重排成「问候 + 两张建议卡 + 换一批建议」。
       只做静态展示；点卡片把文案填进现有输入框，不新增业务逻辑。 ── */
    (function mountAssistantWelcome(){
        const box = byId('chatMessages');
        if(!box) return;
        const sets = [
            {
                hi: 'Hi 创作者!',
                sub: '今天一起创作点什么？',
                cards: [
                    { icon: 'image-plus', title: '生成一张红色杯子的图', desc: '描述画面，我来生成并放到画布上' },
                    { icon: 'layout-grid', title: '用选中的图做电商主图', desc: '先选画布上的参考图，我来排版生成' }
                ]
            },
            {
                hi: 'Hi 创作者!',
                sub: '今天一起创作点什么？',
                cards: [
                    { icon: 'sparkles', title: '创建提示词节点并连线', desc: '把想法拆成节点，自动连好工作流' },
                    { icon: 'video', title: '生成一张赛博朋克风格的街道图', desc: '描述风格和场景，我来生成画面' }
                ]
            }
        ];
        let round = 0;
        const render = () => {
            const welcome = box.querySelector('.chat-welcome');
            if(!welcome || welcome.dataset.canvasWelcome === 'v2') return;
            welcome.dataset.canvasWelcome = 'v2';
            const set = sets[round % sets.length];
            welcome.innerHTML =
                '<div class="canvas-welcome-head">' +
                    '<p class="canvas-welcome-hi">' + set.hi + '</p>' +
                    '<p class="canvas-welcome-sub">' + set.sub + '</p>' +
                '</div>' +
                '<div class="canvas-welcome-cards">' +
                    set.cards.map((card, index) => (
                        '<button type="button" class="canvas-welcome-card" data-suggest="' + index + '">' +
                            '<span class="canvas-welcome-icon"><i data-lucide="' + card.icon + '"></i></span>' +
                            '<span class="canvas-welcome-text"><strong>' + card.title + '</strong><em>' + card.desc + '</em></span>' +
                            '<i class="canvas-welcome-arrow" data-lucide="chevron-right"></i>' +
                        '</button>'
                    )).join('') +
                '</div>' +
                '<button type="button" class="canvas-welcome-refresh"><i data-lucide="refresh-cw"></i><span>换一批建议</span></button>';
            welcome.querySelectorAll('[data-suggest]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const card = set.cards[Number(btn.dataset.suggest)];
                    const input = byId('chatInput');
                    if(!input || !card) return;
                    input.value = card.title;
                    input.focus();
                });
            });
            const refresh = welcome.querySelector('.canvas-welcome-refresh');
            if(refresh) refresh.addEventListener('click', event => {
                event.preventDefault();
                round += 1;
                welcome.dataset.canvasWelcome = '';
                render();
            });
            if(typeof window.refreshIcons === 'function') window.refreshIcons();
            else if(window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
        };
        new MutationObserver(render).observe(box, { childList: true, subtree: true });
        render();
    })();

    /* ── 导出子菜单：锚定「更多」面板里被点的「导出」行（右侧 8px，放不下翻到左侧） ── */
    (function bindExportSubmenu(){
        const menu = byId('smartExportMenu');
        if(!menu) return;
        const close = () => {
            menu.classList.remove('open');
            menu.style.left = '';
            menu.style.top = '';
            const toggle = byId('smartExportToggle');
            if(toggle) toggle.classList.remove('active');
        };
        const openAt = itemEl => {
            menu.classList.add('open');
            const itemRect = itemEl.getBoundingClientRect();
            const panel = byId('canvasLeftMorePanel');
            const panelRect = panel && !panel.hidden ? panel.getBoundingClientRect() : itemRect;
            const menuRect = menu.getBoundingClientRect();
            let left = panelRect.right + 8;
            if(left + menuRect.width > window.innerWidth - 8){
                left = panelRect.left - 8 - menuRect.width;
            }
            left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, left));
            let top = itemRect.top;
            top = Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, top));
            menu.style.left = Math.round(left) + 'px';
            menu.style.top = Math.round(top) + 'px';
        };
        window.__novaiOpenExportSubmenuAt = openAt;
        window.__novaiCloseExportSubmenu = close;
        window.__novaiExportSubmenuOpen = () => menu.classList.contains('open');
        menu.querySelectorAll('[data-export-format]').forEach(item => {
            item.addEventListener('click', () => setTimeout(close, 0));
        });
        document.addEventListener('click', event => {
            if(!menu.classList.contains('open')) return;
            if(menu.contains(event.target)) return;
            if(event.target.closest && event.target.closest('[data-left-more="export"]')) return;
            close();
        }, true);
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && menu.classList.contains('open')) close();
        });
        window.addEventListener('resize', close);
    })();

    /* ── 左栏「更多」浮层：导出 / 快捷键 / 定位居中；点浮层外或 Esc 关闭 ── */
    (function bindLeftMorePanel(){
        const panel = byId('canvasLeftMorePanel');
        const btn = byId('canvasRailMore');
        if(!panel || !btn) return;
        const setOpen = open => {
            panel.hidden = !open;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            btn.classList.toggle('is-open', open);
            if(!open && typeof window.__novaiCloseExportSubmenu === 'function') window.__novaiCloseExportSubmenu();
            if(open){
                const rect = btn.getBoundingClientRect();
                panel.style.left = Math.round(rect.right + 10) + 'px';
                panel.style.top = Math.round(rect.top) + 'px';
            }
        };
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if(panel.hidden) setOpen(true);
            else setOpen(false);
        });
        const moreClose = byId('canvasMoreClose');
        if(moreClose) moreClose.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        });
        panel.addEventListener('click', event => {
            const item = event.target.closest('[data-left-more]');
            if(!item) return;
            event.preventDefault();
            event.stopPropagation();
            const action = item.dataset.leftMore;
            if(action === 'export'){
                if(typeof window.__novaiExportSubmenuOpen === 'function' && window.__novaiExportSubmenuOpen()){
                    if(typeof window.__novaiCloseExportSubmenu === 'function') window.__novaiCloseExportSubmenu();
                    return;
                }
                if(typeof window.__novaiOpenExportSubmenuAt === 'function') window.__novaiOpenExportSubmenuAt(item);
                return;
            }
            setOpen(false);
            if(action === 'shortcut' && typeof window.openSmartCanvasShortcuts === 'function') window.openSmartCanvasShortcuts();
            else if(action === 'center' && typeof window.zoomBarCenter === 'function') window.zoomBarCenter();
            else if(action === 'undo' && typeof window.zoomBarUndo === 'function') window.zoomBarUndo();
            else if(action === 'redo' && typeof window.zoomBarRedo === 'function') window.zoomBarRedo();
        });
        document.addEventListener('click', event => {
            if(panel.hidden) return;
            if(btn.contains(event.target) || panel.contains(event.target)) return;
            setOpen(false);
        });
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && !panel.hidden) setOpen(false);
        });
    })();

    /* ── 左侧浮层：点浮层外关闭（复用左栏同一个按钮的开关逻辑；给已有 JS 的自关闭留一个 tick） ── */
    (function bindLeftPanelOutsideClose(){
        const pairs = [
            ['assetPanel', 'canvasRailAssets'],
            ['smartWorkflowTransferModal', 'canvasRailWorkflow'],
            ['smartLogModal', 'canvasRailLog'],
            ['sourceBrowserPanel', 'canvasRailSource'],
            ['promptTemplatePanel', 'canvasRailTemplates']
        ];
        document.addEventListener('click', event => {
            if(event.target.closest('#canvasRail, #canvasTopRight, #canvasLeftMorePanel, #assetPanel, #smartWorkflowTransferModal, #smartLogModal, #sourceBrowserPanel')) return;
            setTimeout(() => {
                pairs.forEach(([panelId, railId]) => {
                    const panel = byId(panelId);
                    if(!panel || !panel.classList.contains('open')) return;
                    const railBtn = byId(railId);
                    if(railBtn && typeof railBtn.click === 'function') railBtn.click();
                });
            }, 0);
        });
    })();

    /* ── 左栏 hover 胶囊提示：按钮右侧 10px；150ms 显示 / 100ms 隐藏，同一时刻只存在一个 ── */
    (function bindRailTips(){
        const railEl = byId('canvasRail');
        const tip = byId('canvasRailTip');
        if(!railEl || !tip) return;
        let showTimer = 0;
        let hideTimer = 0;
        const hideNow = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            tip.hidden = true;
        };
        const scheduleHide = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { tip.hidden = true; }, 100);
        };
        const tipTextOf = btn => {
            if(!btn) return '';
            if(!btn.dataset.tip){
                const text = btn.getAttribute('title');
                if(!text) return '';
                btn.dataset.tip = text;
                btn.removeAttribute('title');
            }
            return btn.dataset.tip;
        };
        const scheduleShow = btn => {
            const text = tipTextOf(btn);
            if(!text) return;
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            showTimer = setTimeout(() => {
                tip.textContent = text;
                const rect = btn.getBoundingClientRect();
                tip.style.left = Math.round(rect.right + 10) + 'px';
                tip.style.top = Math.round(rect.top + rect.height / 2) + 'px';
                tip.hidden = false;
            }, 150);
        };
        railEl.addEventListener('mouseover', event => {
            const btn = event.target.closest('button');
            if(btn && railEl.contains(btn)) scheduleShow(btn);
            else scheduleHide();
        });
        railEl.addEventListener('mouseout', event => {
            if(!event.relatedTarget || !railEl.contains(event.relatedTarget)) scheduleHide();
        });
        railEl.addEventListener('mouseleave', scheduleHide);
        railEl.addEventListener('focusin', event => {
            const btn = event.target.closest('button');
            if(btn && railEl.contains(btn)) scheduleShow(btn);
        });
        railEl.addEventListener('focusout', hideNow);
        railEl.addEventListener('click', hideNow, true);
        document.addEventListener('click', hideNow, true);
        window.addEventListener('scroll', hideNow, true);
        window.addEventListener('blur', hideNow);
        document.addEventListener('visibilitychange', hideNow);
        /* 鼠标移入任何左栏浮层/面板时立刻收起提示 */
        ['canvasAddPanel', 'canvasLeftMorePanel', 'assetPanel', 'smartWorkflowTransferModal', 'smartLogModal', 'sourceBrowserPanel', 'promptTemplatePanel'].forEach(id => {
            const panel = byId(id);
            if(panel) panel.addEventListener('mouseenter', hideNow);
        });
    })();

    /* ── hover「+」→ 添加节点面板（锚定按钮右侧 10px，移出 300ms 关） ── */
    (function bindAddPanel(){
        const createBtn = byId('canvasRailCreate');
        const panel = byId('canvasAddPanel');
        if(!createBtn || !panel) return;
        let timer = 0;
        const open = () => {
            clearTimeout(timer);
            const rect = createBtn.getBoundingClientRect();
            panel.hidden = false;
            const top = Math.min(rect.top - 8, window.innerHeight - panel.offsetHeight - 16);
            panel.style.left = Math.round(rect.right + 10) + 'px';
            panel.style.top = Math.max(16, Math.round(top)) + 'px';
            createBtn.classList.add('is-open');
        };
        const close = () => {
            panel.hidden = true;
            createBtn.classList.remove('is-open');
        };
        const scheduleClose = () => {
            clearTimeout(timer);
            timer = setTimeout(close, 300);
        };
        createBtn.addEventListener('mouseenter', open);
        createBtn.addEventListener('mouseleave', scheduleClose);
        createBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if(panel.hidden) open(); else close();
        });
        panel.addEventListener('mouseenter', () => clearTimeout(timer));
        panel.addEventListener('mouseleave', scheduleClose);
        panel.addEventListener('click', event => {
            const item = event.target.closest('[data-add-kind]');
            if(!item) return;
            event.preventDefault();
            event.stopPropagation();
            close();
            const kind = item.dataset.addKind;
            if(kind === 'upload'){
                const input = byId('fileInput');
                if(input) input.click();
                return;
            }
            if(typeof window.zoomBarCreate === 'function') window.zoomBarCreate(kind);
        });
        document.addEventListener('click', event => {
            if(panel.hidden) return;
            if(panel.contains(event.target) || createBtn.contains(event.target)) return;
            close();
        });
        document.addEventListener('keydown', event => {
            if(event.key === 'Escape' && !panel.hidden) close();
        });
    })();

    /* ── 左栏所有弹窗：面板级事件隔离，面板内点击/双击不再冒泡到画布 shell（避免双击缩放按钮弹出新建节点菜单） ── */
    (function bindPanelEventIsolation(){
        const panelIds = ['assetPanel', 'smartWorkflowTransferModal', 'smartLogModal', 'canvasLeftMorePanel', 'sourceBrowserPanel', 'promptTemplatePanel', 'onlinePromptPanel'];
        const types = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
        panelIds.forEach(id => {
            const panel = byId(id);
            if(!panel) return;
            types.forEach(type => {
                panel.addEventListener(type, event => { event.stopPropagation(); });
            });
        });
    })();

    /* ── 左下角容器：隔离画布的 pointer 事件，避免画布 preventDefault 抢走滑杆拖动 ── */
    (function bindBottomLeftIsolation(){
        const bar = byId('canvasBottomLeft');
        if(!bar) return;
        /* 冒泡阶段 stopPropagation：先让滑杆自己的 pointerdown/pointermove 拿到事件，再挡住画布全局处理 */
        ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click'].forEach(type => {
            bar.addEventListener(type, event => { event.stopPropagation(); });
        });
    })();

    /* ── 左下工具：map 小地图开关 / link 工作流浮层（复用左栏逻辑）/ grid 网格开关 / scan 适应画布 ── */
    (function bindCanvasBottomTools(){
        const mapBtn = byId('canvasZoomMapBtn');
        const workflowBtn = byId('canvasZoomWorkflowBtn');
        const gridBtn = byId('canvasZoomGridBtn');
        if(mapBtn) mapBtn.addEventListener('click', () => {
            const on = document.body.classList.toggle('canvas-minimap-visible');
            mapBtn.classList.toggle('is-on', on);
            mapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if(workflowBtn){
            const workflowPanel = byId('smartWorkflowTransferModal');
            const syncActive = () => workflowBtn.classList.toggle('is-on', !!workflowPanel && workflowPanel.classList.contains('open'));
            if(workflowPanel){
                new MutationObserver(syncActive).observe(workflowPanel, { attributes: true, attributeFilter: ['class'] });
            }
            workflowBtn.addEventListener('click', () => {
                /* 和左栏「工作流」同一套逻辑：左侧浮层开/合；点完立刻给 active 反馈 */
                const railWorkflow = byId('canvasRailWorkflow');
                if(railWorkflow && typeof railWorkflow.click === 'function') railWorkflow.click();
                setTimeout(syncActive, 0);
            });
            syncActive();
        }
        if(gridBtn) gridBtn.addEventListener('click', () => {
            const hidden = document.body.classList.toggle('canvas-grid-hidden');
            gridBtn.classList.toggle('is-on', !hidden);
            gridBtn.setAttribute('aria-pressed', hidden ? 'false' : 'true');
        });
    })();

    /* ── 左下缩放滑杆：自己实现拖拽（画布全局 pointer 处理会吃掉原生 range 拖拽）；键盘仍走 input ── */
    (function bindZoomSliderDrag(){
        const wrap = document.querySelector('.canvas-zoom-slider');
        const slider = byId('canvasZoomSlider');
        if(!wrap || !slider) return;
        const clamp = value => Math.max(10, Math.min(400, value));
        let dragging = false;
        let activePointer = null;
        const setFill = pct => {
            slider.style.setProperty('--zoom-fill', Math.round(((clamp(pct) - 10) / 390) * 100) + '%');
        };
        const applyFromEvent = event => {
            const rect = slider.getBoundingClientRect();
            if(!rect.width) return;
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            const pct = clamp(Math.round(10 + ratio * 390));
            slider.value = String(pct);
            setFill(pct);
            if(typeof window.zoomBarSetScale === 'function') window.zoomBarSetScale(pct / 100);
        };
        wrap.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            activePointer = event.pointerId;
            try { wrap.setPointerCapture(event.pointerId); } catch(_) {}
            applyFromEvent(event);
        }, true);
        wrap.addEventListener('pointermove', event => {
            if(!dragging) return;
            event.preventDefault();
            event.stopPropagation();
            applyFromEvent(event);
        }, true);
        const finish = event => {
            if(!dragging) return;
            dragging = false;
            if(event && event.pointerId === activePointer){
                try { wrap.releasePointerCapture(event.pointerId); } catch(_) {}
            }
            activePointer = null;
        };
        wrap.addEventListener('pointerup', finish, true);
        wrap.addEventListener('pointercancel', finish, true);
        wrap.addEventListener('lostpointercapture', () => { dragging = false; activePointer = null; });
        /* 原生 input：键盘左右键 / 辅助技术改值时仍然生效 */
        slider.addEventListener('input', () => {
            const pct = clamp(Number(slider.value) || 100);
            setFill(pct);
            if(typeof window.zoomBarSetScale === 'function') window.zoomBarSetScale(pct / 100);
        });
        setFill(Number(slider.value) || 100);
    })();

    /* ── 左下缩放滑杆：百分比变化时回写滑杆 ── */
    (function bindZoomSlider(){
        const slider = byId('canvasZoomSlider');
        const level = byId('canvasZoomLevel');
        if(!slider) return;
        const clamp = value => Math.max(10, Math.min(400, value));
        const setFill = pct => {
            const ratio = (clamp(pct) - 10) / 390;
            slider.style.setProperty('--zoom-fill', Math.round(ratio * 100) + '%');
        };
        slider.addEventListener('input', () => {
            const pct = clamp(Number(slider.value) || 100);
            setFill(pct);
            if(typeof window.zoomBarSetScale === 'function') window.zoomBarSetScale(pct / 100);
        });
        if(!level){ setFill(Number(slider.value) || 100); return; }
        const sync = () => {
            const pct = parseInt(String(level.textContent || '').replace(/[^0-9.-]/g, ''), 10);
            if(Number.isFinite(pct)){
                slider.value = String(clamp(pct));
                setFill(pct);
            }
        };
        new MutationObserver(sync).observe(level, { childList: true, characterData: true, subtree: true });
        sync();
    })();
})();
