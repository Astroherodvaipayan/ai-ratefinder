import { getParserMode } from '../../utils/parserSettings'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const parser_mode = await getParserMode(client, user.id)

  return { parser_mode }
})
