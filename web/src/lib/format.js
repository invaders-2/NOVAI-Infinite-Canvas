export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) { const mb = n / 1024 / 1024; return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB'; }
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
export function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    const p = n => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
