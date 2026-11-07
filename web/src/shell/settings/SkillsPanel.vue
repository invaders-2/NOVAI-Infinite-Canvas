<script setup>
// 设置 → 技能：列出画布助手能用的技能（/api/skills），支持从 GitHub 安装（/api/skills/import-github，只下载 SKILL.md、不执行仓库内容）
// 和导入本地 SKILL.md（/api/skills/import）。已存在同名技能时先问要不要覆盖。
import { ref, computed, onMounted } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import SetCard from './SetCard.vue';
import { state, toast } from '../../lib/store.js';
import { navigate } from '../../lib/bridge.js';
import { ICONS } from '../../lib/icons.js';

const skills = ref([]);
const loading = ref(true);
const failed = ref(false);
const q = ref('');
const dlg = ref(false);
const gh = ref({ url: '', path: '', ref: '' });
const busy = ref(false);
const err = ref('');
const overwrite = ref(null);   // { kind: 'github' | 'file', payload }
const fileEl = ref(null);

async function load(silent) {
    if (!silent) loading.value = true;
    failed.value = false;
    try {
        const r = await fetch('/api/skills', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        skills.value = Array.isArray(d && d.skills) ? d.skills : [];
    } catch (e) { if (!silent) failed.value = true; }
    finally { if (!silent) loading.value = false; }
}

// 启停 / 删除：后端 400/404/409 的 detail 是中文可读文案，直接 toast 出来
const busyId = ref('');
const delTarget = ref(null);
const delBusy = ref(false);
function detailOf(d, status) {
    const detail = d && d.detail;
    return (typeof detail === 'string' && detail.trim()) ? detail : 'HTTP ' + status;
}
async function toggleSkill(s, next) {
    if (busyId.value) return;
    busyId.value = s.id;
    try {
        const r = await fetch('/api/skills/' + encodeURIComponent(s.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ enabled: !!next }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        toast(next ? `已启用技能「${s.name}」` : `已停用技能「${s.name}」`, { icon: 'check' });
        load(true);
    } catch (e) {
        toast((e && e.message) || '切换失败', { danger: true, icon: 'alert' });
    } finally { busyId.value = ''; }
}
function askDelete(s) { if (!delBusy.value) delTarget.value = s; }
async function doDelete(s) {
    if (delBusy.value) return;
    delBusy.value = true;
    try {
        const r = await fetch('/api/skills/' + encodeURIComponent(s.id), { method: 'DELETE', headers: { Accept: 'application/json' } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        delTarget.value = null;
        toast(`已删除技能「${s.name}」`, { icon: 'check' });
        load(true);
    } catch (e) {
        toast((e && e.message) || '删除失败', { danger: true, icon: 'alert' });
    } finally { delBusy.value = false; }
}
const match = s => { const n = q.value.trim().toLowerCase(); return !n || [s.name, s.id, s.description, s.category, ...(s.tags || [])].join(' ').toLowerCase().includes(n); };
const system = computed(() => skills.value.filter(s => s.skill_type !== 'mine' && match(s)));
const mine = computed(() => skills.value.filter(s => s.skill_type === 'mine' && match(s)));
const icon = s => (s.icon && ICONS[s.icon] ? s.icon : 'wand2');

async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
}
async function installGithub(force = false) {
    if (!gh.value.url.trim() || busy.value) return;
    busy.value = true; err.value = '';
    try {
        const { ok, status, data } = await post('/api/skills/import-github', { url: gh.value.url.trim(), path: gh.value.path.trim(), ref: gh.value.ref.trim(), overwrite: force });
        if (status === 409) { overwrite.value = { kind: 'github', text: data.detail }; return; }
        if (!ok) throw new Error(data.detail || '安装失败');
        toast(`已安装技能「${(data.skill && data.skill.name) || ''}」`, { icon: 'check' });
        dlg.value = false; overwrite.value = null; gh.value = { url: '', path: '', ref: '' };
        load();
    } catch (e) { err.value = (e && e.message) || '安装失败'; }
    finally { busy.value = false; }
}
let pendingMarkdown = '';
async function importFile(file, force = false) {
    if (!file && !pendingMarkdown) return;
    const markdown = file ? await file.text() : pendingMarkdown;
    pendingMarkdown = markdown;
    const { ok, status, data } = await post('/api/skills/import', { markdown, overwrite: force });
    if (fileEl.value) fileEl.value.value = '';
    if (status === 409) { overwrite.value = { kind: 'file', text: data.detail }; return; }
    if (!ok) { toast(data.detail || '导入失败', { danger: true, icon: 'alert' }); return; }
    pendingMarkdown = ''; overwrite.value = null;
    toast(`已导入技能「${(data.skill && data.skill.name) || ''}」`, { icon: 'check' });
    load();
}
function confirmOverwrite() {
    const o = overwrite.value; if (!o) return;
    if (o.kind === 'github') installGithub(true); else importFile(null, true);
}
function goMarket() { state.settingsOpen = false; navigate('store'); }

/* GitHub 令牌：只为本机提高读取配额/访问私有仓库；值存后端数据目录，界面只显示掩码 */
const ghToken = ref({ loading: true, configured: false, source: '', masked: '' });
const tokenInput = ref('');
const tokenBusy = ref(false);
async function loadToken() {
    ghToken.value = { ...ghToken.value, loading: true };
    try {
        const r = await fetch('/api/skills/github-token', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        ghToken.value = {
            loading: false,
            configured: !!(d && d.configured),
            source: String((d && d.source) || ''),
            masked: String((d && d.masked) || ''),
        };
    } catch (e) {
        ghToken.value = { loading: false, configured: false, source: '', masked: '' };
    }
}
async function saveToken() {
    const token = tokenInput.value.trim();
    if (!token || tokenBusy.value) return;
    tokenBusy.value = true;
    try {
        const r = await fetch('/api/skills/github-token', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ token }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        ghToken.value = {
            loading: false,
            configured: !!(d && d.configured),
            source: String((d && d.source) || 'settings'),
            masked: String((d && d.masked) || ''),
        };
        tokenInput.value = '';
        if (d && d.verified === false) toast((d && d.message) || '已保存，但没能连上 GitHub 验证令牌', { danger: true, icon: 'alert' });
        else toast(d && d.limit ? '已保存（当前配额 ' + d.limit + ' 次/小时）' : '已保存', { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '保存失败', { danger: true, icon: 'alert' });
    } finally { tokenBusy.value = false; }
}
async function clearToken() {
    if (tokenBusy.value) return;
    tokenBusy.value = true;
    try {
        const r = await fetch('/api/skills/github-token', { method: 'DELETE', headers: { Accept: 'application/json' } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        await Promise.all([loadToken(), loadRelay()]);
        const envLocked = !!(d && d.source === 'env');
        toast((d && d.message) || '已清除 GitHub 令牌', envLocked ? { danger: true, icon: 'alert' } : { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '清除失败', { danger: true, icon: 'alert' });
    } finally { tokenBusy.value = false; }
}

/* GitHub 中转：地址配好后 GitHub 读取全部走用户自己的中转服务，令牌只留在中转上 */
const relay = ref({ loading: true, configured: false, url: '', masked_secret: '' });
const relayUrl = ref('');
const relaySecret = ref('');
const relayBusy = ref(false);
const relayOn = computed(() => !relay.value.loading && relay.value.configured);
async function loadRelay() {
    relay.value = { ...relay.value, loading: true };
    try {
        const r = await fetch('/api/skills/github-relay', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        relay.value = {
            loading: false,
            configured: !!(d && d.configured),
            url: String((d && d.url) || ''),
            masked_secret: String((d && d.masked_secret) || ''),
        };
    } catch (e) {
        relay.value = { loading: false, configured: false, url: '', masked_secret: '' };
    }
}
async function saveRelay() {
    const url = relayUrl.value.trim();
    if (!url || relayBusy.value) return;
    relayBusy.value = true;
    try {
        const payload = { url };
        const secret = relaySecret.value.trim();
        if (secret) payload.secret = secret;
        const r = await fetch('/api/skills/github-relay', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        relayUrl.value = '';
        relaySecret.value = '';
        await Promise.all([loadRelay(), loadToken()]);
        toast((d && d.message) || '已保存中转地址', { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '保存失败', { danger: true, icon: 'alert' });
    } finally { relayBusy.value = false; }
}
async function clearRelay() {
    if (relayBusy.value) return;
    relayBusy.value = true;
    try {
        const r = await fetch('/api/skills/github-relay', { method: 'DELETE', headers: { Accept: 'application/json' } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(detailOf(d, r.status));
        await Promise.all([loadRelay(), loadToken()]);
        toast((d && d.message) || '已清除中转地址', { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '清除失败', { danger: true, icon: 'alert' });
    } finally { relayBusy.value = false; }
}

onMounted(() => { load(); loadToken(); loadRelay(); });
</script>

<template>
    <div class="skp">
        <div class="tools">
            <label class="search"><NvIcon name="search" /><input v-model="q" type="search" placeholder="搜索技能" autocomplete="off" aria-label="搜索技能"></label>
            <span class="sp"></span>
            <button type="button" class="nv-btn sm" @click="fileEl && fileEl.click()"><NvIcon name="upload" />导入 SKILL.md</button>
            <button type="button" class="nv-btn sm primary" @click="dlg = true; err = ''"><NvIcon name="code" />从 GitHub 安装</button>
            <input ref="fileEl" type="file" accept=".md,text/markdown,text/plain" hidden @change="e => importFile(e.target.files && e.target.files[0])">
        </div>

        <div class="ghcfg-stack">
            <div class="ghcfg ghrelay">
                <div class="ghcfg-t">
                    <b>中转地址（可选，推荐）</b>
                    <small>填了中转地址后，GitHub 读取全部走你自己的中转服务；令牌只留在中转上，本机不需要令牌。地址形如 https://xxx.workers.dev</small>
                    <small v-if="!relay.loading && !relay.configured" class="ghcfg-quiet">未配置，将直连 GitHub（受 60 次/小时限制）</small>
                </div>
                <div v-if="relay.loading" class="ghcfg-body"><span class="ghcfg-note">读取中…</span></div>
                <div v-else-if="relay.configured" class="ghcfg-body">
                    <code class="ghcfg-url" :title="relay.url">{{ relay.url }}</code>
                    <span class="ghcfg-src">已连接中转</span>
                    <button type="button" class="nv-btn sm ghost" :disabled="relayBusy" @click="clearRelay">清除</button>
                </div>
                <div v-else class="ghcfg-body">
                    <input v-model="relayUrl" type="url" class="inp mono" placeholder="https://xxx.workers.dev" autocomplete="off" spellcheck="false" aria-label="GitHub 中转地址" @keydown.enter="saveRelay">
                    <input v-model="relaySecret" type="password" class="inp mono ghcfg-secret" placeholder="共享密钥（可选）" autocomplete="new-password" spellcheck="false" aria-label="中转共享密钥" @keydown.enter="saveRelay">
                    <button type="button" class="nv-btn sm" :disabled="relayBusy || !relayUrl.trim()" @click="saveRelay">{{ relayBusy ? '保存中…' : '保存' }}</button>
                </div>
            </div>

            <div class="ghcfg ghtok">
                <div class="ghcfg-t">
                    <b>GitHub 令牌（可选）</b>
                    <small>只用于提高 GitHub 读取配额与访问私有仓库；保存在本机数据目录，不随项目提交，只发给 github.com。</small>
                </div>
                <div v-if="ghToken.loading" class="ghcfg-body"><span class="ghcfg-note">读取中…</span></div>
                <div v-else-if="ghToken.configured" class="ghcfg-body">
                    <code class="ghcfg-mask">{{ ghToken.masked || '••••••••' }}</code>
                    <span class="ghcfg-src">{{ ghToken.source === 'env' ? '环境变量' : '本机设置' }}</span>
                    <button v-if="ghToken.source !== 'env'" type="button" class="nv-btn sm ghost" :disabled="tokenBusy" @click="clearToken">清除</button>
                    <span v-else class="ghcfg-note">由环境变量控制，界面清不掉</span>
                    <span v-if="relayOn" class="ghcfg-note">已使用中转，本地令牌不再使用</span>
                </div>
                <div v-else class="ghcfg-body">
                    <input v-model="tokenInput" type="password" class="inp mono" placeholder="ghp_..." :disabled="relayOn" autocomplete="new-password" spellcheck="false" aria-label="GitHub 令牌" @keydown.enter="saveToken">
                    <button type="button" class="nv-btn sm" :disabled="relayOn || tokenBusy || !tokenInput.trim()" @click="saveToken">{{ tokenBusy ? '保存中…' : '保存' }}</button>
                    <span v-if="relayOn" class="ghcfg-note">已使用中转，本地令牌不再使用</span>
                </div>
            </div>
        </div>

        <div v-if="overwrite" class="ow">
            <NvIcon name="alert" /><span>{{ overwrite.text || '同名技能已存在。' }}</span>
            <button type="button" class="nv-btn sm" @click="overwrite = null">取消</button>
            <button type="button" class="nv-btn sm primary" @click="confirmOverwrite">覆盖</button>
        </div>

        <div v-if="loading" class="ld"><div v-for="n in 4" :key="n" class="nv-skel"></div></div>
        <div v-else-if="failed" class="empty">技能列表加载失败 <button type="button" class="nv-btn sm" @click="load">重试</button></div>
        <template v-else>
            <SetCard v-if="mine.length" :title="'我导入的 · ' + mine.length + ' 个'">
                <template v-for="s in mine" :key="s.id">
                    <div class="row">
                        <span class="lead"><NvIcon :name="icon(s)" /></span>
                        <span class="tx"><b>{{ s.name }}</b><small>{{ s.description || s.id }}</small></span>
                        <span class="st">{{ s.enabled === false ? '已停用' : '可用' }}</span>
                        <span v-if="s.builtin_pack" class="chip" title="随安装包分发，不能删除，可以停用">内置</span>
                        <NvSwitch :model-value="s.enabled !== false" :disabled="busyId === s.id" :label="'启用 ' + s.name" @update:model-value="v => toggleSkill(s, v)" />
                        <button v-if="!s.builtin_pack" type="button" class="act" :title="'删除 ' + s.name" :aria-label="'删除 ' + s.name" @click="askDelete(s)"><NvIcon name="trash" /></button>
                    </div>
                    <div v-if="delTarget && delTarget.id === s.id" class="ow in-card">
                        <NvIcon name="alert" /><span>删除后无法恢复，确定删除「{{ s.name }}」？</span>
                        <button type="button" class="nv-btn sm" @click="delTarget = null">取消</button>
                        <button type="button" class="nv-btn sm danger" :disabled="delBusy" @click="doDelete(s)">{{ delBusy ? '删除中…' : '删除' }}</button>
                    </div>
                </template>
            </SetCard>
            <div v-if="!mine.length && !system.length" class="empty-all">{{ q.trim() ? '没有匹配的技能' : '还没有技能。可以从 GitHub 安装、导入 SKILL.md，或去应用市场把技能添加到画布助手。' }}</div>
            <SetCard v-if="system.length" :title="'内置技能 · ' + system.length + ' 个'" desc="画布助手会按任务自动启用；也可以在首页输入框的「技能」里手动挂上。">
                <template v-for="s in system" :key="s.id">
                    <div class="row">
                        <span class="lead"><NvIcon :name="icon(s)" /></span>
                        <span class="tx"><b>{{ s.name }}</b><small>{{ s.description || s.id }}</small></span>
                        <span v-if="s.usage_count" class="st">用过 {{ s.usage_count }} 次</span>
                        <span v-if="s.enabled === false" class="st">已停用</span>
                        <span v-if="s.builtin_pack" class="chip" title="随安装包分发，不能删除，可以停用">内置</span>
                        <NvSwitch :model-value="s.enabled !== false" :disabled="busyId === s.id" :label="'启用 ' + s.name" @update:model-value="v => toggleSkill(s, v)" />
                        <button v-if="!s.builtin_pack" type="button" class="act" :title="'删除 ' + s.name" :aria-label="'删除 ' + s.name" @click="askDelete(s)"><NvIcon name="trash" /></button>
                    </div>
                    <div v-if="delTarget && delTarget.id === s.id" class="ow in-card">
                        <NvIcon name="alert" /><span>删除后无法恢复，确定删除「{{ s.name }}」？</span>
                        <button type="button" class="nv-btn sm" @click="delTarget = null">取消</button>
                        <button type="button" class="nv-btn sm danger" :disabled="delBusy" @click="doDelete(s)">{{ delBusy ? '删除中…' : '删除' }}</button>
                    </div>
                </template>
                <div v-if="!system.length" class="none">没有匹配的技能</div>
            </SetCard>
            <button type="button" class="more" @click="goMarket"><NvIcon name="bag" />去应用市场看更多技能<NvIcon name="chevr" /></button>
        </template>

        <Teleport to="#nv-layer">
            <div v-if="dlg" class="gh-scrim" @mousedown.self="dlg = false">
                <div class="gh" role="dialog" aria-modal="true" aria-label="从 GitHub 安装技能">
                    <div class="gh-h"><div><h3>从 GitHub 安装技能</h3><p>粘贴仓库链接，自动读取里面的 SKILL.md；只下载这个文件，不运行仓库里的任何代码。</p></div>
                        <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="dlg = false"><NvIcon name="x" /></button></div>
                    <label class="fld"><span>仓库地址</span><input v-model="gh.url" class="inp mono" placeholder="https://github.com/用户名/仓库" @keydown.enter="installGithub()"></label>
                    <div class="two">
                        <label class="fld"><span>子目录（可选）</span><input v-model="gh.path" class="inp mono" placeholder="skills/xxx"></label>
                        <label class="fld"><span>分支（可选）</span><input v-model="gh.ref" class="inp mono" placeholder="main"></label>
                    </div>
                    <p v-if="err" class="err">{{ err }}</p>
                    <div class="gh-f"><button type="button" class="nv-btn sm" @click="dlg = false">取消</button>
                        <button type="button" class="nv-btn sm primary" :disabled="!gh.url.trim() || busy" @click="installGithub()"><span v-if="busy" class="spin"></span>安装</button></div>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.tools { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
.sp { flex: 1; }
.search { display: flex; align-items: center; gap: 8px; width: 220px; height: 30px; padding: 0 10px; border-radius: 9px; background: var(--fill-1); color: var(--ink-3); }
.search .nv-i { width: 14px; height: 14px; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.search input::-webkit-search-cancel-button { display: none; }
.ow { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 10px 12px; border-radius: 12px; background: var(--fill-1); font: 400 12.5px/18px var(--font-sans); }
.ow .nv-i { width: 15px; height: 15px; color: var(--ink-2); flex: none; }
.ow span { flex: 1; }
/* 行内确认条落在卡片底色（fill-1）上，换成实底才分得出来 */
.ow.in-card { margin: 0 0 10px; background: var(--solid); }
.skp :deep(.sc-b) { padding: 4px 14px; }
.row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 9px 0; }
.skp :deep(.nv-switch:disabled) { opacity: .4; cursor: default; }
/* GitHub 中转 / 令牌：工具行下面两条不抢眼的小卡 */
.ghcfg-stack { display: flex; flex-direction: column; gap: 8px; margin: 0 0 18px; }
.ghcfg { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 11px 14px; border-radius: 12px; background: var(--fill-1); font-family: var(--font-sans); }
.ghcfg-t { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 2px; }
.ghcfg-t b { font: 500 12.5px/18px var(--font-sans); color: var(--ink-2); }
.ghcfg-t small { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.ghcfg-t small.ghcfg-quiet { color: var(--ink-4); }
.ghcfg-body { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
.ghcfg .inp { width: 220px; background: var(--solid); }
.ghcfg .inp:focus { background: var(--solid); }
.ghcfg .inp:disabled { color: var(--ink-4); cursor: default; background: var(--fill-2); }
.ghcfg .inp.ghcfg-secret { width: 150px; }
.ghcfg-mask { padding: 4px 8px; border-radius: 7px; background: var(--solid); color: var(--ink-2); font: 400 11.5px/16px var(--font-mono); }
.ghcfg-url { max-width: 220px; min-width: 0; padding: 4px 8px; border-radius: 7px; background: var(--solid); color: var(--ink-2); font: 400 11.5px/16px var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghcfg-src { padding: 2px 6px; border-radius: 5px; background: var(--fill-2); color: var(--ink-3); font: 400 10.5px/14px var(--font-sans); white-space: nowrap; }
.ghcfg-note { color: var(--ink-4); font: 400 11px/16px var(--font-sans); }
.act { width: 26px; height: 26px; flex: none; border: 0; border-radius: 7px; background: transparent; color: var(--ink-4); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background 160ms var(--ease-out), color 160ms var(--ease-out); }
.act:hover { background: var(--fill-2); color: var(--danger); }
.act .nv-i { width: 14px; height: 14px; }
.lead { width: 32px; height: 32px; border-radius: 9px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); flex: none; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.lead .nv-i { width: 15px; height: 15px; }
.tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tx b { font: 500 13px/18px var(--font-sans); }
.tx small { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st { font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); flex: none; }
/* 内置技能标记：软底 chip，不用描边 */
.chip { flex: none; padding: 2px 6px; border-radius: 5px; background: var(--fill-2); color: var(--ink-4); font: 400 10px/14px var(--font-sans); white-space: nowrap; }
.empty-all { padding: 28px 16px; border-radius: 14px; background: var(--fill-1); font: 400 12.5px/19px var(--font-sans); color: var(--ink-3); text-align: center; }
.none { padding: 16px 0; font: 400 12px/16px var(--font-sans); color: var(--ink-3); }
.ld { display: flex; flex-direction: column; gap: 8px; }
.ld .nv-skel { height: 56px; border-radius: 12px; }
.empty { display: flex; align-items: center; gap: 10px; font: 400 12.5px/18px var(--font-sans); color: var(--ink-2); }
.more { display: inline-flex; align-items: center; gap: 6px; margin-top: 18px; height: 30px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink-2); cursor: pointer; }
.more:hover { background: var(--fill-1); color: var(--ink); }
.more .nv-i { width: 14px; height: 14px; }
.gh-scrim { position: fixed; inset: 0; z-index: 2300; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim); font-family: var(--font-sans); color: var(--ink); }
.gh { width: min(480px, 100%); padding: 20px 20px 16px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; gap: 12px; animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.gh-h { display: flex; align-items: flex-start; gap: 10px; }
.gh-h > div { flex: 1; }
.gh-h h3 { margin: 0; font: 600 16px/22px var(--font-sans); }
.gh-h p { margin: 4px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.fld { display: flex; flex-direction: column; gap: 5px; font: 500 11.5px/16px var(--font-sans); color: var(--ink-2); min-width: 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.inp { height: 34px; padding: 0 12px; border: 0; outline: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-sans); min-width: 0; }
.inp.mono { font-family: var(--font-mono); font-size: 12px; }
.inp:focus { background: var(--fill-2); }
.inp::placeholder { color: var(--ink-4); }
.err { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--danger); }
.gh-f { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; display: inline-block; animation: sk-rot .8s linear infinite; }
@keyframes sk-rot { to { transform: rotate(360deg); } }
</style>
