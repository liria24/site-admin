import { defineServerAuth } from '@nuxtjs/better-auth/config'

export default defineServerAuth({
    emailAndPassword: { enabled: true },
    // Isolation checks must query the selected database instead of accepting a signed cookie cache.
    session: { cookieCache: { enabled: false } },
})
