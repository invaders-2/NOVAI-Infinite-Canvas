// 能力生图模型选择：全局一个「上次用的」，与能力/会话无关，跨刷新用 localStorage 记住。
// 未选 = 两个字段都不发（后端按既有规则自动选平台与模型）；选了就把 platform + model 交给本次能力运行。
// 失效（平台删了 / Key 清了 / 模型移除了）由 chatState.loadConfig 在配置到手后调 pruneGenImage 回退到自动，
// 请求侧再用 genImagePair 兜一道，保证失效值不会被发给后端。
import { reactive } from 'vue';

const KEY = 'novai-gen-image-model';

function readSaved() {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) || 'null');
        return v && typeof v === 'object'
            ? { provider: String(v.provider || ''), model: String(v.model || '') }
            : { provider: '', model: '' };
    } catch (e) { return { provider: '', model: '' }; }
}

const saved = readSaved();

export const GEN_IMAGE = reactive({ provider: saved.provider, model: saved.model });

export function setGenImage(provider, model) {
    const pid = String(provider || '');
    const mid = String(model || '');
    GEN_IMAGE.provider = pid;
    GEN_IMAGE.model = mid;
    try {
        if (pid && mid) localStorage.setItem(KEY, JSON.stringify({ provider: pid, model: mid }));
        else localStorage.removeItem(KEY);
    } catch (e) {}
}
export function clearGenImage() { setGenImage('', ''); }

// 当前选择在 list（providersOf('image')）里还成立时返回 {provider, model}，否则 null
export function genImagePair(list) {
    if (!GEN_IMAGE.provider || !GEN_IMAGE.model) return null;
    const p = (list || []).find(x => x.id === GEN_IMAGE.provider);
    if (!p || (p.image_models || []).indexOf(GEN_IMAGE.model) < 0) return null;
    return { provider: GEN_IMAGE.provider, model: GEN_IMAGE.model };
}

// 只在拿到真实平台列表后调用（配置已加载）；失效就清成「自动」
export function pruneGenImage(list) {
    if (!GEN_IMAGE.provider && !GEN_IMAGE.model) return;
    if (genImagePair(list)) return;
    clearGenImage();
}
