// 保存「能力覆盖」后让尺寸策略在整页立即生效。
// 策略表在页面模块里只拉一次（首次 promise 被缓存），所以这里清掉缓存重拉；
// 再调在线生图页的 loadPolicy()，它会 bump policyTick 让比例 / 档位下拉跟着重算。
import { NovaSizePolicy } from '../../../../pages/online/sizePolicy.js';
import { loadPolicy } from '../../../../pages/online/useOnline.js';

export function refreshSizePolicy() {
    return NovaSizePolicy.reload().then(loadPolicy).catch(() => {});
}
