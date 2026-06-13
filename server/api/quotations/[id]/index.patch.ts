import { z } from 'zod'

const Body = z.object({
  title:        z.string().optional(),
  customer:     z.string().nullable().optional(),
  status:       z.enum(['draft', 'sent', 'archived']).optional(),
  discount_pct: z.number().min(0).max(100).optional(),
  gst_pct:      z.number().min(0).max(100).optional(),
  freight:      z.number().min(0).optional(),
  notes:        z.string().nullable().optional(),
  payment_terms: z.string().nullable().optional(),
  delivery_terms: z.string().nullable().optional(),
  validity: z.string().nullable().optional(),
  revision_no: z.number().int().min(1).optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  let { data, error } = await client
    .from('quotations')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id).select().single()

  if (error && /payment_terms|delivery_terms|validity|revision_no|schema cache|column/i.test(error.message)) {
    const {
      payment_terms: _paymentTerms,
      delivery_terms: _deliveryTerms,
      validity: _validity,
      revision_no: _revisionNo,
      ...compatibleBody
    } = body
    const retry = await client
      .from('quotations')
      .update({ ...compatibleBody, updated_at: new Date().toISOString() })
      .eq('id', id).select().single()
    data = retry.data
    error = retry.error
  }

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
