import { expect, it, vi } from 'vitest'
import { withRuntimeEnv } from 'void/_env'
import { voidFilesStorage } from '../packages/site-admin/src/runtime/files'

it('buffers local R2 uploads while retaining native Worker streams and request bindings', async () => {
    const binding = voidFilesStorage.config().binding as unknown as {
        put(key: string, body: ReadableStream): Promise<unknown>
    }
    const first = { put: vi.fn(async (_key: string, _body: unknown) => null) }
    const second = { put: vi.fn(async (_key: string, _body: unknown) => null) }
    const body = () => new Blob(['image']).stream()
    await withRuntimeEnv({ STORAGE: first }, () => binding.put('first', body()))
    expect(new TextDecoder().decode(first.put.mock.calls[0]![1] as ArrayBuffer)).toBe('image')
    vi.stubGlobal('FixedLengthStream', vi.fn())
    try {
        const stream = body()
        await withRuntimeEnv({ STORAGE: second }, () => binding.put('second', stream))
        expect(second.put).toHaveBeenCalledWith('second', stream)
        expect(first.put).toHaveBeenCalledTimes(1)
    } finally {
        vi.unstubAllGlobals()
    }
})
