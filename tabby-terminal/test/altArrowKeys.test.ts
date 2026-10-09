import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleAltArrowWordJump } from '../src/frontends/altArrowKeys.ts'

function fakeEvent (init: Partial<KeyboardEvent>): KeyboardEvent & { calls: string[] } {
    const calls: string[] = []
    return {
        type: 'keydown', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, key: '',
        ...init,
        calls,
        preventDefault: () => calls.push('preventDefault'),
        stopPropagation: () => calls.push('stopPropagation'),
    } as any
}

describe('handleAltArrowWordJump', () => {
    for (const [key, macOS, expected] of [
        ['ArrowLeft', false, '\x1b[1;5D'],
        ['ArrowRight', false, '\x1b[1;5C'],
        ['ArrowLeft', true, '\x1bb'],
        ['ArrowRight', true, '\x1bf'],
    ] as const) {
        it(`sends ${JSON.stringify(expected)} for Alt+${key}${macOS ? ' on macOS' : ''} and cancels the event`, () => {
            const event = fakeEvent({ altKey: true, key })
            const sent: string[] = []
            assert.equal(handleAltArrowWordJump(event, macOS, s => sent.push(s)), true)
            assert.deepEqual(sent, [expected])
            // without these the browser also runs its default action (history back)
            assert.deepEqual(event.calls.sort(), ['preventDefault', 'stopPropagation'])
        })
    }

    it('leaves other keys and modifier combinations alone', () => {
        for (const init of [
            { key: 'ArrowLeft' },
            { altKey: true, key: 'ArrowUp' },
            { altKey: true, ctrlKey: true, key: 'ArrowLeft' },
            { altKey: true, shiftKey: true, key: 'ArrowRight' },
            { altKey: true, metaKey: true, key: 'ArrowRight' },
            { altKey: true, key: 'ArrowLeft', type: 'keyup' },
            { altKey: true, key: 'ArrowLeft', type: 'keypress' },
        ]) {
            const event = fakeEvent(init)
            const sent: string[] = []
            assert.equal(handleAltArrowWordJump(event, false, s => sent.push(s)), false, JSON.stringify(init))
            assert.deepEqual(sent, [])
            assert.deepEqual(event.calls, [])
        }
    })
})
