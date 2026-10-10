// 思考条 / 思考强度相关的纯函数（移植自旧 gpt-chat.html）。

// 十分之一秒 → 「6.4s」/「1m 3.2s」
export function thoughtFmt(ds) {
    return ds < 600 ? (ds / 10).toFixed(1) + 's' : Math.floor(ds / 600) + 'm ' + ((ds % 600) / 10).toFixed(1) + 's';
}

// 思考文本 → 条目：先按换行切，长行再按句末切（流式常见一整段没有换行）
export function thoughtTraceEntries(text) {
    const entries = [];
    String(text || '').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        (trimmed.match(/[^。！？!?；;]+[。！？!?；;]*/g) || [trimmed]).forEach(piece => {
            const item = piece.trim();
            if (item) entries.push(item);
        });
    });
    return entries;
}

export const THINK_LEVELS = [
    { key: 'low', label: '低' },
    { key: 'mid', label: '中' },
    { key: 'high', label: '高' },
    { key: 'xhigh', label: '极高' },
    { key: 'max', label: 'Max' },
];
export function thinkLevelLabel(k) {
    const hit = THINK_LEVELS.find(t => t.key === k);
    return hit ? hit.label : '中';
}

// 基于模型名的推理能力启发式（兜底；后端 model_caps 优先；与 main.py:THINK_MODEL_PATTERN 同步）
export function legacyThinkLevels(modelName) {
    const n = String(modelName).toLowerCase();
    const patterns = [
        /thinking/,
        /qwq/, /qwen3[-_]?(thought|thinking)?/, /qwen3[-_](32b|235b|30b|14b|8b|4b|0\.6b|a22b)[-_]?(thinking)?/,
        /deepseek[-_]?r1\b/, /deepseek[-_]?reasoner/, /\br1\b/, /reasoner/,
        /glm[-_]?z1/, /glm[-_]?zero/,
        /kimi[-_]?(thinking|k2)/, /k2/,
        /(^|[^a-z0-9])o1([^a-z0-9]|$)/, /(^|[^a-z0-9])o3([^a-z0-9]|$)/, /(^|[^a-z0-9])o4([^a-z0-9]|$)/,
        /claude[-_]?3[-_]?(7|5)[-_]?sonnet/, /claude[-_]?3[-_]?opus/,
        /gemini[-_]?2[.-]?(0|5)[-_]?(pro|flash)/, /gemini[-_]?2[.-]?5/,
    ];
    return patterns.some(p => p.test(n)) ? ['low', 'mid', 'high', 'xhigh', 'max'] : null;
}

// providers：当前可用的对话平台列表（带 model_caps）
export function getThinkLevels(modelName, providers) {
    if (!modelName) return null;
    for (const p of providers || []) {
        const caps = p && p.model_caps;
        if (caps && caps[modelName] && Array.isArray(caps[modelName].think)) return caps[modelName].think;
    }
    return legacyThinkLevels(modelName);
}
