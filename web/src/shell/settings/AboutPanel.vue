<script setup>
// 关于：当前版本、检查更新、一键更新（进度）、回滚到更新前的备份（旧版只有函数没有入口，这里补上）、快速上手、项目主页
import { ref, onMounted } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvIcon from '../../components/NvIcon.vue';
import NvProgress from '../../components/NvProgress.vue';
import { state, toast } from '../../lib/store.js';
import { upd, hasUpdate, versionLabel, checkForUpdates, openUpdateModal, listUpdateBackups, rollback, stageText } from '../../lib/update.js';

const emit = defineEmits(['quickstart']);
const backups = ref(null);
const pick = ref('');
const rolling = ref(false);
async function loadBackups() {
    try { backups.value = await listUpdateBackups(); } catch (e) { backups.value = []; }
}
async function doRollback() {
    if (!pick.value) { pick.value = backups.value && backups.value[0] ? backups.value[0].name : ''; return; }
    rolling.value = true;
    try {
        const d = await rollback(pick.value);
        toast(`已还原 ${d.count || 0} 个文件，后端正在重启`, { icon: 'check', duration: 5000 });
    } catch (e) { toast('回滚失败：' + e.message, { danger: true, icon: 'alert' }); }
    rolling.value = false;
}
function fmt(b) {
    const d = new Date((b.created_at || 0) * 1000);
    return `${d.toLocaleString()} · ${b.file_count || 0} 个文件`;
}
function openRepo() { window.open(upd.info.repo_url || 'https://github.com/invaders-2/NOVAI-Infinite-Canvas', '_blank', 'noopener'); }
function openLegacy() { location.href = '/legacy'; }
onMounted(loadBackups);
</script>

<template>
    <div>
        <SetCard title="更新" desc="检查并获取最新版本。">
            <SetRow label="当前版本"><span class="mono ver">{{ versionLabel(state.version) }}</span><span v-if="hasUpdate()" class="nv-badge strong">新版本 {{ versionLabel(upd.remote) }}</span></SetRow>
            <SetRow label="检查更新" desc="从当前选择的更新源检查是否有新版本">
                <button type="button" class="nv-btn sm" :disabled="upd.checking" @click="checkForUpdates(true)"><span v-if="upd.checking" class="spin sm"></span><NvIcon v-else name="refresh" />检查更新</button>
            </SetRow>
            <SetRow label="一键更新" desc="先测试连通性、选下载源，更新前自动备份，完成后后端自动重启">
                <button type="button" class="nv-btn sm" :class="{ primary: hasUpdate() }" @click="openUpdateModal"><NvIcon name="arrowup" />{{ hasUpdate() ? '更新到 ' + versionLabel(upd.remote) : '一键更新' }}</button>
            </SetRow>
            <NvProgress v-if="upd.running && upd.progress" class="prog" :stage="stageText(upd.progress)" :percent="Number(upd.progress.percent) || 0" :error="upd.progress.stage === 'error'" :detail="upd.progress.stage === 'downloading' && upd.progress.current_file ? '当前文件：' + upd.progress.current_file : ''" />
        </SetCard>
        <SetCard title="回滚" desc="每次一键更新前都会备份旧文件；更新后出问题可以还原到其中一份，后端会自动重启。">
            <div v-if="backups === null" class="empty">读取中…</div>
            <div v-else-if="!backups.length" class="empty">还没有更新备份</div>
            <template v-else>
                <label v-for="b in backups.slice(0, 8)" :key="b.name" class="bk" :class="{ on: pick === b.name }">
                    <input v-model="pick" type="radio" name="upd-backup" :value="b.name">
                    <span class="dot"></span>
                    <span class="nm mono">{{ b.name }}</span>
                    <span class="mt">{{ fmt(b) }}</span>
                </label>
                <div class="acts">
                    <button type="button" class="nv-btn sm danger" :disabled="rolling" @click="doRollback">{{ pick ? '还原到这份备份' : '选择一份备份' }}</button>
                    <span v-if="pick" class="hint">还原后后端会自动重启，本页会在恢复后刷新</span>
                </div>
            </template>
        </SetCard>
        <SetCard title="NOVAI" desc="本地 AI 创作工具：无限画布 + 多模型调用。">
            <SetRow label="快速上手" desc="重新看一遍功能介绍"><button type="button" class="nv-btn sm ghost" @click="emit('quickstart')"><NvIcon name="book" />打开</button></SetRow>
            <SetRow label="旧版界面" desc="新界面遇到问题时可临时切回旧版，旧版地址为 /legacy"><button type="button" class="nv-btn sm ghost" @click="openLegacy"><NvIcon name="ext" />切换</button></SetRow>
            <SetRow label="项目主页" desc="源码、问题反馈与发布说明"><button type="button" class="nv-btn sm ghost" @click="openRepo"><NvIcon name="ext" />GitHub</button></SetRow>
        </SetCard>
    </div>
</template>

<style scoped>
.ver { font: 400 13px/1 var(--font-mono); color: var(--ink-2); }
.prog { margin: 4px 0 12px; }
.empty { padding: 20px 0; text-align: center; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.bk { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
.bk + .bk { box-shadow: 0 -1px 0 var(--separator); }
.bk input { position: absolute; opacity: 0; pointer-events: none; }
.bk .dot { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--ink-4); flex: none; transition: box-shadow var(--duration-fast); }
.bk.on .dot { box-shadow: inset 0 0 0 4.5px var(--ink); }
.bk .nm { font: 400 12px/1 var(--font-mono); color: var(--ink); }
.bk .mt { margin-left: auto; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.acts { display: flex; align-items: center; gap: 10px; padding: 12px 0; }
.hint { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.spin.sm { width: 12px; height: 12px; }
</style>
