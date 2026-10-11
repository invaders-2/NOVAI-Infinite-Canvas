// 下载与历史接口（移植自 static/js/shared/utils.js 的 downloadBlob、history-bulk-manager.js 的导出 / 删除）
import { toast } from '../../lib/store.js';
import { pyApi } from '../../lib/env.js';

let inFlight = false;

// 桌面版 pywebview → 原生保存对话框；Chromium → showSaveFilePicker；否则 <a download>
export async function downloadBlob(blob, filename) {
    if (inFlight) { toast('正在保存，请稍候...'); return; }
    inFlight = true;
    try {
        const name = filename || 'download';
        const api = pyApi();
        if (api && typeof api.save_file === 'function') {
            toast('正在准备文件...');
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('read failed'));
                    reader.readAsDataURL(blob);
                });
                const saved = await api.save_file(dataUrl, name);
                if (saved) toast('已保存', { icon: 'check' });
            } catch (e) { toast('保存失败', { danger: true, icon: 'alert' }); }
            return;
        }
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({ suggestedName: name });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                toast('已保存', { icon: 'check' });
                return;
            } catch (e) { if (e && e.name === 'AbortError') return; }
        }
        clickDownload(URL.createObjectURL(blob), name, true);
    } finally { inFlight = false; }
}

function clickDownload(href, name, revoke) {
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export function extOf(url) {
    const clean = String(url || '').split('?')[0];
    const ext = clean.includes('.') ? clean.split('.').pop() : 'png';
    return /^[a-z0-9]{2,5}$/i.test(ext) ? ext : 'png';
}

// 取图并保存；失败时抛错（调用方决定提示文案）
export async function downloadUrl(url, name) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch failed');
    await downloadBlob(await res.blob(), name);
}

// 批量导出（与旧 doExport 相同：逐张 fetch → <a download>，文件名取 URL 末段）；返回成功张数
export async function exportUrls(urls) {
    let ok = 0;
    for (const src of urls) {
        if (!src) continue;
        try {
            const res = await fetch(src);
            if (!res.ok) continue;
            const blob = await res.blob();
            const name = (String(src).split('/').pop().split('?')[0]) || ('novai-' + Date.now());
            clickDownload(URL.createObjectURL(blob), name, true);
            ok++;
        } catch (e) { /* 忽略单张失败 */ }
    }
    return ok;
}

export async function fetchHistory(type) {
    const r = await fetch('/api/history?type=' + encodeURIComponent(type));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
}

// POST /api/history/delete {timestamp}，成功返回 true
export async function deleteHistory(ts) {
    const r = await fetch('/api/history/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timestamp: ts }) });
    const res = await r.json();
    if (res && res.success) return true;
    throw new Error('delete failed');
}

// 与 NovaUtils.getClientId 同一个 localStorage key
export function clientId() {
    let id = null;
    try { id = localStorage.getItem('client_id'); } catch (e) {}
    if (!id) {
        id = (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) || ('c' + Date.now() + Math.random().toString(16).slice(2));
        try { localStorage.setItem('client_id', id); } catch (e) {}
    }
    return id;
}
