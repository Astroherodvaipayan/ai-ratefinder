import { normalizeCatalogSku, parseCatalogQuery } from '../../utils/catalog/query'
import { searchCatalogV2, type CatalogOfferRow } from '../../utils/catalog/searchV2'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, vendor_id: vendorId, document_id: documentId } = getQuery(event)
  if (typeof q !== 'string' || q.trim().length < 2) return { suggestions: [] }

  const client = await userClient(event)
  const input = q.trim()
  const parsed = parseCatalogQuery(input)
  const skuPrefix = normalizeCatalogSku(input.replace(/^sku\s*[:#-]?\s*/i, ''))
  const { data: release, error: releaseError } = await client
    .from('catalog_releases')
    .select('id')
    .eq('status', 'active')
    .maybeSingle()
  if (releaseError || !release) return { suggestions: [] }

  let skuQuery = client
    .from('catalog_offers')
    .select('id, canonical_name, brand, sku, amount, basis_quantity, basis_unit, package_type, category')
    .eq('release_id', release.id)
    .eq('status', 'published')
    .not('sku', 'is', null)
    .order('sku')
    .limit(100)
  if (vendorId && typeof vendorId === 'string') skuQuery = skuQuery.eq('vendor_id', vendorId)
  if (documentId && typeof documentId === 'string') skuQuery = skuQuery.eq('document_id', documentId)
  skuQuery = skuPrefix.length >= 2
    ? skuQuery.ilike('sku', skuLikePattern(skuPrefix))
    : skuQuery.eq('sku', '__no_sku__')

  const [skuResult, catalogResult] = await Promise.all([
    skuQuery,
    parsed.category
      ? searchCatalogV2({
          client,
          message: input,
          vendorId: typeof vendorId === 'string' ? vendorId : null,
          documentId: typeof documentId === 'string' ? documentId : null,
          limit: 8
        }).catch(() => null)
      : Promise.resolve(null)
  ])

  const offers = [
    ...(skuResult.data ?? []).filter((offer: any) => normalizeCatalogSku(offer.sku).startsWith(skuPrefix)),
    ...(catalogResult?.offers ?? [])
  ] as CatalogOfferRow[]
  const seen = new Set<string>()
  const suggestions = offers.flatMap((offer) => {
    const identity = offer.sku ? `sku:${normalizeCatalogSku(offer.sku)}` : `offer:${offer.id}`
    if (seen.has(identity)) return []
    seen.add(identity)
    return [{
      id: offer.id,
      label: suggestionLabel(offer),
      query: offer.sku ? `SKU ${offer.sku}` : offer.canonical_name,
      sku: offer.sku,
      brand: offer.brand,
      category: offer.category,
      amount: Number(offer.amount),
      basis: basisLabel(offer)
    }]
  }).slice(0, 8)

  return { suggestions }
})

function suggestionLabel(offer: Pick<CatalogOfferRow, 'sku' | 'brand' | 'canonical_name'>) {
  const product = String(offer.canonical_name ?? '').replace(/\s+/g, ' ').trim()
  const shortProduct = product.length > 96 ? `${product.slice(0, 93)}…` : product
  return [offer.sku, offer.brand, shortProduct].filter(Boolean).join(' · ')
}

function skuLikePattern(normalizedSku: string) {
  return `%${normalizedSku.split('').join('%')}%`
}

function basisLabel(offer: Pick<CatalogOfferRow, 'basis_quantity' | 'basis_unit' | 'package_type'>) {
  return [
    Number(offer.basis_quantity ?? 1) === 1 ? null : Number(offer.basis_quantity),
    offer.basis_unit,
    offer.package_type
  ].filter(Boolean).join(' ') || null
}
