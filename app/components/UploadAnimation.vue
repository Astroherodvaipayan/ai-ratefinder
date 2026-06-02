<script setup lang="ts">
import type { AnimationItem } from 'lottie-web'

const props = withDefaults(defineProps<{
  size?: number
  loop?: boolean
  autoplay?: boolean
}>(), {
  size: 200,
  loop: true,
  autoplay: true
})

const container = ref<HTMLElement | null>(null)
let animation: AnimationItem | null = null

function destroyAnimation() {
  animation?.destroy()
  animation = null
}

async function mountAnimation() {
  if (!import.meta.client || !container.value) return

  destroyAnimation()

  const { default: lottie } = await import('lottie-web/build/player/lottie')
  if (!container.value) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  animation = lottie.loadAnimation({
    container: container.value,
    renderer: 'canvas',
    loop: props.loop,
    autoplay: props.autoplay,
    path: '/animations/upload-content.json',
    rendererSettings: {
      preserveAspectRatio: 'xMidYMid meet',
      clearCanvas: true,
      progressiveLoad: false,
      dpr
    }
  })

  animation.addEventListener('DOMLoaded', () => {
    animation?.resize()
  })
}

function resizeAnimation() {
  animation?.resize()
}

watch(() => props.size, async () => {
  await nextTick()
  resizeAnimation()
})

watch(() => [props.loop, props.autoplay], () => {
  mountAnimation()
})

onMounted(mountAnimation)
onBeforeUnmount(destroyAnimation)
</script>

<template>
  <div
    ref="container"
    class="upload-lottie mx-auto shrink-0"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  />
</template>

<style scoped>
.upload-lottie {
  line-height: 0;
  overflow: hidden;
}

.upload-lottie :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
  display: block;
}
</style>
