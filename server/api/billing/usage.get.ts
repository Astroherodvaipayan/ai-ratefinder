import { getBillingUsageSummary } from '../../utils/billing'
import { adminClient } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return await getBillingUsageSummary(adminClient(), user.id)
})
