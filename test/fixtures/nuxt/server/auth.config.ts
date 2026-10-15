import { defineServerAuth } from '@nuxtjs/better-auth/config'
import { admin } from 'better-auth/plugins'

export default defineServerAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin({ schema: { user: { fields: { role: 'accessRole' } } } })],
    session: { cookieCache: { enabled: true, maxAge: 300, strategy: 'jwe' } },
})
