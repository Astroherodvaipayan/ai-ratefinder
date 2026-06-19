import { z } from 'zod'

const Body = z.object({
  vendor_name: z.string().trim().min(1, 'Vendor name is required.')
})

async function ensureVendorByName(params: {
  client: Awaited<ReturnType<typeof userClient>>
  ownerId: string
  name: string
}) {
  const { data: existing } = await params.client
    .from('vendors')
    .select('id, name')
    .eq('name', params.name)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) return existing

  const { data: created, error } = await params.client
    .from('vendors')
    .insert({ owner_id: params.ownerId, name: params.name })
    .select('id, name')
    .single()
  if (error || !created) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Could not create vendor.' })
  }
  return created
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data: doc, error: docError } = await client
    .from('documents')
    .select('owner_id')
    .eq('id', id)
    .single()
  if (docError || !doc) throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  if (doc.owner_id !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Only the uploader can edit this document.' })
  }

  const vendor = await ensureVendorByName({
    client,
    ownerId: user.id,
    name: body.vendor_name
  })

  const { data, error } = await client
    .from('documents')
    .update({
      vendor_id: vendor.id,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select('id, vendor:vendor_id(id, name)')
    .single()

  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Could not update document vendor.' })
  }

  return data
})
