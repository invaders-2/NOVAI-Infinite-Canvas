<script setup>
import { computed } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvPills from '../../components/NvPills.vue';
import { state, t } from '../../lib/store.js';

const theme = computed({
    get: () => state.theme,
    set: v => { if (window.StudioTheme) window.StudioTheme.set(v); },
});
const lang = computed({
    get: () => state.lang,
    set: v => { if (window.StudioI18n && window.StudioI18n.lang() !== v) window.StudioI18n.set(v); },
});
// 界面缩放：theme.js 早就支持（studio_ui_scale_mode），旧外壳没有入口，这里补上
const SCALES = ['auto', '80', '90', '100', '115', '125'];
const scaleOptions = SCALES.map(v => ({ value: v, label: v === 'auto' ? '自动' : v + '%' }));
const scale = computed({
    get: () => { void state.scaleTick; return window.StudioScale ? window.StudioScale.getMode() : 'auto'; },
    set: v => { if (window.StudioScale && window.StudioScale.set) window.StudioScale.set(v); state.scaleTick = (state.scaleTick || 0) + 1; },
});
</script>

<template>
    <div>
        <SetCard :title="t('common.themeMode', '主题模式')" :desc="t('common.themeModeDesc', '选择界面明暗模式，切换后立即生效。')">
            <SetRow label="明暗"><NvPills v-model="theme" :options="[{ value: 'light', label: t('common.light', '浅色') }, { value: 'dark', label: t('common.dark', '深色') }]" label="主题模式" /></SetRow>
        </SetCard>
        <SetCard :title="t('common.language', '语言')" :desc="t('common.languageDesc', '切换界面显示语言。')">
            <SetRow label="界面语言"><NvPills v-model="lang" :options="[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]" label="语言" /></SetRow>
        </SetCard>
        <SetCard title="界面缩放" desc="自动会按窗口大小缩放；也可以固定一个比例。">
            <SetRow label="缩放比例"><NvPills v-model="scale" :options="scaleOptions" label="界面缩放" /></SetRow>
        </SetCard>
    </div>
</template>
