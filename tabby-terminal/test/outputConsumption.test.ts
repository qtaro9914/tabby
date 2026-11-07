import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BaseSession } from '../src/session.ts'
import { TerminalWriteCompletion } from '../src/frontends/writeCompletion.ts'

class Session extends BaseSession {
    constructor () { super({ warn () {}, debug () {}, info () {} } as any) }
    async start (): Promise<void> { }
    resize (): void { }
    write (): void { }
    kill (): void { }
    async gracefullyKillProcess (): Promise<void> { }
    supportsWorkingDirectory (): boolean { return false }
    async getWorkingDirectory (): Promise<string|null> { return null }
    emit (data: string): Promise<void> { return this.emitOutput(Buffer.from(data)) }
}

describe('producer output consumption', () => {
    it('waits for every split output from one input and grants one completion', async () => {
        const session = new Session()
        session.releaseInitialDataBuffer()
        const callbacks: Array<() => void> = []
        const outputs: string[] = []
        session.output$.subscribe(data => {
            outputs.push(data)
            session.trackOutputConsumption(new Promise(resolve => callbacks.push(resolve)))
        })
        let finished = false
        const done = session.emit('before\x1b]0;title\x07after').then(() => { finished = true })
        assert.deepEqual(outputs, ['before', '\x1b]0;title\x07', 'after'])
        callbacks[0]()
        await Promise.resolve()
        assert.equal(finished, false)
        callbacks[1]()
        await Promise.resolve()
        assert.equal(finished, false)
        callbacks[2]()
        await done
        assert.equal(finished, true)
        await session.destroy()
    })
    it('consumed/partial OSC input completes without waiting for another packet', async () => {
        const session = new Session()
        session.releaseInitialDataBuffer()
        await session.emit('\x1b]0;partial')
        await session.emit(' title\x07')
        await session.emit('\x1b]1337;CurrentDir=/tmp\x07')
        assert.equal(await session.getWorkingDirectory(), null)
        await session.destroy()
    })
    it('does not wait for a frontend before initial output is released', async () => {
        const session = new Session()
        await session.emit('buffered')
        const received: string[] = []
        session.output$.subscribe(x => received.push(x))
        session.releaseInitialDataBuffer()
        assert.deepEqual(received, ['buffered'])
        await session.destroy()
    })
})

describe('xterm write completion', () => {
    it('resolves after the parser callback and cancels pending work on disposal', async () => {
        let complete = () => {}
        const queue = new TerminalWriteCompletion({ write: (_data, callback) => { complete = callback } })
        let done = false
        const first = queue.write('first').then(() => { done = true })
        await Promise.resolve()
        assert.equal(done, false)
        complete()
        await first
        const second = queue.write('second')
        queue.dispose()
        complete()
        assert.equal(await second, false)
        assert.equal(await queue.write('late'), false)
    })
    it('releases failed/empty writes without retaining pending callbacks', async () => {
        const queue = new TerminalWriteCompletion({ write: () => { throw new Error('failed') } })
        await queue.write('')
        await assert.rejects(queue.write('bad'), /failed/)
        queue.dispose()
    })
})
