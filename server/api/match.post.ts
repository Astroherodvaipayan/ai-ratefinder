/**
 * Run the SKU matcher across a list of BOQ items.
 * Body: { boq_item_ids: string[] } | { queries: { id: string, text: string }[] }
 */
import { z } from 'zod'

const Body = z.object({
  job_id: z.string().uuid().optional(),
  queries: z.array(z.object({ id: z.string(), text: z.string() })).optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  let queries = body.queries
  if (!queries && body.job_id) {
    const { data } = await client
      .from('boq_items')
      .select('id, description')
      .eq('job_id', body.job_id)
    queries = (data ?? []).map(r => ({ id: r.id, text: r.description }))
  }
  if (!queries) throw createError({ statusCode: 400, statusMessage: 'Provide job_id or queries' })

  const results = []
  for (const q of queries) {
    const hits = await matchProducts(client, q.text, 5)
    const top = hits[0]
    const confidence = top?.score ?? 0
    const status = confidence >= 0.85 ? 'auto'
                 : confidence >= 0.6  ? 'suggested'
                 :                      'manual'

    if (body.job_id) {
      await client.from('boq_items').update({
        matched_product_id: top?.product_id ?? null,
        match_confidence: confidence,
        match_status: status
      }).eq('id', q.id)
    }

    results.push({ id: q.id, query: q.text, hits, status })
  }

  // Best-effort audit trail.
  if (body.job_id) {
    await client.from('job_messages').insert({
      job_id: body.job_id,
      role: 'assistant',
      content: `Matched ${results.length} line${results.length === 1 ? '' : 's'} against the master catalogue.`,
      data: { kind: 'match_results', results }
    })
  }

  return { results }
})
