// 「画布里的」区域：智能画布 / 旧版智能画布分类 → 各画布，排序（画布名称时按画布分组）、时间 / 模型筛选、
// 批量下载、生成信息、在画布中定位、用在 N 个画布
import { reactive } from 'vue';
import { S, setStatus, fail, setCanvasData, openPreview } from './state.js';
import { apiJson, assetKind, canvasAssetKindLabel, canvasKindLabel, formatDate, downloadUrl, downloadZip, zhCompare, countKinds, buildKindTabs, matchesKind } from './util.js';
import { openCanvasUrl } from '../../../lib/bridge.js';

export const C = reactive({
    // 空串 = 还没选过：进页面时由 afterLoad() 按「有资产 / 有画布」挑默认分类。
    // 不能写死 'smart'：智能画布的 kind 是 classic，写死会让只用智能画布的用户一进来看到空列表。
    cat: '', canvasId: '', sel: '', ids: new Set(), query: '', sort: 'canvas_asc', model: '', date: '', manage: false,
});
export const SORTS = [
    { value: 'canvas_asc', label: '画布名称' },
    { value: 'updated_desc', label: '最近更新' },
    { value: 'updated_asc', label: '最早更新' },
    { value: 'name_asc', label: '资产名称' },
    { value: 'kind', label: '类型' },
];
const SORT_LABELS = { canvas_asc: '画布名称', updated_desc: '最近更新', updated_asc: '最早更新', name_asc: '名称 A-Z', kind: '类型' };
export const DATES = [['', '全部时间'], ['1', '今天'], ['7', '近 7 天'], ['30', '近 30 天']];

export function uniqueItems(items = S.canvasData.items) {
    const seen = new Set();
    const out = [];
    (items || []).forEach(item => {
        const key = `${item.canvas_id || ''}::${item.url || ''}`;
        if (!item?.url || seen.has(key)) return;
        seen.add(key);
        out.push(item);
    });
    return out;
}
export function categories() {
    const d = S.canvasData;
    if (Array.isArray(d.categories) && d.categories.length) return d.categories.filter(c => ['smart', 'classic'].includes(c.id));
    return [
        { id: 'smart', name: '旧版智能画布', count: (d.items || []).filter(i => i.canvas_kind === 'smart').length, canvas_count: (d.canvases || []).filter(i => i.kind === 'smart').length },
        { id: 'classic', name: '智能画布', count: (d.items || []).filter(i => i.canvas_kind !== 'smart').length, canvas_count: (d.canvases || []).filter(i => i.kind !== 'smart').length },
    ];
}
// 默认分类：优先「真的有资产」的分类；两个分类都有资产时优先智能画布（classic），
// 不能默认落到空的旧版分类，否则用户会觉得智能画布生成的图在素材库里消失了。
function defaultCat() {
    const cats = categories();
    const withAssets = cats.filter(c => Number(c.count || 0) > 0);
    if (withAssets.length) {
        const classic = withAssets.find(c => c.id === 'classic');
        return (classic || withAssets[0]).id;
    }
    const withCanvases = cats.filter(c => Number(c.canvas_count || 0) > 0);
    const classicCanvas = withCanvases.find(c => c.id === 'classic');
    return (classicCanvas || withCanvases[0] || cats[0] || { id: 'classic' }).id;
}
export function activeCat() {
    const cats = categories();
    return cats.find(c => c.id === C.cat) || cats.find(c => c.id === defaultCat()) || { id: 'classic', name: '智能画布', count: 0, canvas_count: 0 };
}
export function canvasesFor(catId) {
    return (S.canvasData.canvases || []).filter(c => (c.kind || 'classic') === catId).sort((a, b) => zhCompare(a.title, b.title));
}
export function countForCanvas(id) { return uniqueItems().filter(i => i.canvas_id === id).length; }
export function activeCanvas() {
    if (!C.canvasId) return null;
    const c = (S.canvasData.canvases || []).find(x => x.id === C.canvasId) || null;
    return c && (c.kind || 'classic') === activeCat().id ? c : null;
}
export const sortLabel = () => SORT_LABELS[C.sort] || SORT_LABELS.canvas_asc;
export function viewTitle() { return activeCanvas()?.title || activeCat().name || '画布资产'; }
export function viewSubtitle(n) {
    const c = activeCanvas();
    if (c) return `${canvasKindLabel(c.kind)} / ${n} 个资产 / ${sortLabel()}`;
    return `${Number(activeCat().canvas_count || 0)} 个画布 / ${n} 个资产 / ${sortLabel()}`;
}
export function findItem(id) { return (S.canvasData.items || []).find(i => i.id === id) || null; }
export function modelOptions() {
    const counts = new Map();
    const cat = activeCat().id;
    uniqueItems().forEach(i => { if ((i.canvas_kind || 'classic') === cat && i.gen_model) counts.set(i.gen_model, (counts.get(i.gen_model) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
// 当前画布分类 / 画布 / 搜索 / 时间 / 模型过滤后的完整集合（不含类型筛选），类型计数和类型筛选都以它为基础
export function baseItems() {
    const q = String(C.query || '').trim().toLowerCase();
    const cat = activeCat().id;
    const canvasId = activeCanvas() ? C.canvasId : '';
    const model = C.model && C.model !== '__none__' && !modelOptions().some(([m]) => m === C.model) ? '' : C.model;
    let list = uniqueItems().filter(item => {
        if ((item.canvas_kind || 'classic') !== cat) return false;
        if (canvasId && item.canvas_id !== canvasId) return false;
        if (model && (model === '__none__' ? item.gen_model : item.gen_model !== model)) return false;
        if (C.date) {
            const days = Number(C.date) || 0;
            const t = Number(item.gen_at || item.created_at || 0);
            const start = days === 1 ? new Date().setHours(0, 0, 0, 0) : Date.now() - days * 86400000;
            if (!t || t < start) return false;
        }
        if (!q) return true;
        return [item.name, item.gen_prompt, item.gen_model, item.url, item.canvas_title, item.node_title, item.node_type, canvasAssetKindLabel(item), canvasKindLabel(item.canvas_kind)].join(' ').toLowerCase().includes(q);
    });
    const byTime = i => Number(i.canvas_updated_at || i.created_at || 0);
    const byCanvasName = (a, b) => zhCompare(a.canvas_title, b.canvas_title) || String(a.canvas_id || '').localeCompare(String(b.canvas_id || ''), 'zh-Hans-CN') || byTime(b) - byTime(a);
    if (C.sort === 'canvas_asc') list.sort(byCanvasName);
    else if (C.sort === 'updated_asc') list.sort((a, b) => byTime(a) - byTime(b));
    else if (C.sort === 'name_asc') list.sort((a, b) => zhCompare(a.name, b.name));
    else if (C.sort === 'kind') list.sort((a, b) => canvasAssetKindLabel(a).localeCompare(canvasAssetKindLabel(b), 'zh-Hans-CN') || byTime(b) - byTime(a));
    else list.sort((a, b) => byTime(b) - byTime(a));
    return list;
}
export function currentItems() { return baseItems().filter(item => matchesKind(item, S.kind)); }
// 当前分类 / 画布范围内的全部资产（不含搜索 / 时间 / 模型 / 类型筛选）
export function scopeItems() {
    const cat = activeCat().id;
    const canvasId = activeCanvas() ? C.canvasId : '';
    return uniqueItems().filter(item => (item.canvas_kind || 'classic') === cat && (!canvasId || item.canvas_id === canvasId));
}
// 类型页签的数量跟列表同一口径：选中某个画布时只算这个画布的资产，没选画布时才算整个分类，
// 否则会出现「画布只有 100 张图，页签却写着 872 / 视频 5，点视频还是一片空」的错觉。
export function kindTotals() { return countKinds(scopeItems()); }
// 搜索 / 时间 / 模型筛掉了多少个当前类型下本应能看到的素材（空状态文案里点名用）
export function filteredOutCount() { return Math.max(0, scopeItems().filter(item => matchesKind(item, S.kind)).length - currentItems().length); }
export function kindTabs() { return buildKindTabs(kindTotals(), S.kind); }
// 按「画布名称」排序时按画布分组，其它排序平铺
export function groupItems(list) {
    if (C.sort !== 'canvas_asc') return [{ key: '__all__', title: '', subtitle: '', items: list }];
    const groups = [];
    const map = new Map();
    list.forEach(item => {
        const key = item.canvas_id || item.canvas_title || '__unknown__';
        if (!map.has(key)) {
            const g = { key, title: item.canvas_title || '未命名画布', subtitle: `${canvasKindLabel(item.canvas_kind)} / ${formatDate(item.canvas_updated_at || item.created_at)}`, items: [] };
            map.set(key, g);
            groups.push(g);
        }
        map.get(key).items.push(item);
    });
    return groups;
}
export function selectedItem(list) { return list.find(i => i.id === C.sel) || list[0] || null; }

// 切分类 / 画布时清掉时间、模型、搜索：上一轮留下的「今天」会把新画布的资产全滤掉，
// 看起来就像「点了画布不显示素材」。清完列表按新选择重算，侧栏角标和标题才对得上。
export function resetFilters() { C.date = ''; C.model = ''; C.query = ''; C.sel = ''; }
export function selectCat(id) { C.cat = id || defaultCat(); C.canvasId = ''; C.ids.clear(); resetFilters(); }
export function selectCanvas(catId, id) { C.cat = catId || C.cat; C.canvasId = id || ''; C.ids.clear(); resetFilters(); }
export function toggleSelect(id) { if (C.ids.has(id)) { C.ids.delete(id); if (C.sel === id) C.sel = ''; } else { C.ids.add(id); C.sel = id; } }
export function clickCard(id) { if (C.manage) toggleSelect(id); else C.sel = id; }
export function toggleManage() { C.manage = !C.manage; if (!C.manage) C.ids.clear(); }
export function selectAll() { currentItems().forEach(i => C.ids.add(i.id)); }
export function setFilter(kind, value) { C[kind] = value || ''; C.sel = ''; }
export function clearFilters() { C.date = ''; C.model = ''; C.query = ''; C.sel = ''; }
let entered = false;
// 刷新后修正失效的分类 / 画布（旧 normalizeCanvasAssetState）
export function afterLoad() {
    // 首次进素材库（页面挂载后的第一次数据加载）把上一轮留下的时间 / 模型还原成「全部」，
    // 否则打开页面就是一片空，看着像素材丢了
    if (!entered) { entered = true; C.date = ''; C.model = ''; }
    if (!C.cat || !categories().some(c => c.id === C.cat)) C.cat = defaultCat();
    if (C.canvasId && !activeCanvas()) C.canvasId = '';
    C.ids = new Set([...C.ids].filter(id => findItem(id)));
}

export async function refresh() {
    try {
        setStatus('正在刷新画布资产...');
        setCanvasData(await apiJson('/api/canvas-assets'));
        afterLoad();
        setStatus('画布资产已刷新');
    } catch (err) { fail(err, '刷新画布资产失败'); }
}
export async function download(ids) {
    const items = (ids || []).map(findItem).filter(i => i?.url);
    if (!items.length) { setStatus('没有可下载的画布资产'); return; }
    if (items.length === 1) { downloadUrl(items[0].url, items[0].name || 'canvas-asset'); setStatus('已下载画布资产'); return; }
    setStatus(`正在打包 ${items.length} 个画布资产...`);
    await downloadZip('canvas-assets.zip', items.map(i => ({ url: i.url, name: i.name || 'canvas-asset' })), '下载画布资产失败');
    setStatus(`已下载 ${items.length} 个画布资产`);
}
export function preview(id) { const it = findItem(id); if (it) openPreview(it.url, assetKind(it), it.name); }

// 在画布中定位：外壳里切到「画布」页并让画布 iframe 直接打开目标画布（旧版直接改 parent 的 frame-canvas.src）
export function canvasFocusUrl(canvasId, kind, nodeId) {
    const id = encodeURIComponent(canvasId || '');
    const focus = nodeId ? `&focus=${encodeURIComponent(nodeId)}` : '';
    return kind === 'smart' ? `/static/smart-canvas.html?id=${id}${focus}&t=${Date.now()}` : `/static/canvas.html?id=${id}&t=${Date.now()}`;
}
export function openCanvasAtNode(canvasId, kind, nodeId) {
    if (!canvasId) return;
    const url = canvasFocusUrl(canvasId, kind, nodeId);
    try { openCanvasUrl(url); } catch (e) { window.open(url, '_blank', 'noopener'); }
}
