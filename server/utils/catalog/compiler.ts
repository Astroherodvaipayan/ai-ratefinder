import { GoogleGenAI, Type } from '@google/genai'
import {
  CATALOG_CATEGORIES,
  CATALOGUE_COMPILER_VERSION,
  type CatalogCategory,
  type CatalogFacets,
  type CompiledCatalogOffer,
  validateCompiledOffer
} from './contracts'
import { sourceExcerpt, type SourceTable } from './sourceTables'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const MAX_ROWS_PER_CHUNK = 32
const HEADER_ROWS_PER_CHUNK = 6

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    offers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, enum: [...CATALOG_CATEGORIES] },
          canonical_name: { type: Type.STRING },
          brand: { type: Type.STRING, nullable: true },
          sku: { type: Type.STRING, nullable: true },
          aliases: { type: Type.ARRAY, items: { type: Type.STRING } },
          facets: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                value: { type: Type.STRING }
              },
              required: ['name', 'value']
            }
          },
          currency: { type: Type.STRING },
          basis_quantity: { type: Type.NUMBER, nullable: true },
          basis_unit: { type: Type.STRING, nullable: true },
          package_type: { type: Type.STRING, nullable: true },
          moq: { type: Type.STRING, nullable: true },
          source_row_index: { type: Type.INTEGER },
          source_col_index: { type: Type.INTEGER },
          source_row_label: { type: Type.STRING, nullable: true },
          source_column_label: { type: Type.STRING, nullable: true }
        },
        required: [
          'category', 'canonical_name', 'aliases', 'facets', 'currency',
          'source_row_index', 'source_col_index'
        ]
      }
    }
  },
  required: ['offers']
}

const SYSTEM_INSTRUCTION = `
You compile vendor price-list tables into purchasable catalogue offers.

Your job is semantic table interpretation, not price generation.
- Emit one offer for every actual monetary price cell in the supplied rows.
- source_row_index and source_col_index MUST identify the exact numeric price cell.
- Never point to a product name, SKU, size, conductor construction, amp rating, pole/core count, pack quantity, serial number, HSN code, dimension, discount, or other specification.
- Do not emit totals, tax, contact information, or catalogue prose.
- Use inherited/merged table headers to preserve variants and price basis.
- The canonical name must identify the purchasable variant without document filenames or marketing prose.
- Put structured facts in facets. Prefer these facet names when applicable:
  standard, conductor_material, armour, cores, pairs, size_sqmm, conductor_size_mm,
  voltage_grade, fire_rating, insulation, current_a, poles, curve,
  breaking_capacity_ka, size_mm, ways, modules, colour, series, variant.
- Distinguish MCB, MCCB, RCCB, RCBO, isolator, switch, and socket categories.
- Distinguish coaxial, data, telephone, flexible, single-core, and power cables.
- CU means copper; AL/Alu means aluminium; CCS is copper-clad steel, not copper.
- basis_quantity/basis_unit describe what the selected amount buys. Example: a 305 m coil has basis_quantity=305, basis_unit="meter", package_type="coil".
- If table meaning is not clear enough to identify the product and price basis, omit the offer. Do not guess.
`.trim()

interface ModelOffer {
  category: CatalogCategory
  canonical_name: string
  brand?: string | null
  sku?: string | null
  aliases?: string[]
  facets?: Array<{ name: string, value: string }>
  currency?: string
  basis_quantity?: number | null
  basis_unit?: string | null
  package_type?: string | null
  moq?: string | null
  source_row_index: number
  source_col_index: number
  source_row_label?: string | null
  source_column_label?: string | null
}

export interface CompileTableOptions {
  apiKey: string
  table: SourceTable
  documentName: string
  vendorName?: string | null
  model?: string
}

export type NumericCellDecisionReason =
  | 'selected_explicit_price'
  | 'selected_matrix_price'
  | 'non_commercial_table'
  | 'header_or_section_value'
  | 'identity_or_specification'
  | 'total_or_tax_row'
  | 'insufficient_price_context'

export interface NumericCellDecision {
  source_row_index: number
  source_col_index: number
  raw_value: string
  amount: number
  selected: boolean
  reason: NumericCellDecisionReason
}

export interface TableCompilationAudit {
  source_page: number | null
  source_table_index: number
  commercial: boolean
  commercial_reasons: string[]
  matrix_likely: boolean
  numeric_cells: number
  selected_price_cells: number
  published_offers: number
  quarantined_offers: number
  decisions: NumericCellDecision[]
}

export interface DeterministicTableCompilation {
  offers: CompiledCatalogOffer[]
  audit: TableCompilationAudit
}

export async function compileSourceTable(options: CompileTableOptions): Promise<CompiledCatalogOffer[]> {
  if (!options.apiKey) throw new Error('GEMINI_API_KEY is required for catalogue compilation')
  if (!commercialTableProfile(options).commercial) return []

  const ai = new GoogleGenAI({ apiKey: options.apiKey })
  const modelOffers: ModelOffer[] = []
  try {
    for (const rows of tableChunks(options.table.grid)) {
      const response = await ai.models.generateContent({
        model: options.model ?? DEFAULT_MODEL,
        contents: JSON.stringify({
          document: options.documentName,
          vendor: options.vendorName ?? null,
          source_page: options.table.page,
          table_index: options.table.tableIndex,
          table_title: options.table.title,
          rows
        }),
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0
        }
      })
      const parsed = JSON.parse(response.text ?? '{"offers":[]}') as { offers?: ModelOffer[] }
      modelOffers.push(...(parsed.offers ?? []))
    }
  } catch (error) {
    if (!isModelUnavailable(error)) throw error
    return compileSourceTableDeterministically(options)
  }

  return dedupeOffers(modelOffers.map(modelOffer => materializeOffer(options, modelOffer)))
}

export function compileSourceTableDeterministically(options: Omit<CompileTableOptions, 'apiKey'>): CompiledCatalogOffer[] {
  return analyzeSourceTableDeterministically(options).offers
}

export function analyzeSourceTableDeterministically(options: Omit<CompileTableOptions, 'apiKey'>): DeterministicTableCompilation {
  const grid = options.table.grid
  const commercialProfile = commercialTableProfile(options)
  const decisions: NumericCellDecision[] = []
  const numericCells = grid.flatMap((row, rowIndex) => row.flatMap((rawValue, colIndex) => {
    const amount = strictMoney(rawValue)
    return amount === null ? [] : [{ rowIndex, colIndex, rawValue, amount }]
  }))

  if (!commercialProfile.commercial) {
    return {
      offers: [],
      audit: {
        source_page: options.table.page,
        source_table_index: options.table.tableIndex,
        commercial: false,
        commercial_reasons: commercialProfile.reasons,
        matrix_likely: commercialProfile.matrixLikely,
        numeric_cells: numericCells.length,
        selected_price_cells: 0,
        published_offers: 0,
        quarantined_offers: 0,
        decisions: numericCells.map(cell => ({
          source_row_index: cell.rowIndex,
          source_col_index: cell.colIndex,
          raw_value: cell.rawValue,
          amount: cell.amount,
          selected: false,
          reason: 'non_commercial_table'
        }))
      }
    }
  }

  let section = options.table.title ?? ''
  let columnHeaders: string[] = []
  let variantHeaders: string[] = []
  let columnProductBands: string[][] = []
  let sawNumericSinceProductBand = false
  let activeBasisContext = ''
  const offers: CompiledCatalogOffer[] = []

  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] ?? []
    const nextRow = grid[rowIndex + 1] ?? []
    const rowProductSection = row.every(cell => strictMoney(cell) === null) ? productSectionFromHeader(row) : null
    if (isSectionRow(row)) {
      const sectionRow = uniqueStrings(row).join(' ')
      section = sectionRow
      const explicitBasis = priceBasisContextFromRow(row)
      if (explicitBasis) activeBasisContext = explicitBasis
      else if (activeBasisContext && /^(?:joints?|angles?|end caps?|brackets?|junctions?|supports?\b)/i.test(sectionRow)) activeBasisContext = ''
      const nextRowContinuesCurrentSchema = columnHeaders.length > 0
        && grid.slice(rowIndex + 1, rowIndex + 6).some(candidate =>
          candidate.length === columnHeaders.length
          && candidate.some(cell => strictMoney(cell) !== null))
      if (!rowProductSection && !nextRowContinuesCurrentSchema) {
        columnHeaders = []
        variantHeaders = []
        columnProductBands = []
        sawNumericSinceProductBand = false
      }
      recordSkippedNumericCells(decisions, row, rowIndex, 'header_or_section_value')
      continue
    }
    const productBand = rowProductSection
    if (productBand) section = productBand
    const productCodeBand = isProductCodeBandRow(row)
    const alignedHeaderRow = productCodeBand ? row : realignHeaderRow(row, nextRow)
    const matrixHeader = matrixVariantHeader(alignedHeaderRow, nextRow)
    const textualVariantHeader = isTextualVariantSubheader(alignedHeaderRow, nextRow, columnHeaders)
    const embeddedNumericHeader = isEmbeddedNumericHeaderRow(row, nextRow)
    const hybridHeaderDataRow = row.some(cell => strictMoney(cell) !== null)
      && row.slice(1).some(isProductDescriptorCell)
    const sparseProductSection = Boolean(productBand)
      && row.every(cell => strictMoney(cell) === null)
      && row.filter(cell => cell.trim()).length <= Math.ceil(row.length / 2)
    const sparseAdministrativeSection = columnHeaders.length > 0
      && row.every(cell => strictMoney(cell) === null)
      && row.filter(cell => cell.trim()).length <= Math.ceil(row.length / 2)
      && row.slice(1).filter(cell => cell.trim()).every(cell => /^(?:hsn|sac|gst|tax)(?:\s+code)?\b/i.test(cell.trim()))
      && nextRow.length === columnHeaders.length
      && nextRow.some(cell => strictMoney(cell) !== null)
    if ((sparseProductSection || sparseAdministrativeSection) && columnHeaders.length) {
      const sectionLabel = row[0]?.replace(/\s+/g, ' ').trim()
      if (sectionLabel) section = sectionLabel
      const explicitBasis = priceBasisContextFromRow(row)
      if (explicitBasis) activeBasisContext = explicitBasis
      else if (activeBasisContext && /^(?:joints?|angles?|end caps?|brackets?|junctions?|supports?\b)/i.test(sectionLabel ?? '')) activeBasisContext = ''
      recordSkippedNumericCells(decisions, row, rowIndex, 'header_or_section_value')
      continue
    }
    if (productCodeBand || embeddedNumericHeader || (!hybridHeaderDataRow && (isColumnHeaderRow(alignedHeaderRow) || textualVariantHeader)) || matrixHeader) {
      if (productCodeBand) {
        if (sawNumericSinceProductBand) columnProductBands = []
        columnProductBands.push(row)
        sawNumericSinceProductBand = false
      }
      const headerSection = matrixHeader?.section ?? productBand ?? productSectionFromHeader(alignedHeaderRow)
      if (headerSection) section = headerSection
      const nextHeaders = matrixHeader?.headers
        ? matrixHeader.section
          ? matrixHeader.headers
          : headerSection
            ? matrixHeader.headers
            : mergeHeaders(columnHeaders, matrixHeader.headers)
        : headerSection
          ? carryHeaders(alignedHeaderRow)
          : mergeHeaders(columnHeaders, carryHeaders(alignedHeaderRow))
      columnHeaders = nextHeaders
      if (!productCodeBand && nextHeaders.some(isVariantLabel)) variantHeaders = nextHeaders
      recordSkippedNumericCells(decisions, row, rowIndex, 'header_or_section_value')
      continue
    }

    if (row.some(cell => strictMoney(cell) !== null)) sawNumericSinceProductBand = true

    for (let colIndex = 0; colIndex < row.length; colIndex++) {
      const rawPrice = row[colIndex] ?? ''
      const amount = strictMoney(rawPrice)
      if (amount === null) continue
      const columnLabel = columnHeaders[colIndex] ?? inferredColumnLabel(grid, rowIndex, colIndex)
      const semanticRow = rowWithInheritedDimensions(grid, rowIndex, row, columnHeaders)
      const inferredRowLabel = rowIdentityLabel(semanticRow, colIndex, columnHeaders)
      const matrixIdentity = matrixRowIdentityLabel(semanticRow, colIndex, columnHeaders, section)
      const localIdentity = localProductIdentityLabel(semanticRow, colIndex, columnHeaders)
      const rowLabel = localIdentity || (strictMoney(semanticRow[0]) !== null
        ? matrixIdentity
        : /[a-z]{3,}/i.test(inferredRowLabel)
        ? inferredRowLabel
        : uniqueStrings([matrixIdentity, inferredRowLabel]).join(' '))
      const context = [options.documentName, options.table.title, section, rowLabel, columnLabel].filter(Boolean).join(' ')
      const columnRole = numericColumnRole(columnHeaders[colIndex] ?? columnLabel)
      const rowRole = colIndex > 0 ? transposedNumericRowRole(row) : 'unknown'
      // Transposed catalogues put products in columns ("1 Module", "2 Module")
      // and price semantics in rows ("Unit Sale Price", "MRP"). In that layout
      // the immediate row role is more specific than the product-column role.
      // Negative row roles still veto every numeric value in a specification,
      // packing, or administrative row.
      const transposedPrice = rowRole === 'price'
      const negativeRowRole = rowRole === 'specification'
        || rowRole === 'packaging'
        || rowRole === 'administrative'
      const identityNumeric = !transposedPrice && (columnRole === 'identity'
        || isLeadingNumericIdentityCell(row, colIndex, columnHeaders, columnLabel)
        || numericValueMatchesAlignedVariantCode(grid, rowIndex, colIndex, amount))
      const prohibitedNumeric = negativeRowRole
        || columnRole === 'specification'
        || columnRole === 'packaging'
        || columnRole === 'administrative'
      const structuralPrice = !identityNumeric
        && !prohibitedNumeric
        && isStableHeaderlessPriceColumn({ grid, row, rowIndex, colIndex, columnHeaders })
      const explicitPrice = !identityNumeric
        && !prohibitedNumeric
        && (transposedPrice || structuralPrice || isDeterministicPriceCell({ grid, row, rowIndex, colIndex, columnLabel, section }))
      const matrixPrice = !prohibitedNumeric && !explicitPrice && isMatrixPriceCell({
        grid,
        row,
        rowIndex,
        colIndex,
        columnLabel,
        columnHeaders,
        section,
        documentName: options.documentName,
        tableTitle: options.table.title,
        matrixLikely: commercialProfile.matrixLikely
      })
      if (identityNumeric || prohibitedNumeric || (!explicitPrice && !matrixPrice)) {
        decisions.push({
          source_row_index: rowIndex,
          source_col_index: colIndex,
          raw_value: rawPrice,
          amount,
          selected: false,
          reason: identityNumeric || prohibitedNumeric
            ? 'identity_or_specification'
            : numericCellRejectionReason({ row, colIndex, columnLabel })
        })
        continue
      }

      decisions.push({
        source_row_index: rowIndex,
        source_col_index: colIndex,
        raw_value: rawPrice,
        amount,
        selected: true,
        reason: explicitPrice ? 'selected_explicit_price' : 'selected_matrix_price'
      })

      const productVariants = productVariantsForColumn(columnProductBands, colIndex)
      const variants = productVariants.length ? productVariants : [{ label: '', sku: null }]
      for (const variant of variants) {
        const variantColumnLabel = uniqueStrings([
          variantHeaders[colIndex] ?? '',
          variant.sku ?? '',
          productVariants.length ? '' : columnLabel
        ]).join(' ')
        const variantRowLabel = uniqueStrings([variant.label, rowLabel]).join(' ')
        const variantContext = [options.documentName, options.table.title, section, variantRowLabel, variantColumnLabel].filter(Boolean).join(' ')
        const category = inferCategory(variantContext, variantRowLabel)
        const facetContext = [options.table.title, section, variantRowLabel, variantColumnLabel].filter(Boolean).join(' ')
        const facets = inferFacets(facetContext, variantRowLabel, variantColumnLabel, category)
        const priceType = priceTypeFromRow(row) ?? priceTypeFromLabel(variantColumnLabel || columnLabel)
        if (priceType) facets.price_type = priceType
        if (category === 'telephone_cable' && facets.conductor_size_mm === undefined) {
          const telephoneSize = inferTelephoneConductorSize(columnHeaders, colIndex)
            ?? inferTelephoneConductorSizeFromRow(semanticRow, colIndex)
          if (telephoneSize !== null) facets.conductor_size_mm = telephoneSize
        }
        let basis = inferBasis([variantColumnLabel, activeBasisContext, section, options.table.title, semanticRow.join(' ')].filter(Boolean).join(' '), category)
        if (structuralPrice && (!basis.quantity || !basis.unit)) {
          basis = { quantity: 1, unit: 'piece', packageType: null, inferred: true }
        }
        basis = inferExtendedPriceBasis(row, colIndex, variantColumnLabel, amount, basis)
        basis = inferTransposedPriceBasis(grid, rowIndex, colIndex, amount, basis)
        basis = inferQuoteLineTotalBasis(row, colIndex, columnHeaders, variantColumnLabel, amount, basis)
        if (basis.inferred) facets.price_basis_inferred = true
        const sku = variant.sku
          ?? inferAlignedSkuFromAdjacentRow(grid, rowIndex, colIndex, localIdentity)
          ?? inferSkuFromRow(semanticRow, colIndex, variantRowLabel, variantColumnLabel, columnHeaders)
        const canonicalName = canonicalNameFor({ category, context: variantContext, rowLabel: variantRowLabel, columnLabel: variantColumnLabel, facets, sku })
        const base = {
          category,
          canonical_name: canonicalName,
          brand: options.vendorName?.trim() || null,
          sku,
          aliases: uniqueStrings([variantRowLabel, variantColumnLabel, sku ?? '', canonicalName]),
          facets,
          amount,
          currency: 'INR',
          basis_quantity: basis.quantity,
          basis_unit: basis.unit,
          package_type: basis.packageType,
          moq: inferMoq(row, columnHeaders),
          source_page: options.table.page,
          source_table_index: options.table.tableIndex,
          source_row_index: rowIndex,
          source_col_index: colIndex,
          source_table_title: options.table.title,
          source_row_label: variantRowLabel || null,
          source_column_label: variantColumnLabel || null,
          raw_price_value: rawPrice,
          source_excerpt: sourceExcerpt(grid, rowIndex)
        }
        offers.push({ ...base, validation_errors: validateCompiledOffer(base) })
      }
    }
  }

  const deduped = dedupeOffers(offers)
  return {
    offers: deduped,
    audit: {
      source_page: options.table.page,
      source_table_index: options.table.tableIndex,
      commercial: true,
      commercial_reasons: commercialProfile.reasons,
      matrix_likely: commercialProfile.matrixLikely,
      numeric_cells: numericCells.length,
      selected_price_cells: decisions.filter(decision => decision.selected).length,
      published_offers: deduped.filter(offer => !offer.validation_errors.length).length,
      quarantined_offers: deduped.filter(offer => offer.validation_errors.length).length,
      decisions
    }
  }
}

function tableChunks(grid: string[][]) {
  if (grid.length <= MAX_ROWS_PER_CHUNK) return [indexedRows(grid, 0, grid.length)]

  const headers = indexedRows(grid, 0, Math.min(HEADER_ROWS_PER_CHUNK, grid.length))
  const chunks: Array<Array<{ row_index: number, cells: Array<{ col_index: number, value: string }> }>> = []
  for (let from = HEADER_ROWS_PER_CHUNK; from < grid.length; from += MAX_ROWS_PER_CHUNK - HEADER_ROWS_PER_CHUNK) {
    chunks.push([...headers, ...indexedRows(grid, from, Math.min(grid.length, from + MAX_ROWS_PER_CHUNK - HEADER_ROWS_PER_CHUNK))])
  }
  return chunks
}

function indexedRows(grid: string[][], from: number, to: number) {
  return grid.slice(from, to).map((row, offset) => ({
    row_index: from + offset,
    cells: row.map((value, colIndex) => ({ col_index: colIndex, value }))
  }))
}

function commercialTableProfile(options: Pick<CompileTableOptions, 'table' | 'documentName'>) {
  const grid = options.table.grid
  const text = grid.slice(0, 12).flat().join(' ').toLowerCase()
  const tableContext = normalized([options.table.title, text].filter(Boolean).join(' '))
  const context = normalized([options.documentName, options.table.title, text].filter(Boolean).join(' '))
  const hasNumbers = grid.some(row => row.some(cell => strictMoney(cell) !== null))
  const hasCommercialSignal = /\b(?:rate|price|mrp|amount|cost|rs|inr|per\s+(?:mtr|meter|coil|piece|pc|unit))\b|ratepc|₹/.test(tableContext)
  const matrixSignal = /\b(?:wire|cable)\b/.test(text)
    && /\b(?:2|3|3.5|4|5|6|7|8|9|10|12|14|16|19|24)\s*core\b/.test(text)
  const priceDocumentSignal = /\b(?:price\s*list|pricelist|rate\s*list|mrp\s*list|mrp|quotation|quote)\b/.test(context)
  const matrixLikely = matrixTableProfile(grid, context, priceDocumentSignal || hasCommercialSignal)
  const headerlessPriceSchema = hasStableHeaderlessPriceSchema(grid)
  const reasons = [
    hasCommercialSignal ? 'explicit_price_language' : null,
    matrixSignal ? 'known_commercial_matrix' : null,
    priceDocumentSignal ? 'price_document' : null,
    matrixLikely ? 'matrix_structure' : null,
    headerlessPriceSchema ? 'stable_headerless_price_schema' : null
  ].filter((value): value is string => Boolean(value))
  return {
    commercial: hasNumbers && (hasCommercialSignal || matrixSignal || (priceDocumentSignal && (matrixLikely || headerlessPriceSchema))),
    matrixLikely,
    reasons
  }
}

function matrixTableProfile(grid: string[][], context = '', commercialContext = false) {
  const rowsWithMultipleNumbers = grid.filter(row => row.filter(cell => strictMoney(cell) !== null).length >= 2)
  if (!rowsWithMultipleNumbers.length) return false

  const descriptiveRows = rowsWithMultipleNumbers.filter(row => row.some(isProductDescriptorCell)).length
  const tableText = normalized([context, grid.slice(0, 12).flat().join(' ')].filter(Boolean).join(' '))
  const technicalDimensionTable = /\b(?:dimensions?|outside\s*diameter|inside\s*diameter|wall\s*thickness|tolerance)\b/.test(tableText)
    && !/\b(?:rate|price|mrp|amount|cost)\b/.test(tableText)
  if (technicalDimensionTable) return false
  const hasProductFamily = /\b(?:pipes?|fittings?|couplers?|elbows?|tees?|sockets?|cables?|wires?|switches?|mcb|mccb|rccb|rcbo|isolators?|boxes?|boards?|plates?|chambers?|manholes?|valves?|conduits?|ppr|cpvc|upvc|pvc|pe[- ]?\d+)\b/.test(tableText)
  const hasVariantHeaders = grid.slice(0, 8).some(row => row.filter(isVariantLabel).length >= 2)
  const hasTextualVariantHeaders = grid.slice(0, 8).some(row => {
    const values = row.map(normalized).filter(Boolean)
    if (values.length < 3 || row.some(cell => strictMoney(cell) !== null)) return false
    return values.slice(1).filter(value => /[a-z]/.test(value) && !/\b(?:description|product|item|rate|price|mrp|amount|pack|quantity)\b/.test(value)).length >= 2
  })
  if (descriptiveRows >= 1 && hasVariantHeaders) return true
  if (hasProductFamily && hasVariantHeaders) return true
  if (rowsWithMultipleNumbers.length >= 2 && hasProductFamily && hasTextualVariantHeaders && commercialContext) return true
  return rowsWithMultipleNumbers.length >= 4 && hasProductFamily && (hasVariantHeaders || hasTextualVariantHeaders)
}

function isProductDescriptorCell(value: string) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!/[a-z]{2,}/i.test(text)) return false
  if (/^(?:mm|inch|inches|kg|cm|mtr|meter|metre|nos?|pcs?|rs|inr|mrp|rate|price)$/i.test(text)) return false
  if (/^(?:dt|dte|date)\s*:?\s*\d/i.test(text)) return false
  if (/^(?:is|iso|astm)\s*:?\s*\d/i.test(text)) return false
  return true
}

function isVariantLabel(value: string) {
  const text = normalized(value)
  if (!text) return false
  return /(?:\d|type\s+[a-z])/.test(text)
    && /(?:\d+(?:\.\d+)?\s*(?:mm|inch|kg|cm|meter|mtr|core|pole|module|way|amp|a|v|kv)|\b(?:sdr|sch|pn|type)[- ]?\w+\b|\d+\s*[x+]\s*\d+)/.test(text)
}

function matrixVariantHeader(row: string[], nextRow: string[]) {
  const nonEmpty = row.map(value => value.trim()).filter(Boolean)
  if (nonEmpty.length < 2) return null
  if (row.filter(cell => strictMoney(cell) !== null).length > 0) return null
  if (nextRow.filter(cell => strictMoney(cell) !== null).length < 2) return null

  const first = nonEmpty[0] ?? ''
  const genericDescriptor = /^(?:item(?:\s*\/\s*size.*)?|size|sizes?|description|deascription|product|name)$/i.test(first)
  const firstIsDescription = !genericDescriptor && isProductDescriptorCell(first) && !isVariantLabel(first)
  const variants = firstIsDescription ? nonEmpty.slice(1) : nonEmpty
  if (variants.length < 2 || variants.filter(isVariantLabel).length < Math.ceil(variants.length * 0.5)) return null

  const nextNumericCount = nextRow.filter(cell => strictMoney(cell) !== null).length
  if (firstIsDescription && variants.length === nextNumericCount) {
    const nextStartsWithIdentity = isSpecificationColumnLabel(first)
      || (Boolean(nextRow[0]?.trim()) && strictMoney(nextRow[0]) === null)
    return {
      section: /\b(?:pipe|fittings?|cables?|wires?|boxes?|boards?|plates?)\b/i.test(nonEmpty[0]!) ? nonEmpty[0]! : null,
      headers: nextStartsWithIdentity ? ['', ...variants] : variants
    }
  }
  const nextHasDescriptorColumn = isProductDescriptorCell(nextRow[0] ?? '')
    && (variants.length === nextNumericCount || row.length === nextRow.length - 1 || genericDescriptor)
  if (nextHasDescriptorColumn) {
    const labels = genericDescriptor ? nonEmpty.slice(1) : variants
    return { section: null, headers: ['', ...labels] }
  }
  return { section: null, headers: carryHeaders(row) }
}

function isEmbeddedNumericHeaderRow(row: string[], nextRow: string[]) {
  const structuralLabels = row.filter(cell => /^(?:dimensions?\s*(?:dn|mm)?|sizes?|grams?|weights?|lengths?)\b/i.test(cell.trim())).length
  if (structuralLabels < 1) return false
  const numericVariants = row.filter(cell => strictMoney(cell) !== null).length
  const nextNumeric = nextRow.filter(cell => strictMoney(cell) !== null).length
  const nextProducts = nextRow.filter(isProductDescriptorCell).length
  return (numericVariants >= 2 || structuralLabels >= 2) && nextNumeric >= 1 && nextProducts >= 1
}

function numericValueMatchesAlignedVariantCode(grid: string[][], rowIndex: number, colIndex: number, amount: number) {
  const row = grid[rowIndex] ?? []
  const nextRow = grid[rowIndex + 1] ?? []
  const alignedMatch = (value: number, index: number) => {
    const nextValue = nextRow[index]?.replace(/\s+/g, '').toLowerCase() ?? ''
    if (!nextValue || !/[a-z]/.test(nextValue) || !/\d/.test(nextValue)) return false
    const token = String(value).replace(/\.0+$/, '')
    return new RegExp(`(?:^|[-_/])${token.replace('.', '\\.')}[a-z]*$`, 'i').test(nextValue)
  }
  if (!alignedMatch(amount, colIndex)) return false
  const numericCells = row.flatMap((cell, index) => {
    const value = strictMoney(cell)
    return value === null ? [] : [{ value, index }]
  })
  const alignedMatches = numericCells.filter(cell => alignedMatch(cell.value, cell.index)).length
  return alignedMatches >= 2 && alignedMatches >= Math.ceil(numericCells.length * 0.5)
}

function localProductIdentityLabel(row: string[], priceColIndex: number, columnHeaders: string[] = []) {
  for (let index = priceColIndex - 1; index >= 0; index--) {
    const value = row[index]?.replace(/\s+/g, ' ').trim() ?? ''
    const header = normalized(columnHeaders[index])
    if (/^(?:make|brand|manufacturer|vendor|supplier|qty|quantity|unit|uom|discount)$/.test(header)) continue
    if (!value || strictMoney(value) !== null || !isProductDescriptorCell(value)) continue
    if (/^(?:part\s*no\.?|cat(?:alogue)?\.?\s*no\.?|hsn(?:\s*code)?|dimensions?\s*(?:dn|mm)?|size|grams?|rate|price|mrp|sn[- ]?\d+)\b/i.test(value)) continue
    if (/^\d+(?:\.\d+)?\s*(?:sq\.?\s*mm|mm|cm|mtrs?|meters?|metres?|core|pole|amp|a|kg)\b/i.test(value)) continue
    const codes = codeCandidates(value)
    const productWords = /\b(?:pipes?|fittings?|bends?|elbows?|tees?|couplers?|couplings?|plugs?|traps?|valves?|reducers?|caps?|clamps?|brackets?|sockets?|switches?|boards?|boxes?|cables?|wires?)\b/i
    if (codes.some(code => normalized(code) === normalized(value)) && !productWords.test(value)) continue
    return value
  }
  return ''
}

function inferAlignedSkuFromAdjacentRow(grid: string[][], rowIndex: number, colIndex: number, productLabel: string) {
  if (!productLabel) return null
  const nextRow = grid[rowIndex + 1] ?? []
  const codes = productCodes(nextRow[colIndex] ?? '')
  if (!codes.length) return null
  const nextLabel = localProductIdentityLabel(nextRow, colIndex)
  const hasPartNumberBand = nextRow.slice(0, colIndex).some(cell => /^part\s*no\.?$/i.test(cell.trim()))
  if (normalized(nextLabel) !== normalized(productLabel) && !hasPartNumberBand) return null
  return codes[0] ?? null
}

function isTextualVariantSubheader(row: string[], nextRow: string[], previousHeaders: string[]) {
  if (!previousHeaders.length || row.some(cell => strictMoney(cell) !== null)) return false
  if (nextRow.filter(cell => strictMoney(cell) !== null).length < 2) return false
  const labels = row.map(value => normalized(value)).filter(Boolean)
  if (labels.length < 2) return false
  const knownVariants = labels.filter(value => /^(?:fr|hrfr|frls|frlsh|lszh|lsoh|hffr|zhfr|xlpe|pvc|copper|aluminium|armoured|unarmoured)(?:\s+.*)?$/.test(value))
  return knownVariants.length >= 2 && knownVariants.length >= Math.ceil(labels.length * 0.6)
}

function productSectionFromHeader(row: string[]) {
  const values = row.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const descriptive = values.filter(value => isProductDescriptorCell(value)
    && (!isVariantLabel(value) || /\b(?:pipe|fittings?|cable|wire|box|board)\b/i.test(value)))
  const text = uniqueStrings(descriptive).join(' ')
  if (!/\b(?:pipe|fittings?|coupler|elbow|tee|socket|cable|wire|switch|mcb|mccb|rccb|rcbo|isolator|box|board|chamber|manhole|valve|conduit|ppr|cpvc|upvc|pvc|pe[- ]?\d+|quickfit|ringfit)\b/i.test(text)) return null
  return text
}

function realignHeaderRow(row: string[], nextRow: string[]) {
  if (!nextRow.length || !isProductDescriptorCell(row[0] ?? '')) return row
  if (/^(?:item|description|product|name|cat(?:alogue)?\.?\s*(?:no|nos)?\.?|code|sku|reference|model|sr[- .]*no|serial(?:\s*no)?|db\s*type)$/i.test(row[0]?.trim() ?? '')) return row
  const firstIdentity = row.findIndex((value, index) => index > 0 && /^(?:mm|inch|inches|size|description|deascription|item)$/i.test(value?.trim() ?? ''))
  if (firstIdentity <= 0) return row
  const prefix = uniqueStrings(row.slice(0, firstIdentity).map(value => value.trim()).filter(Boolean))
  if (prefix.length !== 1) return row
  return row.slice(firstIdentity)
}

function recordSkippedNumericCells(
  decisions: NumericCellDecision[],
  row: string[],
  rowIndex: number,
  reason: NumericCellDecisionReason
) {
  for (let colIndex = 0; colIndex < row.length; colIndex++) {
    const amount = strictMoney(row[colIndex])
    if (amount === null) continue
    decisions.push({
      source_row_index: rowIndex,
      source_col_index: colIndex,
      raw_value: row[colIndex] ?? '',
      amount,
      selected: false,
      reason
    })
  }
}

function matrixRowIdentityLabel(row: string[], priceColIndex: number, columnHeaders: string[], section: string) {
  const leading = row.slice(0, priceColIndex).flatMap((value, index) => {
    const clean = value?.replace(/\s+/g, ' ').trim()
    if (!clean) return []
    const header = columnHeaders[index]?.replace(/\s+/g, ' ').trim() ?? ''
    const role = numericColumnRole(header)
    if (role === 'packaging' || role === 'specification' || role === 'administrative') return []
    if (strictMoney(clean) !== null && role === 'identity') {
      const normalizedHeader = normalized(header)
      const unit = /sq\.?mm|area.*sqmm|sqmm.*area/.test(normalizedHeader)
        ? 'SQ.MM'
        : /\bmm\b/.test(normalizedHeader)
          ? 'MM'
          : normalizedHeader.match(/\b(?:inch|inches)\b/)?.[0] ?? ''
      return [`${clean}${unit ? ` ${unit}` : ''}`]
    }
    if (strictMoney(clean) !== null && !header) return [clean]
    if (strictMoney(clean) === null) return [clean]
    return []
  })
  const sectionIdentity = normalized(section)
    .replace(/\b(?:price list by|price list|mrp list|rate list|rate rs\.? per (?:meter|piece|unit)|rate per (?:meter|piece|unit)|the|industries|ltd|limited|mumbai|date|dt|dte)\b/g, ' ')
    .replace(/\blp\s+no\b.*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return uniqueStrings([sectionIdentity, ...leading]).join(' ')
}

type NumericColumnRole = 'price' | 'identity' | 'specification' | 'packaging' | 'administrative' | 'unknown'

/**
 * Classifies the immediate (most specific) header for a numeric cell. Negative
 * roles deliberately win over inherited price-list context: a merged "RATE"
 * band must never turn amperage, packing, HSN, or dimension columns into prices.
 */
export function numericColumnRole(value: string): NumericColumnRole {
  const text = normalized(value)
  if (!text) return 'unknown'

  if (/\b(?:hsn|sac|gst|tax|discount|serial|sr\s*no|page|date|effective|lp\s*no)\b/.test(text)) {
    return 'administrative'
  }

  // Numeric variant headers (1.5 SQ.MM, 4 CORE, 6 AMP, and similar) label
  // price columns in cross-tab matrices; bare SIZE/MM columns remain identity.
  if (/^\d+(?:\.\d+)?\s*(?:sqmm|mm|core|pole|amp|a|kv|kg\s*\/\s*cm2)\b/.test(text)) return 'price'
  if (/\btype\s+[a-z0-9]+\b.*\b\d+(?:\.\d+)?\s*(?:sqmm|mm|inch|core)\b/.test(text)) return 'price'

  // A numeric-length header such as "100 Mtr Packing" identifies the amount
  // bought by the price below it. A "Standard Packing" column instead contains
  // the packing quantity itself and is not a price column.
  if (/^\d+(?:\.\d+)?\s*(?:meter|mtr)\b.*\b(?:packing|pack|coil|spool|box)\b/.test(text)) return 'price'
  if (/\b(?:pack|packing|pkg)$/.test(text)) return 'packaging'
  if (/\b(?:standard|standards|std)\.?\s*(?:coil\s*)?(?:packing|pack|pkg)\b/.test(text)
    || /\b(?:standardpacking|standardspacking|stdpacking)(?:mtrs?|meters?|nos?|numbers?)?\b/.test(text)
    || /\b(?:stdpack|stdpkg|coilpacking)\b/.test(text)
    || /\b(?:packing|pack|box)\s*(?:quantity|qty)\b/.test(text)
    || /\b(?:units?|nos?|numbers?)\s+in\s+(?:master\s+)?packing\b/.test(text)
    || /\b(?:no\.?\s*of\s*coils?|ofcoils?|coil\s*count|moq)\b/.test(text)) {
    return 'packaging'
  }

  if (/\b(?:current\s*(?:carrying|rating|capacity|amps?|a)|amps?|ampere|wattage|power\s*rating|voltage|frequency|dimension|width|height|depth|weight|mw)\b/.test(text)) {
    return 'specification'
  }

  // Merged multi-row headers such as "Rate per 90 Meter Coil / 0.4 MM"
  // describe a priced cable variant. The local size label is identity for the
  // variant, but the numeric cells below it are still rates.
  if (/\b(?:rate|price|mrp|amount|cost|basic|dealer|net)\b|ratepc/.test(text)
    && /\b\d+(?:\.\d+)?\s*(?:sqmm|sq\.?\s*mm|mm|core|pole|amp|a)\b/.test(text)) {
    return 'price'
  }

  if (/\b(?:item|description|product|name|cat(?:alogue)?|code|sku|reference|model|type|variant|size|sizesq|sqmm|mm|inch|inches|modules?|ways?|cross\s*section|crosssection|conductor\s*(?:area|construction)|diameter|od|id|stranding|no\.?\s*&?\s*size\s*of\s*wire|no\.?\s*of\s*pairs?)\b/.test(text)) {
    return 'identity'
  }

  if (/\b(?:rate|price|mrp|amount|cost|basic|dealer|net|unit\s*sale\s*price|lp)\b|ratepc/.test(text)) return 'price'
  if (/\b(?:per|packing|pack)\s*\d*\s*(?:meter|mtr|coil|roll|piece|pc|unit)\b/.test(text)) return 'price'
  if (/\b\d+(?:\.\d+)?\s*(?:meter|mtr)\b/.test(text)) return 'price'
  return 'unknown'
}

function transposedNumericRowRole(row: string[]): NumericColumnRole {
  if (row.slice(1).filter(cell => strictMoney(cell) !== null).length < 2) return 'unknown'
  const text = normalized(row[0])
  if (!text) return 'unknown'
  const role = numericColumnRole(text)
  if (role === 'price'
    && /^(?:unit\s+sale\s+price|unit\s+price|maximum\s+retail\s+price|mrp|rate|price|amount|cost|basic|dealer|net)\b/.test(text)) {
    return role
  }
  if (role === 'specification'
    && /^(?:(?:approx(?:imate)?|max(?:imum)?|rated)\s+)*(?:current|amps?|ampere|wattage|power\s+rating|voltage|frequency|dimensions?|width|height|depth|weight|mw)\b/.test(text)) {
    return role
  }
  if (role === 'packaging'
    && /^(?:standard|standards|std|packing|pack|box|no\.?\s*of\s*coils?|coil\s*count|moq)\b/.test(text)) {
    return role
  }
  if (role === 'administrative'
    && /^(?:hsn|sac|gst|tax|discount|serial|sr\s*no|page|date|effective|lp\s*no)\b/.test(text)) {
    return role
  }
  return 'unknown'
}

function isBareIdentityColumnLabel(value: string) {
  const text = normalized(value)
  if (!text) return false
  return /^(?:mm|inch|inches|size|size mm|size inch|diameter|od|id|coil length|coll length|length|sku|code|item code|catalogue no|cat no|serial|sr no|hsn|quantity|qty|packing|pack|pkg|box pkg|box pack|pack qty|packing qty|std pkg|standard pkg|std pack|standard pack|current|current a|amps?|core|cores|no of core|poles?)$/.test(text)
}

function isSpecificationColumnLabel(value: string) {
  const text = normalized(value)
  if (/^\d+(?:\.\d+)?\s*(?:sqmm|mm|core|pole|amp|a|kv|meter|mtr)\b/.test(text)) return false
  return /\b(?:size|sizesq|sqmm|cross ?section|conductor area|diameter|od|id|stranding|construction|pack\s*qty|packing\s*qty|std\.?\s*pkg|std\s*pack|stdpack|stdpacking|standard\s*pkg|standard\s*pack|standardpacking|box\s*pkg|box\s*pack|quantity|qty|moq|serial|sr\s*no|hsn|discount|dimension|current\s*(?:rating|carrying|capacity|amps?)|amps?|coil\s*count|no\.?\s*of\s*coils?|ofcoils|mw)\b/.test(text)
    || /\bpack\b.*\b(?:nos?|numbers?|meter|mtr)\b/.test(text)
    || /\w+pack\b.*\b(?:nos?|numbers?|meter|mtr)\b/.test(text)
}

function isProductCodeBandRow(row: string[]) {
  const codes = row.filter(cell => productCodes(cell).length > 0).length
  if (codes < 2) return false
  const hasCodeLabel = row.slice(0, 2).some(cell => /^(?:code|cat\.?\s*nos?|catalogue\s*nos?|catalog\s*nos?|reference|sku)$/i.test(cell.trim()))
  if (hasCodeLabel) return true
  if (isSpecificationColumnLabel(row[0] ?? '')) return false
  return false
}

function isMatrixPriceCell(params: {
  grid: string[][]
  row: string[]
  rowIndex: number
  colIndex: number
  columnLabel: string
  columnHeaders: string[]
  section: string
  documentName: string
  tableTitle: string | null
  matrixLikely: boolean
}) {
  if (!params.matrixLikely) return false
  if (!params.columnLabel.trim()) return false
  if (isSpecificationColumnLabel(params.columnHeaders[params.colIndex] ?? params.columnLabel)) return false
  const rowText = normalized(params.row.join(' '))
  if (/\b(?:subtotal|grand total|gst|tax|freight|discount|standard packing quantity|standards packing quantity|packing quantity|packing qty|pack qty|box pkg|box pack|std pkg|standard pkg|std pack|standard pack)\b/.test(rowText)) return false

  const moneyIndexes = params.row.flatMap((value, index) => strictMoney(value) === null ? [] : [index])
  if (!moneyIndexes.length) return false
  const descriptorBefore = params.row.slice(0, params.colIndex).some(isProductDescriptorCell)
  const inheritedProduct = /\b(?:pipes?|fittings?|couplers?|elbows?|tees?|sockets?|cables?|wires?|switches?|mcb|mccb|rccb|rcbo|isolators?|boxes?|boards?|plates?|chambers?|manholes?|valves?|conduits?|ppr|cpvc|upvc|pvc|quickfit|ringfit|pe[- ]?\d+|sdr[- ]?\d+)\b/i.test([
    params.documentName,
    params.section,
    params.tableTitle,
    ...params.grid.slice(Math.max(0, params.rowIndex - 5), params.rowIndex).flat()
  ].filter(Boolean).join(' '))

  if (!descriptorBefore && !inheritedProduct) return false
  if (!descriptorBefore && params.colIndex === moneyIndexes[0] && moneyIndexes.length > 1) {
    const header = params.columnHeaders[params.colIndex] ?? params.columnLabel
    if (params.colIndex === 0 || isBareIdentityColumnLabel(header)) return false
  }
  if (!descriptorBefore && (isBareIdentityColumnLabel(params.columnHeaders[params.colIndex] ?? '') || isSpecificationColumnLabel(params.columnHeaders[params.colIndex] ?? params.columnLabel))) return false

  const documentIsPriceList = /\b(?:price\s*list|pricelist|rate\s*list|mrp|quotation|quote)\b/i.test(params.documentName)
  const rowHasMatrixDensity = moneyIndexes.length >= 2
  return rowHasMatrixDensity || (documentIsPriceList && descriptorBefore)
}

function isLeadingNumericIdentityCell(row: string[], colIndex: number, columnHeaders: string[], columnLabel: string) {
  if (strictMoney(row[colIndex]) === null) return false
  const next = row[colIndex + 1]?.trim() ?? ''
  if (colIndex === 0 && /^\d+(?:\.\d+)?\s*(?:[”"']|\/)/.test(next)) return true
  if (colIndex === 0 && /^\d+(?:\.\d+)?\s*$/.test(row[colIndex] ?? '') && /^(?:\d+(?:\.\d+)?\s*)?(?:mm|inch|inches)$/i.test((columnHeaders[colIndex] ?? columnLabel).trim())) return true
  return isBareIdentityColumnLabel(columnHeaders[colIndex] ?? '')
}

function numericCellRejectionReason(params: { row: string[], colIndex: number, columnLabel: string }): NumericCellDecisionReason {
  const rowText = normalized(params.row.join(' '))
  if (/\b(?:subtotal|grand total|gst|tax|freight|discount)\b/.test(rowText)) return 'total_or_tax_row'
  if (/\b(?:standard packing quantity|standards packing quantity|packing quantity|packing qty|pack qty|box pkg|box pack|std pkg|standard pkg|std pack|standard pack)\b/.test(rowText)) return 'identity_or_specification'
  if (params.colIndex === 0 || isBareIdentityColumnLabel(params.columnLabel)) return 'identity_or_specification'
  return 'insufficient_price_context'
}

function isModelUnavailable(error: unknown) {
  const value = error as { status?: number | string, message?: string }
  return Number(value?.status) === 429
    || /quota|spending cap|resource[_ -]?exhausted|rate limit/i.test(value?.message ?? '')
}

function normalized(value: string | null | undefined) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/\bper\s*(\d)/g, 'per $1')
    .replace(/(\d+(?:\.\d+)?)\s*mtrs?\.?\b/g, '$1 meter ')
    .replace(/\bcu\b/g, ' copper ')
    .replace(/\b(?:alu|aluminium|aluminum)\b/g, ' aluminium ')
    .replace(/\barm(?:ou?red|ored|d)?\b/g, ' armoured ')
    .replace(/\bun\s*arm(?:ou?red|ored|d)?\b/g, ' unarmoured ')
    .replace(/\bsq\.?\s*mm\b/g, ' sqmm ')
    .replace(/\bmtrs?\.?\b|\bmetres?\b|\bmeters?\b/g, ' meter ')
    .replace(/[^a-z0-9./+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSectionRow(row: string[]) {
  const nonEmpty = row.filter(Boolean)
  const unique = uniqueStrings(nonEmpty)
  if (!unique.length) return false
  if (unique.length === 1 && /[a-z]/i.test(unique[0]!)) return true
  return false
}

function isColumnHeaderRow(row: string[]) {
  const text = normalized(row.join(' '))
  if (!/[a-z]/.test(text)) return false
  const numericCells = row.filter(cell => strictMoney(cell) !== null).length
  if (numericCells > Math.max(1, row.filter(Boolean).length / 3)) return false
  return /\b(?:size|sizesq|sqmm|description|product|item|model|cat|code|sku|rate|price|mrp|amount|packing|pack|meter|coil|core|pole|unit|current|rating|cond(?:uctor)?|amps?)\b/.test(text)
}

function carryHeaders(row: string[]) {
  const headers: string[] = []
  let carried = ''
  for (let index = 0; index < row.length; index++) {
    const value = row[index]?.replace(/\s+/g, ' ').trim() ?? ''
    if (value) carried = value
    headers[index] = value || carried
  }
  return headers
}

function mergeHeaders(previous: string[], next: string[]) {
  const width = Math.max(previous.length, next.length)
  return Array.from({ length: width }, (_, index) =>
    uniqueStrings([previous[index] ?? '', next[index] ?? '']).join(' '))
}

function inferredColumnLabel(grid: string[][], rowIndex: number, colIndex: number) {
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 4); index--) {
    const previous = grid[index] ?? []
    const lastHeader = previous.at(-1)?.replace(/\s+/g, ' ').trim() ?? ''
    if (colIndex >= previous.length
      && grid[rowIndex]!.length === previous.length + 1
      && /\b(?:rate|price|mrp|amount|cost|net)\b/i.test(lastHeader)) {
      return lastHeader
    }
  }
  const values: string[] = []
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 8); index--) {
    const value = grid[index]?.[colIndex]?.replace(/\s+/g, ' ').trim()
    if (!value || strictMoney(value) !== null) continue
    values.unshift(value)
    if (/\b(?:rate|price|mrp|meter|mtr|coil|core|pole|unit|packing)\b/i.test(value)) break
  }
  return uniqueStrings(values).join(' ')
}

function isStableHeaderlessPriceColumn(params: {
  grid: string[][]
  row: string[]
  rowIndex: number
  colIndex: number
  columnHeaders: string[]
}) {
  if (params.row.length < 4 || params.colIndex !== params.row.length - 2) return false
  if (params.columnHeaders[params.colIndex]?.trim()) return false
  const price = strictMoney(params.row[params.colIndex])
  const pack = headerlessPackValue(params.row.at(-1))
  if (price === null || pack === null || pack > 1000) return false
  if (!/[a-z]{2,}/i.test(params.row[1] ?? '')) return false
  const code = (params.row[0] ?? '').replace(/\s+/g, '')
  if (!/^(?=.*\d)[a-z0-9.*-]{4,}$/i.test(code)) return false

  const matchingRows = params.grid.filter(row => {
    if (row.length !== params.row.length) return false
    const rowPrice = strictMoney(row[params.colIndex])
    const rowPack = headerlessPackValue(row.at(-1))
    const rowCode = (row[0] ?? '').replace(/\s+/g, '')
    return rowPrice !== null
      && rowPack !== null
      && rowPack <= 1000
      && /^(?=.*\d)[a-z0-9.*-]{4,}$/i.test(rowCode)
      && /[a-z]{2,}/i.test(row[1] ?? '')
  })
  const slashPack = matchingRows.some(row => /^\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*$/.test(row.at(-1) ?? ''))
  return matchingRows.length >= (slashPack ? 2 : 3)
}

function hasStableHeaderlessPriceSchema(grid: string[][]) {
  return grid.some((row, rowIndex) => row.length >= 4 && isStableHeaderlessPriceColumn({
    grid,
    row,
    rowIndex,
    colIndex: row.length - 2,
    columnHeaders: []
  }))
}

function headerlessPackValue(value: string | undefined) {
  const text = value?.trim() ?? ''
  const match = text.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/)
  if (!match?.[1]) return null
  return Math.max(Number(match[1]), Number(match[2] ?? match[1]))
}

function rowIdentityLabel(row: string[], priceColIndex: number, columnHeaders: string[]) {
  const values: string[] = []
  const clean = (value: string | undefined) => value?.replace(/\s+/g, ' ').trim() ?? ''
  const isUsable = (value: string) => Boolean(
    value
    && !/^(?:na|n\/?a|-+)$/i.test(value)
    && !/^hsn(?:\s*code)?\b/i.test(value)
  )

  // Repeating matrix tables often have [size, price, size, price] groups. Only
  // use identity columns belonging to the current price group.
  let segmentStart = 0
  for (let index = priceColIndex - 1; index >= 0; index--) {
    if (/\b(?:rate|price|mrp|amount|cost|net)\b|ratepc/.test(normalized(columnHeaders[index]))) {
      segmentStart = index + 1
      break
    }
  }

  const identityHeader = /\b(?:item|description|product|name|cat(?:alogue)?|code|sku|reference|model|type|variant|size|sizesq|sqmm|cross section|conductor|diameter|od|rated current|current|rating|pole)\b/

  // Include shared row dimensions (description, current or conductor size)
  // that sit before the first variant-specific price group.
  const sharedIdentityHeader = /\b(?:description|product|item|name|size|sizesq|sqmm|cross ?section|crosssection|conductor area|rated current|current \(a\))\b/
  const segmentHasSize = columnHeaders.slice(segmentStart, priceColIndex)
    .some(header => /\b(?:size|sizesq|sqmm|cross ?section|crosssection|conductor area)\b/.test(normalized(header)))
  for (let index = 0; index < segmentStart; index++) {
    const value = clean(row[index])
    const header = normalized(columnHeaders[index])
    const isSize = /\b(?:size|sizesq|sqmm|cross ?section|crosssection|conductor area)\b/.test(header)
    if (isUsable(value) && sharedIdentityHeader.test(header) && !(isSize && segmentHasSize)) values.push(value)
  }

  for (let index = segmentStart; index < priceColIndex; index++) {
    const value = clean(row[index])
    const header = normalized(columnHeaders[index])
    if (!isUsable(value) || !identityHeader.test(header)) continue
    if (strictMoney(value) !== null && !isBareIdentityColumnLabel(header)) continue
    if (/\b(?:hsn|discount|standard pack|std pack|std pkg|packing|quantity|qty|moq)\b/.test(header)) continue
    values.push(value)
  }

  // A package-level MRP column commonly follows a unit-price and pack-size
  // column. Reuse the product identity from the left side of the row.
  if (!values.length && segmentStart > 0) {
    for (let index = 0; index < segmentStart; index++) {
      const value = clean(row[index])
      const header = normalized(columnHeaders[index])
      if (!isUsable(value) || !identityHeader.test(header)) continue
      if (strictMoney(value) !== null && !isBareIdentityColumnLabel(header)) continue
      if (/\b(?:hsn|discount|standard pack|std pack|std pkg|packing|quantity|qty|moq)\b/.test(header)) continue
      values.push(value)
    }
  }

  // OCR sometimes loses or pollutes the header. Preserve a descriptive cell
  // adjacent to the price instead of returning a header-only catalogue entry.
  if (!values.some(value => /[a-z]/i.test(value) && !codeCandidates(value).includes(value))) {
    const description = row.slice(segmentStart, priceColIndex)
      .map(clean)
      .find(value => isUsable(value)
        && /[a-z]{3,}/i.test(value)
        && !/^\d+(?:\.\d+)?\s*(?:a|v|w|mm|mtr|meter)?$/i.test(value))
    if (description) values.push(description)
  }

  const first = clean(row[segmentStart])
  if (!values.length && isUsable(first) && strictMoney(first) === null) values.push(first)
  if (!values.length && priceColIndex > 0) {
    const globalFirst = clean(row[0])
    const hasVariantIdentity = row.slice(0, priceColIndex).some(value => codeCandidates(value ?? '').length)
      || /(?:\b(?:pole|reference)\b|\d+(?:\.\d+)?\s*core\b)/.test(normalized(columnHeaders[priceColIndex]))
    if (isUsable(globalFirst) && hasVariantIdentity) values.push(globalFirst)
  }

  const code = row.slice(0, priceColIndex).reverse().find(value =>
    /\b(?=[A-Z0-9./ -]{4,}\b)(?=[A-Z0-9./ -]*[A-Z])(?=[A-Z0-9./ -]*\d)[A-Z]{2,}[A-Z0-9]*(?:[ ./-][A-Z0-9]+)*\b/.test(value)
  )
  if (code) values.push(code.replace(/\s+/g, ' ').trim())

  for (let index = priceColIndex - 1; index >= segmentStart; index--) {
    const value = row[index]?.replace(/\s+/g, ' ').trim()
    const header = normalized(columnHeaders[index])
    if (!value || /^(?:na|-+)$/i.test(value)) continue
    if (/\b(?:size|sqmm|cross section|conductor|diameter|variant|type|model|code|sku)\b/.test(header)) {
      if (strictMoney(value) !== null && !isBareIdentityColumnLabel(header)) continue
      values.push(value)
      break
    }
  }
  return uniqueStrings(values).join(' ')
}

function rowWithInheritedDimensions(grid: string[][], rowIndex: number, row: string[], columnHeaders: string[]) {
  const inherited = [...row]
  for (let colIndex = 0; colIndex < inherited.length; colIndex++) {
    if (inherited[colIndex]?.trim()) continue
    const header = normalized(columnHeaders[colIndex])
    if (!/\b(?:rated current|current \(a\)|earth leakage|sensitivity)\b/.test(header)) continue
    for (let previous = rowIndex - 1; previous >= Math.max(0, rowIndex - 20); previous--) {
      const value = grid[previous]?.[colIndex]?.trim()
      if (!value) continue
      if (strictMoney(value) === null) break
      inherited[colIndex] = value
      break
    }
  }
  return inherited
}

function isDeterministicPriceCell(params: {
  grid: string[][]
  row: string[]
  rowIndex: number
  colIndex: number
  columnLabel: string
  section: string
}) {
  const column = normalized(params.columnLabel)
  const section = normalized(params.section)
  const row = normalized(params.row.join(' '))
  if (isSpecificationColumnLabel(column) || /\b(?:core size|no of core|amps?)\b/.test(column)) {
    return false
  }
  if (/\b(?:subtotal|grand total|gst|tax|freight)\b/.test(row)) return false
  if (/^lp$/.test(column)) return true
  if (/\b(?:rate|price|mrp|amount|cost|basic|dealer|net)\b|ratepc/.test(column)) return true
  if (/\b(?:per|packing|pack)\s*\d*\s*(?:meter|mtr|coil|roll|piece|pc|unit)\b/.test(column)) return true
  if (/\b\d+(?:\.\d+)?\s*(?:meter|mtr)\b/.test(column)) return true
  if (/\b(?:2|3|3.5|4|5|6|7|8|9|10|12|14|16|19|24)\s*core\b/.test(column)
    && /\b(?:cables?|rate|price)\b/.test(section)) return true
  return false
}

function inferCategory(value: string, rowLabel = ''): CatalogCategory {
  const text = normalized(value)
  const row = normalized(rowLabel)
  const identity = row || text
  if (/\b(?:modular\s+)?(?:surface\s+)?ac\s+box\b/.test(identity)) return 'modular_box'
  const modularBox = (candidate: string) => /\b(?:gi\s+)?(?:(?:sheet\s+)?metal\s+)?box(?:es)?\b/.test(candidate)
    && /\b(?:module|modular|concealed|surface|plastic|gi|sheet\s+metal)\b/.test(candidate)
  if (modularBox(identity) || modularBox(text)) return 'modular_box'
  const accessoryIdentity = /\b(?:accessor(?:y|ies)|wire\s*set|bus\s*bar|cover|plate|frame|connector|terminal)\b/.test(row)
  if (/distribution board|wire way box|\bdb\b|tpn db|spn db/.test(identity)
    || (!accessoryIdentity && /distribution board|wire way box|\bdb\b|tpn db|spn db/.test(text))) return 'distribution_board'
  if (/\bmccb\b|moulded case circuit breaker|molded case circuit breaker/.test(row)) return 'mccb'
  if (/\brcbo\b|residual current circuit breaker with overcurrent/.test(row)) return 'rcbo'
  if (/\brccb\b|residual current circuit breaker/.test(row)) return 'rccb'
  if (/\bisolator\b/.test(row)) return 'isolator'
  if (/\bchangeover\b|\bcos\b/.test(row)) return 'switch'
  if (/\bmcb\b|miniature circuit breaker/.test(row)) return 'mcb'
  if (/\bmccb\b|moulded case circuit breaker|molded case circuit breaker/.test(text)) return 'mccb'
  if (/\brcbo\b|residual current circuit breaker with overcurrent/.test(text)) return 'rcbo'
  if (/\brccb\b|residual current circuit breaker/.test(text)) return 'rccb'
  if (/\bmcb\b|miniature circuit breaker/.test(text)) return 'mcb'
  if (/\b[abcd]\s*curve\b/.test(text) && /\b(?:single|double|triple|four)\s*pole\b/.test(text)) return 'mcb'
  if (/\bisolator\b/.test(text)) return 'isolator'
  if (/\bsocket\b/.test(row)) return 'socket'
  if (/\bswitch\b/.test(row)) return 'switch'
  if (/\brj\s*(?:11|45)\b/.test(identity) && !/\b(?:cable|utp|stp)\b/.test(identity)) return 'socket'
  if (/\brg[ -]?(?:6|11|59)\b|co axial|coaxial/.test(identity)) return 'coaxial_cable'
  if (/\bcctv\b/.test(identity) && /cable|communication|packing|rg[ -]?59/.test(text)) return 'coaxial_cable'
  if (/\bcat[ -]?(?:5e|6|6a|7)\b|\butp\b|\bstp\b|lan cable/.test(identity)) return 'data_cable'
  if (/telephone|jelly filled|\bpair\b/.test(identity) && /cable|wire|pair/.test(identity)) return 'telephone_cable'
  if (/\bprcb\s*\d+/i.test(identity)) return 'junction_box'
  if (/junction/.test(identity)) return 'junction_box'
  if (/\b(?:lugs?|terminals?|ferrules?|thimbles?|glands?|connectors?|cable ties?|fan regulators?|regulators?|dimmers?|indicators?|plates?|covers?|frames?|cabinets?|enclosures?|plugs?|bells?|buzzers?|adapters?|adaptors?|clips?|clamps?|brackets?|sealing rings?|gaskets?|knobs?|partitions?|lubricants?)\b|cover\s*plate/.test(row)) return 'accessory'
  if (/\bplug\s*top\b/.test(identity)) return 'accessory'
  if (/modular box|module box|\d+\s*m\s*(?:box|cabinet)|(?:surface|flush)\s+(?:mounting|wall)\s+box|(?:box|cabinet)\s*[-–]?\s*\d+\s*m\b/.test(identity)) return 'modular_box'
  if (/\b(?:conduits?|pipes?|fittings?|elbows?|bends?|couplers?|couplings?|socket fitting|tees?|reducers?|saddles?|trunking|internal angle|external angle|unions?|end caps?|strainer|floor trap|[ps]\s+trap|nahani trap|air admittance valve|ball valve|vent cowel|sovent|compensator|single y|double y|door y|red cross|red y)\b/.test(text)
    || /\b(?:pvc|cpvc|upvc|ppr)\s+(?:pipes?\s*(?:&|and)\s*)?fittings?\b/.test(text)
    || /\bsockett?edpipe\b/.test(text)) return 'conduit'
  if (/flexible|\bflx\b/.test(text) && /cable|wire/.test(text)) return 'flexible_cable'
  if (/submersible/.test(text) && /cable/.test(text)) return 'flexible_cable'
  if (/multi\s*core/.test(text) && /(?:frls|pvc insulated)/.test(text) && /copper/.test(text) && /(?:round sheathed|industrial cable)/.test(text)) return 'flexible_cable'
  if (/single core|frlsh|frls|hffr|zhfr|homecab|conflame|banfire/.test(text) && /wire|cable|conductor|homecab|conflame|banfire/.test(text)) return 'single_core_wire'
  if (/armoured|xlpe|power cable|\b[ax]?2x[wyf]+\b/.test(text) && /cable/.test(text)) return 'power_cable'
  if (/\b(?:lugs?|terminals?|ferrules?|thimbles?|glands?|connectors?|cable ties?|fan regulators?|regulators?|dimmers?|indicators?|plates?|covers?|frames?|cabinets?|enclosures?|plugs?|bells?|buzzers?|adapters?|adaptors?|clips?|clamps?|brackets?|sealing rings?|gaskets?|knobs?|partitions?|lubricants?)\b/.test(text)) return 'accessory'
  if (/conduit|\bpipe\b/.test(text)) return 'conduit'
  if (/[a-z]{3,}/.test(row) && /\b(?:per unit|per number|ratepc|unit mrp|mrp per unit|price per unit)\b/.test(text)) return 'accessory'
  return 'other'
}

function inferFacets(context: string, rowLabel: string, columnLabel: string, category: CatalogCategory): CatalogFacets {
  const text = normalized(`${context} ${rowLabel} ${columnLabel}`)
  const rowText = normalized(rowLabel)
  const columnText = normalized(columnLabel)
  const facets: CatalogFacets = {}
  const setNumber = (name: string, re: RegExp) => {
    const match = text.match(re)
    if (match?.[1]) facets[name] = Number(match[1])
  }

  const rg = text.match(/\brg[ -]?(6|11|59)\b/)
  if (rg) facets.standard = `RG-${rg[1]}`
  const cat = text.match(/\bcat[ -]?(5e|6a?|7)\b/)
  if (cat) facets.standard = `CAT-${cat[1]!.toUpperCase()}`
  if (/\bccs\b|copper clad steel/.test(rowText)) facets.conductor_material = 'copper-clad steel'
  else if (/\bcopper\b/.test(rowText)) facets.conductor_material = 'copper'
  else if (/\baluminium\b/.test(rowText)) facets.conductor_material = 'aluminium'
  else if (['power_cable', 'flexible_cable', 'single_core_wire'].includes(category)) {
    if (/\bcopper\b/.test(text)) facets.conductor_material = 'copper'
    else if (/\baluminium\b/.test(text)) facets.conductor_material = 'aluminium'
  }
  if (/\bunarmoured\b/.test(text)) facets.armour = 'unarmoured'
  else if (/\barmoured\b/.test(text)) facets.armour = 'armoured'
  const variantText = /\b(?:frlsh|frls|hrfr|hffr|zhfr|fr)\b/.test(columnText) ? columnText : text
  if (/\bfrlsh\b|fr ls h/.test(variantText)) facets.fire_rating = 'FRLSH'
  else if (/\bfrls\b/.test(variantText)) facets.fire_rating = 'FRLS'
  else if (/\bhrfr\b/.test(variantText)) facets.fire_rating = 'HRFR'
  else if (/\bhffr\b|\bzhfr\b/.test(variantText)) facets.fire_rating = /\bzhfr\b/.test(variantText) ? 'ZHFR' : 'HFFR'
  else if (/\bfr\b/.test(variantText)) facets.fire_rating = 'FR'

  setNumber('size_sqmm', /\b(\d+(?:\.\d+)?)\s*sqmm\b/)
  if (facets.size_sqmm === undefined && ['power_cable', 'flexible_cable', 'single_core_wire'].includes(category)) {
    const first = normalized(rowLabel).match(/^\s*(\d+(?:\.\d+)?)\b/)
    if (first?.[1]) facets.size_sqmm = Number(first[1])
  }
  setNumber('cores', /\b(\d+(?:\.\d+)?)\s*core\b/)
  const trailingCoreCount = rowText.match(/\b(\d{1,2})\s*$/)?.[1]
  if (facets.cores === undefined
    && ['power_cable', 'flexible_cable', 'telephone_cable'].includes(category)
    && trailingCoreCount
    && /\b\d+(?:\.\d+)?\s*sq\.?\s*mm\b|\b\d+(?:\.\d+)?\s*sqmm\b/.test(columnText)) {
    facets.cores = Number(trailingCoreCount)
  }
  if (facets.cores === undefined && /\bsingle\s*core\b/.test(columnText)) facets.cores = 1
  if (category === 'single_core_wire' && facets.cores === undefined) facets.cores = 1
  setNumber('pairs', /\b(\d+(?:\.\d+)?)\s*pair\b/)
  if (category === 'telephone_cable') {
    const conductorSize = rowText.match(/\b\d+(?:\.\d+)?\s*pair\D+(\d+(?:\.\d+)?)\b/)
    if (conductorSize?.[1]) facets.conductor_size_mm = Number(conductorSize[1])
  }
  const currentEvidence = normalized(`${rowLabel} ${columnLabel}`)
  const current = currentEvidence.match(/\b(\d+(?:\.\d+)?)\s*(?:a|ax|amp)(?=\d|\b)/)
  if (current?.[1]) facets.current_a = Number(current[1])
  if (facets.current_a === undefined && ['mcb', 'mccb', 'rccb', 'rcbo', 'isolator'].includes(category) && /rated current|current \(a\)/.test(text)) {
    const current = rowText.match(/^\s*(\d+(?:\.\d+)?)\b/)
    if (current?.[1]) facets.current_a = Number(current[1])
  }
  const hasPole = (value: string) => /\b(?:\d+(?:\.\d+)?\s*pole|single pole|double pole|three pole|triple pole|four pole|sp|dp|tp|fp)\b/.test(value)
  const poleText = hasPole(rowText) ? rowText : hasPole(columnText) ? columnText : text
  const pole = poleText.match(/\b(\d+(?:\.\d+)?)\s*pole\b/)
  if (pole?.[1]) facets.poles = Number(pole[1])
  else if (poleText.includes('single pole')) facets.poles = 1
  else if (poleText.includes('double pole')) facets.poles = 2
  else if (poleText.includes('three pole') || poleText.includes('triple pole')) facets.poles = 3
  else if (poleText.includes('four pole')) facets.poles = 4
  else if (/\bsp\b/.test(poleText)) facets.poles = 1
  else if (/\bdp\b/.test(poleText)) facets.poles = 2
  else if (/\btp\b/.test(poleText)) facets.poles = 3
  else if (/\bfp\b/.test(poleText)) facets.poles = 4
  const lastPoleShorthand = [...rowText.matchAll(/\b(sp|dp|tp|fp)\b/g)].at(-1)?.[1]
  if (lastPoleShorthand) facets.poles = ({ sp: 1, dp: 2, tp: 3, fp: 4 } as const)[lastPoleShorthand as 'sp' | 'dp' | 'tp' | 'fp']
  setNumber('breaking_capacity_ka', /\b(\d+(?:\.\d+)?)\s*ka\b/)
  const curve = text.match(/\b([bcd])\s*curve\b/)
  if (curve?.[1]) facets.curve = curve[1].toUpperCase()
  setNumber('size_mm', /\b(\d+(?:\.\d+)?)\s*mm\b/)
  setNumber('ways', /\b(\d+(?:\.\d+)?)\s*way\b/)
  if (category === 'junction_box') {
    const code = text.match(/\bprcb\s*(\d{2})(\d)(?:[a-z]+)?\b/)
    if (code) {
      facets.size_mm = Number(code[1])
      facets.ways = Number(code[2])
    }
    if (facets.size_mm === undefined && /\bsize(?:od)?(?:\s*\(mm\))?\b/.test(text)) {
      const size = rowText.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*$/)
      if (size?.[1]) facets.size_mm = Number(size[1])
    }
  }
  setNumber('modules', /\b(\d+(?:\.\d+)?)\s*(?:module|mod)\b/)
  if (facets.modules === undefined && ['modular_box', 'distribution_board', 'switch', 'socket', 'accessory'].includes(category)) {
    setNumber('modules', /\b(\d+(?:\.\d+)?)\s*m\b/)
  }
  setNumber('pins', /\b(\d+(?:\.\d+)?)\s*pin\b/)
  if (/\b(?:combi(?:ned)?|combine(?:d)?)\b/.test(text)) facets.combined = true
  // Slash-separated conductor construction (for example 16/0.20) and price
  // list references (26-27/01) are not electrical current ranges. This facet
  // is commercially meaningful for socket variants only and must come from
  // the product row/column evidence rather than document-level context.
  const currentRangeEvidence = normalized(`${rowLabel} ${columnLabel}`)
  const currentRange = category === 'socket'
    ? currentRangeEvidence.match(/\b(\d+)\s*(?:a|amp)?\s*\/\s*(\d+)\s*(?:a|amp)?\b/)
    : null
  if (currentRange) facets.current_range = `${currentRange[1]}/${currentRange[2]}A`
  if (/\btpn\b/.test(text)) facets.board_type = 'TPN'
  else if (/\bspn\b/.test(text)) facets.board_type = 'SPN'
  if (/\bindicator\b/.test(text)) facets.indicator = true
  if (/\bshutter\b/.test(text)) facets.shutter = true
  if (/\bswitched\s+socket\b/.test(text)) facets.switched = true
  const voltage = text.match(/\b(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*kv|\d+(?:\.\d+)?\s*kv|650\s*\/\s*1100\s*v)\b/)
  if (voltage?.[1]) facets.voltage_grade = normalizeVoltageGrade(voltage[1])
  return facets
}

function normalizeVoltageGrade(value: string) {
  const compact = value.replace(/\s+/g, '').toUpperCase()
  return compact === '650/1100V' || compact === '1.1KV' ? '1.1KV' : compact
}

function inferBasis(value: string, category: CatalogCategory) {
  const text = normalized(value)
  const length = text.match(/(?:^|\D)(\d+(?:\.\d+)?)\s*meter\b/)
  const scheduleJoinedToLength = length?.[1]
    ? new RegExp(`\\bsch\\s*${length[1].replace('.', '\\.')}\\s*meter\\b`).test(text)
    : false
  if (length?.[1] && !scheduleJoinedToLength) {
    return {
      quantity: Number(length[1]),
      unit: 'meter',
      packageType: /\bcoil\b/.test(text)
        ? 'coil'
        : /\broll\b/.test(text)
          ? 'roll'
          : /\bbox\b/.test(text)
            ? 'box'
            : /\bspool\b/.test(text)
              ? 'spool'
              : null,
      inferred: false
    }
  }
  if (/\bper\s*meter\b|rate\s*(?:per\s*)?(?:mtr|meter)\b|ratemtr\b/.test(text)) return { quantity: 1, unit: 'meter', packageType: null, inferred: false }
  if (/\bper coil\b/.test(text)) return { quantity: 1, unit: 'coil', packageType: 'coil', inferred: false }
  if (['power_cable', 'flexible_cable', 'telephone_cable'].includes(category)) {
    return { quantity: 1, unit: 'meter', packageType: null, inferred: true }
  }
  if (['mcb', 'mccb', 'rccb', 'rcbo', 'isolator', 'junction_box', 'distribution_board', 'modular_box', 'switch', 'socket', 'accessory'].includes(category)) {
    return { quantity: 1, unit: 'piece', packageType: null, inferred: false }
  }
  if (category === 'conduit') return { quantity: 1, unit: 'piece', packageType: null, inferred: false }
  if (/\b(?:per unit|per piece|per pc|per number|ratepc|unit mrp|mrp per unit|price per unit)\b/.test(text)) {
    return { quantity: 1, unit: 'piece', packageType: null, inferred: false }
  }
  if (category === 'other' && /\b(?:rate|price|mrp|cost)\b/.test(text)) {
    return { quantity: 1, unit: 'unit', packageType: null, inferred: true }
  }
  return { quantity: null, unit: null, packageType: null, inferred: false }
}

function inferExtendedPriceBasis(
  row: string[],
  priceColIndex: number,
  columnLabel: string,
  amount: number,
  fallback: ReturnType<typeof inferBasis>
) {
  if (!/maximum retail price/i.test(columnLabel) || priceColIndex < 2) return fallback
  const pack = strictMoney(row[priceColIndex - 1])
  const unitPrice = strictMoney(row[priceColIndex - 2])
  if (!pack || !unitPrice || !Number.isInteger(pack) || pack > 1000) return fallback
  if (Math.abs((pack * unitPrice) - amount) > 0.01) return fallback
  return { quantity: pack, unit: 'piece', packageType: null, inferred: false }
}

function priceBasisContextFromRow(row: string[]) {
  const text = row.join(' ').replace(/\s+/g, ' ').trim()
  const match = text.match(/\b(?:rate|price|mrp)\s+per\s+(?:\d+(?:\.\d+)?\s*)?(?:mtrs?|meters?|metres?|coils?|rolls?|pieces?|pcs?|numbers?|units?|kg)\b/i)
  return match?.[0] ?? ''
}

function inferTransposedPriceBasis(
  grid: string[][],
  rowIndex: number,
  colIndex: number,
  amount: number,
  fallback: ReturnType<typeof inferBasis>
) {
  const rowLabel = normalized(grid[rowIndex]?.[0])
  if (!/maximum retail price|\bmrp\b/.test(rowLabel)) return fallback
  const previousLabel = normalized(grid[rowIndex - 1]?.[0])
  const nextLabel = normalized(grid[rowIndex + 1]?.[0])
  if (!/unit sale price|unit price|price per (?:number|piece|unit)/.test(previousLabel)) return fallback
  if (!/packing quantity|packing qty|pack qty|standard packing|standards packing/.test(nextLabel)) return fallback
  const unitPrice = strictMoney(grid[rowIndex - 1]?.[colIndex])
  const pack = strictMoney(grid[rowIndex + 1]?.[colIndex])
  if (!unitPrice || !pack || !Number.isInteger(pack) || pack > 10000) return fallback
  if (Math.abs((unitPrice * pack) - amount) > 0.02) return fallback
  return { quantity: pack, unit: 'piece', packageType: 'box', inferred: false }
}

function priceTypeFromRow(row: string[]) {
  const label = normalized(row[0])
  if (/unit sale price|unit price|price per (?:number|piece|unit)/.test(label)) return 'unit_sale_price'
  if (/maximum retail price|\bmrp\b/.test(label)) return 'mrp'
  return null
}

function priceTypeFromLabel(value: string) {
  const label = normalized(value)
  if (/unit sale price|unit price|price per (?:number|piece|unit)/.test(label)) return 'unit_sale_price'
  if (/maximum retail price|\bmrp\b/.test(label)) return 'mrp'
  if (/^(?:lp|list price)$/.test(label)) return 'list_price'
  if (/\bnet\b/.test(label)) return 'net_price'
  if (/^amount$|line total|total amount/.test(label)) return 'line_total'
  return null
}

function inferQuoteLineTotalBasis(
  row: string[],
  priceColIndex: number,
  columnHeaders: string[],
  columnLabel: string,
  amount: number,
  fallback: ReturnType<typeof inferBasis>
) {
  if (!/^(?:amount|line total|total amount)$/i.test(columnLabel.trim())) return fallback
  const quantityIndex = columnHeaders.findIndex(header => /^(?:qty|quantity)$/i.test(header.trim()))
  const netIndex = columnHeaders.findIndex(header => /^(?:net|net price|unit price)$/i.test(header.trim()))
  const unitIndex = columnHeaders.findIndex(header => /^(?:unit|uom)$/i.test(header.trim()))
  if (quantityIndex < 0 || netIndex < 0 || quantityIndex >= priceColIndex || netIndex >= priceColIndex) return fallback
  const quantity = strictMoney(row[quantityIndex])
  const net = strictMoney(row[netIndex])
  if (!quantity || !net || Math.abs((quantity * net) - amount) > 0.02) return fallback
  const rawUnit = normalized(row[unitIndex] ?? '')
  const unit = /^(?:mtr|meter|metre)$/.test(rawUnit)
    ? 'meter'
    : /^(?:pc|pcs|piece|pieces|nos?|number)$/.test(rawUnit)
      ? 'piece'
      : fallback.unit
  if (!unit) return fallback
  return { quantity, unit, packageType: fallback.packageType, inferred: false }
}

function productVariantsForColumn(productBands: string[][], colIndex: number) {
  const variants: Array<{ label: string, sku: string | null }> = []
  for (const band of productBands) {
    const codes = productCodes(band[colIndex] ?? '')
    if (!codes.length) continue
    const label = band[0]?.replace(/\s+/g, ' ').trim() ?? ''
    for (const sku of codes) variants.push({ label, sku })
  }
  const seen = new Set<string>()
  return variants.filter(variant => {
    const key = `${variant.label.toLowerCase()}:${variant.sku?.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function productCodes(value: string) {
  const semanticCodes = codeCandidates(value)
  if (semanticCodes.length) return semanticCodes
  const plain = value.trim()
  return /^\d{4,}$/.test(plain) ? [plain] : []
}

function inferSkuFromRow(
  row: string[],
  priceColIndex: number,
  rowLabel: string,
  columnLabel = '',
  columnHeaders: string[] = []
) {
  // Prefer a dedicated item/catalogue-code cell over code-like electrical
  // notation in the description (for example Item 21011 beside "10AX1 Way").
  // Purely numeric catalogue codes are common and were previously losing to
  // alphanumeric current/rating tokens such as 10AX1.
  for (let index = 0; index < priceColIndex; index++) {
    const header = normalized(columnHeaders[index])
    if (!/^(?:item(?:\s*(?:code|no))?|product\s*(?:code|no)|cat(?:alogue)?\s*(?:code|no)|code|sku|reference|model)$/.test(header)) continue
    const value = row[index]?.trim() ?? ''
    if (!/^(?=[a-z0-9_./-]{4,}$)(?=[a-z0-9_./-]*\d)[a-z0-9_./-]+$/i.test(value)) continue
    return value
  }
  const candidates = [...row.slice(0, priceColIndex), rowLabel, columnLabel]
  const matches = candidates.flatMap((candidate, cellIndex) => codeCandidates(candidate ?? '').map(code => ({
    code,
    score: codeScore(code, candidate ?? '', cellIndex)
  })))
  matches.sort((a, b) => b.score - a.score || b.code.length - a.code.length)
  if (matches[0]?.code) return matches[0].code
  if (row.slice(0, priceColIndex).some(isProductDescriptorCell)) {
    const numericSku = row.slice(0, priceColIndex).find(value => /^\d{4,}$/.test(value.trim()))
    if (numericSku) return numericSku.trim()
  }
  return null
}

function codeCandidates(value: string) {
  const compact = value.trim()
  const tokens = compact.match(/\b(?=[A-Z0-9_./-]{4,}\b)(?=[A-Z0-9_./-]*[A-Z])(?=[A-Z0-9_./-]*\d)[A-Z0-9_./-]+\b/g) ?? []
  const numeric = compact.match(/^\d{4,}\s+\d{2,}[A-Z]?$/)?.[0]
  const spaced = compact.match(/\b[A-Z]{2,}\s+\d{2,}[A-Z0-9]*\b/g) ?? []
  return uniqueStrings([...tokens, ...spaced, numeric ?? ''])
    .filter(code => !/^(?:RATE|MRP|SIZE|PAIR|TRAID|IP\d+|\d+(?:V|A|KA|M))$/i.test(code))
}

function codeScore(code: string, source: string, cellIndex: number) {
  const exactCell = source.trim().toUpperCase() === code.toUpperCase()
  const letters = (code.match(/[A-Z]/gi) ?? []).length
  const digits = (code.match(/\d/g) ?? []).length
  return (exactCell ? 100 : 0) + (code.includes('_') ? 15 : 0) + Math.min(code.length, 30) + Math.min(letters, 8) + Math.min(digits, 8) + cellIndex
}

function canonicalNameFor(params: {
  category: CatalogCategory
  context: string
  rowLabel: string
  columnLabel: string
  facets: CatalogFacets
  sku: string | null
}) {
  const values = [params.rowLabel, params.columnLabel]
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const name = uniqueStrings(values).join(' — ')
  return name || params.sku || params.category.replace(/_/g, ' ')
}

function inferMoq(row: string[], columnHeaders: string[]) {
  for (let index = 0; index < row.length; index++) {
    const header = normalized(columnHeaders[index])
    if (/\b(?:moq|std pack|standard pack|packing qty|quantity)\b/.test(header) && row[index]?.trim()) return row[index]!.trim()
  }
  return null
}

function inferTelephoneConductorSize(columnHeaders: string[], priceColIndex: number) {
  const label = normalized(columnHeaders[priceColIndex])
  const explicit = label.match(/\b(0\.[456])\s*mm\b/)
  if (explicit?.[1]) return Number(explicit[1])

  const sameVariantColumns = columnHeaders
    .map((header, index) => ({ index, header: normalized(header) }))
    .filter(item => item.header.includes('unarmoured') && /\b(?:rate|meter|coil)\b/.test(item.header))
    .map(item => item.index)
  const position = sameVariantColumns.indexOf(priceColIndex)
  if (position === 0 && sameVariantColumns.length >= 2) return 0.4
  if (position === 1 && sameVariantColumns.length >= 2) return 0.5
  return null
}

function inferTelephoneConductorSizeFromRow(row: string[], priceColIndex: number) {
  for (let index = priceColIndex - 1; index >= 0; index--) {
    const value = row[index]?.trim().replace(/\*$/, '')
    if (/^0\.[456]0?$/.test(value ?? '')) return Number(value)
  }
  return null
}

function strictMoney(value: string | null | undefined) {
  const raw = (value ?? '').trim()
  if (!/^\s*(?:₹|rs\.?|inr)?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*(?:\/-)?\s*$/i.test(raw)) return null
  const normalized = raw.replace(/(?:₹|rs\.?|inr|,|\/\-|\s)/gi, '')
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function materializeOffer(options: CompileTableOptions, value: ModelOffer): CompiledCatalogOffer {
  const rowIndex = Number(value.source_row_index)
  const colIndex = Number(value.source_col_index)
  const rawPrice = options.table.grid[rowIndex]?.[colIndex] ?? ''
  const amount = strictMoney(rawPrice) ?? Number.NaN
  const facets = Object.fromEntries((value.facets ?? [])
    .filter(facet => facet.name?.trim() && facet.value?.trim())
    .map(facet => [facet.name.trim(), typedFacetValue(facet.value)])) as CatalogFacets

  const base = {
    category: value.category,
    canonical_name: value.canonical_name?.trim() ?? '',
    brand: value.brand?.trim() || options.vendorName?.trim() || null,
    sku: value.sku?.trim() || null,
    aliases: uniqueStrings(value.aliases ?? []),
    facets,
    amount,
    currency: 'INR',
    basis_quantity: finitePositive(value.basis_quantity),
    basis_unit: value.basis_unit?.trim().toLowerCase() || null,
    package_type: value.package_type?.trim().toLowerCase() || null,
    moq: value.moq?.trim() || null,
    source_page: options.table.page,
    source_table_index: options.table.tableIndex,
    source_row_index: rowIndex,
    source_col_index: colIndex,
    source_table_title: options.table.title,
    source_row_label: value.source_row_label?.trim() || null,
    source_column_label: value.source_column_label?.trim() || null,
    raw_price_value: rawPrice,
    source_excerpt: sourceExcerpt(options.table.grid, rowIndex)
  }
  return { ...base, validation_errors: validateCompiledOffer(base) }
}

function typedFacetValue(value: string): string | number | boolean {
  const normalized = value.trim()
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized)
  if (/^(?:true|false)$/i.test(normalized)) return normalized.toLowerCase() === 'true'
  return normalized
}

function finitePositive(value: number | null | undefined) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const clean = value.trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

function dedupeOffers(offers: CompiledCatalogOffer[]) {
  const byKey = new Map<string, CompiledCatalogOffer>()
  for (const offer of offers) {
    const key = [
      offer.source_table_index,
      offer.source_row_index,
      offer.source_col_index,
      offer.category,
      offer.canonical_name.toLowerCase()
    ].join(':')
    const existing = byKey.get(key)
    if (!existing || offer.validation_errors.length < existing.validation_errors.length) byKey.set(key, offer)
  }
  return [...byKey.values()]
}

function semanticOfferLabel(value: string | null) {
  return normalized(value)
    .replace(/\b(?:price list by|price list|mrp list|rate list|the supreme industries ltd|mumbai|dt|dte|date)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function dedupeDocumentOffers(offers: CompiledCatalogOffer[]) {
  const byKey = new Map<string, CompiledCatalogOffer>()
  for (const offer of offers) {
    const key = JSON.stringify([
      offer.source_page,
      semanticOfferLabel(offer.canonical_name),
      semanticOfferLabel(offer.source_row_label),
      semanticOfferLabel(offer.source_column_label),
      offer.sku?.toLowerCase() ?? '',
      Number(offer.amount),
      offer.basis_quantity,
      offer.basis_unit,
      offer.package_type
    ])
    const existing = byKey.get(key)
    if (!existing || offer.validation_errors.length < existing.validation_errors.length) byKey.set(key, offer)
  }
  // Tiled OCR deliberately overlaps a page. Table title + row/column identity,
  // SKU, value, and purchase basis are the stable semantic coordinates across
  // those different physical grids. Series/colour bands remain distinct
  // because they are carried in the table title or row identity.
  return [...byKey.values()]
}

export { strictMoney }
