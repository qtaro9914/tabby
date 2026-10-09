import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BaseSession } from '../src/session.ts'

const MB = 1024 * 1024
const logger = { debug () {}, info () {}, warn () {}, error () {}, log () {} } as any

class TestSession extends BaseSession {
    constructor () { super(logger) }
    async start (): Promise<void> { }
    resize (): void { }
    write (): void { }
    kill (): void { }
    async gracefullyKillProcess (): Promise<void> { }
    supportsWorkingDirectory (): boolean { return false }
    async getWorkingDirectory (): Promise<string|null> { return null }
    emit (data: Buffer): void { this.emitOutput(data) }
}

function capture (session: TestSession): Buffer[] {
    const out: Buffer[] = []
    session.binaryOutput$.subscribe(data => out.push(data))
    return out
}

/** A 64 KB chunk whose content says which chunk it is */
function numberedChunk (i: number): Buffer {
    return Buffer.alloc(64 * 1024, `chunk ${String(i).padStart(4, '0')}\n`)
}

describe('BaseSession output before the terminal is shown', () => {
    it('passes a normal amount of output through unchanged', () => {
        const session = new TestSession()
        const out = capture(session)
        session.emit(Buffer.from('hello '))
        session.emit(Buffer.from('world\r\n'))
        session.releaseInitialDataBuffer()
        assert.equal(Buffer.concat(out).toString(), 'hello world\r\n')
    })

    it('keeps only the newest 8 MB for a tab that is never shown', () => {
        const session = new TestSession()
        const out = capture(session)
        for (let i = 0; i < 320; i++) {   // 20 MB
            session.emit(numberedChunk(i))
        }
        session.releaseInitialDataBuffer()
        const released = Buffer.concat(out).toString()
        const marker = '\x1b[0m[... earlier output dropped ...]\r\n'
        assert.ok(released.startsWith(marker), 'dropped output is not marked')
        const body = released.slice(marker.length)
        assert.equal(body.length, 8 * MB)
        // the newest 128 chunks (192..319), in order
        assert.equal(body.slice(0, 64 * 1024), numberedChunk(192).toString(), 'the newest output is not what was kept')
        assert.equal(body.slice(-64 * 1024), numberedChunk(319).toString())
    })

    it('keeps only the tail of a single chunk over the limit', () => {
        const session = new TestSession()
        const out = capture(session)
        const chunk = Buffer.alloc(16 * MB)
        for (let i = 0; i < chunk.length; i += 4) {
            chunk.writeUInt32BE(i, i)
        }
        session.emit(chunk)
        assert.ok((session as any).initialDataBufferLength <= 8 * MB, 'the oversized chunk is retained')
        assert.ok((session as any).initialDataBuffer[0].buffer.byteLength <= 8 * MB, 'the tail still references the oversized chunk')
        session.releaseInitialDataBuffer()
        const released = Buffer.concat(out)
        const marker = Buffer.from('\x1b[0m[... earlier output dropped ...]\r\n')
        assert.ok(released.subarray(0, marker.length).equals(marker), 'dropped output is not marked')
        assert.ok(released.subarray(marker.length).equals(chunk.subarray(-8 * MB)), 'the kept output is not the newest 8 MB')
    })

    it('does not split a UTF-8 character when cutting a single oversized chunk', () => {
        const session = new TestSession()
        const out = capture(session)
        // 3-byte characters, with a 1-byte prefix so the 8 MB cut lands inside one
        const text = 'x' + '€'.repeat(Math.ceil(16 * MB / 3))
        const chunk = Buffer.from(text)
        assert.notEqual((chunk.length - 8 * MB) % 3, 1, 'the cut must not fall on a character boundary')
        session.emit(chunk)
        session.releaseInitialDataBuffer()
        const marker = '\x1b[0m[... earlier output dropped ...]\r\n'
        const released = Buffer.concat(out).toString()
        const body = released.slice(marker.length)
        assert.ok(!body.includes('\ufffd'), 'a character was split')
        assert.ok(/^€+$/.test(body))
        assert.ok(Buffer.byteLength(body) <= 8 * MB)
        assert.ok(Buffer.byteLength(body) > 8 * MB - 3)
    })

    it('buffers in linear time', () => {
        // Buffer.concat on every chunk re-copies the whole backlog each time (quadratic).
        // Count the bytes Buffer.concat copies while 16 MB arrive.
        const session = new TestSession()
        const chunk = Buffer.alloc(64 * 1024, 'x')
        const realConcat = Buffer.concat
        let copied = 0
        Buffer.concat = ((list: readonly Uint8Array[], length?: number) => {
            const result = realConcat(list, length)
            copied += result.length
            return result
        }) as typeof Buffer.concat
        try {
            for (let i = 0; i < 256; i++) {
                session.emit(chunk)
            }
        } finally {
            Buffer.concat = realConcat
        }
        assert.ok(copied <= 2 * 16 * MB, `copied ${Math.round(copied / MB)} MB to buffer 16 MB`)
    })

    it('releases the buffer only once', () => {
        const session = new TestSession()
        const out = capture(session)
        session.emit(Buffer.from('once'))
        session.releaseInitialDataBuffer()
        session.releaseInitialDataBuffer()
        assert.equal(out.length, 1)
    })
})
