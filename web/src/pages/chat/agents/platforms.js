// 平台元数据：筛选栏顺序、线性小图标、标签别名。
// 图标统一按 24×24 viewBox 的线性描边写（与 lib/icons.js 同款），不填充、不加底色。
const api = (() => {
    const ICON = {
        all: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
        taobao: '<path d="M4 9.5 5.6 4h12.8L20 9.5M4 9.5h16v9A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M9.5 13.5h5"/>',
        douyin: '<path d="M9.5 18.5V6.5l9-2v12"/><circle cx="6.8" cy="18.5" r="2.7"/><circle cx="15.8" cy="16.5" r="2.7"/>',
        pdd: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
        ali1688: '<path d="M3.5 20.5h17M5.5 20.5V10l6.5-4 6.5 4v10.5M9.5 20.5v-5.5h5v5.5"/>',
        xhs: '<path d="M4 19V5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20"/><path d="M8.5 8h7M8.5 11.5h4.5"/>',
        jd: '<path d="M6 2.5 3.5 6v13.5A2 2 0 0 0 5.5 21.5h13a2 2 0 0 0 2-2V6L18 2.5z"/><path d="M3.5 6h17M16 10.5a4 4 0 0 1-8 0"/>',
        tax: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/>',
        amazon: '<path d="M4 8h16l-1.2 11.1a1.5 1.5 0 0 1-1.5 1.4H6.7a1.5 1.5 0 0 1-1.5-1.4z"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2M8 15.5c2.4 1.4 5.6 1.4 8 0"/>',
        private: '<circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 20a6 6 0 0 1 12 0"/><path d="M16 5.6a3.5 3.5 0 0 1 0 6.8M17.5 14.4A6 6 0 0 1 21 20"/>',
    };

    // 顺序 = 界面筛选栏顺序（截图同款）
    const LIST = [
        { id: 'all', name: '全部平台', icon: ICON.all, aliases: [] },
        { id: 'taobao', name: '淘宝天猫', icon: ICON.taobao, aliases: ['天猫', '淘宝'] },
        { id: 'douyin', name: '抖音电商', icon: ICON.douyin, aliases: ['抖音'] },
        { id: 'pdd', name: '拼多多', icon: ICON.pdd, aliases: [] },
        { id: 'ali1688', name: '1688', icon: ICON.ali1688, aliases: ['阿里巴巴'] },
        { id: 'xhs', name: '小红书', icon: ICON.xhs, aliases: [] },
        { id: 'jd', name: '京东', icon: ICON.jd, aliases: [] },
        { id: 'tax', name: '财税', icon: ICON.tax, aliases: ['税务', '财务'] },
        { id: 'amazon', name: '亚马逊', icon: ICON.amazon, aliases: ['Amazon'], soon: true },
        { id: 'private', name: '私域', icon: ICON.private, aliases: ['微信', '企微', '私域运营'] },
    ];

    const byNameCache = new Map();
    LIST.forEach(p => {
        byNameCache.set(p.name, p);
        p.aliases.forEach(a => byNameCache.set(a, p));
    });

    function byName(name) { return byNameCache.get(String(name || '').trim()) || null; }
    function isPlatformTag(tag) { return !!byName(tag); }
    // 能力可以同时属于多个平台（标签里会有多个平台名），筛选要按「命中任意一个」算
    function platformsOf(tags) {
        const list = Array.isArray(tags) ? tags : [];
        const out = [];
        const seen = new Set();
        list.forEach(tag => {
            const p = byName(tag);
            if (!p || p.id === 'all' || seen.has(p.id)) return;
            seen.add(p.id);
            out.push(p);
        });
        return out;
    }
    function platformOf(tags) { return platformsOf(tags)[0] || null; }
    function iconSvg(name) { const p = byName(name); return p ? p.icon : ''; }

    return { LIST, byName, isPlatformTag, platformsOf, platformOf, iconSvg };
})();

export const { LIST, byName, isPlatformTag, platformsOf, platformOf, iconSvg } = api;
