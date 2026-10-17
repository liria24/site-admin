import { storage } from 'void/storage'
import type { R2BindingOptions } from 'files-sdk/r2'

// Void and Files SDK declare Cloudflare bindings through different ambient type packages.
export const voidFilesStorage = {
    adapter: 'r2' as const,
    config: (): R2BindingOptions => ({
        binding: new Proxy(storage, {
            get(target, key) {
                if (key === 'put' && !('FixedLengthStream' in globalThis))
                    return async (...args: Parameters<typeof storage.put>) => {
                        // Node's local R2 bridge cannot transmit a stream with a known length.
                        if (args[1] instanceof ReadableStream) args[1] = await new Response(args[1]).arrayBuffer()
                        return target.put(...args)
                    }
                return Reflect.get(target, key)
            },
        }) as unknown as R2BindingOptions['binding'],
    }),
}
