// 「工作流」：工作流分组（资产库里 type=workflow 的分组）、上传 JSON / ZIP、导出、重命名、删除
import { reactive } from 'vue';
import { S, setStatus } from './state.js';
import { apiJson, jsonBody, downloadUrl, downloadZip, workflowKindLabel } from './util.js';
import { libraries } from './library.js';

export const W = reactive({ libId: '', catId: '', sel: '', ids: new Set(), query: '', manage: false, pendingDelete: '', pendingBatch: false, treeEdit: null, pendingTreeDelete: '' });

export function categories() {
    const cats = [];
    libraries().forEach(lib => (lib.categories || []).filter(c => (c.type || '') === 'workflow').forEach(c => cats.push({ ...c, __libraryId: lib.id, __libraryName: lib.name || '资产库' })));
    return cats;
}
export function activeCat() {
    const cats = categories();
    return cats.find(c => c.id === W.catId && c.__libraryId === W.libId) || cats.find(c => c.id === W.catId) || cats[0] || null;
}
export function activeLibId() {
    const c = activeCat();
    if (c) return c.__libraryId;
    const libs = libraries();
    return (libs.find(l => l.id === W.libId) || libs.find(l => l.id === S.assetLibrary.active_library_id) || libs[0])?.id || '';
}
export function total() { return categories().reduce((n, c) => n + (c.items || []).length, 0); }
export function currentItems() {
    const q = W.query.trim().toLowerCase();
    return (activeCat()?.items || []).filter(item => !q || [item.name, item.url, workflowKindLabel(item)].join(' ').toLowerCase().includes(q));
}
export function findWorkflow(id) {
    for (const lib of libraries()) for (const cat of lib.categories || []) {
        if ((cat.type || '') !== 'workflow') continue;
        for (const i of cat.items || []) if (i.id === id) return i;
    }
    return null;
}
export function selectedItem(list = currentItems()) { return list.find(i => i.id === W.sel) || list[0] || null; }
function setLib(data) {
    if (data && data.library) S.assetLibrary = data.library;
    W.ids = new Set([...W.ids].filter(id => findWorkflow(id)));
}
export function resetToDefault() {
    const libs = libraries();
    W.libId = (libs.find(l => l.id === 'default') || libs[0])?.id || '';
    W.catId = ''; W.sel = ''; W.ids.clear();
}

export function selectCat(libId, catId) { W.libId = libId || W.libId; W.catId = catId; W.sel = ''; W.ids.clear(); }
export function toggleSelect(id) { W.pendingBatch = false; if (W.ids.has(id)) { W.ids.delete(id); if (W.sel === id) W.sel = ''; } else { W.ids.add(id); W.sel = id; } }
export function clickCard(id) { if (W.manage) toggleSelect(id); else W.sel = id; W.pendingDelete = ''; }
export function toggleManage() { W.manage = !W.manage; if (!W.manage) W.ids.clear(); W.pendingDelete = ''; }
export function selectAll() { W.pendingBatch = false; currentItems().forEach(i => W.ids.add(i.id)); }

export function startTreeEdit(kind) {
    if (kind === 'category-new') W.treeEdit = { kind, placement: 'head', value: '新工作流分组', label: '工作流分组名称' };
    else { const c = activeCat(); if (!c) return; W.treeEdit = { kind, value: c.name || '', label: '工作流分组名称', categoryId: c.id }; }
    W.pendingTreeDelete = '';
}
export async function saveTreeEdit(name) {
    const ed = W.treeEdit;
    if (!ed) return;
    if (!String(name || '').trim()) { setStatus('名称不能为空'); return false; }
    const libId = activeLibId();
    if (ed.kind === 'category-new') {
        if (!libId) { setStatus('请先选择资产库'); return false; }
        const data = await apiJson('/api/asset-library/categories', jsonBody('POST', { library_id: libId, name, type: 'workflow' }));
        setLib(data);
        W.libId = libId; W.catId = data.category?.id || W.catId;
    } else {
        const cid = ed.categoryId || activeCat()?.id;
        if (!cid) return;
        setLib(await apiJson(`/api/asset-library/categories/${encodeURIComponent(cid)}`, jsonBody('PATCH', { name, library_id: libId })));
        W.catId = cid;
    }
    W.treeEdit = null; W.pendingTreeDelete = '';
    setStatus('已保存');
}
export async function deleteCategory() {
    const cat = activeCat(); if (!cat) return;
    const libId = cat.__libraryId || W.libId;
    const key = `workflow-cat:${libId}:${cat.id}`;
    if (W.pendingTreeDelete !== key) { W.pendingTreeDelete = key; W.treeEdit = null; setStatus('再次点击确认删除工作流分组'); return; }
    setLib(await apiJson(`/api/asset-library/categories/${encodeURIComponent(cat.id)}?library_id=${encodeURIComponent(libId)}`, { method: 'DELETE' }));
    W.catId = ''; W.sel = ''; W.ids.clear(); W.pendingTreeDelete = '';
    setStatus('工作流分组已删除');
}

export async function upload(files) {
    if (!activeCat()) throw new Error('请先创建工作流分组');
    const list = [...files].filter(f => /\.(json|zip)$/i.test(f.name || '') || ['application/json', 'application/zip', 'application/x-zip-compressed'].includes(String(f.type || '').toLowerCase()));
    if (!list.length) throw new Error('没有可上传的工作流文件');
    const form = new FormData();
    form.append('library_id', activeLibId());
    form.append('category_id', activeCat().id);
    list.forEach(f => form.append('files', f));
    const data = await apiJson('/api/asset-library/workflows/upload', { method: 'POST', body: form });
    setLib(data);
    W.ids.clear();
    W.sel = data.items?.[0]?.id || W.sel;
    setStatus(`已上传 ${data.items?.length || 0} 个工作流`);
}
export async function exportItems(ids) {
    const items = (ids || []).map(findWorkflow).filter(i => i?.url);
    if (!items.length) return;
    if (items.length === 1) {
        const it = items[0];
        const ext = String(it.url || '').toLowerCase().split('?')[0].endsWith('.json') ? '.json' : '.zip';
        downloadUrl(it.url, `${it.name || 'workflow'}${ext}`);
        setStatus('已导出工作流');
        return;
    }
    await downloadZip('workflows.zip', items.map(i => ({ url: i.url, name: i.name || 'workflow' })), '导出工作流失败');
    setStatus(`已导出 ${items.length} 个工作流`);
}
export async function rename(id, name) {
    if (!findWorkflow(id) || !String(name || '').trim()) return;
    setLib(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, jsonBody('PATCH', { name })));
    setStatus('已重命名工作流');
}
export async function saveInlineName(id, name) {
    const it = findWorkflow(id);
    if (!it || String(it.name || '') === String(name || '')) return;
    setLib(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, jsonBody('PATCH', { name: name || '' })));
    setStatus('已保存工作流名称');
}
export async function deleteOne(id) {
    if (!findWorkflow(id)) return;
    if (W.pendingDelete !== id) { W.pendingDelete = id; setStatus('再次点击确认删除工作流'); return; }
    setLib(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    W.ids.delete(id); W.sel = ''; W.pendingDelete = '';
    setStatus('已删除工作流');
}
export async function deleteSelected() {
    const ids = [...W.ids];
    if (!ids.length) return;
    if (!W.pendingBatch) { W.pendingBatch = true; setStatus('再次点击确认删除所选工作流'); return; }
    W.pendingBatch = false;
    const data = await apiJson('/api/asset-library/items/delete', jsonBody('POST', { library_id: activeLibId(), ids }));
    setLib(data);
    W.ids.clear(); W.sel = '';
    setStatus(`已删除 ${data.removed || 0} 个工作流`);
}
