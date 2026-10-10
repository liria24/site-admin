import { defineServerAuth } from '@nuxtjs/better-auth/config'
import { admin } from 'better-auth/plugins'

export default defineServerAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin({ schema: { user: { fields: { role: 'accessRole' } } } })],
    // Isolation checks must query the selected database instead of accepting a signed cookie cache.
    session: { cookieCache: { enabled: false } },
})
