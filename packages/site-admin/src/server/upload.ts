import { createHash } from 'node:crypto'
import { SiteAdminError } from '../errors'
import type { UploadAssetInput } from './types'

/** Keep only the signature and one input chunk in flight. Storage controls read-ahead. */
export const prepareUpload = async (input: UploadAssetInput, maxSize?: number) => {
    let body = input.body
    if (typeof body === 'string') body = new TextEncoder().encode(body)
    const size = body instanceof Blob ? body.size : body instanceof ReadableStream ? input.size : body.byteLength
    if (!Number.isSafeInteger(size) || size! <= 0 || (input.size !== undefined && input.size !== size)) {
        if (body instanceof ReadableStream) await body.cancel().catch(() => {})
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Uploads require a positive, accurate byte size.')
    }
    if (maxSize !== undefined && size! > maxSize) {
        if (body instanceof ReadableStream) await body.cancel().catch(() => {})
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Upload exceeds the ${maxSize}-byte limit.`)
    }
    const source =
        body instanceof ReadableStream
            ? body
            : body instanceof Blob
              ? body.stream()
              : new Blob([body as BlobPart]).stream()
    const reader = source.getReader()
    const prefix = new Uint8Array(Math.min(12, size!))
    let pending: Uint8Array | undefined
    let offset = 0
    try {
        while (offset < prefix.length) {
            const { done, value } = await reader.read()
            if (done) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Upload ended before its declared size.')
            const count = Math.min(value.byteLength, prefix.length - offset)
            prefix.set(value.subarray(0, count), offset)
            offset += count
            if (count < value.byteLength) pending = value.subarray(count)
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {})
        throw error
    }
    const hash = createHash('sha256')
    let total = 0
    let first = true
    let complete = false
    const stream = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    const chunk = first
                        ? { value: prefix, done: false }
                        : pending
                          ? { value: pending, done: false }
                          : await reader.read()
                    if (first) first = false
                    else pending = undefined
                    if (chunk.done) {
                        if (total !== size)
                            throw new SiteAdminError(
                                'SITE_ADMIN_INVALID_INPUT',
                                'Upload size does not match its declared size.',
                            )
                        complete = true
                        controller.close()
                        return
                    }
                    total += chunk.value!.byteLength
                    if (total > size!)
                        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Upload exceeds its declared size.')
                    hash.update(chunk.value!)
                    controller.enqueue(chunk.value!)
                } catch (error) {
                    controller.error(error)
                    await reader.cancel(error).catch(() => {})
                }
            },
            cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
    )
    return {
        cancel: (reason?: unknown) => reader.cancel(reason),
        checksum: () => {
            if (!complete) throw new Error('Storage did not consume the complete upload.')
            return hash.digest('hex')
        },
        prefix,
        size: size!,
        stream,
    }
}

export const safeFilename = (value: string): string => {
    const name =
        value
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/[^A-Za-z0-9._-]+/gu, '-') ?? 'file'
    return name.replace(/^[.-]+/u, '').slice(0, 120) || 'file'
}

export const detectedMime = (bytes: Uint8Array): string => {
    const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
    if (starts(0x52, 0x49, 0x46, 0x46) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
    if (
        new TextDecoder().decode(bytes.slice(4, 12)) === 'ftypavif' ||
        new TextDecoder().decode(bytes.slice(4, 12)) === 'ftypavis'
    )
        return 'image/avif'
    if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
    return 'application/octet-stream'
}
