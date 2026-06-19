export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)
  const { data: vendor, error: vendorError } = await client
    .from('vendors')
    .select('owner_id')
    .eq('id', id)
    .single()
  if (vendorError || !vendor) throw createError({ statusCode: 404, statusMessage: 'Vendor not found' })
  if (vendor.owner_id !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Only the creator can delete this vendor.' })
  }

  const { error } = await client
    .from('vendors')
    .delete()
    .eq('id', id)

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { ok: true }
})
