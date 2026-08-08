import type { CatalogCategory, CatalogFacets } from './contracts'

export interface CatalogQuery {
  raw: string
  normalized_text: string
  corrected_text: string | null
  corrections: CatalogQueryCorrection[]
  sku_candidates: string[]
  category: CatalogCategory | null
  facets: CatalogFacets
  requested_basis_quantity: number | null
  requested_basis_unit: string | null
  terms: string[]
}

export interface CatalogQueryCorrection {
  from: string
  to: string
  kind: 'spelling' | 'alias'
}

export function splitCatalogQueries(message: string) {
  return message.split(/\n+|;/g).map(value => value.trim()).filter(Boolean)
}

export function parseCatalogQuery(raw: string): CatalogQuery {
  const text = normalizeQuery(raw)
  const category = inferQueryCategory(text)
  const facets: CatalogFacets = {}

  const setNumber = (name: string, re: RegExp) => {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
    const matches = [...text.matchAll(new RegExp(re.source, flags))]
    const match = matches.at(-1)
    if (match?.[1]) facets[name] = Number(match[1])
  }

  const rg = text.match(/\brg\s*[- ]?\s*(6|11|59)\b/)
  if (rg) facets.standard = `RG-${rg[1]}`
  const cat = text.match(/\bcat\s*[- ]?\s*(5e|6a?|7)\b/)
  if (cat) facets.standard = `CAT-${cat[1]!.toUpperCase()}`

  if (/\bcopper clad steel\b|\bccs\b/.test(text)) facets.conductor_material = 'copper-clad steel'
  else if (/\bcopper\b/.test(text)) facets.conductor_material = 'copper'
  else if (/\baluminium\b/.test(text)) facets.conductor_material = 'aluminium'
  if (/\bunarmoured\b/.test(text)) facets.armour = 'unarmoured'
  else if (/\barmoured\b/.test(text)) facets.armour = 'armoured'
  if (/\bfrlsh\b/.test(text)) facets.fire_rating = 'FRLSH'
  else if (/\bfrls\b/.test(text)) facets.fire_rating = 'FRLS'
  else if (/\bhffr\b/.test(text)) facets.fire_rating = 'HFFR'
  else if (/\bzhfr\b/.test(text)) facets.fire_rating = 'ZHFR'
  else if (/\bfr\b/.test(text)) facets.fire_rating = 'FR'

  setNumber('size_sqmm', /\b(\d+(?:\.\d+)?)\s*sqmm\b/)
  setNumber('cores', /\b(\d+(?:\.\d+)?)\s*core\b/)
  setNumber('pairs', /\b(\d+(?:\.\d+)?)\s*pair\b/)
  setNumber('current_a', /\b(\d+(?:\.\d+)?)\s*amp\b/)
  setNumber('poles', /\b(\d+(?:\.\d+)?)\s*pole\b/)
  setNumber('breaking_capacity_ka', /\b(\d+(?:\.\d+)?)\s*ka\b/)
  setNumber('ways', /\b(\d+(?:\.\d+)?)\s*way\b/)
  setNumber('modules', /\b(\d+(?:\.\d+)?)\s*(?:module|mod)\b/)
  if (facets.modules === undefined && ['modular_box', 'distribution_board'].includes(category ?? '')) {
    setNumber('modules', /\b(\d+(?:\.\d+)?)\s*m\b/)
  }
  setNumber('pins', /\b(\d+(?:\.\d+)?)\s*pin\b/)
  if (category === 'power_cable' && (facets.size_sqmm === undefined || facets.cores === undefined)) {
    const matrixIdentity = [...text.matchAll(/\b([1-9])\s*x\s*(\d+(?:\.\d+)?)\b/g)].at(-1)
    if (matrixIdentity) {
      if (facets.cores === undefined) facets.cores = Number(matrixIdentity[1])
      if (facets.size_sqmm === undefined) facets.size_sqmm = Number(matrixIdentity[2])
    }
  }
  if (/\bcombi(?:ned)?\b|\bcombine(?:d)?\s+box\b/.test(text)) facets.combined = true
  const currentRange = text.match(/\b(\d+)\s*(?:amp|a)?\s*\/\s*(\d+)\s*(?:amp|a)?\b/)
  if (currentRange && ['socket', 'accessory'].includes(category ?? '')) {
    facets.current_range = `${currentRange[1]}/${currentRange[2]}A`
  }
  if (/\btpn\b/.test(text)) facets.board_type = 'TPN'
  else if (/\bspn\b/.test(text)) facets.board_type = 'SPN'
  if (category === 'junction_box' || category === 'conduit') setNumber('size_mm', /\b(\d+(?:\.\d+)?)\s*mm\b/)
  if (category === 'telephone_cable') setNumber('conductor_size_mm', /\b(\d+(?:\.\d+)?)\s*mm\b/)

  const voltageSegment = normalizeQuery(raw.split(/[—–]/).at(-1) ?? raw)
  const segmentVoltages = [...voltageSegment.matchAll(/\b(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*kv|\d+(?:\.\d+)?\s*kv|650\s*\/\s*1100\s*v)\b/g)]
  const allVoltages = segmentVoltages.length
    ? segmentVoltages
    : [...text.matchAll(/\b(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*kv|\d+(?:\.\d+)?\s*kv|650\s*\/\s*1100\s*v)\b/g)]
  const voltage = /\bue\b/.test(voltageSegment) ? allVoltages[0] : allVoltages.at(-1)
  if (voltage?.[1]) facets.voltage_grade = normalizeVoltageGrade(voltage[1])
  const curve = text.match(/\b([bcd])\s*curve\b/)
  if (curve?.[1]) facets.curve = curve[1].toUpperCase()

  const requestedBasis = requestedBasisFromQuery(text, category)
  const corrections = queryCorrections(raw)
  return {
    raw,
    normalized_text: text,
    corrected_text: corrections.length ? applySafeCorrections(raw) : null,
    corrections,
    sku_candidates: extractSkuCandidates(raw),
    category,
    facets,
    requested_basis_quantity: requestedBasis.quantity,
    requested_basis_unit: requestedBasis.unit,
    terms: text.split(' ').filter(term => term.length >= 2 && !QUERY_NOISE.has(term))
  }
}

function normalizeQuery(value: string) {
  return value.toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/(\d+(?:\.\d+)?)\s*sq\.?\s*mm\b/g, '$1 sqmm ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/g, '$1 core ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:poles?|pole|p)\b/g, '$1 pole ')
    .replace(/\bcabels?\b/g, ' cable ')
    .replace(/\bflx\b/g, ' flexible ')
    .replace(/\b(\d+)\s*p\s*oles?\b/g, '$1 pole ')
    .replace(/(\d+(?:\.\d+)?)\s*model\s*(?:(metal|surface|flush|plastic)\s*)?box\b/g, '$1 module $2 box ')
    .replace(/\bcu\b/g, ' copper ')
    .replace(/\b(?:alu|aluminium|aluminum)\b/g, ' aluminium ')
    .replace(/\bun\s*[-_/]?\s*arm(?:ou?red|ored|d)?\b/g, ' unarmoured ')
    .replace(/\barm(?:ou?red|ored|d)?\b/g, ' armoured ')
    .replace(/\bfr\s*[-_/]?\s*ls\s*h\b/g, ' frlsh ')
    .replace(/\bfr\s*[-_/]?\s*ls\b/g, ' frls ')
    .replace(/\bsq\.?\s*mm\b/g, ' sqmm ')
    .replace(/\bsc\b/g, ' 1 core ')
    .replace(/\bsp\b/g, ' 1 pole ')
    .replace(/\bdp\b/g, ' 2 pole ')
    .replace(/\btp\b/g, ' 3 pole ')
    .replace(/\bfp\b/g, ' 4 pole ')
    .replace(/\bsingle\s+poles?\b/g, ' 1 pole ')
    .replace(/\bdouble\s+poles?\b/g, ' 2 pole ')
    .replace(/\b(?:triple|three)\s+poles?\b/g, ' 3 pole ')
    .replace(/\bfour\s+poles?\b/g, ' 4 pole ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:amps?|amperes?|a)\b/g, '$1 amp ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/g, '$1 core ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:poles?|pole)\b/g, '$1 pole ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|meters?|metres?)\b/g, '$1 meter ')
    .replace(/[^a-z0-9./+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferQueryCategory(text: string): CatalogCategory | null {
  if (/\b(?:\d+\s*way\s+)?mcb\s+(?:box|db|enclosure)\b/.test(text)) return 'distribution_board'
  if (/\bmccb\b/.test(text)) return 'mccb'
  if (/\brcbo\b/.test(text)) return 'rcbo'
  if (/\brccb\b/.test(text)) return 'rccb'
  if (/\bmcb\b/.test(text)) return 'mcb'
  if (/\bisolator\b/.test(text)) return 'isolator'
  if (/\brg\s*[- ]?\s*(?:6|11|59)\b|coaxial|tv cable/.test(text)) return 'coaxial_cable'
  if (/\bcat\s*[- ]?\s*(?:5e|6a?|6|7)\b|\butp\b|\bstp\b|network(?:ing)?\s+cable|lan\s+cable/.test(text)) return 'data_cable'
  if (/telephone/.test(text)) return 'telephone_cable'
  if (/junction/.test(text)) return 'junction_box'
  if (/\bplug\s*top\b|\b(?:\d+\s*)?pin\s*top\b/.test(text)) return 'accessory'
  if (/\bcombine(?:d)?\s+box\b|\bcombi\s+(?:box|socket)\b/.test(text)) return 'socket'
  if (/\b\d+\s*(?:m|module)\s+(?:(?:db|metal|surface|flush|plastic|gi|concealed)\s+)*box\b|modular box|module(?:\s+(?:metal|surface|flush|plastic|gi|concealed))*\s+box/.test(text)) return 'modular_box'
  if (/distribution board|tpn db|spn db|\bdb box\b/.test(text)) return 'distribution_board'
  if (/\bsocket\b/.test(text)) return 'socket'
  if (/\bswitch\b/.test(text)) return 'switch'
  if (/single core|\bwire\b/.test(text) && /frlsh|frls|hffr|zhfr|\bfr\b/.test(text)) return 'single_core_wire'
  if (/\b1 core\b/.test(text) && /\bsqmm\b/.test(text) && /\b(?:\d+(?:\.\d+)?\s*meter|coil)\b/.test(text)) return 'single_core_wire'
  if (/flexible|\bflx\b/.test(text)) return 'flexible_cable'
  if (/armoured|xlpe|\bcable\b/.test(text) && /sqmm|core|kv/.test(text)) return 'power_cable'
  if (/conduit|\b(?:hms\s+)?pipe\b/.test(text)) return 'conduit'
  return null
}

function normalizeVoltageGrade(value: string) {
  const compact = value.replace(/\s+/g, '').toUpperCase()
  if (compact === '650/1100V' || compact === '1.1KV') return '1.1KV'
  const ratio = compact.match(/^\d+(?:\.\d+)?\/(\d+(?:\.\d+)?)KV$/)
  return ratio?.[1] ? `${ratio[1]}KV` : compact
}

export function normalizeCatalogSku(value: string | null | undefined) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function extractSkuCandidates(raw: string) {
  const candidates = new Set<string>()
  const add = (value: string | undefined) => {
    const normalized = normalizeCatalogSku(value)
    if (normalized.length >= 3) candidates.add(normalized)
  }
  // SKU mode must be explicit. Bare product words such as CAT-6, 3Pair,
  // 90Mtr, or "12 Model Metal Box" are product language, not catalogue codes.
  for (const match of raw.matchAll(/\b(?:sku|item\s*code|product\s*code|catalogue\s*(?:no|number)|catalog\s*(?:no|number)|cat\s*(?:no|number)|model\s*(?:no|number))\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]*(?:\s+[a-z0-9][a-z0-9._/-]*)?)/gi)) {
    add(match[1])
  }
  if (candidates.size) return [...candidates]

  const trimmed = raw.trim()
  const looksLikeStandaloneCode = /^[a-z0-9][a-z0-9 ./_-]{2,30}$/i.test(trimmed)
    && (/\d/.test(trimmed) && /[a-z]/i.test(trimmed) || /^\d{4,}$/.test(trimmed))
    && !/\b(?:amp|core|pair|pole|sqmm|sq\.?\s*mm|meter|mtr|module|model|way|kv|cable|wire|box|mcb|socket|switch|telephone|networking|surface|metal|flush|pipe|conduit|fr|frls|frlsh|hffr)\b/i.test(trimmed)
    && !/(?:^|[\s(/])\d+(?:\.\d+)?\s*(?:a|amp|c|core|p|pole|m|mm|mtr|meter|sqmm|kv|ka)\b/i.test(trimmed)
    && !/^(?:cat|rg)\s*[- ]?\s*(?:5e|6a?|6|7|11|59)(?:\s+\d+\s*(?:m|mtr|meter))?$/i.test(trimmed)
  if (looksLikeStandaloneCode) add(trimmed)
  return [...candidates]
}

function queryCorrections(raw: string): CatalogQueryCorrection[] {
  const corrections: CatalogQueryCorrection[] = []
  const add = (re: RegExp, to: string, kind: CatalogQueryCorrection['kind']) => {
    const match = raw.match(re)
    if (match?.[0]) corrections.push({ from: match[0], to, kind })
  }
  add(/\bcabels?\b/i, 'cable', 'spelling')
  add(/\bflx\b/i, 'flexible', 'alias')
  add(/\b(?:alu|aluminum)\b/i, 'aluminium', 'alias')
  const modelBox = raw.match(/\b(\d+)\s*model\s*(?:(metal|surface|flush|plastic)\s*)?box\b/i)
  if (modelBox?.[0]) {
    corrections.push({
      from: modelBox[0],
      to: `${modelBox[1]} Module ${modelBox[2] ? `${modelBox[2]} ` : ''}Box`,
      kind: 'spelling'
    })
  }
  add(/\b(\d+)\s*p\s*oles?\b/i, `${raw.match(/\b(\d+)\s*p\s*oles?\b/i)?.[1] ?? ''} pole`.trim(), 'spelling')
  return corrections
}

function applySafeCorrections(raw: string) {
  return raw
    .replace(/\bcabels?\b/gi, 'cable')
    .replace(/\bflx\b/gi, 'Flexible')
    .replace(/\b(?:alu|aluminum)\b/gi, 'Aluminium')
    .replace(/\b(\d+)\s*model\s*(?:(metal|surface|flush|plastic)\s*)?box\b/gi, '$1 Module $2 Box')
    .replace(/\b(\d+)\s*p\s*oles?\b/gi, '$1 Pole')
    .replace(/\s+/g, ' ')
    .trim()
}

function requestedBasisFromQuery(text: string, category: CatalogCategory | null) {
  const length = text.match(/\b(\d+(?:\.\d+)?)\s*meter\b/)
  if (length?.[1]) return { quantity: Number(length[1]), unit: 'meter' }
  if (['coaxial_cable', 'data_cable', 'telephone_cable', 'power_cable', 'flexible_cable', 'single_core_wire'].includes(category ?? '')) {
    const shortLength = text.match(/\b(\d+(?:\.\d+)?)\s*m\b/)
    if (shortLength?.[1]) return { quantity: Number(shortLength[1]), unit: 'meter' }
  }
  return { quantity: null, unit: null }
}

const QUERY_NOISE = new Set([
  'find', 'get', 'give', 'need', 'price', 'rate', 'show', 'the', 'for', 'with', 'graded', 'cable', 'wire'
])
