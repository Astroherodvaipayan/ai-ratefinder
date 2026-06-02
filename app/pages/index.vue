<script setup lang="ts">
definePageMeta({
  middleware: () => {
    const session = useSupabaseSession()
    return navigateTo(session.value ? '/chats' : '/login', { replace: true })
  }
})
</script>

<template>
  <div />
</template>
