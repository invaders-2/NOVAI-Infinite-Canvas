/* 在线提示词库（AI Short）前端模块：入口挂在现有提示词模板库面板里。
   纯函数（buildUrl / normalize / render* / fetchPage）可被离线测试直接调用；
   DOM 控制器只在页面存在入口节点时初始化。 */
(function (global) {
    'use strict';

    var PAGE_SIZE = 30;
    var ENDPOINT = '/api/prompt-library/online';
    var CATEGORIES_ENDPOINT = '/api/prompt-library/online/categories';
    var SOURCE_BASE = 'https://www.aishort.top/community-prompt/';
    var TAG_KEYS = ['write','code','language','ai','tool','pedagogy','company','article','mind','social','comments','academic','professional','text','interesting','living','life','games','speech','doctor','philosophy','interpreter','seo','music','finance','contribute'];

    function t(key, fallback) {
        try {
            if (global.StudioI18n && typeof global.StudioI18n.t === 'function') {
                var value = global.StudioI18n.t(key);
                if (value && value !== key) return value;
            }
        } catch (_) {}
        return fallback;
    }

    function buildUrl(options) {
        var opts = options || {};
        var params = new URLSearchParams();
        params.set('q', String(opts.q || ''));
        params.set('page', String(Math.max(1, Number(opts.page) || 1)));
        params.set('pageSize', String(Math.max(1, Number(opts.pageSize) || PAGE_SIZE)));
        params.set('lang', String(opts.lang || 'zh'));
        if (opts.tag) params.set('tag', String(opts.tag));
        if (opts.refresh) params.set('refresh', 'true');
        return ENDPOINT + '?' + params.toString();
    }

    function normalizePayload(data) {
        var payload = data && typeof data === 'object' ? data : {};
        var items = Array.isArray(payload.items) ? payload.items : [];
        items = items.filter(function (item) {
            return item && typeof item === 'object' && String(item.prompt || '').trim();
        });
        var page = Math.max(1, Number(payload.page) || 1);
        var total = Math.max(0, Number(payload.total) || items.length);
        var pageSize = Math.max(1, Number(payload.pageSize) || PAGE_SIZE);
        var pageCount = Math.max(1, Number(payload.pageCount) || Math.ceil(total / pageSize) || 1);
        return {
            ok: payload.ok !== false,
            error: payload.ok === false ? String(payload.error || '') : '',
            total: total,
            page: page,
            pageCount: pageCount,
            items: items,
            updatedAt: payload.updatedAt ? String(payload.updatedAt) : '',
            stale: payload.stale === true,
            ageSeconds: Math.max(0, Number(payload.ageSeconds) || 0),
            matchMode: ['exact', 'expanded', 'fuzzy', 'none'].indexOf(String(payload.matchMode || '')) >= 0 ? String(payload.matchMode) : '',
            expandedTerms: Array.isArray(payload.expandedTerms) ? payload.expandedTerms.map(function (term) { return String(term || ''); }).filter(Boolean) : []
        };
    }

    function fetchPage(options) {
        var opts = options || {};
        var fetchImpl = opts.fetchImpl || (global.fetch ? global.fetch.bind(global) : null);
        if (typeof fetchImpl !== 'function') {
            return Promise.reject(new Error('fetch unavailable'));
        }
        var url = buildUrl(opts);
        return Promise.resolve(fetchImpl(url, { method: 'GET', headers: { 'Accept': 'application/json' } }))
            .then(function (response) {
                if (!response || response.ok === false) {
                    var status = response && response.status ? 'HTTP ' + response.status : '';
                    throw new Error(status || 'request failed');
                }
                return response.json();
            })
            .then(function (data) {
                var normalized = normalizePayload(data);
                if (!normalized.ok) throw new Error(normalized.error || 'request failed');
                return normalized;
            });
    }

    function fetchCategories(options) {
        var opts = options || {};
        var fetchImpl = opts.fetchImpl || (global.fetch ? global.fetch.bind(global) : null);
        if (typeof fetchImpl !== 'function') {
            return Promise.reject(new Error('fetch unavailable'));
        }
        var url = CATEGORIES_ENDPOINT + (opts.refresh ? '?refresh=true' : '');
        return Promise.resolve(fetchImpl(url, { method: 'GET', headers: { 'Accept': 'application/json' } }))
            .then(function (response) {
                if (!response || response.ok === false) throw new Error('categories request failed');
                return response.json();
            })
            .then(function (data) {
                if (!data || data.ok === false || !Array.isArray(data.items)) throw new Error('categories payload invalid');
                var list = data.items.filter(function (item) {
                    return item && item.key;
                }).map(function (item) {
                    return { key: String(item.key), count: Math.max(0, Number(item.count) || 0) };
                });
                list.updatedAt = data.updatedAt ? String(data.updatedAt) : '';
                list.stale = data.stale === true;
                list.ageSeconds = Math.max(0, Number(data.ageSeconds) || 0);
                return list;
            });
    }

    function tagLabel(key) {
        return t('smart.onlineTag.' + key, key);
    }

    function tFmt(key, fallback, n) {
        return String(t(key, fallback)).replace('{n}', String(n)).replace('{terms}', String(n));
    }

    function formatUpdatedAt(ageSeconds, stale) {
        var age = Math.max(0, Number(ageSeconds) || 0);
        if (stale) {
            var hours = Math.max(1, Math.floor(age / 3600));
            return t('smart.onlineStale', '离线缓存') + ' · ' + tFmt('smart.onlineHoursAgo', '{n} 小时前', hours);
        }
        var core;
        if (age < 60) core = t('smart.onlineJustNow', '刚刚');
        else if (age < 3600) core = tFmt('smart.onlineMinutesAgo', '{n} 分钟前', Math.floor(age / 60));
        else core = tFmt('smart.onlineHoursAgo', '{n} 小时前', Math.floor(age / 3600));
        return t('smart.onlineUpdatedPrefix', '更新于') + ' ' + core;
    }

    function renderChips(state) {
        var s = state || {};
        var cats = Array.isArray(s.categories) ? s.categories : [];
        var active = s.activeTag || '';
        return cats.map(function (cat) {
            return '<button type="button" class="online-prompt-chip' + (active === cat.key ? ' is-active' : '') + '" data-online-tag="' + escapeHtml(cat.key) + '">'
                + escapeHtml(tagLabel(cat.key)) + ' <span>' + cat.count + '</span></button>';
        }).join('');
    }

    function formatSearchHint(matchMode, expandedTerms) {
        var terms = Array.isArray(expandedTerms) ? expandedTerms.filter(Boolean) : [];
        if (matchMode === 'expanded') {
            var shown = terms.slice(0, 5);
            var rest = terms.length - shown.length;
            var joined = shown.join(' / ') + (rest > 0 ? ' ' + tFmt('smart.onlineHintMore', '等 {n} 项', rest) : '');
            return tFmt('smart.onlineHintExpanded', '没有精确匹配，已扩展搜索：{terms}', joined);
        }
        if (matchMode === 'fuzzy') return t('smart.onlineHintFuzzy', '没有精确匹配，以下为相关内容');
        return '';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function tagsOf(item) {
        if (Array.isArray(item && item.tags)) return item.tags.filter(Boolean).slice(0, 4);
        if (typeof (item && item.tags) === 'string') {
            return item.tags.split(/[,，\s]+/).filter(Boolean).slice(0, 4);
        }
        return [];
    }

    function isLocalItem(item) {
        return String((item && item.source) || '').toLowerCase() === 'local';
    }

    function cardHtml(item, selectedId) {
        var active = selectedId && selectedId === item.id;
        var tagText = tagsOf(item).map(function (tag) { return tagLabel(tag); }).join(' ');
        var curated = isLocalItem(item) ? '<span class="online-prompt-curated">' + escapeHtml(t('smart.onlineCurated', '精选')) + '</span>' : '';
        return '<button type="button" class="online-prompt-card' + (active ? ' is-active' : '') + '" data-online-id="' + escapeHtml(item.id) + '">'
            + '<span class="online-prompt-card-top"><strong>' + escapeHtml(item.title || item.remark || '未命名提示词') + '</strong>'
            + curated
            + '<em>' + escapeHtml(item.count ? (item.count + ' 次使用') : '') + '</em></span>'
            + (item.remark ? '<span class="online-prompt-remark">' + escapeHtml(item.remark) + '</span>' : '')
            + (tagText ? '<span class="online-prompt-tags">' + escapeHtml(tagText) + '</span>' : '')
            + '</button>';
    }

    function skeletonHtml() {
        var rows = '';
        for (var i = 0; i < 5; i += 1) rows += '<div class="online-prompt-skeleton-row"></div>';
        return '<div class="online-prompt-skeleton">' + rows + '</div>';
    }

    function renderList(state) {
        var s = state || {};
        var items = Array.isArray(s.items) ? s.items : [];
        if (s.loading && !items.length) {
            return skeletonHtml() + '<div class="online-prompt-status">' + escapeHtml(t('smart.onlineLoading', '在线库加载中…')) + '</div>';
        }
        if (s.error && !items.length) {
            return '<div class="online-prompt-state is-error">'
                + '<p>' + escapeHtml(t('smart.onlineLoadFailed', '在线库加载失败')) + '</p>'
                + '<button type="button" class="online-prompt-btn" data-online-retry="1">' + escapeHtml(t('smart.onlineRetry', '重试')) + '</button>'
                + '</div>';
        }
        if (!s.loading && !s.error && !items.length) {
            return '<div class="online-prompt-state is-empty"><p>' + escapeHtml(t('smart.onlineEmpty', '没有找到相关提示词')) + '</p></div>';
        }
        var html = items.map(function (item) { return cardHtml(item, s.selectedId); }).join('');
        if (s.error) {
            html += '<div class="online-prompt-status is-error">' + escapeHtml(t('smart.onlineLoadFailed', '在线库加载失败')) + '</div>';
        }
        if ((s.page || 0) < (s.pageCount || 1)) {
            html += '<button type="button" class="online-prompt-more" data-online-more="1"'
                + (s.loading ? ' disabled' : '') + '>'
                + escapeHtml(s.loading ? t('smart.onlineLoading', '在线库加载中…') : t('smart.onlineLoadMore', '加载更多'))
                + '</button>';
        }
        return html;
    }

    function renderDetail(item) {
        if (!item) return '';
        var sourceUrl = sourceUrlOf(item);
        var detailTags = tagsOf(item).map(function (tag) { return tagLabel(tag); }).join(' ');
        var sourceBlock = isLocalItem(item)
            ? '<span class="online-prompt-curated">' + escapeHtml(t('smart.onlineCurated', '精选')) + '</span>'
            : '<a class="online-prompt-source" data-online-source="1" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener">'
                + escapeHtml(t('smart.onlineSource', '来源：aishort.top')) + '</a>';
        return '<div class="online-prompt-detail-head">'
                + '<button type="button" class="online-prompt-detail-close" data-online-detail-close="1" aria-label="' + escapeHtml(t('common.close', '关闭')) + '">×</button>'
                + '<strong>' + escapeHtml(item.title || item.remark || '未命名提示词') + '</strong>'
                + '<span>' + escapeHtml(item.remark || '') + '</span>'
                + (detailTags ? '<span class="online-prompt-detail-tags">' + escapeHtml(detailTags) + '</span>' : '')
            + '</div>'
            + '<pre class="online-prompt-text">' + escapeHtml(item.prompt || '') + '</pre>'
            + '<div class="online-prompt-detail-foot">'
                + sourceBlock
                + '<div class="online-prompt-actions">'
                    + '<button type="button" class="online-prompt-btn" data-online-copy="1">' + escapeHtml(t('smart.onlineCopy', '复制')) + '</button>'
                    + '<button type="button" class="online-prompt-btn is-primary" data-online-apply="1">' + escapeHtml(t('smart.onlineApply', '应用到画布')) + '</button>'
                + '</div>'
            + '</div>';
    }

    function sourceUrlOf(item) {
        if (item && item.url) return String(item.url);
        var id = item && item.id ? String(item.id) : '';
        return id ? SOURCE_BASE + encodeURIComponent(id) : 'https://www.aishort.top/';
    }

    function createController(options) {
        var opts = options || {};
        var doc = opts.document || (typeof document !== 'undefined' ? document : null);
        if (!doc) return null;
        var fetchImpl = opts.fetchImpl || null;
        var onApply = opts.onApply || function () {};
        var state = { items: [], page: 0, pageCount: 1, total: 0, loading: false, error: '', selectedId: '', query: '', loaded: false, categories: [], categoriesLoaded: false, categoriesLoading: false, activeTag: null, updatedAt: '', stale: false, ageSeconds: null, metaAt: 0, refreshing: false, matchMode: '', expandedTerms: [] };
        var seq = 0;
        var root = doc.getElementById('onlinePromptPanel');
        var listEl = doc.getElementById('onlinePromptList');
        var detailEl = doc.getElementById('onlinePromptDetail');
        var searchEl = doc.getElementById('onlinePromptSearch');
        var entryEl = doc.getElementById('onlinePromptEntry');
        var chipsEl = doc.getElementById('onlinePromptChips');
        var hintEl = doc.getElementById('onlinePromptSearchHint');
        var updatedEl = doc.getElementById('onlinePromptUpdatedAt');
        var refreshBtn = doc.getElementById('onlinePromptRefresh');
        var panelEl = doc.getElementById('promptTemplatePanel');
        if (!root || !listEl || !detailEl) return null;
        var debounceTimer = null;
        var ageTimer = null;

        function currentAge() {
            if (state.ageSeconds == null) return null;
            var extra = state.metaAt ? Math.max(0, (Date.now() - state.metaAt) / 1000) : 0;
            return state.ageSeconds + extra;
        }
        function applyMeta(data) {
            if (!data) return;
            if (data.updatedAt) state.updatedAt = String(data.updatedAt);
            if (typeof data.stale === 'boolean') state.stale = data.stale;
            if (typeof data.ageSeconds === 'number') {
                state.ageSeconds = data.ageSeconds;
                state.metaAt = Date.now();
            }
        }
        function renderMeta() {
            if (!updatedEl) return;
            var age = currentAge();
            if (age == null) {
                updatedEl.hidden = true;
                updatedEl.textContent = '';
                return;
            }
            updatedEl.hidden = false;
            updatedEl.textContent = formatUpdatedAt(age, state.stale);
            updatedEl.classList.toggle('is-stale', state.stale);
        }
        function setRefreshUI() {
            if (!refreshBtn) return;
            refreshBtn.disabled = state.refreshing;
            refreshBtn.classList.toggle('is-refreshing', state.refreshing);
            refreshBtn.setAttribute('aria-busy', state.refreshing ? 'true' : 'false');
        }

        function selectedItem() {
            return state.items.filter(function (item) { return item.id === state.selectedId; })[0] || null;
        }
        function render() {
            renderMeta();
            if (hintEl) {
                var hintText = formatSearchHint(state.matchMode, state.expandedTerms);
                hintEl.hidden = !hintText;
                hintEl.textContent = hintText;
                hintEl.classList.toggle('is-fuzzy', state.matchMode === 'fuzzy');
            }
            if (chipsEl) {
                chipsEl.hidden = !state.categories.length;
                chipsEl.innerHTML = state.categories.length ? renderChips(state) : '';
            }
            listEl.innerHTML = renderList(state);
            const selected = selectedItem();
            detailEl.innerHTML = renderDetail(selected);
            detailEl.hidden = !selected;
            detailEl.classList.toggle('is-open', Boolean(selected));
        }
        function loadCategories(force) {
            if (!force && (state.categoriesLoaded || state.categoriesLoading)) return Promise.resolve(state.categories);
            state.categoriesLoading = true;
            return fetchCategories({ fetchImpl: fetchImpl, refresh: force === true })
                .then(function (categories) {
                    state.categoriesLoading = false;
                    state.categoriesLoaded = true;
                    state.categories = categories;
                    applyMeta(categories);
                    render();
                    return categories;
                })
                .catch(function () {
                    state.categoriesLoading = false;
                    state.categoriesLoaded = true;
                    state.categories = [];
                    render();
                    return [];
                });
        }
        function selectTag(key) {
            var next = key ? String(key) : null;
            if (next === state.activeTag) next = null;
            state.activeTag = next;
            state.selectedId = '';
            state.suppressAutoSelect = true;
            if (listEl) listEl.scrollTop = 0;
            render();
            return load(1);
        }
        function reset(query) {
            state.items = [];
            state.page = 0;
            state.pageCount = 1;
            state.total = 0;
            state.error = '';
            state.selectedId = '';
            state.matchMode = '';
            state.expandedTerms = [];
            state.query = query == null ? state.query : String(query);
        }
        function load(page, options) {
            var opts = options || {};
            var token = ++seq;
            var firstPage = page <= 1;
            if (firstPage) reset(state.query);
            state.loading = true;
            state.error = '';
            render();
            return fetchPage({ q: state.query, page: page, pageSize: PAGE_SIZE, tag: state.activeTag, refresh: opts.refresh === true, fetchImpl: fetchImpl })
                .then(function (data) {
                    if (token !== seq) return null; // 只认最后一次响应
                    state.loading = false;
                    applyMeta(data);
                    state.matchMode = data.matchMode || '';
                    state.expandedTerms = Array.isArray(data.expandedTerms) ? data.expandedTerms : [];
                    state.page = data.page;
                    state.pageCount = data.pageCount;
                    state.total = data.total;
                    state.items = firstPage ? data.items : state.items.concat(data.items);
                    state.loaded = true;
                    render();
                    return data;
                })
                .catch(function (error) {
                    if (token !== seq) return null;
                    state.loading = false;
                    state.error = String((error && error.message) || error || '');
                    render();
                    return null;
                });
        }
        function setQuery(query) {
            clearTimeout(debounceTimer);
            state.query = String(query || '');
            debounceTimer = setTimeout(function () { load(1); }, 300);
        }
        function loadMore() {
            if (state.loading || state.page >= state.pageCount) return null;
            return load(state.page + 1);
        }
        function refresh() {
            if (state.refreshing) return Promise.resolve();
            state.refreshing = true;
            setRefreshUI();
            return loadCategories(true)
                .then(function (categories) {
                    if (state.activeTag && !categories.some(function (cat) { return cat.key === state.activeTag; })) {
                        state.activeTag = null; // 分类已不存在 → 回退无分类
                        state.selectedId = '';
                        state.suppressAutoSelect = true;
                    }
                    return load(1, { refresh: true });
                })
                .then(function () {
                    state.refreshing = false;
                    setRefreshUI();
                    render();
                }, function () {
                    state.refreshing = false;
                    setRefreshUI();
                    render();
                });
        }
        function select(id) {
            state.selectedId = String(id || '');
            render();
            if (id && detailEl && typeof detailEl.scrollIntoView === 'function') {
                detailEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
        function setEntryLabel(text){
            if(!entryEl) return;
            entryEl.innerHTML = '<i data-lucide="chevron-left"></i><span>' + escapeHtml(text) + '</span>';
            if(typeof global.refreshIcons === 'function') global.refreshIcons();
            else if(global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
        }
        var subtitleEl = panelEl ? panelEl.querySelector('.prompt-template-head span') : null;
        var localSubtitle = subtitleEl ? subtitleEl.textContent : '';
        function enter() {
            if (panelEl) panelEl.classList.add('is-online');
            if (entryEl) {
                entryEl.classList.add('is-online');
                setEntryLabel(t('smart.onlineBack', '返回本地库'));
            }
            if (subtitleEl) subtitleEl.textContent = t('smart.onlineSubtitle', '在线提示词库（AI Short）');
            root.hidden = false;
            render();
            if (!ageTimer) ageTimer = setInterval(renderMeta, 30000);
            if (!state.loaded) {
                return loadCategories().then(function (categories) {
                    if (!state.defaulted) {
                        state.defaulted = true;
                        var hasEcommerce = categories.some(function (cat) { return cat.key === 'ecommerce'; });
                        if (hasEcommerce) state.activeTag = 'ecommerce';
                    }
                    return load(1);
                });
            }
            return loadCategories();
        }
        function exit() {
            if (panelEl) panelEl.classList.remove('is-online');
            if (entryEl) {
                entryEl.classList.remove('is-online');
                setEntryLabel(t('smart.onlineLibrary', '在线提示词库'));
            }
            if (subtitleEl) subtitleEl.textContent = localSubtitle;
            root.hidden = true;
            if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
        }
        function toggle() {
            if (root.hidden) enter(); else exit();
        }
        function applySelected() {
            var item = selectedItem();
            if (!item) return;
            onApply(item);
        }
        function copySelected() {
            var item = selectedItem();
            if (!item) return;
            var text = String(item.prompt || '');
            try {
                if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
                    global.navigator.clipboard.writeText(text);
                    return;
                }
            } catch (_) {}
            try {
                var area = doc.createElement('textarea');
                area.value = text;
                doc.body.appendChild(area);
                area.select();
                doc.execCommand('copy');
                area.remove();
            } catch (_) {}
        }

        root.addEventListener('click', function (event) {
            if (event.target.closest('[data-online-detail-close]')) { select(''); return; }
            var chip = event.target.closest('[data-online-tag]');
            if (chip) { selectTag(chip.getAttribute('data-online-tag')); return; }
            var card = event.target.closest('[data-online-id]');
            if (card) { select(card.getAttribute('data-online-id')); return; }
            if (event.target.closest('[data-online-more]')) { loadMore(); return; }
            if (event.target.closest('[data-online-retry]')) { load(1); return; }
            if (event.target.closest('[data-online-copy]')) { copySelected(); return; }
            if (event.target.closest('[data-online-apply]')) { applySelected(); return; }
            var source = event.target.closest('[data-online-source]');
            if (source) {
                event.preventDefault();
                try { global.open(source.getAttribute('href'), '_blank', 'noopener'); } catch (_) {}
            }
        });
        if (searchEl) searchEl.addEventListener('input', function () { setQuery(searchEl.value); });
        if (refreshBtn) refreshBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); refresh(); });
        if (entryEl) entryEl.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); toggle(); });
        /* 首次进入由 enter() 统一先拉分类再按默认分类请求，避免面板 class 变化触发一次无 tag 的竞态请求 */
        return {
            state: state,
            enter: enter,
            exit: exit,
            toggle: toggle,
            load: load,
            loadMore: loadMore,
            select: select,
            selectTag: selectTag,
            loadCategories: loadCategories,
            refresh: refresh,
            setQuery: setQuery,
            render: render,
            applySelected: applySelected,
            copySelected: copySelected
        };
    }

    function init() {
        if (global.__novaOnlinePromptBound) return;
        var doc = typeof document !== 'undefined' ? document : null;
        if (!doc || !doc.getElementById('onlinePromptPanel')) return;
        global.__novaOnlinePromptBound = true;
        createController({
            document: doc,
            onApply: function (item) {
                if (typeof global.applyPromptTextToCanvas === 'function') {
                    global.applyPromptTextToCanvas(item.prompt || '');
                }
            }
        });
    }

    global.NovaOnlinePrompt = {
        PAGE_SIZE: PAGE_SIZE,
        ENDPOINT: ENDPOINT,
        CATEGORIES_ENDPOINT: CATEGORIES_ENDPOINT,
        TAG_KEYS: TAG_KEYS,
        buildUrl: buildUrl,
        normalizePayload: normalizePayload,
        fetchPage: fetchPage,
        fetchCategories: fetchCategories,
        formatUpdatedAt: formatUpdatedAt,
        formatSearchHint: formatSearchHint,
        isLocalItem: isLocalItem,
        tagLabel: tagLabel,
        renderChips: renderChips,
        cardHtml: cardHtml,
        renderList: renderList,
        renderDetail: renderDetail,
        tagsOf: tagsOf,
        sourceUrlOf: sourceUrlOf,
        createController: createController,
        init: init
    };

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }
})(typeof window !== 'undefined' ? window : this);
