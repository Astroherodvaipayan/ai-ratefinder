export default defineEventHandler(async (event) => {
  await requireUser(event)
  const itemId = getRouterParam(event, 'itemId')!
  const client = await userClient(event)
  const { error } = await client.from('quotation_items').delete().eq('id', itemId)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { ok: true }
})
