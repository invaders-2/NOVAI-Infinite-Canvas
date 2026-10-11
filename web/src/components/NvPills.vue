<script setup>
// 分段选择（带滑动底块）：options = [{ value, label, sub? }]
import { ref, watch, nextTick } from 'vue';
import { useGlide } from '../lib/glide.js';
const props = defineProps({ modelValue: [String, Number], options: Array, label: String, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const host = ref(null);
const g = useGlide(host, 'button');
watch(() => [props.modelValue, props.options && props.options.length], () => nextTick(g.refresh));
</script>
<template>
    <div ref="host" class="nv-seg" role="group" :aria-label="label">
        <span class="thumb-slide" data-glide-pill></span>
        <button v-for="o in options" :key="o.value" type="button" :class="{ 'is-on': o.value === modelValue }" :aria-pressed="o.value === modelValue" :disabled="disabled"
                @click="emit('update:modelValue', o.value)">{{ o.label }}<em v-if="o.sub" class="sub">{{ o.sub }}</em></button>
    </div>
</template>
<style scoped>
.sub { font-style: normal; color: var(--ink-4); margin-left: 6px; font-weight: 400; }
.nv-seg button:disabled { opacity: .5; cursor: default; }
</style>
