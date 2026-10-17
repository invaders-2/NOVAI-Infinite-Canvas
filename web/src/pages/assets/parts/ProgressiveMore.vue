<script setup>
// 分批渲染的「继续加载」哨兵：滚到附近（900px 余量）自动加载下一批，也可以手动点
import { ref, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';

defineProps({ rest: { type: Number, default: 0 } });
const emit = defineEmits(['more']);
const el = ref(null);
let io = null;
onMounted(() => {
    if (typeof IntersectionObserver !== 'function' || !el.value) return;
    const root = el.value.closest('.am-scroll');
    io = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) requestAnimationFrame(() => emit('more'));
    }, { root, rootMargin: '0px 0px 900px 0px' });
    io.observe(el.value);
});
onBeforeUnmount(() => { if (io) io.disconnect(); });
</script>

<template>
    <div ref="el" class="am-more">
        <button type="button" class="nv-btn sm" @click="emit('more')"><NvIcon name="chev" />继续加载（还有 {{ rest }} 个）</button>
    </div>
</template>
