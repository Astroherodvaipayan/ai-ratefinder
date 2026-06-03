import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const logoCandidates = [
  join(process.cwd(), 'public/brand/rj-logo.png'),
  join(process.cwd(), '.output/public/brand/rj-logo.png'),
  join(process.cwd(), '../public/brand/rj-logo.png'),
  join(process.cwd(), '../../public/brand/rj-logo.png')
]

export function brandLogoBuffer(): Buffer | null {
  const logoPath = logoCandidates.find(path => existsSync(path))
  return logoPath ? readFileSync(logoPath) : null
}

export function brandLogoDataUrl(): string | null {
  const logo = brandLogoBuffer()
  return logo ? `data:image/png;base64,${logo.toString('base64')}` : null
}
