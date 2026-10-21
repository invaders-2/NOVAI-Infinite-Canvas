// 资产「注册到平台」（真人 / 数字人私域素材审核）：平台判断、注册、查询、自动轮询，与旧版一致
import { S, setStatus } from './state.js';
import { apiJson, jsonBody } from './util.js';
import { L, findAsset, libId, setLibrary } from './library.js';

// 认证支持的平台键（与后端 AVATAR_SUPPORTED_PLATFORMS 保持一致；新增平台时同步）
const SUPPORTED = ['apimart', 'volcengine'];
const LABELS = { apimart: 'APIMart', volcengine: '火山引擎' };

export function providerPlatform(p) {
    const proto = String(p?.protocol || '').toLowerCase();
    const base = String(p?.base_url || '').toLowerCase();
    if (proto === 'apimart' || base.includes('apimart.ai') || base.includes('apib.ai')) return 'apimart';
    if (proto === 'volcengine') return 'volcengine';
    return '';
}
export const providerSupported = p => SUPPORTED.includes(providerPlatform(p));
export const platformLabel = platform => LABELS[String(platform || '')] || String(platform || '平台');
export const candidateProviders = () => (S.providers || []).filter(p => p && p.enabled !== false);
export function activeProvider() {
    const list = candidateProviders();
    if (!list.length) return null;
    return list.find(p => p.id === L.avatarProvider) || list.find(providerSupported) || list[0];
}
export function providerOptionLabel(p) {
    const name = p.name || p.id;
    const platform = providerPlatform(p);
    if (!platform) return `${name}（暂不支持，待接入）`;
    if (!providerSupported(p)) return `${name}（${platformLabel(platform)}·待接入）`;
    return `${name}（${platformLabel(platform)}）`;
}
// 找出某平台当前可用的 provider_id（优先注册时记录的，其次同平台任一启用 provider）
export function providerIdForPlatform(platform, preferredId = '') {
    const list = candidateProviders();
    if (preferredId && list.some(p => p.id === preferredId)) return preferredId;
    return list.find(p => providerPlatform(p) === platform)?.id || '';
}
export function registrations(item) {
    const regs = item && item.registrations && typeof item.registrations === 'object' ? item.registrations : {};
    return Object.keys(regs).filter(k => regs[k] && regs[k].task_id).map(platform => ({ platform, ...regs[platform] }));
}
function regOf(item, platform) {
    const regs = item && item.registrations && typeof item.registrations === 'object' ? item.registrations : {};
    return regs[platform] || null;
}
function providerById(id) { return (id && (S.providers || []).find(p => p.id === id)) || activeProvider(); }

export async function register(id, providerId = '') {
    if (!findAsset(id)) return;
    const provider = providerById(providerId);
    if (!provider) { setStatus('请先在 API 平台管理中添加并启用 API 平台'); return; }
    if (!providerSupported(provider)) { setStatus(`「${platformLabel(providerPlatform(provider))}」的资产认证 API 尚未接入`); return; }
    if (L.avatarBusy) return;
    L.avatarBusy = id; L.sel = id;
    const label = platformLabel(providerPlatform(provider));
    setStatus(`正在上传素材并提交 ${label} 审核…`);
    try {
        setLibrary(await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/register-avatar`, jsonBody('POST', { library_id: libId(), provider_id: provider.id })));
        setStatus(`已提交审核，正在等待 ${label} 通过…`);
        schedulePoll(id, provider.id);
    } catch (err) { setStatus(err.message || '数字人提交失败'); } finally { L.avatarBusy = ''; }
}
export async function checkStatus(id, silent = false, providerId = '') {
    if (!findAsset(id)) return;
    const provider = providerById(providerId);
    if (!provider) return;
    const platform = providerPlatform(provider);
    const reg = regOf(findAsset(id), platform);
    if (!reg || !reg.task_id) return;
    if (!silent) { L.avatarBusy = id; setStatus('正在查询审核状态…'); }
    try {
        const data = await apiJson(`/api/asset-library/items/${encodeURIComponent(id)}/avatar-status`, jsonBody('POST', { library_id: libId(), provider_id: provider.id }));
        setLibrary(data);
        const newReg = (data.item?.registrations && data.item.registrations[platform]) || {};
        if (newReg.status === 'Active') setStatus('审核通过，已生成 asset:// 地址，可在视频生成中通过 @ 调用');
        else if (newReg.status === 'Failed') setStatus(newReg.detail || '审核未通过');
        else { setStatus('仍在审核中，稍后会自动刷新…'); schedulePoll(id, provider.id); }
    } catch (err) { if (!silent) setStatus(err.message || '查询审核状态失败'); } finally { L.avatarBusy = ''; }
}
function schedulePoll(id, providerId) {
    setTimeout(() => {
        const item = findAsset(id);
        const provider = (S.providers || []).find(p => p.id === providerId);
        if (!item || !provider) return;
        const reg = regOf(item, providerPlatform(provider));
        if (reg && reg.task_id && reg.status === 'Processing') checkStatus(id, true, providerId);
    }, 6000);
}
