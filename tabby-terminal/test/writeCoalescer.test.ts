import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WriteCoalescer } from '../src/frontends/writeCoalescer.ts'

const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve() } }

function controlledSink () {
    const writes: string[] = []
    const pending: Array<{ resolve: () => void, reject: (e: Error) => void }> = []
    const sink = (data: string) => new Promise<void>((resolve, reject) => {
        writes.push(data)
        pending.push({ resolve, reject })
    })
    return { writes, pending, sink }
}

describe('WriteCoalescer', () => {
    it('writes an idle chunk alone and merges chunks queued behind it', async () => {
        const { writes, pending, sink } = controlledSink()
        const queue = new WriteCoalescer(sink)
        const settled: string[] = []
        const a = queue.write('a').then(() => settled.push('a'))
        await flush()
        assert.deepEqual(writes, ['a'])

        const b = queue.write('b').then(() => settled.push('b'))
        const c = queue.write('c').then(() => settled.push('c'))
        await flush()
        assert.deepEqual(writes, ['a'], 'queued chunks wait for the in-flight write')

        pending[0].resolve()
        await a
        await flush()
        assert.deepEqual(writes, ['a', 'bc'])
        assert.deepEqual(settled, ['a'], 'merged callers wait for their own batch')

        pending[1].resolve()
        await Promise.all([b, c])
        assert.deepEqual(settled, ['a', 'b', 'c'])
    })

    it('starts a new batch for chunks that arrive while a batch is written', async () => {
        const { writes, pending, sink } = controlledSink()
        const queue = new WriteCoalescer(sink)
        void queue.write('1')
        await flush()
        void queue.write('2')
        pending[0].resolve()
        await flush()
        assert.deepEqual(writes, ['1', '2'])
        void queue.write('3')
        void queue.write('4')
        await flush()
        assert.deepEqual(writes, ['1', '2'])
        pending[1].resolve()
        await flush()
        assert.deepEqual(writes, ['1', '2', '34'])
        pending[2].resolve()
    })

    it('rejects only the failed batch and keeps writing later ones', async () => {
        const { writes, pending, sink } = controlledSink()
        const errors: unknown[] = []
        const queue = new WriteCoalescer(sink, e => errors.push(e))
        const bad = queue.write('x')
        await flush()
        const next = queue.write('y')
        pending[0].reject(new Error('boom'))
        await assert.rejects(bad, /boom/)
        await flush()
        assert.equal(errors.length, 1)
        assert.deepEqual(writes, ['x', 'y'])
        pending[1].resolve()
        await next
    })
})
