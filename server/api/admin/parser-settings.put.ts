import { z } from 'zod'
import { isParserMode, isSarvamLanguage, setParserSettings } from '../../utils/parserSettings'

const Body = z.object({
  parser_mode: z.string().refine(isParserMode, 'Invalid parser mode'),
  sarvam_language: z.string().refine(isSarvamLanguage, 'Invalid Sarvam language').optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const body = Body.parse(await readBody(event))
  const settings = await setParserSettings(client, user.id, body)

  return settings
})
