import { boolean, defineSiteAdminConfig, model } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    models: {
        settings: model({ fields: { enabled: boolean() }, publishing: false }),
    },
})
