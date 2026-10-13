// 产物打开：HTML 报告在浏览器里渲染打开（产物接口带 Content-Disposition: attachment，直接 window.open 只会下载，
// 所以先开窗占位再把取回的 HTML 写进去）；xlsx / csv 走下载；其它类型新窗口打开。
const api = (() => {
    const SHEET = ['xlsx', 'xls', 'csv', 'excel'];
    const DOC = ['html', 'htm'];

    function kindOf(a) { return String((a && a.kind) || '').toLowerCase(); }
    function isSheet(a) { return SHEET.includes(kindOf(a)); }
    function isDoc(a) { return DOC.includes(kindOf(a)); }
    function kindLabel(a) {
        const k = kindOf(a);
        if (k === 'html' || k === 'htm') return 'HTML 报告';
        if (k === 'xlsx' || k === 'excel') return 'Excel 表格';
        if (k === 'csv') return 'CSV 表格';
        if (k === 'pdf') return 'PDF 文档';
        return (a && a.label) || k || '产物';
    }
    function fileName(a) {
        return String((a && (a.name || a.label)) || '产物');
    }

    function download(a) {
        const el = document.createElement('a');
        el.href = a.url;
        el.download = fileName(a);
        el.rel = 'noopener';
        document.body.appendChild(el);
        el.click();
        el.remove();
    }

    function openWindow(url) {
        try {
            const w = window.open(url, '_blank', 'noopener');
            if (!w) location.href = url;
        } catch (e) { location.href = url; }
    }

    async function openHtml(a) {
        let win = null;
        try { win = window.open('', '_blank'); } catch (e) { win = null; }
        try {
            const res = await fetch(a.url, { headers: { Accept: 'text/html' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const text = await res.text();
            if (win && win.document) {
                win.document.open();
                win.document.write(text);
                win.document.close();
                return;
            }
            const url = URL.createObjectURL(new Blob([text], { type: 'text/html' }));
            const w = window.open(url, '_blank', 'noopener');
            if (!w) location.href = url;
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) {
            if (win) { try { win.close(); } catch (x) {} }
            openWindow(a.url);
        }
    }

    function openArtifact(a) {
        if (!a || !a.url) return;
        if (isSheet(a)) { download(a); return; }
        if (isDoc(a)) { openHtml(a); return; }
        openWindow(a.url);
    }

    return { isSheet, isDoc, kindLabel, fileName, openArtifact, download, openHtml };
})();

export const { isSheet, isDoc, kindLabel, fileName, openArtifact, download, openHtml } = api;
