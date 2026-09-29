import { defineConfig } from 'oxlint'

export default defineConfig({
    ignorePatterns: ['**/dist/**', '**/.nuxt/**', '**/.output/**', '**/.data/**', '**/.wrangler/**', '**/.tmp/**'],
    options: { typeAware: true },
    plugins: ['import', 'typescript'],
    categories: { correctness: 'error', suspicious: 'error' },
    rules: {
        // Keep typed lint focused on promise handling; generic API/style changes are separate work.
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/no-unnecessary-type-assertion': 'off',
        'typescript/no-unnecessary-type-parameters': 'off',
        'typescript/no-unnecessary-type-arguments': 'off',
        'typescript/no-unnecessary-type-conversion': 'off',
        'typescript/no-unnecessary-boolean-literal-compare': 'off',
        'typescript/no-redundant-type-constituents': 'off',
        'typescript/no-base-to-string': 'off',
        'typescript/consistent-return': 'off',
        'no-console': 'off',
        'typescript/no-explicit-any': 'error',
        'typescript/no-floating-promises': 'error',
        'import/no-cycle': 'error',
    },
    overrides: [
        {
            files: ['test/**/*.ts'],
            rules: { 'typescript/no-implied-eval': 'off', 'import/no-empty-named-blocks': 'off' },
        },
    ],
})
