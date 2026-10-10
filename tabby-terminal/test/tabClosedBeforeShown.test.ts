import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Subject, config, first, take, type Observable } from 'rxjs'
import { Frontend } from '../src/frontends/frontend.ts'

// The abstract members aren't needed to exercise the lifecycle subjects
const TestFrontend = class extends (Frontend as any) { } as unknown as new (injector: any) => Frontend

/**
 * Reproduces what BaseTerminalTabComponent does with a tab that is closed
 * before it was ever shown (e.g. a restored background tab): it waits for the
 * frontend's first resize, its own first focus and - for connectable tabs -
 * the first key press, and destroy() then completes all of them without a
 * value (frontend.destroy() before BaseTabComponent.destroy()).
 */
async function closeNeverShownTab (once: <T>(source: Observable<T>) => Observable<T>): Promise<string[]> {
    const frontend = new TestFrontend({})
    const focused = new Subject<void>()
    const called: string[] = []
    once(frontend.resize$).subscribe(() => called.push('resize'))
    once(focused).subscribe(() => called.push('focused'))
    once(frontend.input$).subscribe(() => called.push('input'))
    frontend.destroy()
    focused.complete()
    // rxjs reports errors nobody subscribed for from a timeout
    await new Promise(resolve => setTimeout(resolve, 10))
    return called
}

describe('closing a terminal tab that was never shown', () => {
    let unhandled: unknown[] = []
    const previousHandler = config.onUnhandledError

    beforeEach(() => {
        unhandled = []
        config.onUnhandledError = error => unhandled.push(error)
    })

    afterEach(() => {
        config.onUnhandledError = previousHandler
    })

    it('reports no unhandled error when waiting with take(1)', async () => {
        const called = await closeNeverShownTab(source => source.pipe(take(1)))
        assert.deepEqual(called, [])
        assert.deepEqual(unhandled, [])
    })

    it('would report an EmptyError per subscription with first()', async () => {
        // why take(1): these surfaced as "ERROR EmptyErrorImpl" in the console
        await closeNeverShownTab(source => source.pipe(first()))
        assert.equal(unhandled.length, 3)
        for (const error of unhandled) {
            assert.equal((error as Error).name, 'EmptyError')
        }
    })

    it('is how the tab components wait for those first values', () => {
        for (const file of ['baseTerminalTab.component.ts', 'connectableTerminalTab.component.ts']) {
            const source = readFileSync(new URL(`../src/api/${file}`, import.meta.url), 'utf8')
            assert.doesNotMatch(source, /(resize|focused|input)\$\.pipe\(first\(\)\)/, `${file} waits with first() again`)
        }
        const base = readFileSync(new URL('../src/api/baseTerminalTab.component.ts', import.meta.url), 'utf8')
        assert.match(base, /resize\$\.pipe\(take\(1\)\)/)
        assert.match(base, /focused\$\.pipe\(take\(1\)\)/)
    })
})
