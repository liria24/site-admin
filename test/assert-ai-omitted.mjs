import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Inspect actual bundled/traced Node or Worker output; externalized size probes are insufficient. */
export async function assertAiOmitted(fixture) {
    let bytes = 0
    for (const name of await readdir(join(fixture, '.output'), { recursive: true })) {
        const normalized = name.replaceAll('\\', '/')
        if (/(?:^|\/)node_modules\/(?:ai\/|@ai-sdk\/)/u.test(normalized))
            throw new Error('Unused AI package traced into output: ' + name)
        if (!/\.(?:mjs|js|json)$/u.test(name)) continue
        if (!(await stat(join(fixture, '.output', name))).isFile()) continue
        const source = await readFile(join(fixture, '.output', name), 'utf8')
        bytes += Buffer.byteLength(source)
        if (source.includes('AI_NoOutputGeneratedError') || source.includes('AI_APICallError'))
            throw new Error('Unused AI SDK/provider implementation bundled: ' + name)
    }
    const runtime = await readFile(join(fixture, '.nuxt/site-admin/runtime.mjs'), 'utf8')
    const client = await readFile(join(fixture, '.nuxt/site-admin/client.ts'), 'utf8')
    if (
        runtime.includes('@liria24/site-admin/ai') ||
        runtime.includes('runAiAction:') ||
        client.includes('useAiAction')
    )
        throw new Error('Unused AI capability was generated.')
    const handlers = await readFile(join(fixture, '.nuxt/nitro.json'), 'utf8').catch(() => '')
    if (handlers.includes('ai-action-handler')) throw new Error('Unused AI handler was registered.')
    console.log(`Verified unused AI omission across ${bytes} bytes of actual output: ${fixture}`)
}
