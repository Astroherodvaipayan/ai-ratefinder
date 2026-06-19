import { normalizeSearchText, tokenize, uniqueText } from './text'

export interface FullKittingProductVendor {
  vendor: string
  product: string
}

export const FULL_KITTING_UNITS = [
  { aliases: ['nos', 'no', 'number', 'numbers'], canonical: 'piece' },
  { aliases: ['mtr', 'mtrs', 'meter', 'meters', 'metre', 'metres', 'm'], canonical: 'meter' },
  { aliases: ['bag', 'bags'], canonical: 'bag' },
  { aliases: ['bdl', 'bdls', 'bundle', 'bundles'], canonical: 'bundle' },
  { aliases: ['box', 'boxes'], canonical: 'box' },
  { aliases: ['case', 'cases'], canonical: 'case' },
  { aliases: ['coil', 'coils'], canonical: 'coil' },
  { aliases: ['kg', 'kilogram', 'kilograms'], canonical: 'kg' },
  { aliases: ['ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'], canonical: 'litre' },
  { aliases: ['pkt', 'packet', 'packets'], canonical: 'packet' },
  { aliases: ['roll', 'rolls'], canonical: 'roll' },
  { aliases: ['set', 'sets'], canonical: 'set' },
  { aliases: ['sqft', 'sq ft', 'square feet', 'square foot'], canonical: 'sqft' },
  { aliases: ['sqm', 'sq m', 'square meter', 'square meters', 'square metre', 'square metres'], canonical: 'sqm' },
  { aliases: ['tin', 'tins'], canonical: 'tin' },
  { aliases: ['ton', 'tons'], canonical: 'ton' },
  { aliases: ['unt', 'unit', 'units'], canonical: 'unit' },
  { aliases: ['dozen', 'dozens'], canonical: 'dozen' }
] as const

export const FULL_KITTING_KNOWN_UNITS = uniqueText(FULL_KITTING_UNITS.flatMap(unit => [
  unit.canonical,
  ...unit.aliases
]).map(normalizeSearchText))

export const FULL_KITTING_PRODUCT_VENDORS: FullKittingProductVendor[] = [
  { vendor: 'Norisys', product: '6Amp Switch' },
  { vendor: 'Norisys', product: '3M Plate' },
  { vendor: 'Norisys', product: '8M Plate Horizontal' },
  { vendor: 'Norisys', product: '32Amp DP Switch' },
  { vendor: 'Norisys', product: '16Amp Switch' },
  { vendor: 'Norisys', product: '16Amp Socket' },
  { vendor: 'Norisys', product: 'Fan Regulator' },
  { vendor: 'Norisys', product: '2M Plate' },
  { vendor: 'Norisys', product: '12M Plate' },
  { vendor: 'Norisys', product: '8M Plate With 8H' },
  { vendor: 'Norisys', product: '8M Plate With 4H 2SW' },
  { vendor: 'Norisys', product: '6M Plate' },
  { vendor: 'Norisys', product: '4M Plate' },
  { vendor: 'Norisys', product: '6Amp 3Pin Socket' },
  { vendor: 'Norisys', product: '6Amp 1Way Switch' },
  { vendor: 'Norisys', product: 'Blank Plate' },
  { vendor: 'Norisys', product: '16Amp 3Pin Socket' },
  { vendor: 'Hills', product: 'HL-12W FLAWA WH 4000K' },
  { vendor: 'Hills', product: 'HL-12W STAR SPOT LIGHT' },
  { vendor: 'Hills', product: '12W LED DOWNLIGHT WH 4000K 0704' },
  { vendor: 'Hills', product: '17MM PROFILE-LED HIGHLUMES STRIP' },
  { vendor: 'Hills', product: 'HANGING LIGHT 4FT LINEAR BK 4000K' },
  { vendor: 'Hills', product: '17MM Surface Profile' },
  { vendor: 'Hills', product: '17MM Corner Profile' },
  { vendor: 'Hills', product: '5MM Corner Profile' },
  { vendor: 'Hills', product: '5MM Council Profile' },
  { vendor: 'Hills', product: '5MM LED Strip 6K' },
  { vendor: 'Hills', product: '300W SMPS' },
  { vendor: 'Hills', product: 'Wardrobe Scensior' },
  { vendor: 'Hills', product: '17mm Conceal Profile HEAVY' },
  { vendor: 'Hills', product: '17mm Surface Profile HEAVY' },
  { vendor: 'Hills', product: 'Corner Profile HEAVY' },
  { vendor: 'Hills', product: '12mm Flexible' },
  { vendor: 'Hills', product: 'LED Strip 24V 240 LED HEAVY' },
  { vendor: 'Hills', product: 'End Caps' },
  { vendor: 'Hills', product: 'Single Door Sensor' },
  { vendor: 'Hills', product: 'LED Driver 60W HEAVY' },
  { vendor: 'Hills', product: 'LED Driver 100W HEAVY' },
  { vendor: 'Hills', product: 'LED Driver 150W HEAVY' },
  { vendor: 'Hills', product: 'LED Driver 200W HEAVY' },
  { vendor: 'Hills', product: 'LED Driver 300W HEAVY' },
  { vendor: 'Hills', product: '16Amp Driver' },
  { vendor: 'Hills', product: '10Amp Driver' },
  { vendor: 'Hills', product: '5Amp Driver' },
  { vendor: 'Supreme', product: '4 X 3 Meter long PVC SWR Pipe Type-B S/S' },
  { vendor: 'Supreme', product: '2 1/2 X 3 Meter long PVC SWR Pipe Type-B 3X10 S/S' },
  { vendor: 'Supreme', product: 'WALL BRACKET 4X3 FOR U CLAMP' },
  { vendor: 'Supreme', product: 'WALL BRACKET 6X3 FOR U CLAMP' },
  { vendor: 'Supreme', product: 'WALL BRACKET 8X3 FOR U CLAMP' },
  { vendor: 'Precision', product: '20mm Conduit pipe MMS' },
  { vendor: 'Precision', product: '25mm Conduit pipe MMS' },
  { vendor: 'Precision', product: 'Fan Box With Rod' },
  { vendor: 'Precision', product: '20mm 4Way Junction' },
  { vendor: 'Precision', product: '20mm 3Way Junction' },
  { vendor: 'Precision', product: '20mm 1Way Junction' },
  { vendor: 'Precision', product: '20mm Coupler' },
  { vendor: 'Precision', product: '25mm Coupler' },
  { vendor: 'Precision', product: '20mm Normal Bend' },
  { vendor: 'Precision', product: 'Solvent Cement 500ML' },
  { vendor: 'Precision', product: '25mm PVC PIPE MMS' },
  { vendor: 'Precision', product: '20mm flexible pipe' },
  { vendor: 'Precision', product: '25mm bend' },
  { vendor: 'Polycab', product: '2.5sqmm x 4C flx wire bundle of 100 Mtr' },
  { vendor: 'Polycab', product: '1.5sqmm x 4C flx wire bundle of 100 Mtr' },
  { vendor: 'Polycab', product: '1.5sqmm x 2C Shielded Wire Bundle of 100 Mtr' },
  { vendor: 'Polycab', product: '25Sqmm*3.5Core XLPE Cu Armoured Cable' },
  { vendor: 'Polycab', product: '10Sqmm*4Core XLPE Cu Armoured Cable' },
  { vendor: 'Polycab', product: '6Sqmm*4Core XLPE Cu Armoured Cable' },
  { vendor: 'Polycab', product: '4Sqmm*3Core XLPE Cu Armoured Cable' },
  { vendor: 'Polycab', product: '6Sqmm*1Core Flx Cable FRLs' },
  { vendor: 'Polycab', product: '4Sqmm*SC Red' },
  { vendor: 'Polycab', product: '4Sqmm*SC Black' },
  { vendor: 'Polycab', product: '2.5Sqmm*SC Red' },
  { vendor: 'Polycab', product: '2.5Sqmm*SC Black' },
  { vendor: 'Polycab', product: '1.5Sqmm*SC Red' },
  { vendor: 'Polycab', product: '1.5Sqmm*SC Black' },
  { vendor: 'Polycab', product: '2.5SqmmXSC 180Mtr FR R2 Blk2' },
  { vendor: 'Polycab', product: '1SqmmXSC 180Mtr FR Blk3 R1 B2 Y2 G2' },
  { vendor: 'Legrand Mylinc', product: '9M Plate' },
  { vendor: 'Legrand Mylinc', product: '6M Plate' },
  { vendor: 'Legrand Mylinc', product: '16Amp Socket' },
  { vendor: 'Legrand Mylinc', product: '16Amp Switch Indicator' },
  { vendor: 'Legrand Mylinc', product: '6Amp switch' },
  { vendor: 'Legrand Mylinc', product: '2M Regulator' },
  { vendor: 'Legrand Mylinc', product: 'Telephone Jack' },
  { vendor: 'Legrand Mylinc', product: 'Blank Plate' },
  { vendor: 'Legrand Mylinc', product: 'Bell Indicator' },
  { vendor: 'Legrand Mylinc', product: 'Buzzer 1M' },
  { vendor: 'Legrand Lyncus White', product: '2 M Plate' },
  { vendor: 'Legrand Lyncus White', product: '3 M Plate' },
  { vendor: 'Legrand Lyncus White', product: '4 M Plate' },
  { vendor: 'Legrand Lyncus White', product: '6 M Plate' },
  { vendor: 'Legrand Lyncus White', product: '12 M Plate' },
  { vendor: 'Legrand Lyncus White', product: '6 amp switch' },
  { vendor: 'Legrand Lyncus White', product: '6 amp socket' },
  { vendor: 'Legrand Lyncus White', product: '16 amp switch' },
  { vendor: 'Legrand Lyncus White', product: '16 amp socket' },
  { vendor: 'Legrand Lyncus White', product: '2 way switch' },
  { vendor: 'Legrand Lyncus White', product: 'Fan regulator' },
  { vendor: 'Legrand Lyncus White', product: '3 modular foot light' },
  { vendor: 'Legrand Lyncus White', product: 'blank plate' },
  { vendor: 'Legrand DX', product: '10 A SP MCB 72 20 A SP 40 25A SP 40' },
  { vendor: 'Legrand DX', product: '32 amp 3 pole MCB' },
  { vendor: 'Legrand DX', product: '40 amp 3 pole MCB' },
  { vendor: 'Legrand DX', product: '40 amp 4 pole MCB' },
  { vendor: 'Legrand DX', product: '63 amp 4 pole MCB' },
  { vendor: 'Legrand DX', product: '125 amp 4 pole Mccb 16Ka' },
  { vendor: 'KEI', product: '1.5Sqmm Wire FRLS 300Mtr' },
  { vendor: 'KEI', product: '2.5Sqmm Wire FRLS 300Mtr' },
  { vendor: 'KEI', product: '4Sqmm Wire FRLS 200Mtr' },
  { vendor: 'KEI', product: '2.5sqmm*4C Copper Flx' },
  { vendor: 'KEI', product: '1.5Sqmm*2C Copper Flx' },
  { vendor: 'Dowells', product: '1.5 Copper Pin Lugs' },
  { vendor: 'Dowells', product: '2.5 Copper Pin Lugs' },
  { vendor: 'Dowells', product: '4 Copper Pin Lugs' },
  { vendor: 'Dowells', product: '1.5mm*5 Ring Terminals Lugs' },
  { vendor: 'Dowells', product: '35mm*8 Ring Terminals Lugs' },
  { vendor: 'Dowells', product: 'Lugs Aluminium Ring Type 35 Sqmm' },
  { vendor: 'Anchor', product: '6M Metal Box' },
  { vendor: 'Anchor', product: '4M Metal Box' },
  { vendor: 'Anchor', product: '3M Metal Box' },
  { vendor: 'Anchor', product: '2M Metal Box' },
  { vendor: 'Anchor', product: '4M Surface Box' },
  { vendor: 'Anchor', product: '4M Plate' },
  { vendor: 'Anchor', product: '16Amp Socket' },
  { vendor: 'Anchor', product: '16Amp Switch With Indicator' },
  { vendor: 'Anchor', product: '6Amp Switch' },
  { vendor: 'Anchor', product: '6Amp 2Way Switch' },
  { vendor: 'Anchor', product: '3M Surface Box' },
  { vendor: 'Anchor', product: '2M Surface Box' },
  { vendor: 'Anchor', product: 'Switch 6AMP Anchor Screw Type' },
  { vendor: 'Anchor', product: 'Socket 6Amp Anchor Screw' },
  { vendor: 'Anchor', product: 'Tube Light LED 20W With Fitting' },
  { vendor: 'Anchor', product: '6Amp 1Way Switch' },
  { vendor: 'Anchor', product: '6Amp 3Pin Socket' },
  { vendor: 'Anchor', product: '3M Plate' },
  { vendor: 'Anchor', product: '12M Plate' },
  { vendor: 'Anchor', product: '18M Pate' },
  { vendor: 'RR', product: '1.5 sqmm wire FRLS 200 mt Red 6 black 3' },
  { vendor: 'RR', product: '2.5sqmm wire FRLS 200 mt Rrd 3 blak 3' },
  { vendor: 'RR', product: '6sqmm wire FRLS 200mt green 2.5 Red 1 yellow 1 blue 1 black 1' },
  { vendor: 'RR', product: '10 sq mm wire FRLS 100 mt red 3 yellow 3 blue 3 black 3' },
  { vendor: 'RR', product: '16 sqmm wire FRLS 100Mtr Red 1 yellow1 blue1 black 1' }
]

const UNIT_BY_ALIAS = new Map<string, string>()
for (const unit of FULL_KITTING_UNITS) {
  UNIT_BY_ALIAS.set(normalizeSearchText(unit.canonical), unit.canonical)
  for (const alias of unit.aliases) UNIT_BY_ALIAS.set(normalizeSearchText(alias), unit.canonical)
}

const VENDOR_TERMS = uniqueText(FULL_KITTING_PRODUCT_VENDORS.flatMap(item => {
  const normalized = normalizeSearchText(item.vendor)
  const [first] = normalized.split(' ')
  return [normalized, first]
}).filter(Boolean))

const PRODUCT_VENDORS_BY_NORMALIZED_PRODUCT = new Map<string, Set<string>>()
for (const item of FULL_KITTING_PRODUCT_VENDORS) {
  const normalizedProduct = normalizeSearchText(item.product)
  const vendors = PRODUCT_VENDORS_BY_NORMALIZED_PRODUCT.get(normalizedProduct) ?? new Set<string>()
  vendors.add(normalizeSearchText(item.vendor))
  PRODUCT_VENDORS_BY_NORMALIZED_PRODUCT.set(normalizedProduct, vendors)
}

export function normalizeFullKittingUnitToken(value: string): string | null {
  return UNIT_BY_ALIAS.get(normalizeSearchText(value)) ?? null
}

export function fullKittingVendorTermsForQuery(query: string): string[] {
  const normalizedQuery = normalizeSearchText(query)
  const queryTokens = new Set(tokenize(normalizedQuery))
  const terms = new Set<string>()

  for (const vendor of VENDOR_TERMS) {
    if (vendor && tokenPhraseInText(normalizedQuery, vendor)) terms.add(vendor)
  }

  for (const [product, vendors] of PRODUCT_VENDORS_BY_NORMALIZED_PRODUCT) {
    if (vendors.size !== 1) continue
    if (!productMatchesQuery(product, queryTokens, normalizedQuery)) continue
    for (const vendor of vendors) terms.add(vendor)
  }

  return uniqueText([...terms])
}

function productMatchesQuery(product: string, queryTokens: Set<string>, normalizedQuery: string) {
  if (tokenPhraseInText(normalizedQuery, product)) return true
  const productTokens = meaningfulProductTokens(product)
  if (productTokens.length < 2) return false
  const matched = productTokens.filter(token => queryTokens.has(token))
  return matched.length >= 2 && matched.length / productTokens.length >= 0.7
}

function meaningfulProductTokens(product: string) {
  const stop = new Set(['with', 'of', 'for', 'type'])
  return tokenize(product).filter(token => !stop.has(token))
}

function tokenPhraseInText(normalizedText: string, normalizedPhrase: string) {
  const phraseTokens = normalizedPhrase.split(' ').filter(Boolean)
  if (!phraseTokens.length) return false
  const textTokens = normalizedText.split(' ').filter(Boolean)
  for (let index = 0; index <= textTokens.length - phraseTokens.length; index++) {
    if (phraseTokens.every((token, offset) => textTokens[index + offset] === token)) return true
  }
  return false
}
