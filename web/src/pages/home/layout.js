// 把模板的节点图排成示意图：列 = col，列内竖排；坐标是 0–100 的百分比，封面和技能预览共用
export function diagram(t) {
    const nodes = t.nodes.filter(n => n.type !== 'label');
    const cols = {};
    nodes.forEach(n => { (cols[n.col || 0] = cols[n.col || 0] || []).push(n); });
    const ids = Object.keys(cols).map(Number).sort((a, b) => a - b);
    const bw = ids.length > 2 ? 20 : 24;
    const gap = ids.length > 2 ? 10 : 16;
    const total = ids.length * bw + (ids.length - 1) * gap;
    const x0 = (100 - total) / 2;
    const pos = {};
    ids.forEach((c, ci) => {
        const list = cols[c];
        const bh = list.length > 3 ? 15 : list.length > 2 ? 20 : 26;
        const vg = list.length > 3 ? 5 : 8;
        const th = list.length * bh + (list.length - 1) * vg;
        const y0 = (100 - th) / 2;
        list.forEach((n, i) => {
            pos[n.key] = { x: x0 + ci * (bw + gap), y: y0 + i * (bh + vg), w: bw, h: bh, gen: n.type === 'gen' || n.type === 'batch', video: !!n.video, type: n.type, key: n.key };
        });
    });
    const wires = [];
    nodes.forEach(n => (n.inputs || []).forEach(k => {
        const a = pos[k], b = pos[n.key];
        if (!a || !b) return;
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
        wires.push(`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
    }));
    return { boxes: Object.values(pos), wires, count: nodes.length };
}

export function templateKind(t) {
    if (t.nodes.some(n => n.video)) return { label: '视频', icon: 'video' };
    if (t.nodes.some(n => n.type === 'batch')) return { label: '批量', icon: 'table' };
    return { label: '图片', icon: 'image' };
}

export function formatUpdateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    const pad = n => (n < 10 ? '0' : '') + n;
    return (d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
