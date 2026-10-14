import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'

export const stopProcess = async (child: ChildProcess | undefined) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    let forced = false
    const force = setTimeout(() => {
        forced = true
        child.kill('SIGKILL')
    }, 5_000)
    try {
        child.kill()
        await exited
        if (forced) throw new Error('Test process required SIGKILL after its shutdown deadline.')
    } finally {
        clearTimeout(force)
    }
}
