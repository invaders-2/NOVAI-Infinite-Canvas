// 保存「能力覆盖」后让尺寸策略立即生效：清掉首次加载的缓存重新拉一份。
import { NovaSizePolicy } from '../../../../lib/sizePolicy.js';

export function refreshSizePolicy() {
    return NovaSizePolicy.reload().catch(() => {});
}
