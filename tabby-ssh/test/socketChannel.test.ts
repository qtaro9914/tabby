import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { Subject } from 'rxjs'
import { forwardSocketChannel } from '../src/session/socketChannel.ts'

function createForward () {
    const written: Buffer[] = []
    const errors: string[] = []
    const channelWrites: string[] = []
    let closeRequests = 0
    let finishChannel: () => void = () => undefined
    const channelFinished = new Promise<void>(resolve => { finishChannel = resolve })
    const channel = {
        data$: new Subject<Uint8Array>(),
        eof$: new Subject<void>(),
        closed$: new Subject<void>(),
        async write (data: Uint8Array) {
            await new Promise<void>(resolve => setImmediate(resolve))
            channelWrites.push(Buffer.from(data).toString())
        },
        async eof () {
            channelWrites.push('EOF')
            finishChannel()
        },
        async close () { closeRequests++ },
    }
    const socket = new Duplex({
        allowHalfOpen: true,
        highWaterMark: 1,
        read () { /* This fixture only writes to the socket. */ },
        write (chunk, _encoding, callback) {
            setImmediate(() => {
                written.push(Buffer.from(chunk))
                callback()
            })
        },
    })
    const logger = {
        debug () { /* Debug messages are not checked here. */ },
        error (message: string) { errors.push(message) },
    }
    forwardSocketChannel(channel, socket as unknown as Socket, logger, 'test')
    return { channel, socket, written, errors, channelWrites, channelFinished, getCloseRequests: () => closeRequests }
}

test('flushes queued socket writes before remote EOF', async t => {
    const forward = createForward()
    t.after(() => forward.socket.destroy())
    const finished = once(forward.socket, 'finish')
    forward.channel.data$.next(Buffer.from('A'))
    forward.channel.data$.next(Buffer.from('B'))
    forward.channel.data$.next(Buffer.from('C'))
    forward.channel.eof$.next()
    await finished
    assert.equal(Buffer.concat(forward.written).toString(), 'ABC')
    assert.deepEqual(forward.errors, [])
})

test('flushes queued and buffered writes before remote channel close', async () => {
    const forward = createForward()
    const closed = once(forward.socket, 'close')
    forward.channel.data$.next(Buffer.from('A'))
    forward.channel.data$.next(Buffer.from('B'))
    forward.channel.closed$.next()
    await closed
    assert.equal(Buffer.concat(forward.written).toString(), 'AB')
    assert.equal(forward.socket.writableFinished, true)
    assert.deepEqual(forward.errors, [])
})

test('preserves queued writes when EOF is immediately followed by channel close', async () => {
    const forward = createForward()
    const closed = once(forward.socket, 'close')
    forward.channel.data$.next(Buffer.from('A'))
    forward.channel.data$.next(Buffer.from('B'))
    forward.channel.eof$.next()
    forward.channel.closed$.next()
    await closed
    assert.equal(Buffer.concat(forward.written).toString(), 'AB')
    assert.deepEqual(forward.errors, [])
})

test('closes a remote channel without EOF after the socket already finished', async () => {
    const forward = createForward()
    const finished = once(forward.socket, 'finish')
    forward.channel.data$.next(Buffer.from('A'))
    forward.channel.eof$.next()
    await finished
    const closed = once(forward.socket, 'close')
    forward.channel.closed$.next()
    await closed
    assert.equal(Buffer.concat(forward.written).toString(), 'A')
})

test('sends local EOF after queued channel writes', async t => {
    const forward = createForward()
    t.after(() => forward.socket.destroy())
    forward.socket.emit('data', Buffer.from('A'))
    forward.socket.emit('data', Buffer.from('B'))
    forward.socket.emit('end')
    await forward.channelFinished
    assert.deepEqual(forward.channelWrites, ['A', 'B', 'EOF'])
    assert.deepEqual(forward.errors, [])
})

test('bounds the pending socket queue and closes on overflow', async () => {
    const forward = createForward()
    const closed = once(forward.socket, 'close')
    forward.channel.data$.next(Buffer.from('A'))
    forward.channel.data$.next(Buffer.alloc(8 * 1024 * 1024 + 1))
    await closed
    assert.equal(forward.getCloseRequests(), 1)
    assert.equal(forward.errors.length, 1)
    assert.match(forward.errors[0], /socket write queue exceeded/)
})
