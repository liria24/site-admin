export default {
    ignorePatterns: ['packages/site-admin/dist/**'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
        'no-console': 'off',
        'typescript/no-explicit-any': 'error',
    },
}
