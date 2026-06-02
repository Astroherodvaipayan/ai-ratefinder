<script setup lang="ts">
import { hasAuthSession } from '~/composables/useAuthSession'

definePageMeta({
  middleware: async () => {
    const supabase = useSupabaseClient()
    const authed = await hasAuthSession(supabase)
    return navigateTo(authed ? '/chats' : '/login', { replace: true })
  }
})
</script>

<template>
  <div />
</template>
