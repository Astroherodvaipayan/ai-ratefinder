import { z } from 'zod'
import { currentBillingMonthStart } from '~~/shared/billing'

const Body = z.object({
  reference_no: z.string().trim().min(3).max(120),
  amount_inr: z.number().finite().positive().optional(),
  note: z.string().trim().max(500).optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const body = Body.parse(await readBody(event))

  const { data, error } = await client
    .from('api_payment_refs')
    .insert({
      owner_id: user.id,
      billing_month: currentBillingMonthStart().slice(0, 10),
      reference_no: body.reference_no,
      amount_inr: body.amount_inr ?? 1500,
      note: body.note ?? null
    })
    .select('id, reference_no, amount_inr, created_at')
    .single()

  if (error) {
    if (/api_payment_refs|schema cache|Could not find the table/i.test(error.message ?? '')) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Billing migration is not applied yet. Run supabase/migrations/0015_api_usage_billing.sql.'
      })
    }
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return { ok: true, payment_ref: data }
})
