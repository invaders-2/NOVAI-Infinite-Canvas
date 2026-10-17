// 「提示词库」：多词库 / 分组树、树内编辑、搜索、批量删除、新增 / 编辑 / 删除提示词
import { reactive } from 'vue';
import { S, setStatus } from './state.js';
import { apiJson, jsonBody } from './util.js';

export const P = reactive({
    libId: '', cat: 'all', focus: 'category', sel: '', ids: new Set(), query: '', manage: false,
    edit: false, create: false, pendingDelete: '', pendingBatch: false, treeEdit: null, pendingTreeDelete: '',
});
const BUILTIN = [
    { id: 'view', name: '视角' }, { id: 'storyboard', name: '分镜' }, { id: 'character', name: '角色' },
    { id: 'product', name: '产品' }, { id: 'lighting', name: '光影' }, { id: 'custom', name: '我的' },
];

export function libraries() {
    const libs = Array.isArray(S.promptLibrary.libraries) ? S.promptLibrary.libraries.filter(Boolean) : [];
    if (!libs.length) return [{ id: 'system', name: '系统提示词库', system: true, items: [], categories: [] }];
    return [...libs.filter(l => l.id === 'system'), ...libs.filter(l => l.id !== 'system')];
}
export const isSystem = lib => !lib || lib.id === 'system';
export function activeLib() {
    const libs = libraries();
    return libs.find(l => l.id === P.libId) || libs.find(l => l.id === S.promptLibrary.active_library_id) || libs[0] || null;
}
// 每个库用自己的分类；只有系统库在完全为空时才补默认内置分类（新建普通库不借用系统分类）
export function categoriesFor(lib) {
    const own = Array.isArray(lib?.categories) ? lib.categories.filter(c => c?.id) : [];
    if (own.length) return own;
    return isSystem(lib) ? BUILTIN : [];
}
export function activeCatId() { return P.cat !== 'all' && !categoriesFor(activeLib()).some(c => c.id === P.cat) ? 'all' : P.cat; }
export function categoryLabel(category = 'custom') {
    const found = categoriesFor(activeLib()).find(c => c.id === category);
    if (found?.name) return found.name;
    const map = { view: '视角', storyboard: '分镜', character: '角色', product: '产品', lighting: '光影', mine: '我的', custom: '我的' };
    return map[category] || category || '自定义';
}
export function countFor(category, lib = activeLib()) {
    const items = lib?.items || [];
    return category === 'all' ? items.length : items.filter(i => (i.category || 'custom') === category).length;
}
export function currentItems() {
    const q = P.query.trim().toLowerCase();
    const cat = activeCatId();
    return (activeLib()?.items || []).filter(item => {
        if (cat !== 'all' && (item.category || 'custom') !== cat) return false;
        if (!q) return true;
        return [item.name, item.scene, item.positive, item.negative, item.category].join(' ').toLowerCase().includes(q);
    });
}
export function findPrompt(id) { for (const lib of libraries()) for (const i of lib.items || []) if (i.id === id) return i; return null; }
export function selectedItem(list = currentItems()) { return list.find(i => i.id === P.sel) || list[0] || null; }
function setLib(data) {
    if (data && data.library) S.promptLibrary = data.library;
    P.ids = new Set([...P.ids].filter(id => findPrompt(id)));
}
function clearPending() { P.pendingDelete = ''; P.pendingBatch = false; }

/* ───────── 导航 / 选择 ───────── */
export function selectLib(id) { P.libId = id; P.cat = 'all'; P.focus = 'library'; P.sel = ''; P.create = false; P.edit = false; P.ids.clear(); }
export function selectCat(libId, cat) { P.libId = libId || P.libId; P.cat = cat || 'all'; P.focus = 'category'; P.sel = ''; P.create = false; P.edit = false; P.ids.clear(); }
export function toggleSelect(id) {
    if (P.ids.has(id)) { P.ids.delete(id); if (P.sel === id) P.sel = ''; } else { P.ids.add(id); P.sel = id; }
    P.edit = false; P.create = false; clearPending();
}
export function clickRow(id) { if (P.manage) toggleSelect(id); else P.sel = id; P.edit = false; P.create = false; clearPending(); }
export function toggleManage() { P.manage = !P.manage; clearPending(); if (!P.manage) P.ids.clear(); }
export function selectAll() { currentItems().forEach(i => P.ids.add(i.id)); clearPending(); }
export function clearSelection() { P.ids.clear(); clearPending(); }

/* ───────── 树内编辑 ───────── */
export function startTreeEdit(kind) {
    const map = {
        'library-new': { placement: 'head', value: '新提示词库', label: '提示词库名称' },
        'library-rename': { value: activeLib()?.name || '', label: '提示词库名称' },
        'category-new': { value: '新分组', label: '分组名称' },
        'category-rename': { value: categoriesFor(activeLib()).find(c => c.id === P.cat)?.name || '', label: '分组名称' },
    };
    P.focus = kind === 'category-rename' ? 'category' : 'library';
    P.treeEdit = { kind, ...map[kind] };
    P.pendingTreeDelete = '';
}
export async function saveTreeEdit(name) {
    const ed = P.treeEdit;
    if (!ed) return;
    if (!String(name || '').trim()) { setStatus('名称不能为空'); return false; }
    let data;
    if (ed.kind === 'library-new') {
        data = await apiJson('/api/prompt-libraries', jsonBody('POST', { name }));
        setLib(data);
        P.libId = data.prompt_library?.id || P.libId; P.cat = 'all'; P.focus = 'library';
    } else if (ed.kind === 'library-rename') {
        const lib = activeLib(); if (!lib) return;
        setLib(await apiJson(`/api/prompt-libraries/${encodeURIComponent(lib.id)}`, jsonBody('PATCH', { name })));
        P.focus = 'library';
    } else if (ed.kind === 'category-new') {
        data = await apiJson('/api/prompt-libraries/categories', jsonBody('POST', { library_id: activeLib()?.id || 'system', name }));
        setLib(data);
        P.cat = data.category?.id || P.cat; P.focus = 'category';
    } else if (ed.kind === 'category-rename') {
        setLib(await apiJson(`/api/prompt-libraries/categories/${encodeURIComponent(P.cat)}`, jsonBody('PATCH', { name })));
        P.focus = 'category';
    }
    P.treeEdit = null; P.pendingTreeDelete = '';
    setStatus('已保存');
}
export async function deleteCategory() {
    if (activeCatId() === 'all') { setStatus('请选择具体分组后删除'); return; }
    const key = `prompt-cat:${P.cat}`;
    if (P.pendingTreeDelete !== key) { P.pendingTreeDelete = key; P.treeEdit = null; setStatus('再次点击确认删除分组'); return; }
    setLib(await apiJson(`/api/prompt-libraries/categories/${encodeURIComponent(P.cat)}`, { method: 'DELETE' }));
    P.cat = 'all'; P.pendingTreeDelete = '';
    setStatus('分组已删除');
}
export async function deleteLibrary() {
    const lib = activeLib(); if (!lib) return;
    if (isSystem(lib)) { setStatus('系统提示词库不能删除'); return; }
    const key = `prompt-lib:${lib.id}`;
    if (P.pendingTreeDelete !== key) { P.pendingTreeDelete = key; P.treeEdit = null; setStatus('再次点击确认删除提示词库'); return; }
    setLib(await apiJson(`/api/prompt-libraries/${encodeURIComponent(lib.id)}`, { method: 'DELETE' }));
    P.libId = S.promptLibrary.active_library_id || libraries()[0]?.id || 'system';
    P.cat = 'all'; P.sel = ''; P.ids.clear(); P.pendingTreeDelete = '';
    setStatus('提示词库已删除');
}

/* ───────── 新增 / 编辑 / 删除 ───────── */
export function startCreate() { P.create = true; P.edit = false; P.pendingDelete = ''; }
export function startEdit(id) { P.sel = id || P.sel; P.edit = true; P.create = false; P.pendingDelete = ''; }
export function cancelEdit() { P.edit = false; P.create = false; }
export async function saveCreate(f) {
    const lib = activeLib(); if (!lib) return;
    if (!String(f.name || '').trim() || !String(f.positive || '').trim()) { setStatus('名称和正向提示词不能为空'); return false; }
    const category = activeCatId() === 'all' ? 'custom' : activeCatId();
    const data = await apiJson('/api/prompt-libraries/items', jsonBody('POST', { library_id: lib.id, name: f.name, positive: f.positive, negative: f.negative || '', category, scene: f.scene || '' }));
    setLib(data);
    P.sel = data.item?.id || P.sel; P.create = false;
    setStatus('提示词已新增');
}
export async function saveEdit(id, f) {
    const item = findPrompt(id), lib = activeLib();
    if (!item || !lib) return;
    if (!String(f.name || '').trim() || !String(f.positive || '').trim()) { setStatus('名称和正向提示词不能为空'); return false; }
    setLib(await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, jsonBody('PATCH', { library_id: lib.id, name: f.name, positive: f.positive, negative: f.negative || '', category: item.category || 'custom', scene: f.scene || '' })));
    P.sel = id; P.edit = false;
    setStatus('提示词已保存');
}
// 单条删除：改为「再点一次确认」（旧版界面上有确认样式，但代码里点一下就删了）
export async function deleteOne(id) {
    if (!findPrompt(id)) return;
    if (P.pendingDelete !== id) { P.pendingDelete = id; setStatus('再次点击确认删除提示词'); return; }
    setLib(await apiJson(`/api/prompt-libraries/items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    P.ids.delete(id);
    if (P.sel === id) P.sel = '';
    P.pendingDelete = '';
    setStatus('提示词已删除');
}
export async function deleteSelected() {
    if (!P.ids.size) return;
    if (!P.pendingBatch) { P.pendingBatch = true; setStatus('再次点击确认删除所选提示词'); return; }
    const ids = [...P.ids];
    setLib(await apiJson('/api/prompt-libraries/items/delete', jsonBody('POST', { ids })));
    if (ids.includes(P.sel)) P.sel = '';
    P.ids.clear(); P.pendingBatch = false;
    setStatus(`已删除 ${ids.length} 条提示词`);
}
