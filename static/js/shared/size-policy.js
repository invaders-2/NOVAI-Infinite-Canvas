// NOVAI 生图尺寸策略 — 尺寸真值源在后端 /api/ai/size-policy（server/protocols/model_protocols.json）。
// 浏览器全局 IIFE，无构建步骤；与 shared/utils.js 同样在页面里以 <script> 引入。
// 暴露 window.NovaSizePolicy：load / policy / isEnum / enumOptions / constrain / fitSource。
(function(){
    'use strict';

    const FORMAT = 'novai-size-policy/v1';
    const DEFAULT_POLICY = {
        mode: 'free',
        hintOnly: false,
        maxEdge: 0,
        maxPixels: 0,
        minPixels: 0,
        multipleOf: 0,
        minRatio: 0,
        maxRatio: 0,
        options: [],
        prefer: 'ratio',
        autoSize: false,
        defaultLevel: '',
        ratios: [],
        resolutions: [],
        tiers: [
            { id: '1k', maxPixels: 1572864 },
            { id: '2k', maxPixels: 4194304 },
            { id: '4k', maxPixels: 8294400 },
        ],
    };
    const MODES = ['free', 'bounds', 'enum'];
    const LEVELS = ['1k', '2k', '4k'];
    // 供应商级覆盖（/api/ai/size-policy 下发的 ratios）用的比例词表：内部 key → 官方宽高比。
    // 与 web 在线页 RATIOS/EXTRA_RATIOS、两套画布 SIZE_MAP 的键同源；未命中时按原 key 比对。
    const RATIO_ID_LABELS = {
        square: '1:1', portrait12: '1:2', landscape21: '2:1', story: '9:16', wide: '16:9',
        portrait43: '3:4', landscape43: '4:3', landscape: '3:2', portrait: '2:3', landscape54: '5:4',
        portrait45: '4:5', ultrawide: '21:9', ultratall: '9:21', landscape31: '3:1', portrait13: '1:3',
        portrait14: '1:4', portrait18: '1:8', landscape41: '4:1', landscape81: '8:1',
    };

    function defaultTiers(){
        return DEFAULT_POLICY.tiers.map(tier => ({ id: tier.id, maxPixels: tier.maxPixels }));
    }

    function emptyTable(){
        const fallback = Object.assign({}, DEFAULT_POLICY);
        fallback.tiers = defaultTiers();
        return { format: FORMAT, default: fallback, models: {} };
    }

    let table = emptyTable();
    let pending = null;

    function positiveNumber(value){
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    // 档位表校验：id + 严格递增的 maxPixels；非法（含非数组）就整体退回默认档位
    function normalizeTiers(value){
        if (!Array.isArray(value)) return null;
        const tiers = [];
        let previous = 0;
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (!item || typeof item !== 'object') return null;
            const id = String(item.id == null ? '' : item.id).trim();
            const maxPixels = positiveNumber(item.maxPixels);
            if (!id || !maxPixels || maxPixels <= previous) return null;
            tiers.push({ id: id, maxPixels: maxPixels });
            previous = maxPixels;
        }
        return tiers;
    }

    function normalizePolicy(raw){
        const policy = Object.assign({}, DEFAULT_POLICY);
        policy.tiers = defaultTiers();
        if (!raw || typeof raw !== 'object') return policy;
        const mode = String(raw.mode == null ? '' : raw.mode).trim().toLowerCase();
        if (MODES.indexOf(mode) >= 0) policy.mode = mode;
        const prefer = String(raw.prefer == null ? '' : raw.prefer).trim().toLowerCase();
        if (prefer === 'ratio' || prefer === 'area') policy.prefer = prefer;
        if (Array.isArray(raw.options)) {
            policy.options = raw.options
                .map(option => String(option == null ? '' : option).trim())
                .filter(Boolean);
        }
        const level = String(raw.defaultLevel == null ? '' : raw.defaultLevel).trim().toLowerCase();
        if (LEVELS.indexOf(level) >= 0) policy.defaultLevel = level;
        const tiers = normalizeTiers(raw.tiers);
        if (tiers) policy.tiers = tiers;
        policy.ratios = Array.isArray(raw.ratios)
            ? raw.ratios.map(item => String(item == null ? '' : item).trim()).filter(Boolean) : [];
        policy.resolutions = Array.isArray(raw.resolutions)
            ? raw.resolutions.map(item => String(item == null ? '' : item).trim().toLowerCase()).filter(Boolean) : [];
        policy.hintOnly = !!raw.hintOnly;
        policy.autoSize = !!raw.autoSize;
        policy.maxEdge = positiveNumber(raw.maxEdge);
        policy.maxPixels = positiveNumber(raw.maxPixels);
        policy.minPixels = positiveNumber(raw.minPixels);
        policy.multipleOf = positiveNumber(raw.multipleOf);
        policy.minRatio = positiveNumber(raw.minRatio);
        policy.maxRatio = positiveNumber(raw.maxRatio);
        return policy;
    }

    function normalizeTable(raw){
        const out = emptyTable();
        if (!raw || typeof raw !== 'object') return out;
        out.default = normalizePolicy(raw.default);
        const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
        Object.keys(models).forEach(name => {
            const key = String(name == null ? '' : name).trim();
            if (key) out.models[key] = normalizePolicy(models[key]);
        });
        return out;
    }

    /* ── 策略查询（同步；未加载或未知模型都返回 default，永不返回 null） ── */
    function policy(model){
        const key = String(model == null ? '' : model).trim();
        return (key && table.models[key]) || table.default;
    }

    // 吸附提示（smart-canvas/apiRatioSnap）以本判定为闸门：bounds 声明了比例范围时会夹比例，
    // 同样会出现「实发比例 ≠ 选中比例」，必须算进去，否则超范围比例会被静默改掉。
    function isEnum(model){
        const current = policy(model);
        return current.mode === 'enum' || (current.mode === 'bounds' && (current.minRatio > 0 || current.maxRatio > 0));
    }

    function enumOptions(model){
        const current = policy(model);
        return current.mode === 'enum' ? current.options.slice() : null;
    }

    /* ── 尺寸计算 ── */
    function parseSize(size){
        const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(String(size == null ? '' : size));
        if (!match) return null;
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return width > 0 && height > 0 ? { width: width, height: height } : null;
    }

    function hasLimits(current){
        return current.maxEdge > 0 || current.maxPixels > 0 || current.minPixels > 0
            || current.minRatio > 0 || current.maxRatio > 0;
    }

    function alignDown(value, multiple){
        if (multiple < 2) return Math.max(1, Math.round(value));
        return Math.max(multiple, Math.floor(value / multiple) * multiple);
    }

    function alignUp(value, multiple){
        if (multiple < 2) return Math.max(1, Math.round(value));
        return Math.max(multiple, Math.ceil(value / multiple) * multiple);
    }

    // 比例先夹进 [minRatio, maxRatio]，再等比缩进 maxEdge / maxPixels，按 multipleOf 对齐；
    // 对齐会再让比例越界（floor 把两边削得不一样），所以对齐后按 16 的倍数严格再夹一次；
    // 最后不足 minPixels 时等比放大（与后端 registry._fit_size_within 同规则）。
    function fitWithin(pair, current){
        let width = pair.width;
        let height = pair.height;
        if (current.maxRatio > 0 && width > height * current.maxRatio) width = height * current.maxRatio;
        if (current.minRatio > 0 && width < height * current.minRatio) height = width / current.minRatio;
        let scale = 1;
        if (current.maxEdge > 0) scale = Math.min(scale, current.maxEdge / Math.max(width, height));
        if (current.maxPixels > 0) scale = Math.min(scale, Math.sqrt(current.maxPixels / (width * height)));
        const multiple = Math.max(1, current.multipleOf);
        width = alignDown(width * scale, current.multipleOf);
        height = alignDown(height * scale, current.multipleOf);
        if (current.maxRatio > 0 && width > height * current.maxRatio) {
            width = Math.max(multiple, Math.floor(height * current.maxRatio / multiple) * multiple);
        }
        if (current.minRatio > 0 && width < height * current.minRatio) {
            height = Math.max(multiple, Math.floor(width / current.minRatio / multiple) * multiple);
        }
        if (current.minPixels > 0 && width * height < current.minPixels) {
            const grow = Math.sqrt(current.minPixels / (width * height));
            width = alignUp(width * grow, current.multipleOf);
            height = alignUp(height * grow, current.multipleOf);
        }
        return width + 'x' + height;
    }

    function orientationOf(pair){
        if (pair.width === pair.height) return 'square';
        return pair.width > pair.height ? 'landscape' : 'portrait';
    }

    // 请求尺寸自己属于哪一档：第一个 maxPixels ≥ 面积的档；超过最后一档就取最后一档
    function tierIndexOf(pair, tiers){
        const area = pair.width * pair.height;
        for (let i = 0; i < tiers.length; i++) {
            if (area <= tiers[i].maxPixels) return i;
        }
        return tiers.length - 1;
    }

    function scoreCandidate(cand, pair, current, tiers){
        const preferArea = current.prefer === 'area';
        const ratioScore = Math.abs(Math.log((pair.width / pair.height) / (cand.width / cand.height)));
        const areaScore = Math.abs(cand.width * cand.height - pair.width * pair.height);
        return {
            text: cand.text,
            tier: tiers.length ? tierIndexOf(cand, tiers) : 0,
            first: preferArea ? areaScore : ratioScore,
            second: preferArea ? ratioScore : areaScore,
        };
    }

    function pickBest(pool, pair, current, tiers){
        let best = null;
        pool.forEach(cand => {
            const scored = scoreCandidate(cand, pair, current, tiers);
            if (!best || scored.tier > best.tier
                || (scored.tier === best.tier
                    && (scored.first < best.first || (scored.first === best.first && scored.second < best.second)))) {
                best = scored;
            }
        });
        return best ? best.text : null;
    }

    function snapEnum(size, pair, current){
        const candidates = [];
        current.options.forEach(option => {
            const cand = parseSize(option);
            if (!cand) return;
            if (current.maxEdge > 0 && Math.max(cand.width, cand.height) > current.maxEdge) return;
            if (current.maxPixels > 0 && cand.width * cand.height > current.maxPixels) return;
            candidates.push({ text: option, width: cand.width, height: cand.height });
        });
        if (!candidates.length) return size;
        const tiers = Array.isArray(current.tiers) ? current.tiers : [];
        if (!tiers.length) return pickBest(candidates, pair, current, tiers) || size;
        // 用户选的档位不能被吃掉：先按方向收窄，再只留"不超过请求档位"的候选，档位高者优先
        const targetOrientation = orientationOf(pair);
        const targetTier = tierIndexOf(pair, tiers);
        let pool = candidates.filter(cand =>
            orientationOf(cand) === targetOrientation && tierIndexOf(cand, tiers) <= targetTier);
        if (!pool.length) pool = candidates;
        return pickBest(pool, pair, current, tiers) || size;
    }

    /* ── 供应商级覆盖：空数组 = 未声明 = 不过滤；只把接口下发的允许项合并到静态表之上 ── */
    function hasRatioOverride(model){ return (policy(model).ratios || []).length > 0; }

    function hasLevelOverride(model){ return (policy(model).resolutions || []).length > 0; }

    function ratioAllowed(model, ratioKey){
        const allowed = policy(model).ratios || [];
        if (!allowed.length) return true;
        const key = String(ratioKey == null ? '' : ratioKey).trim();
        const label = RATIO_ID_LABELS[key];
        return allowed.indexOf(key) >= 0 || (label ? allowed.indexOf(label) >= 0 : false);
    }

    function levelAllowed(model, level){
        const allowed = policy(model).resolutions || [];
        if (!allowed.length) return true;
        return allowed.indexOf(String(level == null ? '' : level).trim().toLowerCase()) >= 0;
    }

    function allRatioKeys(){ return Object.keys(RATIO_ID_LABELS); }

    /* ── 对外 API ── */
    function load(){
        if (!pending) {
            pending = Promise.resolve()
                .then(() => fetch('/api/ai/size-policy', { headers: { Accept: 'application/json' } }))
                .then(response => (response && response.ok ? response.json() : null))
                .then(data => { table = normalizeTable(data); return table; })
                .catch(() => { table = emptyTable(); return table; });
        }
        return pending;
    }

    function constrain(size, model){
        const raw = String(size == null ? '' : size);
        const pair = parseSize(raw);
        if (!pair) return raw;
        const current = policy(model);
        if (current.mode === 'enum') return snapEnum(raw, pair, current);
        if (current.mode === 'bounds' || hasLimits(current)) return fitWithin(pair, current);
        return raw;
    }

    function fitSource(width, height, model){
        const w = Math.round(Number(width));
        const h = Math.round(Number(height));
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return '';
        const size = w + 'x' + h;
        const pair = { width: w, height: h };
        const current = policy(model);
        if (current.mode === 'enum') return snapEnum(size, pair, current);
        if (current.mode === 'bounds' || hasLimits(current)) return fitWithin(pair, current);
        return size;
    }

    window.NovaSizePolicy = { load, policy, isEnum, enumOptions, constrain, fitSource,
        hasRatioOverride, hasLevelOverride, ratioAllowed, levelAllowed, allRatioKeys };
})();
