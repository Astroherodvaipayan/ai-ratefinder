import { z } from 'zod'
import { isParserMode, setParserMode } from '../../utils/parserSettings'

const Body = z.object({
  parser_mode: z.string().refine(isParserMode, 'Invalid parser mode')
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const body = Body.parse(await readBody(event))
  const parser_mode = await setParserMode(client, user.id, body.parser_mode)

  return { parser_mode }
})
