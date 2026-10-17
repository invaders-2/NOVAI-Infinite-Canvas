<script setup>
// 页面底部「素材保存路径」（旧 asset-manager.html 内联脚本）：读取 / 选择（桌面原生选择框 → 浏览器目录选择 → 手动输入）/
// 保存后提示搬迁数量并询问是否重启 / 在资源管理器打开
import { ref, onMounted } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { pyApi } from '../../../lib/env.js';
import { ask, notify } from '../lib/state.js';

const path = ref('加载中...');
async function load() {
    try { const d = await (await fetch('/api/config/storage')).json(); path.value = d.path || '默认路径'; } catch (e) { path.value = '无法加载'; }
}
async function choose() {
    const api = pyApi();
    if (api && api.select_directory) {
        const p = await api.select_directory();
        if (p) save(p);
    } else if (typeof window.showDirectoryPicker === 'function') {
        try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); save(h.name); } catch (e) { if (e && e.name !== 'AbortError') notify('选择文件夹失败', e.message); }
    } else {
        const p = await ask({ title: '素材保存目录', desc: '请输入素材保存目录路径：', input: true, placeholder: '目录路径', ok: '保存' });
        if (p && p.trim()) save(p.trim());
    }
}
async function save(p) {
    try {
        const res = await fetch('/api/config/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
        const d = await res.json();
        path.value = d.path || p;
        const migrated = d.migrated || 0;
        const desc = (migrated > 0 ? `已搬迁 ${migrated} 个文件。` : '') + '需要重启 NOVAI 才能生效，现在重启吗？';
        if (await ask({ title: '素材路径已更新', desc, ok: '立即重启', cancel: '稍后' })) {
            const api = pyApi();
            if (api && api.quit_app) api.quit_app(); else notify('请手动重启 NOVAI。');
        }
    } catch (e) { notify('保存失败', e.message); }
}
function openDir() {
    const api = pyApi();
    if (api && api.open_data_dir) api.open_data_dir(); else notify('请在桌面应用中打开素材目录');
}
onMounted(load);
defineExpose({ load });
</script>

<template>
    <div class="am-pathbar">
        <NvIcon name="folder" /><span class="k">素材保存路径</span><span class="v" :title="path">{{ path }}</span>
        <button type="button" class="nv-btn sm ghost" @click="choose"><NvIcon name="search" />选择</button>
        <button type="button" class="nv-btn sm ghost" @click="openDir"><NvIcon name="ext" />打开</button>
    </div>
</template>

<style scoped>
.am-pathbar { flex: none; display: flex; align-items: center; gap: 10px; height: 44px; margin-top: 14px; padding: 0 8px 0 14px; border-radius: 14px; background: var(--solid); box-shadow: var(--shadow-float); font: 400 12px/1 var(--font-sans); }
.am-pathbar > .nv-i { width: 14px; height: 14px; color: var(--ink-3); flex: none; }
.k { color: var(--ink-3); flex: none; }
.v { flex: 1; min-width: 0; font: 400 11.5px/1 var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nv-btn.sm { height: 28px; flex: none; }
</style>
