// 「资产库」区域：库 / 分组 / 智能分类、管理模式、剪贴板、移动到、上传、下载、智能分类、编辑、平台注册
import { reactive } from 'vue';
import { S, setStatus, fail, ensureCaptionModel, openPreview } from './state.js';
import { apiJson, jsonBody, assetKind, assetKindLabel, downloadAsAttachment, assetDownloadName, downloadZip, writeCanvasInbox, countKinds, buildKindTabs, matchesKind } from './util.js';
import { classEntriesForItems, classSearchText, itemsMatchingClass, classGroupIdForKey } from './classify.js';

export const L = reactive({
    libId: '', catId: '', classFilter: '', openGroup: 'environment', focus: 'category',
    sel: '', ids: new Set(), query: '', manage: false, moveTarget: '', clipboard: null,
    edit: false, pendingDelete: '', pendingBatch: false, treeEdit: null, pendingTreeDelete: '',
    classifyBusy: false, avatarProvider: '', avatarBusy: '',
});

/* ───────── 读取 ───────── */
export function libraries() {
    const lib = S.assetLibrary;
    return Array.isArray(lib.libraries) && lib.libraries.length ? lib.libraries : [{ id: 'default', name: '默认资产库', categories: lib.categories || [] }];
}
export function activeLib() {
    const libs = libraries();
    return libs.find(l => l.id === L.libId) || libs.find(l => l.id === S.assetLibrary.active_library_id) || libs[0] || null;
}
export const imageCats = lib => (lib?.categories || []).filter(c => (c.type || 'image') === 'image');
export function categories() { return imageCats(activeLib()); }
export function activeCat() { const cats = categories(); return cats.find(c => c.id === L.catId) || cats[0] || null; }
export const libId = () => activeLib()?.id || '';
export const catId = () => activeCat()?.id || '';
export function countForLib(lib) { return imageCats(lib).reduce((n, c) => n + (c.items || []).length, 0); }
export function classEntries(lib = activeLib()) { return classEntriesForItems(imageCats(lib).flatMap(c => c.items || [])); }
export function activeClassEntry() { return classEntries().find(e => e.key === L.classFilter) || null; }
export function findAsset(id) {
    for (const lib of libraries()) for (const cat of lib.categories || []) for (const item of cat.items || []) if (item.id === id) return item;
    return null;
}
// 当前分组 / 智能分类 / 搜索过滤后的完整集合（不含类型筛选），类型计数和类型筛选都以它为基础
export function baseItems() {
    const q = L.query.trim().toLowerCase();
    const filter = activeClassEntry() ? L.classFilter : '';
    const source = filter
        ? itemsMatchingClass(categories().flatMap(c => c.items || []), filter)
        : q ? categories().flatMap(c => c.items || []) : (activeCat()?.items || []);
    if (!q) return source;
    return source.filter(item => [item.name, item.url, assetKindLabel(item), classSearchText(item)].join(' ').toLowerCase().includes(q));
}
export function currentItems() { return baseItems().filter(item => matchesKind(item, S.kind)); }
// 类型页签的数量 = 当前资产库的完整素材集（与来源页签的计法一致，不随搜索/分类变化）
export function kindTotals() { return countKinds(categories().flatMap(c => c.items || [])); }
export function kindTabs() { return buildKindTabs(kindTotals(), S.kind); }
export function selectedItem(items = currentItems()) { return items.find(i => i.id === L.sel) || items[0] || null; }
export function viewTitle() { const e = activeClassEntry(); return e ? (e.tag || '智能分类') : (activeCat()?.name || '图片资产'); }
export function viewSubtitle(n) {
    const libName = activeLib()?.name || '资产库';
    const e = activeClassEntry();
    return e ? `${libName} / 智能分类：${e.label} / ${n} 个素材` : `${libName} / ${n} 个素材`;
}
export function selectedImages() { return [...L.ids].map(findAsset).filter(i => i && assetKind(i) === 'image'); }
export function moveTargets() {
    const cur = `${libId()}::${catId()}`;
    const out = [];
    libraries().forEach(lib => imageCats(lib).forEach(cat => {
        const key = `${lib.id}::${cat.id}`;
        if (key !== cur) out.push({ value: key, label: `${lib.name || '资产库'} / ${cat.name || '分组'}` });
    }));
    if (!out.some(t => t.value === L.moveTarget)) L.moveTarget = out[0]?.value || '';
    return out;
}

function setLibrary(data) {
    if (data && data.library) S.assetLibrary = data.library;
    L.ids = new Set([...L.ids].filter(id => findAsset(id)));
}
export function resetToDefault() {
    const libs = libraries();
    L.libId = (libs.find(l => l.id === 'default') || libs[0])?.id || '';
    L.catId = ''; L.sel = ''; L.classFilter = '';
    L.ids.clear();
}

/* ───────── 树导航 ───────── */
function clearPending() { L.pendingDelete = ''; L.pendingBatch = false; }
export function selectLib(id) {
    L.libId = id; L.focus = 'library'; L.classFilter = '';
    L.catId = categories()[0]?.id || ''; L.sel = ''; L.ids.clear(); L.edit = false;
}
export function selectCat(lid, cid) {
    L.libId = lid || L.libId; L.catId = cid; L.classFilter = ''; L.focus = 'category'; L.sel = ''; L.ids.clear(); L.edit = false;
}
export function classRoot(lid) {
    L.libId = lid || L.libId; L.focus = 'class';
    if (!classEntries().length) setStatus('暂无智能分类，请先选择图片并点击“智能分类”');
}
export function toggleGroup(gid) { L.openGroup = L.openGroup === gid ? '' : gid; }
export function toggleClassFilter(key, lid) {
    if (lid) L.libId = lid;
    L.classFilter = L.classFilter === key ? '' : key;
    if (L.classFilter) L.openGroup = classGroupIdForKey(L.classFilter, classEntries()) || L.openGroup;
    L.focus = 'class'; L.sel = ''; L.ids.clear(); clearPending();
}

/* ───────── 选择 ───────── */
export function toggleSelect(id) {
    if (L.ids.has(id)) { L.ids.delete(id); if (L.sel === id) L.sel = ''; } else { L.ids.add(id); L.sel = id; }
    clearPending();
}
export function clickCard(id) {
    if (L.manage) toggleSelect(id); else L.sel = id;
    L.edit = false; clearPending();
}
export function toggleManage() { L.manage = !L.manage; clearPending(); if (!L.manage) L.ids.clear(); }
export function selectAll() { currentItems().forEach(i => L.ids.add(i.id)); clearPending(); }
export function clearSelection() { L.ids.clear(); clearPending(); }

/* ───────── 树内编辑（新建库 / 重命名库 / 新分组 / 重命名分组） ───────── */
export function startTreeEdit(kind, extra = {}) {
    if (extra.libId) L.libId = extra.libId;
    if (extra.catId) L.catId = extra.catId;
    const map = {
        'library-new': { placement: 'head', value: '新资产库', label: '资产库名称' },
        'library-rename': { value: activeLib()?.name || '', label: '资产库名称' },
        'category-new': { value: '新分组', label: '分组名称' },
        'category-rename': { value: activeCat()?.name || '', label: '分组名称' },
    };
    if (kind.startsWith('library')) L.focus = 'library';
    if (kind === 'category-rename') L.focus = 'category';
    L.treeEdit = { kind, ...map[kind] };
    L.pendingTreeDelete = '';
}
export async function saveTreeEdit(name) {
    const ed = L.treeEdit;
    if (!ed) return;
    if (!String(name || '').trim()) { setStatus('名称不能为空'); return false; }
    let data = null;
    if (ed.kind === 'library-new') {
        data = await apiJson('/api/asset-library/libraries', jsonBody('POST', { name }));
        setLibrary(data);
        L.libId = data.asset_library?.id || L.libId; L.catId = ''; L.classFilter = ''; L.focus = 'library';
    } else if (ed.kind === 'library-rename') {
        const lib = activeLib(); if (!lib) return;
        setLibrary(await apiJson(`/api/asset-library/libraries/${encodeURIComponent(lib.id)}`, jsonBody('PATCH', { name })));
        L.focus = 'library';
    } else if (ed.kind === 'category-new') {
        data = await apiJson('/api/asset-library/categories', jsonBody('POST', { library_id: libId(), name, type: 'image' }));
        setLibrary(data);
        L.catId = data.category?.id || L.catId; L.classFilter = ''; L.focus = 'category';
    } else if (ed.kind === 'category-rename') {
        const cat = activeCat(); if (!cat) return;
        setLibrary(await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}`, jsonBody('PATCH', { name })));
        L.focus = 'category';
    }
    L.treeEdit = null; L.pendingTreeDelete = '';
    setStatus('已保存');
}
export async function deleteLib(lid) {
    if (lid) L.libId = lid;
    const lib = activeLib(); if (!lib) return;
    const key = `asset-lib:${lib.id}`;
    if (L.pendingTreeDelete !== key) { L.pendingTreeDelete = key; L.treeEdit = null; setStatus('再次点击确认删除资产库'); return; }
    setLibrary(await apiJson(`/api/asset-library/libraries/${encodeURIComponent(lib.id)}`, { method: 'DELETE' }));
    L.libId = S.assetLibrary.active_library_id || libraries()[0]?.id || '';
    L.catId = ''; L.classFilter = ''; L.sel = ''; L.ids.clear(); L.pendingTreeDelete = '';
}
export async function deleteCat() {
    const cat = activeCat(); if (!cat) return;
    const key = `asset-cat:${cat.id}`;
    if (L.pendingTreeDelete !== key) { L.pendingTreeDelete = key; L.treeEdit = null; setStatus('再次点击确认删除分组'); return; }
    setLibrary(await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}`, { method: 'DELETE' }));
    L.catId = ''; L.classFilter = ''; L.sel = ''; L.ids.clear(); L.pendingTreeDelete = '';
}

/* ───────── 上传 ───────── */
export async function uploadFiles(files) {
    if (!activeCat()) throw new Error('请先创建图片分组');
    const form = new FormData();
    [...files].forEach(f => form.append('files', f));
    setStatus('正在上传...');
    const uploaded = await apiJson('/api/ai/upload', { method: 'POST', body: form });
    const lid = libId(), cid = catId();
    const items = (uploaded.files || []).filter(f => f?.url).map(f => ({ library_id: lid, category_id: cid, url: f.url, name: f.name || 'asset' }));
    if (!items.length) throw new Error('没有可保存的素材');
    const data = await apiJson('/api/asset-library/items/batch', jsonBody('POST', { library_id: lid, category_id: cid, items }));
    setLibrary(data);
    L.ids.clear();
    L.sel = data.items?.[0]?.id || L.sel;
    setStatus(`已上传 ${items.length} 个素材`);
}

/* ───────── 剪贴板 / 移动到 ───────── */
export function setClipboard(mode) {
    if (!L.ids.size) return;
    L.clipboard = { mode, ids: [...L.ids], sourceLibraryId: libId(), sourceCategoryId: catId(), items: [...L.ids].map(findAsset).filter(Boolean) };
    L.ids.clear(); clearPending();
    setStatus(`${mode === 'cut' ? '剪切' : '复制'}了 ${L.clipboard.ids.length} 个素材，切换分组后粘贴`);
}
export function clipboardSameTarget() { const c = L.clipboard; return !!c && c.sourceLibraryId === libId() && c.sourceCategoryId === catId(); }
export async function pasteClipboard() {
    const c = L.clipboard;
    if (!c?.ids?.length) return;
    if (c.mode === 'cut') {
        if (clipboardSameTarget()) return;
        const data = await apiJson('/api/asset-library/items/move', jsonBody('POST', { library_id: c.sourceLibraryId, target_library_id: libId(), target_category_id: catId(), ids: c.ids }));
        setLibrary(data);
        setStatus(`已移动 ${data.moved || 0} 个素材`);
    } else {
        const items = (c.items || []).map(i => ({ url: i.url, name: i.name || 'asset' })).filter(i => i.url);
        const data = await apiJson('/api/asset-library/items/batch', jsonBody('POST', { library_id: libId(), category_id: catId(), items }));
        setLibrary(data);
        setStatus(`已复制 ${data.items?.length || 0} 个素材`);
    }
    L.clipboard = null; L.ids.clear(); L.sel = '';
}
// 旧代码里写好了但界面上没有入口的「移动到…」（moveSelectedAssets / assetMoveTarget），本次补上下拉
export async function moveSelected(target = L.moveTarget) {
    if (!L.ids.size || !target) return;
    const [tLib, tCat] = target.split('::');
    if (!tLib || !tCat) return;
    const ids = [...L.ids];
    const data = await apiJson('/api/asset-library/items/move', jsonBody('POST', { library_id: libId(), target_library_id: tLib, target_category_id: tCat, ids }));
    setLibrary(data);
    L.ids.clear();
    if (ids.includes(L.sel)) L.sel = '';
    setStatus(`已移动 ${data.moved || 0} 个素材`);
}

/* ───────── 下载 / 复制到画布 / 删除 ───────── */
export function downloadOne(id) {
    const item = findAsset(id);
    if (!item || !item.url) { setStatus('没有可下载的素材'); return; }
    downloadAsAttachment(item);
    setStatus('已开始下载');
}
export async function downloadSelected() {
    const items = [...L.ids].map(findAsset).filter(i => i?.url);
    if (!items.length) { setStatus('没有可下载的素材'); return; }
    if (items.length === 1) { downloadOne(items[0].id); return; }
    setStatus(`正在打包 ${items.length} 个素材...`);
    try {
        await downloadZip('assets.zip', items.map(i => ({ url: i.url, name: assetDownloadName(i) })));
        setStatus(`已下载 ${items.length} 个素材`);
    } catch (err) { fail(err, '下载失败'); }
}
export function copyToCanvas() {
    try {
        const n = writeCanvasInbox([...L.ids].map(findAsset));
        if (!n) { setStatus('没有可复制的素材'); return; }
        setStatus(`已复制 ${n} 个素材，去智能画布按 Ctrl+V 粘贴`);
    } catch (err) { setStatus('复制失败：' + (err?.message || err)); }
}
// 单个删除：改成与工作流一致的「再点一次确认」（旧版点一下就删）
export async function deleteOne(id) {
    if (!findAsset(id)) return;
    if (L.pendingDelete !== id) { L.pendingDelete = id; setStatus('再次点击确认删除素材'); return; }
    setLibrary(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    L.ids.delete(id);
    if (L.sel === id) L.sel = '';
    L.pendingDelete = '';
    setStatus('素材已删除');
}
export async function deleteSelected() {
    if (!L.ids.size) return;
    if (!L.pendingBatch) { L.pendingBatch = true; setStatus('再次点击确认删除所选素材'); return; }
    const ids = [...L.ids];
    const data = await apiJson('/api/asset-library/items/delete', jsonBody('POST', { library_id: libId(), ids }));
    setLibrary(data);
    if (ids.includes(L.sel)) L.sel = '';
    L.ids.clear(); L.pendingBatch = false;
    setStatus(`已删除 ${data.removed || ids.length} 个素材`);
}

/* ───────── 编辑 / 重命名 ───────── */
export function startEdit(id) { L.sel = id || L.sel; L.edit = true; L.pendingDelete = ''; }
export async function saveEdit(id, name) {
    if (!findAsset(id) || !String(name || '').trim()) { setStatus('素材名称不能为空'); return false; }
    setLibrary(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, jsonBody('PATCH', { name })));
    L.sel = id; L.edit = false;
    setStatus('素材已保存');
}
export async function saveInlineName(id, name) {
    const item = findAsset(id);
    if (!item || !String(name || '').trim() || String(item.name || '') === String(name)) return;
    setLibrary(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, jsonBody('PATCH', { name })));
    L.sel = id;
    setStatus('素材名称已保存');
}
export function preview(id) { const it = findAsset(id); if (it) openPreview(it.url, assetKind(it), it.name); }

/* ───────── AI 智能分类 ───────── */
export async function classifySelected() {
    const images = selectedImages();
    if (!images.length || L.classifyBusy) return;
    if (!ensureCaptionModel()) return;
    L.classifyBusy = true;
    setStatus(`正在智能分类 ${images.length} 张资产图片...`);
    try {
        const data = await apiJson('/api/asset-library/items/classify', jsonBody('POST', {
            library_id: libId(), ids: images.map(i => i.id), provider: S.caption.provider, model: S.caption.model, prompt: (S.caption.classifyPrompt || '').trim(),
        }));
        setLibrary(data);
        if (images[0]?.id) L.sel = images[0].id;
        const failed = (data.items || []).filter(i => !i.ok);
        setStatus(failed.length ? `处理完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '分类失败'}` : `处理完成 ${data.count || images.length} 张资产图片`);
    } catch (err) { fail(err, '智能分类失败'); } finally { L.classifyBusy = false; }
}
export { setLibrary };
