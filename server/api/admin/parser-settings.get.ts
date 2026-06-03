import { getParserSettings } from '../../utils/parserSettings'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const settings = await getParserSettings(client, user.id)

  return settings
})
