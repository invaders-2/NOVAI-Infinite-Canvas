<script setup>
// 页面底部「存储位置」（旧 asset-manager.html 内联脚本的 Vue 版）：读取 / 选择 /
// 统一迁移（数据库+画布+素材库+生成物一起走，先校验再复制，旧目录保留）/ 在资源管理器打开
import { ref, onMounted } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { pyApi } from '../../../lib/env.js';
import { ask, notify } from '../lib/state.js';
import { formatBytes } from '../../../lib/format.js';

const path = ref('加载中...');
const info = ref(null);
const hint = ref('');
async function load() {
    try {
        const res = await fetch('/api/config/storage', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        info.value = await res.json();
        path.value = info.value.assets_dir || info.value.data_root || '默认位置';
        hint.value = info.value.restart_required
            ? '新位置已保存：' + (info.value.configured_data_root || '默认位置') + '（重启后生效）'
            : info.value.data_root_source === 'env' ? '由环境变量 NOVAI_DATA_DIR 指定' : '';
    } catch (e) { path.value = '无法加载'; hint.value = ''; }
}
async function choose() {
    const api = pyApi();
    let picked = '';
    if (api && api.select_directory) {
        picked = await api.select_directory();
    } else {
        // 浏览器（File System Access）只给得到文件夹名、给不到绝对路径，后端按绝对路径迁移，
        // 所以这里一律让用户手填绝对路径，绝不拿 name 去猜（会解析到进程工作目录，真往错的地方搬）。
        const p = await ask({ title: '存储位置', desc: '请输入新的存储位置（绝对路径，会连同数据库、画布、素材库一起迁移）：', input: true, placeholder: '例如 D:\\NOVAI 或 /Volumes/Data/NOVAI', ok: '检查' });
        picked = p && p.trim();
    }
    if (picked) save(picked);
}
async function plan(target) {
    const res = await fetch('/api/config/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target, dry_run: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status));
    return data;
}
async function save(p) {
    try {
        const steps = await plan(p);
        const parts = (steps.entries || []).map(e => e.name + ' ' + e.files + ' 个文件').join('、');
        const desc = (steps.action === 'adopt' ? '目标已是 NOVAI 数据目录，将直接切换过去。' : '会把 ' + (parts || '数据') + '复制到 ' + steps.target + '（共 ' + formatBytes((steps.total || {}).bytes) + '），旧目录保留。') + ' 需要重启 NOVAI 后生效。继续吗？';
        if (!(await ask({ title: '迁移存储位置', desc, ok: steps.action === 'adopt' ? '切换' : '开始迁移', cancel: '取消' }))) return;
        path.value = '正在复制数据，请不要关闭 NOVAI…';
        const res = await fetch('/api/config/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.detail || ('HTTP ' + res.status));
        await load();
        notify('存储位置已更新', d.message || '重启 NOVAI 后生效');
    } catch (e) {
        await load();
        notify('迁移失败', (e && e.message) || '请重试');
    }
}
function openDir() {
    const api = pyApi();
    if (api && api.open_data_dir) api.open_data_dir(); else notify('请在桌面应用中打开存储目录');
}
onMounted(load);
defineExpose({ load });
</script>

<template>
    <div class="am-pathbar">
        <NvIcon name="folder" /><span class="k">存储位置</span><span class="v" :title="path">{{ path }}</span>
        <span v-if="hint" class="hint" :title="hint">{{ hint }}</span>
        <button type="button" class="nv-btn sm ghost" @click="choose"><NvIcon name="search" />选择</button>
        <button type="button" class="nv-btn sm ghost" @click="openDir"><NvIcon name="ext" />打开</button>
    </div>
</template>

<style scoped>
.am-pathbar { flex: none; display: flex; align-items: center; gap: 10px; height: 44px; margin: 0 0 14px; padding: 0 8px 0 14px; border-radius: 12px; background: var(--fill-1); font: 400 12px/1 var(--font-sans); }
.am-pathbar > .nv-i { width: 14px; height: 14px; color: var(--ink-3); flex: none; }
.k { color: var(--ink-3); flex: none; }
.v { flex: 1; min-width: 0; font: 400 11.5px/1 var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { flex: none; max-width: 260px; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nv-btn.sm { height: 28px; flex: none; }
</style>
