import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampWheelReports, repeatWheelReports, scrollToBottomIfNeeded } from '../src/frontends/scrolling.ts'

const WHEEL = 4
const LEFT = 0

// Mirrors xterm: the mouse service encodes the report, rewrites the event and
// hands the bytes to the core service (SGR as data, DEFAULT encoding as binary)
function fakeXterm ({ accept = true, binary = false } = {}) {
    const received: any[] = []
    const writes: [string, string, boolean?][] = []
    const input = {
        triggerDataEvent: (data: string, wasUserInput?: boolean): void => { writes.push(['data', data, wasUserInput]) },
        triggerBinaryEvent: (data: string): void => { writes.push(['binary', data]) },
    }
    const service = {
        triggerMouseEvent (event: any): boolean {
            received.push({ ...event })
            if (!accept) {
                return false
            }
            event.col++
            event.row++
            const report = `<${event.button === WHEEL ? 64 + event.action : event.button};${event.col};${event.row}M`
            if (binary) {
                input.triggerBinaryEvent(report)
            } else {
                input.triggerDataEvent(report, true)
            }
            return true
        },
    }
    return { service, input, received, writes }
}

describe('repeatWheelReports', () => {
    it('sends each wheel report the configured number of times with the same coordinates', () => {
        const { service, input, received } = fakeXterm()
        repeatWheelReports(service, input, () => 3)
        assert.equal(service.triggerMouseEvent({ button: WHEEL, action: 1, col: 4, row: 7 } as any), true)
        assert.deepEqual(received, Array(3).fill({ button: WHEEL, action: 1, col: 4, row: 7 }))
    })

    it('sends the repeated reports as one user-input write so the app reads them together', () => {
        const { service, input, writes } = fakeXterm()
        repeatWheelReports(service, input, () => 3)
        service.triggerMouseEvent({ button: WHEEL, action: 1, col: 4, row: 7 } as any)
        assert.deepEqual(writes, [['data', '<65;5;8M<65;5;8M<65;5;8M', true]])
    })

    it('batches DEFAULT-encoded (binary) reports too', () => {
        const { service, input, writes } = fakeXterm({ binary: true })
        repeatWheelReports(service, input, () => 2)
        service.triggerMouseEvent({ button: WHEEL, action: 0, col: 0, row: 0 } as any)
        assert.deepEqual(writes, [['binary', '<64;1;1M<64;1;1M']])
    })

    it('restores the input service afterwards, even when encoding throws', () => {
        const { service, input, writes } = fakeXterm()
        const { triggerDataEvent, triggerBinaryEvent } = input
        let fail = false
        const encode = service.triggerMouseEvent.bind(service)
        service.triggerMouseEvent = (e: any) => { if (fail) { throw new Error('boom') } return encode(e) }
        repeatWheelReports(service, input, () => 3)
        fail = true
        assert.throws(() => service.triggerMouseEvent({ button: WHEEL, action: 0, col: 0, row: 0 } as any))
        assert.equal(input.triggerDataEvent, triggerDataEvent)
        assert.equal(input.triggerBinaryEvent, triggerBinaryEvent)
        assert.deepEqual(writes, [])
    })

    it('passes everything else straight through', () => {
        const { service, input, received, writes } = fakeXterm()
        repeatWheelReports(service, input, () => 3)
        service.triggerMouseEvent({ button: LEFT, action: 1, col: 0, row: 0 } as any)
        assert.equal(received.length, 1)
        assert.deepEqual(writes, [['data', '<0;1;1M', true]])
    })

    it('keeps one report per event at the default of 1', () => {
        const { service, input, writes } = fakeXterm()
        repeatWheelReports(service, input, () => 1)
        service.triggerMouseEvent({ button: WHEEL, action: 1, col: 0, row: 0 } as any)
        assert.deepEqual(writes, [['data', '<65;1;1M', true]])
    })

    it('does not repeat a report xterm refused (protocol does not take wheel events)', () => {
        const { service, input, received, writes } = fakeXterm({ accept: false })
        repeatWheelReports(service, input, () => 3)
        assert.equal(service.triggerMouseEvent({ button: WHEEL, action: 0, col: 0, row: 0 } as any), false)
        assert.equal(received.length, 1)
        assert.deepEqual(writes, [])
    })

    it('reads the count on every event, so a config change applies right away', () => {
        const { service, input, received } = fakeXterm()
        let count = 1
        repeatWheelReports(service, input, () => count)
        service.triggerMouseEvent({ button: WHEEL, action: 0, col: 0, row: 0 } as any)
        count = 2
        service.triggerMouseEvent({ button: WHEEL, action: 0, col: 0, row: 0 } as any)
        assert.equal(received.length, 3)
    })
})

describe('clampWheelReports', () => {
    for (const [input, expected] of [
        [1, 1], [3, 3], [2.6, 3], [0, 1], [-5, 1], [999, 10], ['4', 4], [undefined, 1], [null, 1], ['', 1], [NaN, 1],
    ] as const) {
        it(`${JSON.stringify(input)} -> ${expected}`, () => {
            assert.equal(clampWheelReports(input), expected)
        })
    }
})

describe('scrollToBottomIfNeeded', () => {
    it('skips the repaint-everything scroll when already at the bottom', () => {
        const core = { buffer: { ydisp: 100, ybase: 100 }, scrollToBottom: () => null }
        let calls = 0
        scrollToBottomIfNeeded(core, () => calls++)()
        assert.equal(calls, 0)
    })

    it('scrolls when the viewport is above the bottom', () => {
        const core = { buffer: { ydisp: 40, ybase: 100 }, scrollToBottom: () => null }
        let calls = 0
        scrollToBottomIfNeeded(core, () => calls++)()
        assert.equal(calls, 1)
    })

    it('reads the buffer at call time (the buffer object is swapped on alt-screen switch)', () => {
        const core = { buffer: { ydisp: 0, ybase: 0 }, scrollToBottom: () => null }
        let calls = 0
        const scroll = scrollToBottomIfNeeded(core, () => calls++)
        core.buffer = { ydisp: 10, ybase: 20 }
        scroll()
        assert.equal(calls, 1)
    })
})
