import type { CatalogCategory, CatalogFacets } from './contracts'

export interface CatalogQuery {
  raw: string
  category: CatalogCategory | null
  facets: CatalogFacets
  requested_basis_quantity: number | null
  requested_basis_unit: string | null
  terms: string[]
}

export function splitCatalogQueries(message: string) {
  return message.split(/\n+|;/g).map(value => value.trim()).filter(Boolean)
}

export function parseCatalogQuery(raw: string): CatalogQuery {
  const text = normalizeQuery(raw)
  const category = inferQueryCategory(text)
  const facets: CatalogFacets = {}

  const setNumber = (name: string, re: RegExp) => {
    const match = text.match(re)
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
  if (/\bcombi(?:ned)?\b|\bcombine(?:d)?\s+box\b/.test(text)) facets.combined = true
  const currentRange = text.match(/\b(\d+)\s*(?:amp|a)?\s*\/\s*(\d+)\s*(?:amp|a)?\b/)
  if (currentRange) facets.current_range = `${currentRange[1]}/${currentRange[2]}A`
  if (/\btpn\b/.test(text)) facets.board_type = 'TPN'
  else if (/\bspn\b/.test(text)) facets.board_type = 'SPN'
  if (category === 'junction_box') setNumber('size_mm', /\b(\d+(?:\.\d+)?)\s*mm\b/)
  if (category === 'telephone_cable') setNumber('conductor_size_mm', /\b(\d+(?:\.\d+)?)\s*mm\b/)

  const voltage = text.match(/\b(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*kv|\d+(?:\.\d+)?\s*kv|650\s*\/\s*1100\s*v)\b/)
  if (voltage?.[1]) facets.voltage_grade = normalizeVoltageGrade(voltage[1])
  const curve = text.match(/\b([bcd])\s*curve\b/)
  if (curve?.[1]) facets.curve = curve[1].toUpperCase()

  const requestedBasis = requestedBasisFromQuery(text)
  return {
    raw,
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
    .replace(/(\d+(?:\.\d+)?)\s*model\s*box\b/g, '$1 module box ')
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
    .replace(/(\d+(?:\.\d+)?)\s*(?:amps?|amperes?|a)\b/g, '$1 amp ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/g, '$1 core ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:poles?|pole)\b/g, '$1 pole ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|meters?|metres?)\b/g, '$1 meter ')
    .replace(/[^a-z0-9./+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferQueryCategory(text: string): CatalogCategory | null {
  if (/\bmccb\b/.test(text)) return 'mccb'
  if (/\brcbo\b/.test(text)) return 'rcbo'
  if (/\brccb\b/.test(text)) return 'rccb'
  if (/\bmcb\b/.test(text)) return 'mcb'
  if (/\bisolator\b/.test(text)) return 'isolator'
  if (/\brg\s*[- ]?\s*(?:6|11|59)\b|coaxial|tv cable/.test(text)) return 'coaxial_cable'
  if (/\bcat\s*[- ]?\s*(?:5e|6a?|6|7)\b|\butp\b|\bstp\b/.test(text)) return 'data_cable'
  if (/telephone/.test(text)) return 'telephone_cable'
  if (/junction/.test(text)) return 'junction_box'
  if (/\bplug\s*top\b|\b(?:\d+\s*)?pin\s*top\b/.test(text)) return 'accessory'
  if (/\bcombine(?:d)?\s+box\b|\bcombi\s+(?:box|socket)\b/.test(text)) return 'socket'
  if (/\b\d+\s*(?:m|module)\s+(?:db\s+)?box\b|modular box|module box/.test(text)) return 'modular_box'
  if (/distribution board|tpn db|spn db|\bdb box\b/.test(text)) return 'distribution_board'
  if (/\bsocket\b/.test(text)) return 'socket'
  if (/\bswitch\b/.test(text)) return 'switch'
  if (/single core|\bwire\b/.test(text) && /frlsh|frls|hffr|zhfr|\bfr\b/.test(text)) return 'single_core_wire'
  if (/flexible|\bflx\b/.test(text)) return 'flexible_cable'
  if (/armoured|xlpe|\bcable\b/.test(text) && /sqmm|core|kv/.test(text)) return 'power_cable'
  if (/conduit/.test(text)) return 'conduit'
  return null
}

function normalizeVoltageGrade(value: string) {
  const compact = value.replace(/\s+/g, '').toUpperCase()
  return compact === '650/1100V' || compact === '1.1KV' ? '1.1KV' : compact
}

function requestedBasisFromQuery(text: string) {
  const length = text.match(/\b(\d+(?:\.\d+)?)\s*meter\b/)
  if (length?.[1]) return { quantity: Number(length[1]), unit: 'meter' }
  return { quantity: null, unit: null }
}

const QUERY_NOISE = new Set([
  'find', 'get', 'give', 'need', 'price', 'rate', 'show', 'the', 'for', 'with', 'graded', 'cable', 'wire'
])
