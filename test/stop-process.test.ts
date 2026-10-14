import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vite-plus/test'
import { stopProcess } from './stop-process.ts'

test.skipIf(process.platform === 'win32')(
    'forced cleanup fails the test instead of reporting successful shutdown',
    async () => {
        const child = spawn(
            process.execPath,
            ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')"],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        try {
            await once(child.stdout, 'data')
            await expect(stopProcess(child)).rejects.toThrow('required SIGKILL')
            expect(child.signalCode).toBe('SIGKILL')
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }
    },
)
