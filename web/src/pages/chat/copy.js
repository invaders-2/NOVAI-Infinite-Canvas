// 复制到剪贴板（clipboard API 不可用时退回 execCommand）
export async function copyText(text) {
    const s = String(text || '');
    try {
        if (navigator.clipboard && window.isSecureContext !== false) { await navigator.clipboard.writeText(s); return true; }
    } catch (e) {}
    try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) { return false; }
}
