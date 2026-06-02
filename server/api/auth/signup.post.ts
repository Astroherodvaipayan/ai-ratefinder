import { z } from 'zod'

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8)
})

export default defineEventHandler(async (event) => {
  const parsed = SignupBody.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Enter a valid email and an 8+ character password.'
    })
  }

  const { email, password } = parsed.data
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true
  })

  if (error) {
    const message = error.message.toLowerCase()
    if (message.includes('already') || message.includes('registered')) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Account already exists. Sign in instead.'
      })
    }

    throw createError({ statusCode: 400, statusMessage: error.message })
  }

  return {
    id: data.user?.id,
    email: data.user?.email
  }
})
