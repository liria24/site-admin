import { defineWranglerConfig } from 'wrangler/experimental-config'

export default defineWranglerConfig({
    alias: {
        '@aws-sdk/client-s3': './unused-aws.ts',
        '@aws-sdk/lib-storage': './unused-aws.ts',
        '@aws-sdk/s3-presigned-post': './unused-aws.ts',
        '@aws-sdk/s3-request-presigner': './unused-aws.ts',
    },
    types: {
        generate: false,
    },
})
