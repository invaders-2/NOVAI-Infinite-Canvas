<script setup>
// 存储设置 → 输出目录：自定义生成图片 / 视频的保存位置（/api/settings/output-dir、/api/pick-folder，照旧）
import { ref, onMounted } from 'vue';
import AIcon from './AIcon.vue';
import ApiHead from './ApiHead.vue';
import { toast } from '../../../../lib/store.js';

const dir = ref('');
const status = ref({ text: '', ok: false });
const saving = ref(false);
const inputEl = ref(null);

async function load() {
    try {
        const data = await fetch('/api/settings/output-dir').then(r => r.json());
        dir.value = data.output_dir || '';
        status.value = data.is_custom
            ? { text: '当前生效路径: ' + data.effective_output_dir, ok: true }
            : { text: '当前使用默认路径: ' + data.effective_output_dir, ok: false };
    } catch (e) { console.error('加载输出目录设置失败:', e); }
}
async function save() {
    if (saving.value) return;
    saving.value = true;
    try {
        const res = await fetch('/api/settings/output-dir', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output_dir: dir.value.trim() }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            status.value = { text: (data.message || '已保存') + '。重启后生效。', ok: true };
            dir.value = data.output_dir || '';
            toast('已保存输出目录，重启后生效', { icon: 'check' });
        } else toast('保存失败: ' + (data.detail || '未知错误'), { danger: true, icon: 'alert' });
    } catch (e) { toast('保存失败: ' + e.message, { danger: true, icon: 'alert' }); }
    finally { saving.value = false; }
}
function reset() { dir.value = ''; save(); }
async function browse() {
    try {
        const data = await fetch('/api/pick-folder', { method: 'POST' }).then(r => r.json());
        if (data.path) dir.value = data.path;
    } catch (e) {
        // 浏览器环境不支持选择目录：让用户手动输入
        if (inputEl.value) inputEl.value.focus();
    }
}
onMounted(load);
</script>

<template>
    <div class="sv">
        <ApiHead crumb="存储设置" title="输出目录" url="自定义生成的图片、视频保存位置（不影响 API 配置和画布数据）">
            <template #actions>
                <button type="button" class="nv-btn sm" :disabled="saving" @click="save"><span v-if="saving" class="spin xs"></span><AIcon v-else name="save" />保存</button>
            </template>
        </ApiHead>
        <section class="blk">
            <div class="bh"><b>生成文件存放路径</b><span>修改后需重启应用生效。留空恢复默认路径（%APPDATA%\NOVAI\output）</span></div>
            <label class="lb" for="api-output-dir">自定义目录</label>
            <div class="row">
                <input id="api-output-dir" ref="inputEl" v-model="dir" class="inp" type="text" placeholder="例如 D:\NOVAI\图片输出" spellcheck="false" @keydown.enter="save">
                <button type="button" class="nv-btn sm lk" @click="browse"><AIcon name="search" />浏览</button>
                <button type="button" class="nv-btn sm lk" @click="reset"><AIcon name="refresh" />默认</button>
            </div>
            <div v-if="status.text" class="st" :class="{ ok: status.ok }">{{ status.text }}</div>
        </section>
    </div>
</template>

<style scoped>
.sv { display: flex; flex-direction: column; gap: 22px; }
.blk { background: var(--fill-1); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.bh { margin-bottom: 4px; }
.bh b { display: block; font: 500 13px/19px var(--font-sans); }
.bh span { display: block; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.lb { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.row { display: flex; align-items: center; gap: 6px; }
.inp { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--solid); font: 400 12px/1 var(--font-mono); color: var(--ink); transition: box-shadow 160ms; }
.inp:focus { background: var(--fill-2); box-shadow: none; }
.inp::placeholder { font-family: var(--font-sans); color: var(--ink-4); }
.lk { background: var(--solid); }
.lk:hover { background: var(--fill-2); }
.st { font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
.st.ok { color: var(--ink); }
.spin.xs { width: 12px; height: 12px; border-width: 1.2px; }
</style>
