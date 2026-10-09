import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vite-plus/test'

const cleanup = new URL('./public-data-consumer.mjs', import.meta.url).href

const probe = (persistent: boolean) => {
    // A fresh process lets native rm capture the controlled rmdir before its first call.
    const result = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const directory = await mkdtemp(join(tmpdir(), 'site-admin-public-data-cleanup-'))
const profile = join(directory, 'chromium-profile', 'Default')
await mkdir(profile, { recursive: true })
const target = ${persistent} ? directory : profile
const original = fs.rmdir
const failure = Object.assign(new Error('Controlled profile shutdown race'), { code: 'ENOTEMPTY' })
let calls = 0
let inject = true
fs.rmdir = (path, ...args) => {
  if (inject && String(path) === target) {
    calls++
    if (${persistent} || calls <= 2) {
      queueMicrotask(() => args.at(-1)(failure))
      return
    }
  }
  return original(path, ...args)
}
try {
  const { removePublicDataConsumer } = await import(${JSON.stringify(cleanup)})
  if (${persistent}) {
    await assert.rejects(removePublicDataConsumer(directory), error => error === failure)
    assert.ok(calls >= 6 && calls <= 12, 'Native retries must exhaust within the configured bound.')
    assert.ok((await stat(directory)).isDirectory())
  } else {
    await removePublicDataConsumer(directory)
    assert.ok(calls >= 3 && calls <= 4, 'The transient error must be retried successfully.')
    await assert.rejects(stat(directory), { code: 'ENOENT' })
  }
} finally {
  inject = false
  fs.rmdir = original
  await rm(directory, { recursive: true, force: true })
}
`,
        ],
        { encoding: 'utf8', timeout: 5_000 },
    )
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
}

describe('public data consumer profile cleanup', () => {
    it('retries a transient ENOTEMPTY and removes the owned fixture', () => probe(false))
    it('propagates persistent ENOTEMPTY after the bounded native retries', () => probe(true))
})

it('reports bounded startup output, process state and the port-file failure without launching Chrome', () => {
    const result = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
const directory = await mkdtemp(join(tmpdir(), 'site-admin-chromium-startup-'))
await mkdir(join(directory, 'chromium-profile', 'Default'), { recursive: true })
process.env.CHROMIUM_PATH = process.execPath
childProcess.spawn = () => {
  const browser = Object.assign(new EventEmitter(), {
    pid: process.pid, exitCode: 17, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
  })
  queueMicrotask(() => {
    browser.stdout.write('discarded-output-prefix' + '.'.repeat(20_000) + 'synthetic stdout')
    browser.stderr.write('discarded-error-prefix' + '.'.repeat(20_000) + 'synthetic stderr')
  })
  return browser
}
syncBuiltinESMExports()
try {
  const { chromiumProbe } = await import(${JSON.stringify(cleanup)})
  await assert.rejects(chromiumProbe('http://127.0.0.1:1', directory), error => {
    assert.ok(error.message.includes('Chromium exited before its debugging endpoint started'))
    assert.ok(error.message.includes('"exit":17'))
    assert.ok(error.message.includes('"version":{"output":"v') && error.message.includes('"elapsedMs":'))
    assert.ok(error.message.includes('"portState":{"error":"ENOENT"}'))
    assert.ok(error.message.includes('"profileEntries":["Default"]'))
    assert.ok(error.message.includes('synthetic stdout') && error.message.includes('synthetic stderr'))
    assert.ok(!error.message.includes('discarded-output-prefix') && !error.message.includes('discarded-error-prefix'))
    assert.ok(error.message.length < 35_000)
    return true
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
`,
        ],
        { encoding: 'utf8', timeout: 5_000 },
    )
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
})
