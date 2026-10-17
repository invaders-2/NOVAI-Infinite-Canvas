// 「本地上传」区域（assets/uploads）：文件夹树、智能分类筛选、上传、剪切/移动、下载、复制到画布、删除、
// 行内重命名、提示词反推（批量 / 单张）、智能分类、反推提示词编辑保存
import { reactive } from 'vue';
import { S, setStatus, fail, ensureCaptionModel, loadLocalAssets, openPreview } from './state.js';
import { apiJson, jsonBody, assetKind, assetKindLabel, isLocalMediaFile, downloadAsAttachment, assetDownloadName, downloadZip, writeCanvasInbox, countKinds, buildKindTabs, matchesKind } from './util.js';
import { classEntriesForItems, classSearchText, itemsMatchingClass } from './classify.js';

export const U = reactive({
    folder: '', classFilter: '', openGroup: '', sel: '', ids: new Set(), query: '', manage: false,
    clipboard: null, captionBusy: false, classifyBusy: false, classifyPromptOpen: false,
    pendingBatch: false, pendingDelete: '', renaming: '',
});

export function findUpload(id) { return (S.localAssets || []).find(i => i.id === id) || null; }
function walk(node, fn) { if (!node) return null; if (fn(node)) return node; for (const c of node.children || []) { const r = walk(c, fn); if (r) return r; } return null; }
export function folderByPath(path = '') { return walk(S.localTree, n => String(n.path || '') === String(path || '')); }
export function folderContainsActive(folder) {
    if (!folder || activeClassEntry()) return false;
    if (String(folder.path || '') === U.folder) return true;
    return (folder.children || []).some(folderContainsActive);
}
export function classEntries() { return classEntriesForItems((S.localAssets || []).filter(i => assetKind(i) === 'image')); }
export function activeClassEntry() { return classEntries().find(e => e.key === U.classFilter) || null; }
// 当前文件夹 / 智能分类 / 搜索过滤后的完整集合（不含类型筛选），类型计数和类型筛选都以它为基础
export function baseItems() {
    const q = String(U.query || '').trim().toLowerCase();
    let list = (S.localAssets || []).slice();
    if (activeClassEntry()) list = itemsMatchingClass(S.localAssets, U.classFilter);
    else if (U.folder && !q) list = list.filter(it => String(it.folder || '') === U.folder);
    if (q) list = list.filter(it => [it.name, it.file, assetKindLabel(it), classSearchText(it)].join(' ').toLowerCase().includes(q));
    return list;
}
export function items() { return baseItems().filter(it => matchesKind(it, S.kind)); }
// 类型页签的数量 = 全部本地上传（没有音频就不显示音频，与来源页签的计法一致）
export function kindTotals() { return countKinds(S.localAssets || []); }
export function kindTabs() { return buildKindTabs(kindTotals(), S.kind); }
export function folderTitle() {
    const e = activeClassEntry();
    if (e) return e.tag || '智能分类';
    if (!U.folder) return '本地上传';
    return folderByPath(U.folder)?.name || U.folder.split('/').pop() || '本地上传';
}
export function viewSubtitle(n) {
    const e = activeClassEntry();
    return e ? `智能分类：${e.label} / ${n} 个素材` : `${n} / ${(S.localAssets || []).length} 个素材`;
}
export function selectedImages() { return [...U.ids].map(findUpload).filter(i => i && assetKind(i) === 'image'); }
// 选中的素材「真的不存在了」才清空；只是被分类/筛选挡住时保留预览（旧版的有意设计，方便对照找相似图）
export function detailItem(list = items()) {
    if (U.sel && findUpload(U.sel)) return findUpload(U.sel);
    return list[0] || null;
}
// 数据重载后清理无效状态（旧 loadLocalAssets 尾部那段）
export function afterLoad() {
    if (U.folder && !folderByPath(U.folder)) U.folder = '';
    if (U.classFilter && !activeClassEntry()) U.classFilter = '';
    U.ids = new Set([...U.ids].filter(id => findUpload(id)));
}
function clearPending() { U.pendingBatch = false; U.pendingDelete = ''; }

/* ───────── 导航 / 选择 ───────── */
export function selectFolder(path) { U.folder = path || ''; U.classFilter = ''; U.sel = ''; U.ids.clear(); clearPending(); }
export function toggleGroup(gid) { U.openGroup = U.openGroup === gid ? '' : gid; }
export function toggleClassFilter(key) { U.classFilter = U.classFilter === key ? '' : key; U.ids.clear(); clearPending(); }
export function classRoot() { if (!classEntries().length) setStatus('暂无智能分类，请先选择图片并点击“智能分类”'); }
export function toggleSelect(id) {
    if (U.ids.has(id)) { U.ids.delete(id); if (U.sel === id) U.sel = ''; } else { U.ids.add(id); U.sel = id; }
    clearPending();
}
export function clickCard(id) { if (U.manage) toggleSelect(id); else { U.sel = id; clearPending(); } }
export function toggleManage() { U.manage = !U.manage; clearPending(); if (!U.manage) U.ids.clear(); }
export function selectAll() { items().forEach(i => U.ids.add(i.id)); clearPending(); }
export function clearSelection() { U.ids.clear(); clearPending(); }
export function preview(id) { const it = findUpload(id); if (it) openPreview(it.url, assetKind(it), it.name); }

/* ───────── 上传 / 文件夹 ───────── */
export async function upload(files) {
    const list = [...(files || [])].filter(isLocalMediaFile);
    if (!list.length) { setStatus('没有可上传的图片/视频/音频文件'); return; }
    const form = new FormData();
    form.append('folder', U.folder || '');
    list.forEach(f => form.append('files', f));
    setStatus('正在上传...');
    try {
        const data = await apiJson('/api/local-assets/upload', { method: 'POST', body: form });
        const uploaded = Array.isArray(data.files) ? data.files : [];
        await loadLocalAssets();
        U.classFilter = '';
        U.sel = uploaded[0]?.id || U.sel;
        setStatus(`已上传 ${uploaded.length} 个素材`);
    } catch (err) { fail(err, '上传失败'); }
}
function applyTree(data) {
    S.localAssets = Array.isArray(data.items) ? data.items : S.localAssets;
    S.localTree = data.tree || S.localTree;
}
export async function createFolder(name) {
    if (!String(name || '').trim()) return;
    try {
        const data = await apiJson('/api/local-assets/folders', jsonBody('POST', { parent: U.folder || '', name }));
        applyTree(data);
        U.folder = data.folder?.path || U.folder; U.classFilter = ''; U.sel = ''; U.ids.clear();
        setStatus('已新建本地素材文件夹');
    } catch (err) { fail(err, '新建文件夹失败'); }
}
export async function renameFolder(name) {
    if (!U.folder) { setStatus('根目录不能重命名'); return; }
    if (!String(name || '').trim() || name === folderTitle()) return;
    try {
        const data = await apiJson('/api/local-assets/folders', jsonBody('PATCH', { path: U.folder, name }));
        applyTree(data);
        U.folder = data.folder?.path || U.folder; U.classFilter = ''; U.sel = ''; U.ids.clear();
        setStatus('已重命名本地素材文件夹');
    } catch (err) { fail(err, '重命名文件夹失败'); }
}
export async function saveName(id, name) {
    const item = findUpload(id);
    if (!item || !String(name || '').trim() || String(item.name || '') === String(name)) return;
    try {
        const data = await apiJson('/api/local-assets/items', jsonBody('PATCH', { path: item.file || item.id, name }));
        applyTree(data);
        U.sel = data.item?.id || data.item?.file || U.sel;
        if (U.ids.has(id)) { U.ids.delete(id); if (data.item?.id) U.ids.add(data.item.id); }
        setStatus('已重命名素材，反推提示词和分类索引已同步');
    } catch (err) { fail(err, '重命名失败'); }
}

/* ───────── 剪切 / 移动 ───────── */
export function cutSelected() {
    const ids = [...U.ids];
    if (!ids.length) { setStatus('没有选中的素材'); return; }
    U.clipboard = { ids, sourceFolder: U.folder || '' };
    U.ids.clear();
    setStatus(`已剪切 ${ids.length} 个素材，切换到目标文件夹后点"移动到此文件夹"`);
}
export function clipboardSameFolder() { return !!U.clipboard && String(U.clipboard.sourceFolder || '') === String(U.folder || ''); }
export async function pasteClipboard() {
    if (!U.clipboard?.ids?.length) return;
    const names = U.clipboard.ids.map(id => findUpload(id)?.file).filter(Boolean);
    if (!names.length) { U.clipboard = null; return; }
    setStatus('正在移动...');
    try {
        const data = await apiJson('/api/local-assets/move', jsonBody('POST', { names, folder: U.folder || '' }));
        await loadLocalAssets();
        U.clipboard = null; U.ids.clear();
        setStatus(`已移动 ${data?.moved ?? names.length} 个素材`);
    } catch (err) { fail(err, '移动失败'); }
}

/* ───────── 下载 / 画布 / 删除 ───────── */
export function downloadOne(id) {
    const item = findUpload(id);
    if (!item || !item.url) { setStatus('没有可下载的素材'); return; }
    downloadAsAttachment(item);
    setStatus('已开始下载');
}
export async function downloadSelected() {
    const list = [...U.ids].map(findUpload).filter(i => i?.url);
    if (!list.length) { setStatus('没有可下载的素材'); return; }
    if (list.length === 1) { downloadOne(list[0].id); return; }
    setStatus(`正在打包 ${list.length} 个素材...`);
    try {
        await downloadZip('local-assets.zip', list.map(i => ({ url: i.url, name: assetDownloadName(i) })));
        setStatus(`已下载 ${list.length} 个素材`);
    } catch (err) { fail(err, '下载失败'); }
}
export function copyToCanvas() {
    try {
        const n = writeCanvasInbox([...U.ids].map(findUpload));
        if (!n) { setStatus('没有可复制的素材'); return; }
        setStatus(`已复制 ${n} 个素材，去智能画布按 Ctrl+V 粘贴`);
    } catch (err) { setStatus('复制失败：' + (err?.message || err)); }
}
// 删除会删磁盘文件：加「再点一次确认」（旧版点一下就删）。key 区分批量 / 单个
export async function remove(ids, key) {
    const names = (ids || []).map(id => findUpload(id)?.file).filter(Boolean);
    if (!names.length) return;
    if (key === 'batch' ? !U.pendingBatch : U.pendingDelete !== key) {
        if (key === 'batch') U.pendingBatch = true; else U.pendingDelete = key;
        setStatus('再次点击确认删除（会删除磁盘文件）');
        return;
    }
    clearPending();
    setStatus('正在删除...');
    try {
        await apiJson('/api/local-assets/delete', jsonBody('POST', { names }));
        await loadLocalAssets();
        if (U.classFilter && !activeClassEntry()) U.classFilter = '';
        U.ids.clear();
        if (U.sel && !findUpload(U.sel)) U.sel = '';
        setStatus(`已删除 ${names.length} 个素材`);
    } catch (err) { fail(err, '删除失败'); }
}

/* ───────── 反推 / 分类 ───────── */
function captionBody(names, prompt) {
    return jsonBody('POST', { names, provider: S.caption.provider, model: S.caption.model, prompt });
}
export async function captionSelected() {
    const images = selectedImages();
    if (!images.length || U.captionBusy) return;
    if (!ensureCaptionModel()) return;
    U.captionBusy = true;
    setStatus(`正在反推 ${images.length} 张本地图片的提示词...`);
    try {
        const data = await apiJson('/api/local-assets/caption', captionBody(images.map(i => i.file || i.id), (S.caption.prompt || '描述图片').trim() || '描述图片'));
        await loadLocalAssets();
        U.ids.clear();
        if (images[0]?.id) U.sel = images[0].id;
        const failed = (data.items || []).filter(i => !i.ok);
        setStatus(failed.length ? `已完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '反推失败'}` : `已反推并保存 ${data.count || images.length} 张图片提示词`);
    } catch (err) { fail(err, '提示词反推失败'); } finally { U.captionBusy = false; }
}
export async function captionOne(id) {
    const item = findUpload(id);
    if (!item || assetKind(item) !== 'image' || U.captionBusy || U.classifyBusy) return;
    if (!ensureCaptionModel()) return;
    U.captionBusy = true; U.sel = item.id;
    setStatus(`正在反推「${item.name || '本地图片'}」的提示词...`);
    try {
        const data = await apiJson('/api/local-assets/caption', captionBody([item.file || item.id], (S.caption.prompt || '描述图片').trim() || '描述图片'));
        const result = (data.items || [])[0] || null;
        if (result && !result.ok) throw new Error(result.error || '反推失败');
        await loadLocalAssets();
        U.sel = item.id;
        setStatus('已反推并保存当前图片提示词');
    } catch (err) { fail(err, '提示词反推失败'); } finally { U.captionBusy = false; }
}
export async function classifySelected() {
    const images = selectedImages();
    if (!images.length || U.classifyBusy) return;
    if (!ensureCaptionModel()) return;
    U.classifyBusy = true;
    setStatus(`正在智能分类 ${images.length} 张本地图片...`);
    try {
        const data = await apiJson('/api/local-assets/classify', captionBody(images.map(i => i.file || i.id), (S.caption.classifyPrompt || '').trim()));
        await loadLocalAssets();
        if (images[0]?.id) U.sel = images[0].id;
        const failed = (data.items || []).filter(i => !i.ok);
        setStatus(failed.length ? `处理完成 ${data.count || 0} 张，${failed.length} 张失败：${failed[0].error || '分类失败'}` : `处理完成 ${data.count || images.length} 张图片`);
    } catch (err) { fail(err, '智能分类失败'); } finally { U.classifyBusy = false; }
}
export async function saveCaption(id, caption) {
    const item = findUpload(id);
    if (!item || assetKind(item) !== 'image') return;
    try {
        const data = await apiJson('/api/local-assets/caption', jsonBody('PATCH', { name: item.file || item.id, caption }));
        item.caption = data.caption || '';
        item.caption_file = data.caption_file || item.caption_file || '';
        setStatus('已保存反推提示词');
    } catch (err) { fail(err, '保存提示词失败'); return false; }
}
