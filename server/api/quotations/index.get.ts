export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const { data, error } = await client
    .from('quotations')
    .select('id, title, customer, status, discount_pct, gst_pct, freight, created_at, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
