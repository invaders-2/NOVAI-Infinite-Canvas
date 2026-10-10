<script setup>
defineProps({ modelValue: Boolean, label: String, disabled: Boolean });
defineEmits(['update:modelValue']);
</script>
<template>
    <button type="button" role="switch" class="nv-switch" :class="{ 'is-on': modelValue }" :aria-checked="modelValue" :aria-label="label" :disabled="disabled"
            @click="$emit('update:modelValue', !modelValue)"></button>
</template>
