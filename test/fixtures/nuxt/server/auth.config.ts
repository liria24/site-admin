import { defineServerAuth } from '@nuxtjs/better-auth/config'

export default defineServerAuth({
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true, maxAge: 300, strategy: 'jwe' } },
})
