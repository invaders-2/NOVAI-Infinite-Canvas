// 素材库通用工具（移植自旧 asset-manager.js 顶部的工具函数，逻辑与接口完全照旧）
export const LOCAL_MEDIA_EXTS = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|mp3|wav|flac|ogg|m4a|aac)(\?|#|$)/i;
export const SMART_CANVAS_ASSET_INBOX_KEY = 'smart_canvas_asset_inbox';

export async function apiJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.message || '操作失败');
    return data;
}
export function jsonBody(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function formatDate(value) {
    const num = Number(value || 0);
    if (!num) return '未知';
    try { return new Date(num).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return '未知'; }
}
// 卡片上用的短时间（09/30 14:12），详情里仍用 formatDate
export function shortDate(value) {
    const num = Number(value || 0);
    if (!num) return '未知';
    const d = new Date(num);
    if (Number.isNaN(d.getTime())) return '未知';
    const p = n => (n < 10 ? '0' : '') + n;
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function formatFileSize(bytes = 0) {
    const size = Number(bytes || 0);
    if (!size) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
    return `${(size / Math.pow(1024, idx)).toFixed(idx ? 1 : 0)} ${units[idx]}`;
}

export function assetKind(item) {
    const url = String(item?.url || '').toLowerCase();
    const kind = String(item?.kind || item?.type || '').toLowerCase();
    if (kind.includes('video') || /\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video';
    if (kind.includes('audio') || /\.(mp3|wav|flac|ogg|m4a)(\?|#|$)/.test(url)) return 'audio';
    if (kind.includes('text') || /\.(txt|json|csv|srt|vtt|md)(\?|#|$)/.test(url)) return 'text';
    return 'image';
}
export function assetKindLabel(item) {
    const kind = assetKind(item);
    if (kind === 'video') return '视频';
    if (kind === 'audio') return '音频';
    if (kind === 'text') return '文本';
    return '图片';
}
export function canvasAssetKindLabel(item) {
    const kind = assetKind(item);
    if (kind === 'video') return '视频';
    if (kind === 'audio') return '音频';
    if (String(item?.kind || '').toLowerCase() === 'text') return '文本';
    return '图片';
}
export function canvasKindLabel(kind) { return kind === 'smart' ? '智能画布' : '普通画布'; }

// 类型筛选（素材库 / 本地上传 / 画布里的三个面板共用）。只列 图片/视频/音频，文本归在「全部」里；
// 某个类型在当前面板一条数据都没有时不显示它的页签（没有音频数据就不显示音频），
// 但当前选中的类型即使没数据也保留，避免从一个面板切到另一个面板时筛选被藏住、看起来像空列表。
export const ASSET_KIND_TABS = [
    { id: 'image', label: '图片' },
    { id: 'video', label: '视频' },
    { id: 'audio', label: '音频' },
];
export function assetKindName(kind) { return ASSET_KIND_TABS.find(k => k.id === kind)?.label || ''; }
export function countKinds(items) {
    const out = { all: 0, image: 0, video: 0, audio: 0, text: 0 };
    (items || []).forEach(item => { out.all += 1; const kind = assetKind(item); out[kind] = (out[kind] || 0) + 1; });
    return out;
}
// totals = 当前面板的完整素材集（也用来显示数量）；某个类型一条都没有就不出现它的页签，
// 但当前选中的类型即使没数据也保留，避免切到没有该类型的面板后筛选被藏住。
export function buildKindTabs(totals, active = '') {
    const tabs = [{ id: '', label: '全部', count: totals.all || 0 }];
    ASSET_KIND_TABS.forEach(k => {
        if ((totals[k.id] || 0) > 0 || active === k.id) tabs.push({ id: k.id, label: k.label, count: totals[k.id] || 0 });
    });
    return tabs;
}
export function matchesKind(item, kind) { return !kind || assetKind(item) === kind; }
export function workflowKindLabel(item) {
    const format = String(item?.format || '').toLowerCase();
    const url = String(item?.url || '').toLowerCase();
    if (format === 'json' || url.endsWith('.json')) return 'JSON 工作流';
    return 'ZIP 工作流包';
}

// 缩略图走服务端缩放代理（/api/media-preview），仅对本地 /output、/assets 的图片/视频生效
export function assetPreviewUrl(url, w = 256) {
    const raw = String(url || '');
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
        try { path = new URL(raw).pathname; } catch (e) { return raw; }
    }
    if (!(path.startsWith('/output/') || path.startsWith('/assets/'))) return raw;
    if (!/\.(png|jpe?g|webp|gif|bmp|avif|tiff?|mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(path)) return raw;
    const width = Math.max(64, Math.min(2048, Math.round(Number(w) || 256)));
    return `/api/media-preview?w=${width}&url=${encodeURIComponent(path)}`;
}

export function isLocalMediaFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')) return true;
    return LOCAL_MEDIA_EXTS.test(file.name || '');
}

export async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; } } catch (e) {}
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) { return false; }
}

export function downloadUrl(url, filename = 'download') {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || '';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    link.remove();
}
// 多个文件打包下载（旧代码各处复制粘贴的同一段：POST /api/canvas-assets/download 取 zip）
export async function downloadZip(filename, items, failText = '下载失败') {
    const res = await fetch('/api/canvas-assets/download', jsonBody('POST', { filename, items }));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || failText);
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1200);
}
export function assetDownloadName(item) {
    let name = String(item?.name || 'asset');
    const urlPath = String(item?.url || '').split('?')[0];
    const dot = urlPath.lastIndexOf('.');
    const ext = dot > urlPath.lastIndexOf('/') ? urlPath.slice(dot) : '';
    if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
    return name;
}
// 走 /api/download-output 强制以附件形式下载（带正确文件名/后缀）
export function downloadAsAttachment(item) {
    const name = assetDownloadName(item);
    downloadUrl(`/api/download-output?url=${encodeURIComponent(item.url)}&name=${encodeURIComponent(name)}`, name);
}

function canvasInboxAssetFromItem(item) {
    const out = { url: item?.url || '', name: item?.name || '素材', kind: item?.kind || '' };
    ['natural_w', 'natural_h', 'width', 'height', 'w', 'h', 'layout_w', 'layout_h'].forEach(key => {
        const n = Number(item?.[key]);
        if (Number.isFinite(n) && n > 0) out[key] = n;
    });
    return out;
}
// 写入跨页剪贴板，智能画布按 Ctrl+V 读取并批量粘贴；返回写入条数，失败抛错
export function writeCanvasInbox(list) {
    const items = (list || []).filter(it => it?.url).map(canvasInboxAssetFromItem);
    if (!items.length) return 0;
    localStorage.setItem(SMART_CANVAS_ASSET_INBOX_KEY, JSON.stringify({ items, ts: Date.now() }));
    return items.length;
}

export function zhCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}
