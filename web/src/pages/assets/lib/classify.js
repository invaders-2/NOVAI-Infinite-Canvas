// 智能分类（item.classification）相关的纯函数，资产库与本地上传共用；分组规则与旧代码完全一致
export const ASSET_CLASS_GROUPS = [
    { id: 'environment', name: '环境', dims: ['environment', 'scene', 'space', 'mood'] },
    { id: 'composition', name: '构图', dims: ['composition'] },
    { id: 'lighting', name: '光影', dims: ['lighting', 'color'] },
    { id: 'model', name: '模特', dims: ['model', 'people'] },
    { id: 'subject', name: '主体', dims: ['subject', 'objects', 'materials'] },
    { id: 'style', name: '风格', dims: ['style', 'use_case', 'quality'] },
    { id: 'tags', name: '标签', dims: ['tags'] },
];
const GROUP_BY_DIM = new Map(ASSET_CLASS_GROUPS.flatMap(group => group.dims.map(dim => [dim, group])));
const LABELS = {
    environment: '环境', scene: '场景', space: '空间', subject: '主体', model: '模特', people: '人物', style: '风格', lighting: '光影',
    color: '色彩', composition: '构图', mood: '氛围', use_case: '用途', objects: '物体', materials: '材质', quality: '质量', tags: '标签',
};

function flatOf(item) { return Array.isArray(item?.classification?.flat) ? item.classification.flat : []; }

export function classKey(entry) {
    const dimension = String(entry?.dimension || '').trim();
    const tag = String(entry?.tag || '').trim();
    return dimension && tag ? `${dimension}::${tag}` : '';
}
export function parseClassKey(key = '') {
    const text = String(key || '');
    const index = text.indexOf('::');
    if (index < 0) return null;
    return { dimension: text.slice(0, index), tag: text.slice(index + 2) };
}
export function classChips(item, limit = 10) {
    return flatOf(item).slice(0, limit).map(entry => {
        const tag = entry?.tag || '';
        return tag ? { label: entry?.label || entry?.dimension || '分类', tag, key: classKey(entry), dimension: entry?.dimension || '' } : null;
    }).filter(Boolean);
}
export function classEntriesForItems(items = []) {
    const groups = new Map();
    (items || []).forEach(item => {
        flatOf(item).forEach(entry => {
            const key = classKey(entry);
            if (!key) return;
            const cur = groups.get(key) || { key, dimension: String(entry.dimension || ''), label: String(entry.label || entry.dimension || '分类'), tag: String(entry.tag || ''), count: 0 };
            cur.count += 1;
            groups.set(key, cur);
        });
    });
    const cmp = (a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    return [...groups.values()].sort((a, b) => (a.label !== b.label ? cmp(a.label, b.label) : (b.count - a.count || cmp(a.tag, b.tag))));
}
export function classEntryGroup(entry) {
    const dim = String(entry?.dimension || '');
    if (dim === 'subject' && /人|人物|模特|男|女|儿童|老人|青年|肖像|半身|全身/.test(String(entry?.tag || ''))) {
        return ASSET_CLASS_GROUPS.find(g => g.id === 'model');
    }
    return GROUP_BY_DIM.get(dim) || ASSET_CLASS_GROUPS.find(g => g.id === 'tags');
}
export function groupedClassEntries(entries = []) {
    const byGroup = new Map(ASSET_CLASS_GROUPS.map(g => [g.id, { ...g, count: 0, entries: [] }]));
    (entries || []).forEach(entry => {
        const bucket = byGroup.get(classEntryGroup(entry).id) || byGroup.get('tags');
        bucket.entries.push(entry);
        bucket.count += Number(entry.count || 0);
    });
    return [...byGroup.values()].filter(g => g.entries.length);
}
export function classGroupIdForKey(key, entries = []) {
    const entry = (entries || []).find(e => e.key === key);
    return entry ? classEntryGroup(entry)?.id || '' : '';
}
export function itemsMatchingClass(items, key) {
    const parsed = parseClassKey(key);
    if (!parsed) return [];
    return (items || []).filter(item => flatOf(item).some(e => String(e.dimension || '') === parsed.dimension && String(e.tag || '') === parsed.tag));
}
export function classSearchText(item) {
    const c = item?.classification || {};
    const flatText = flatOf(item).map(entry => [classEntryGroup(entry)?.name, entry?.label, entry?.dimension, entry?.tag].filter(Boolean).join(' ')).join(' ');
    const catText = c.categories && typeof c.categories === 'object'
        ? Object.entries(c.categories).map(([key, values]) => {
            const group = GROUP_BY_DIM.get(String(key || ''));
            const list = Array.isArray(values) ? values : [values];
            return [group?.name, LABELS[key] || key, key, ...list].filter(Boolean).join(' ');
        }).join(' ')
        : '';
    const tags = Array.isArray(c.tags) ? c.tags.join(' ') : '';
    return [c.summary, flatText, catText, tags].filter(Boolean).join(' ');
}
