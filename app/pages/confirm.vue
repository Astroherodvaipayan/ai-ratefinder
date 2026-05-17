<script setup lang="ts">
definePageMeta({ layout: false })

const user = useSupabaseUser()
watchEffect(() => { if (user.value) navigateTo('/') })
</script>

<template>
  <div class="grid min-h-screen place-items-center">
    <div class="text-center text-sm text-muted">
      <UIcon name="i-lucide-loader-2" class="animate-spin text-2xl" />
      <p class="mt-2">Confirming your session…</p>
    </div>
  </div>
</template>
