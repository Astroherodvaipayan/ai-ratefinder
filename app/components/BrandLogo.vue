<script setup lang="ts">
const props = withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md'
})

const sizeClass = computed(() => ({
  sm: 'size-8',
  md: 'size-10',
  lg: 'size-12'
}[props.size]))
</script>

<template>
  <span
    class="grid shrink-0 place-items-center overflow-hidden rounded-lg border border-default bg-white shadow-sm"
    :class="sizeClass"
  >
    <img
      src="/brand/rj-logo.png"
      alt=""
      class="size-full object-contain p-1"
      draggable="false"
    >
  </span>
</template>
