import manifest from '../package.json' with { type: 'json' }

// Keep consumer versions in the workspace manifest instead of maintaining another set of pins.
export const consumerDependencies = (names) =>
    Object.fromEntries(names.map((name) => [name, manifest.devDependencies[name]]))
