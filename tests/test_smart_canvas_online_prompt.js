#!/usr/bin/env node
/*
 * 在线提示词库（AI Short）离线回归：vm 执行模块纯函数 + stub fetch，不联网。
 * 同时做静态结构断言（入口/面板/脚本顺序/CSS/应用逻辑导出）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const smart = read('static/js/smart-canvas.js');
const i18n = read('static/js/i18n/smart-canvas.js');
const moduleSrc = read('static/js/online-prompt-library.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function fakeEl() {
    return {
        innerHTML: '',
        hidden: true,
        style: {},
        classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        addEventListener(){},
        setAttribute(){},
        querySelector(){ return null; },
        getBoundingClientRect(){ return { x: 0, y: 0, width: 0, height: 0 }; }
    };
}

const sandbox = {
    console,
    URLSearchParams,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: class { observe(){} disconnect(){} },
    document: {
        readyState: 'loading',
        addEventListener(){},
        getElementById(){ return null; },
        createElement(){ return fakeEl(); },
        body: fakeEl()
    },
    navigator: {},
    fetch: null
};
sandbox.window = sandbox;
sandbox.StudioI18n = { t: key => ({ 'smart.onlineTag.ecommerce': '电商', 'smart.onlineTag.writing': '写作', 'smart.onlineTag.video': '视频', 'smart.onlineTag.marketing': '营销' }[key] || key) };
vm.runInNewContext(moduleSrc, sandbox, { filename: 'online-prompt-library.js' });
const NP = sandbox.window.NovaOnlinePrompt;
ok(Boolean(NP), '模块导出 window.NovaOnlinePrompt');

console.log('[1] 请求 URL');
ok(NP.buildUrl({}) === '/api/prompt-library/online?q=&page=1&pageSize=30&lang=zh', '默认 URL 带 q/page/pageSize/lang');
const url = NP.buildUrl({ q: '赛博朋克 city', page: 3, pageSize: 30, lang: 'en' });
ok(url.startsWith('/api/prompt-library/online?') && url.includes('page=3') && url.includes('pageSize=30') && url.includes('lang=en'), '分页/语言参数正确');
ok(NP.buildUrl({ q: 'a b' }).includes('q=a+b') || NP.buildUrl({ q: 'a b' }).includes('q=a%20b'), 'q 做了 URL 编码');

console.log('[2] 响应归一化');
const normalized = NP.normalizePayload({ ok: true, total: 61, page: 2, pageCount: 3, items: [
    { id: '1', title: 'T', prompt: 'P' },
    { id: '2', title: 'no prompt' },
    null
] });
ok(normalized.ok && normalized.total === 61 && normalized.page === 2 && normalized.pageCount === 3, 'total/page/pageCount 透传');
ok(normalized.items.length === 1 && normalized.items[0].id === '1', '过滤无 prompt 的项');
const failed = NP.normalizePayload({ ok: false, error: 'boom' });
ok(!failed.ok && failed.error === 'boom', 'ok:false 保留 error');

console.log('[3] 卡片 / 列表 / 详情渲染');
const card = NP.cardHtml({ id: 'abc', title: '标题<1>', remark: '简介', prompt: 'p', tags: ['ecommerce', 'writing'], count: 8 }, 'abc');
ok(card.includes('标题&lt;1&gt;') && card.includes('/static') === false, '卡片做 HTML 转义');
ok(card.includes('data-online-id="abc"') && card.includes('is-active'), '选中态 + data-online-id');
ok(card.includes('电商 写作') && !card.includes('class="online-prompt-tag"') && !card.includes('>ecommerce<'), '卡片 tag 走 tagLabel 且空格分隔');
ok(NP.tagLabel('ecommerce') === '电商' && NP.tagLabel('writing') === '写作', 'tagLabel 映射中文');
ok(NP.tagLabel('unknown_tag') === 'unknown_tag', '未映射 tag 原样输出');
const cardRaw = NP.cardHtml({ id: 'r', title: 'R', prompt: 'p', tags: ['unknown_tag', 'video'] }, '');
ok(cardRaw.includes('unknown_tag 视频'), '未映射原词与映射词混排、空格分隔');
const detailTags = NP.renderDetail({ id: 'd', prompt: 'p', tags: ['ecommerce', 'writing'] });
ok(detailTags.includes('online-prompt-detail-tags') && detailTags.includes('电商 写作'), '详情 tag 也映射 + 空格分隔');
const loadingList = NP.renderList({ loading: true, items: [] });
ok(loadingList.includes('online-prompt-skeleton') && loadingList.includes('在线库加载中'), '加载中骨架 + 文案');
const errorList = NP.renderList({ error: 'HTTP 502', items: [], loading: false });
ok(errorList.includes('在线库加载失败') && errorList.includes('data-online-retry'), '失败态 + 重试按钮');
const emptyList = NP.renderList({ items: [], loading: false, error: '' });
ok(emptyList.includes('没有找到相关提示词'), '空态文案');
const p1 = NP.renderList({ items: [{ id: '1', title: 'A', prompt: 'p' }], loading: false, page: 1, pageCount: 2, selectedId: '1' });
ok(p1.includes('data-online-id="1"') && p1.includes('data-online-more'), '有卡片且还有下一页时显示加载更多');
const plast = NP.renderList({ items: [{ id: '1', title: 'A', prompt: 'p' }], loading: false, page: 2, pageCount: 2 });
ok(!plast.includes('data-online-more'), '最后一页不显示加载更多');
const pLoadingMore = NP.renderList({ items: [{ id: '1', title: 'A', prompt: 'p' }], loading: true, page: 1, pageCount: 2 });
ok(pLoadingMore.includes('data-online-more') && pLoadingMore.includes('disabled'), '加载更多时按钮禁用');
const detail = NP.renderDetail({ id: 'xyz', title: 'D', remark: 'R', prompt: 'line1\nline2' });
ok(detail.includes('online-prompt-text') && detail.includes('line1'), '详情渲染完整 prompt');
ok(detail.includes('https://www.aishort.top/community-prompt/xyz') && detail.includes('data-online-source'), '来源链接按 id 生成');
ok(detail.includes('data-online-copy') && detail.includes('data-online-apply'), '复制 / 应用到画布按钮');
const detailUrl = NP.renderDetail({ id: 'x', url: 'https://www.aishort.top/community-prompt/custom', prompt: 'p' });
ok(detailUrl.includes('community-prompt/custom'), '自定义 url 优先');
// 内置精选：source=local、url 为空 → 精选标签 + 无 aishort 链接
const localItem = { id: 'local-1', title: '电商精选标题', remark: '精选简介', prompt: 'LOCAL PROMPT', source: 'local', url: '', count: 5 };
ok(NP.isLocalItem(localItem) === true && NP.isLocalItem({ source: 'online' }) === false, 'isLocalItem 判定');
const localCard = NP.cardHtml(localItem, 'local-1');
ok(localCard.includes('online-prompt-curated') && localCard.includes('精选'), 'local 卡片显示精选标签');
const localDetail = NP.renderDetail(localItem);
ok(localDetail.includes('online-prompt-curated') && localDetail.includes('精选'), 'local 详情显示精选标签');
ok(!localDetail.includes('data-online-source') && !localDetail.includes('aishort.top'), 'local 详情不显示 aishort 链接');
ok(localDetail.includes('data-online-copy') && localDetail.includes('data-online-apply'), 'local 详情保留复制/应用按钮');
ok(!NP.renderDetail({ id: 'on', prompt: 'p', source: 'online', url: '' }).includes('online-prompt-curated'), '非 local 不显示精选');
// local 应用逻辑在 [5b] 控制器内验证

console.log('[4] 分类 chips / categories 接口');
ok(NP.buildUrl({ q: '', page: 1 }).indexOf('tag=') === -1, '全部时 URL 不带 tag');
ok(NP.buildUrl({ q: 'cat', page: 1, tag: 'write' }).includes('tag=write'), '带分类时 URL 带 tag');
ok(NP.buildUrl({ q: 'cat', page: 1, tag: 'write' }).includes('q=cat'), 'tag 与搜索可组合');
const chipsHtml = NP.renderChips({ categories: [{ key: 'write', count: 21 }, { key: 'code', count: 12 }], activeTag: null });
ok(!chipsHtml.includes('data-online-tag=""') && !chipsHtml.includes('is-active'), 'chips 不渲染「全部」且默认无选中');
ok(chipsHtml.includes('data-online-tag="write"') && chipsHtml.includes('21'), '分类 chip 带 key 与数量');
ok(chipsHtml.includes('data-online-tag="code"'), '多个分类都渲染');
const chipsActive = NP.renderChips({ categories: [{ key: 'write', count: 21 }], activeTag: 'write' });
ok(/data-online-tag="write"[^>]*class="online-prompt-chip is-active"|class="online-prompt-chip is-active"[^>]*data-online-tag="write"/.test(chipsActive), '选中分类有 is-active');
ok(chipsActive.includes('>21<') && !chipsActive.includes('全部'), '分类数量渲染且无全部');
ok(NP.renderChips({ categories: [{ key: 'unknown_tag', count: 2 }] }).includes('unknown_tag'), '未知分类显示原词');
ok(NP.formatSearchHint('expanded', ['商品', '网店', '营销']).includes('已扩展搜索') && NP.formatSearchHint('expanded', ['商品', '网店', '营销']).includes('商品 / 网店 / 营销'), 'expanded 提示拼接展开词');
ok(NP.formatSearchHint('expanded', ['a','b','c','d','e','f']).includes('等 1 项'), '展开词超过 5 个显示等 N 项');
ok(NP.formatSearchHint('fuzzy', []).includes('以下为相关内容'), 'fuzzy 提示文案');
ok(NP.formatSearchHint('exact', ['x']) === '' && NP.formatSearchHint('none', []) === '', 'exact/none 不显示提示');
let categoriesUrl = '';
NP.fetchCategories({ fetchImpl: u => {
    categoriesUrl = u;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'write', count: 21 }, { key: 'code', count: 12 }] }) });
} }).then(cats => {
    ok(categoriesUrl.endsWith('/api/prompt-library/online/categories'), 'categories 请求地址正确');
    ok(cats.length === 2 && cats[0].key === 'write' && cats[0].count === 21, 'categories 归一化');
    return NP.fetchCategories({ fetchImpl: () => Promise.reject(new Error('boom')) }).then(() => false).catch(() => true);
}).then((rejected) => {
    ok(rejected, 'categories 失败会 reject（上层隐藏 chips）');
}).then(() => {
console.log('[4b] fetchPage（stub，不联网）');
let requested = '';
const stubFetch = u => {
    requested = u;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 31, page: 2, pageCount: 2, items: [{ id: '9', prompt: 'hello' }] }) });
};
NP.fetchPage({ q: 'cat', page: 2, fetchImpl: stubFetch }).then(data => {
    ok(requested.includes('q=cat') && requested.includes('page=2'), 'fetchPage 请求 q/page 参数');
    (async () => {
        console.log('[5] controller 加载更多 / 竞态');
        const els = {};
        ['onlinePromptPanel', 'onlinePromptList', 'onlinePromptDetail', 'onlinePromptSearch', 'onlinePromptEntry', 'onlinePromptChips', 'onlinePromptSearchHint', 'onlinePromptRefresh', 'onlinePromptUpdatedAt', 'promptTemplatePanel'].forEach(id => { els[id] = fakeEl(); });
        els.onlinePromptChips.hidden = true;
        els.onlinePromptPanel.hidden = true;
        const doc = { getElementById(id){ return els[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() };
        const calls = [];
        const ctrl = NP.createController({
            document: doc,
            fetchImpl: u => {
                calls.push(u);
                if (u.indexOf('/categories') >= 0) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'write', count: 21 }, { key: 'code', count: 12 }] }) });
                }
                const tag = (u.match(/tag=([^&]*)/) || [])[1] || '';
                const page = Number((u.match(/page=(\d+)/) || [])[1] || 1);
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 2, page, pageCount: 2, items: [{ id: 'p' + page, title: 'T' + page, prompt: 'text' + page + (tag ? '-' + tag : '') }] }) });
            },
            onApply(){}
        });
        ok(Boolean(ctrl), 'createController 初始化');
        await ctrl.load(1);
        ok(ctrl.state.items.length === 1 && ctrl.state.page === 1, 'home 第一页加载');
        await ctrl.loadMore();
        ok(ctrl.state.items.length === 2 && ctrl.state.page === 2, '加载更多追加第二页');
        const listCalls = () => calls.filter(u => u.indexOf('/categories') < 0);
        ok(listCalls().length >= 2 && listCalls()[1].includes('page=2'), '加载更多请求 page=2');
        // 分类：首次 enter 才拉 categories，一次并缓存
        const moreSnapshot = { list: els.onlinePromptList.innerHTML, detail: els.onlinePromptDetail.innerHTML };
        els.onlinePromptPanel.hidden = true;
        await ctrl.enter();
        await new Promise(resolve => setTimeout(resolve, 0));
        ok(ctrl.state.categories.length === 2 && ctrl.state.categoriesLoaded, 'enter 拉取并缓存 categories');
        ok(els.onlinePromptChips.hidden === false && els.onlinePromptChips.innerHTML.includes('data-online-tag="write"'), 'chips 渲染分类');
        const countBefore = calls.filter(u => u.indexOf('/categories') >= 0).length;
        await ctrl.loadCategories();
        ok(calls.filter(u => u.indexOf('/categories') >= 0).length === countBefore, 'categories 只请求一次（缓存）');
        // 点分类 → page=1 带 tag；再点同一分类取消
        const beforeTagCalls = listCalls().length;
        await ctrl.selectTag('write');
        const tagCall = listCalls()[beforeTagCalls] || '';
        ok(tagCall.includes('tag=write') && tagCall.includes('page=1'), '点分类请求第 1 页并带 tag');
        ok(ctrl.state.activeTag === 'write' && ctrl.state.selectedId === '', '切分类清空选中并记录 activeTag');
        const beforeCancel = listCalls().length;
        await ctrl.selectTag('write');
        const cancelCall = listCalls()[beforeCancel] || '';
        ok(ctrl.state.activeTag === null && cancelCall.indexOf('tag=') === -1, '再点同一分类取消筛选（无分类）');
        // 分类 + 搜索组合
        ctrl.state.query = 'cat';
        const beforeCombo = listCalls().length;
        await ctrl.selectTag('code');
        const comboCall = listCalls()[beforeCombo] || '';
        ok(comboCall.includes('tag=code') && comboCall.includes('q=cat'), '分类与搜索词同时生效');
        ctrl.state.query = '';
        // categories 失败只隐藏 chips，不影响列表
        const failDoc = { getElementById(id){ return els[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() };
        const ctrlFail = NP.createController({
            document: failDoc,
            fetchImpl: u => {
                if (u.indexOf('/categories') >= 0) return Promise.resolve({ ok: false, status: 500 });
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 1, page: 1, pageCount: 1, items: [{ id: 'x', title: 'X', prompt: 'p' }] }) });
            },
            onApply(){}
        });
        await ctrlFail.enter();
        ok(ctrlFail.state.categoriesLoaded && ctrlFail.state.categories.length === 0, 'categories 失败后记录已加载（不再重试）');
        ok(els.onlinePromptChips.hidden === true, 'categories 失败时隐藏 chips');
        ok(ctrlFail.state.items.length === 1, 'categories 失败不影响列表加载');
        ok(moreSnapshot.list.includes('data-online-id="p2"'), '列表渲染新卡片');
        ok(moreSnapshot.detail === '', '详情默认不自动选中/不渲染');
        // 竞态：连续两个请求只认最后一次
        let resolvers = [];
        const ctrl2 = NP.createController({
            document: doc,
            fetchImpl: () => new Promise(resolve => { resolvers.push(resolve); }),
            onApply(){}
        });
        const a = ctrl2.load(1);
        const b = ctrl2.load(1);
        resolvers[0]({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, page: 1, pageCount: 1, items: [{ id: 'old', prompt: 'old' }] }) });
        resolvers[1]({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, page: 1, pageCount: 1, items: [{ id: 'new', prompt: 'new' }] }) });
        await a; await b;
        ok(ctrl2.state.items.length === 1 && ctrl2.state.items[0].id === 'new', '只认最后一次响应（防竞态）');
        console.log('[5b] 刷新与更新时间');
        ok(NP.buildUrl({ q: '', page: 1, refresh: true }).includes('refresh=true'), 'buildUrl 支持 refresh=true');
        ok(NP.formatUpdatedAt(30, false).includes('刚刚'), '<1 分钟显示刚刚');
        ok(NP.formatUpdatedAt(120, false).includes('2 分钟前'), '分钟文案');
        ok(NP.formatUpdatedAt(7200, false).includes('2 小时前'), '小时文案');
        ok(NP.formatUpdatedAt(7200, true).includes('离线缓存') && NP.formatUpdatedAt(7200, true).includes('2 小时前'), 'stale 显示离线缓存 · 小时前');
        const normMeta = NP.normalizePayload({ ok: true, total: 1, page: 1, pageCount: 1, items: [{ id: 'a', prompt: 'p' }], updatedAt: '2026-10-18T10:00:00Z', stale: true, ageSeconds: 7200 });
        ok(normMeta.stale === true && normMeta.ageSeconds === 7200 && normMeta.updatedAt.includes('2026-10-18'), '列表响应携带 updatedAt/stale/ageSeconds');
        // 默认电商 + 详情默认隐藏/点开/关闭
        const defaultEls = {};
        ['onlinePromptPanel','onlinePromptList','onlinePromptDetail','onlinePromptSearch','onlinePromptEntry','onlinePromptChips','onlinePromptSearchHint','onlinePromptRefresh','onlinePromptUpdatedAt','promptTemplatePanel'].forEach(id => { defaultEls[id] = fakeEl(); });
        defaultEls.onlinePromptDetail.hidden = true;
        const defaultCalls = [];
        const defaultCtrl = NP.createController({
            document: { getElementById(id){ return defaultEls[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() },
            fetchImpl: u => {
                defaultCalls.push(u);
                if (u.indexOf('/categories') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'ecommerce', count: 21 }, { key: 'video', count: 10 }] }) });
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 1, page: 1, pageCount: 1, items: [{ id: 'e1', title: 'E', prompt: 'EP' }] }) });
            },
            onApply(){}
        });
        await defaultCtrl.enter();
        await new Promise(resolve => setTimeout(resolve, 0));
        ok(defaultCtrl.state.activeTag === 'ecommerce', '进入在线模式默认选中电商');
        ok(defaultCalls.some(u => u.indexOf('/online?') >= 0 && u.indexOf('tag=ecommerce') >= 0), '默认请求带 tag=ecommerce');
        ok(defaultEls.onlinePromptDetail.hidden === true && defaultEls.onlinePromptDetail.innerHTML === '', '详情默认隐藏且无占位文案');
        defaultCtrl.select('e1');
        ok(defaultEls.onlinePromptDetail.hidden === false && defaultEls.onlinePromptDetail.innerHTML.includes('data-online-detail-close'), '点卡片后详情展开并带关闭按钮');
        defaultCtrl.select('');
        ok(defaultEls.onlinePromptDetail.hidden === true, '关闭后详情回到隐藏');
        // 智能搜索提示：expanded / fuzzy / exact / 切分类清空
        let hintMode = 'expanded';
        const hintCtrl = NP.createController({
            document: { getElementById(id){ return els[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() },
            fetchImpl: u => {
                if (u.indexOf('/categories') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'ecommerce', count: 9 }, { key: 'video', count: 5 }] }) });
                const mode = u.indexOf('tag=') >= 0 ? 'none' : hintMode;
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 2, page: 1, pageCount: 1, items: [{ id: 'h', title: 'H', prompt: 'P' }], matchMode: mode, expandedTerms: mode === 'expanded' ? ['商品','网店','营销'] : [] }) });
            },
            onApply(){}
        });
        await hintCtrl.enter();
        await new Promise(resolve => setTimeout(resolve, 0));
        hintCtrl.state.activeTag = null;
        await hintCtrl.load(1);
        ok(els.onlinePromptSearchHint.hidden === false && els.onlinePromptSearchHint.textContent.includes('已扩展搜索') && els.onlinePromptSearchHint.textContent.includes('商品 / 网店 / 营销'), 'expanded 显示提示与展开词');
        hintMode = 'fuzzy';
        await hintCtrl.load(1);
        ok(els.onlinePromptSearchHint.textContent.includes('以下为相关内容'), 'fuzzy 显示提示');
        hintMode = 'exact';
        await hintCtrl.load(1);
        ok(els.onlinePromptSearchHint.hidden === true, 'exact 不显示提示');
        hintMode = 'expanded';
        await hintCtrl.load(1);
        await hintCtrl.selectTag('ecommerce');
        ok(els.onlinePromptSearchHint.hidden === true, '切分类后提示清空');
        // local 条目：应用仍有效
        const localApplyCalls = [];
        const localEls = {};
        ['onlinePromptPanel','onlinePromptList','onlinePromptDetail','onlinePromptSearch','onlinePromptEntry','onlinePromptChips','onlinePromptSearchHint','onlinePromptRefresh','onlinePromptUpdatedAt','promptTemplatePanel'].forEach(id => { localEls[id] = fakeEl(); });
        const localCtrl = NP.createController({
            document: { getElementById(id){ return localEls[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() },
            fetchImpl: u => {
                if (u.indexOf('/categories') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'ecommerce', count: 10 }] }) });
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 1, page: 1, pageCount: 1, items: [localItem], matchMode: 'expanded', expandedTerms: ['商品','网店'] }) });
            },
            onApply(item){ localApplyCalls.push(item && item.id); }
        });
        await localCtrl.load(1);
        ok(localEls.onlinePromptList.innerHTML.includes('online-prompt-curated'), 'local 卡片渲染精选标签');
        localCtrl.select('local-1');
        localCtrl.applySelected();
        ok(localApplyCalls.length === 1 && localApplyCalls[0] === 'local-1', 'local 条目应用到画布仍有效（stub）');
        ok(localEls.onlinePromptSearchHint.textContent.includes('已扩展搜索'), 'expanded 下提示行正常（含 local 结果）');
        // 刷新：列表 + categories 各一次 refresh=true；分类数量更新；已选分类不存在回退无分类
        const refreshCalls = [];
        let catCount = 10;
        const refreshCtrl = NP.createController({
            document: { getElementById(id){ return els[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() },
            fetchImpl: u => {
                refreshCalls.push(u);
                if (u.indexOf('/categories') >= 0) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'write', count: catCount }], updatedAt: '2026-10-18T10:00:00Z', ageSeconds: 120, stale: false }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, total: 1, page: 1, pageCount: 1, items: [{ id: 'r1', title: 'R', prompt: 'P' }], updatedAt: '2026-10-18T10:00:00Z', ageSeconds: 90, stale: false }) });
            },
            onApply(){}
        });
        await refreshCtrl.enter();
        await new Promise(resolve => setTimeout(resolve, 0));
        refreshCtrl.state.activeTag = 'removed';
        refreshCtrl.state.selectedId = 'x';
        refreshCalls.length = 0;
        catCount = 3;
        await refreshCtrl.refresh();
        const listRefresh = refreshCalls.filter(u => u.indexOf('/categories') < 0);
        const catRefresh = refreshCalls.filter(u => u.indexOf('/categories') >= 0);
        ok(listRefresh.length === 1 && listRefresh[0].includes('refresh=true'), '刷新列表请求带 refresh=true（一次）');
        ok(catRefresh.length === 1 && catRefresh[0].includes('refresh=true'), '刷新 categories 请求带 refresh=true（一次）');
        ok(refreshCtrl.state.activeTag === null, '刷新后已选分类不存在 → 回退无分类');
        ok(refreshCtrl.state.categories[0].count === 3, 'chips 数量随刷新更新');
        ok(els.onlinePromptUpdatedAt && els.onlinePromptUpdatedAt.textContent.includes('1 分钟前'), '更新时间文案刷新（1 分钟前）');
        // 刷新失败：列表进入错误态，按钮恢复可用
        const failRefreshCtrl = NP.createController({
            document: { getElementById(id){ return els[id] || null; }, createElement(){ return fakeEl(); }, body: fakeEl() },
            fetchImpl: u => {
                if (u.indexOf('/categories') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, items: [{ key: 'write', count: 1 }] }) });
                return Promise.resolve({ ok: false, status: 502 });
            },
            onApply(){}
        });
        await failRefreshCtrl.enter();
        await new Promise(resolve => setTimeout(resolve, 0));
        await failRefreshCtrl.refresh();
        ok(failRefreshCtrl.state.error, '刷新失败进入错误态');
        ok(failRefreshCtrl.state.refreshing === false, '失败后刷新按钮恢复');
        console.log('[6] 静态结构 / 样式 / i18n / 应用逻辑');
        ok(/id="onlinePromptEntry"[^>]*data-i18n="smart\.onlineLibrary"/.test(html), '入口按钮在模板库面板里');
        ['onlinePromptPanel','onlinePromptChips','onlinePromptList','onlinePromptDetail','onlinePromptSearch'].forEach(id => {
            ok(html.includes('id="' + id + '"'), '在线模式节点：' + id);
        });
        ok(/id="onlinePromptChips"[^>]*hidden/.test(html), 'chips 容器默认隐藏（拿到分类再显示）');
        ok(/\.online-prompt-chips \{[\s\S]*?flex-wrap: wrap;/.test(css), 'chips 可换行');
        ok(/\.online-prompt-chip \{[\s\S]*?height: 24px;[\s\S]*?border-radius: var\(--radius-full\);[\s\S]*?font-size: 10\.5px;/.test(css), 'chip 24 高/full 圆角/10.5px');
        ok(/\.online-prompt-chip\.is-active \{ background: var\(--soft\); color: var\(--text\); font-weight: 600; \}/.test(css), '选中 chip 用 var(--soft) 实底 + 600');
        ok(html.indexOf('online-prompt-library.js') > 0 && html.indexOf('online-prompt-library.js') < html.indexOf('smart-canvas.js?'), '脚本在 smart-canvas 前加载');
        ok(/#promptTemplatePanel\.is-online #promptTemplateBody \{ display: none !important; \}/.test(css), '在线模式隐藏本地列表');
        ok(/\.online-prompt-list \{[\s\S]*?overflow: auto;/.test(css) && /\.online-prompt-detail \{[\s\S]*?overflow: auto;/.test(css), '列表/详情内部滚动');
        ok(/window\.applyPromptTextToCanvas = applyPromptTextToCanvas;/.test(smart), '在线库复用 applyPromptTextToCanvas');
        ok(/function applyPromptTemplateToNode\(mode='positive'\)\{[\s\S]*?applyPromptTextToCanvas\(promptTemplateText\(template, mode\)/.test(smart), '本地模板仍走同一段应用逻辑');
        ['smart.onlineLibrary','smart.onlineBack','smart.onlineSearchPlaceholder','smart.onlineLoading','smart.onlineLoadFailed','smart.onlineRetry','smart.onlineEmpty','smart.onlineLoadMore','smart.onlineSource','smart.onlineCopy','smart.onlineApply','smart.onlineSelectHint'].forEach(key => {
            ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{ zh: "[^"]+", en: "[^"]+" \\}').test(i18n), 'i18n 成对：' + key);
        });
        console.log('');
        console.log('在线提示词库回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
        fails.forEach(f => console.log('  ✗ ' + f));
        if (fails.length) process.exit(1);
    })().catch(err => { console.error(err); process.exit(1); });
}).catch(err => { console.error(err); process.exit(1); });
});
