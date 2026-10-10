import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_WEBGL_RECOVERY_ATTEMPTS, WebGLRendererRecovery } from '../src/frontends/rendererRecovery.ts'

class FakeHost {
    webGLWorks = true
    canRecoverNow = true
    attachCalls = 0
    liveAddons = 0
    redraws = 0
    canvasAlive = true

    attachWebGL (): boolean {
        this.attachCalls++
        // like the frontend, dispose a stale addon before loading a new one
        this.liveAddons = 0
        this.canvasAlive = true
        if (!this.webGLWorks) {
            return false
        }
        this.liveAddons++
        return true
    }

    canRecover (): boolean { return this.canRecoverNow }
    webGLRendererAlive (): boolean { return this.liveAddons > 0 && this.canvasAlive }
    redraw (): void { this.redraws++ }

    /** The GPU dropped the context: the frontend disposes the addon and reports it */
    loseContext (recovery: WebGLRendererRecovery): void {
        this.liveAddons--
        recovery.contextLost()
    }
}

function setup (): { host: FakeHost, recovery: WebGLRendererRecovery } {
    const host = new FakeHost()
    return { host, recovery: new WebGLRendererRecovery(host) }
}

describe('WebGLRendererRecovery', () => {
    it('stays on the DOM renderer after a failed initial attach, even with a recovery requested before it', () => {
        // reactivate() before attach -> WebGL init fails -> window focus
        const { host, recovery } = setup()
        host.webGLWorks = false
        assert.equal(recovery.reactivate(), false, 'a recovery ran before the terminal was opened')
        recovery.init()
        assert.equal(recovery.fallenBackToDOM, true)
        assert.equal(recovery.recoveryPending, false)
        host.webGLWorks = true
        recovery.recover()   // window focus
        assert.equal(recovery.reactivate(), false)
        assert.equal(host.attachCalls, 1, 'WebGL was recreated after the permanent fallback')
        assert.equal(recovery.webGLActive, false)
    })

    it('doesn\'t attach twice when shown or focused while the terminal is still opening', () => {
        const { host, recovery } = setup()
        recovery.reactivate()
        recovery.recover()
        recovery.contextLost()
        recovery.recover()
        assert.equal(host.attachCalls, 0, 'attached before init()')
        recovery.init()
        recovery.init()
        recovery.reactivate()
        recovery.recover()
        assert.equal(host.attachCalls, 1)
        assert.equal(host.liveAddons, 1)
        assert.equal(recovery.webGLActive, true)
    })

    it('recreates a lost renderer up to the retry budget, then stays on the DOM renderer', () => {
        const { host, recovery } = setup()
        recovery.init()
        for (let i = 1; i <= MAX_WEBGL_RECOVERY_ATTEMPTS; i++) {
            host.loseContext(recovery)
            assert.equal(recovery.webGLActive, true, `loss #${i} was not recovered`)
            assert.equal(host.attachCalls, 1 + i)
        }
        host.loseContext(recovery)
        assert.equal(recovery.webGLActive, false)
        assert.equal(recovery.fallenBackToDOM, true)
        assert.equal(recovery.recoveryPending, false)
        recovery.recover()
        assert.equal(recovery.reactivate(), false)
        assert.equal(host.attachCalls, 1 + MAX_WEBGL_RECOVERY_ATTEMPTS)
        assert.equal(host.liveAddons, 0)
    })

    it('falls back for good when recreating the renderer fails', () => {
        const { host, recovery } = setup()
        recovery.init()
        host.webGLWorks = false
        host.loseContext(recovery)
        assert.equal(recovery.fallenBackToDOM, true)
        host.webGLWorks = true
        recovery.recover()
        recovery.reactivate()
        assert.equal(host.attachCalls, 2)
    })

    it('defers recovery until a context can be created', () => {
        const { host, recovery } = setup()
        recovery.init()
        host.canRecoverNow = false
        host.loseContext(recovery)
        assert.equal(host.attachCalls, 1)
        assert.equal(recovery.recoveryPending, true)
        host.canRecoverNow = true
        recovery.recover()
        assert.equal(host.attachCalls, 2)
        assert.equal(recovery.webGLActive, true)
        assert.equal(recovery.recoveryPending, false)
    })

    it('resets the retry budget when shown with a live renderer', () => {
        const { host, recovery } = setup()
        recovery.init()
        host.loseContext(recovery)
        host.loseContext(recovery)
        assert.equal(recovery.recoveryAttempts, 2)
        assert.equal(recovery.reactivate(), false)
        assert.equal(recovery.recoveryAttempts, 0)
    })

    it('runs a pending recovery when the pane is shown again', () => {
        const { host, recovery } = setup()
        host.canRecoverNow = false
        recovery.init()
        host.loseContext(recovery)
        host.canRecoverNow = true
        assert.equal(recovery.reactivate(), true)
        assert.equal(recovery.webGLActive, true)
        assert.equal(host.redraws, 1)
    })

    it('recovers a renderer whose canvas went blank without a context loss event when shown', () => {
        const { host, recovery } = setup()
        recovery.init()
        // a GPU reset drops the context without contextlost reaching xterm:
        // the addon is still loaded, contextLost() is never called
        host.canvasAlive = false
        assert.equal(recovery.webGLActive, true)
        recovery.recover()   // window focus alone doesn't notice
        assert.equal(host.attachCalls, 1)
        host.canRecoverNow = false
        assert.equal(recovery.reactivate(), true)
        assert.equal(recovery.webGLActive, false)
        assert.equal(recovery.recoveryPending, true, 'the blank renderer was not noticed')
        host.canRecoverNow = true
        recovery.recover()
        assert.equal(host.attachCalls, 2)
        assert.equal(host.liveAddons, 1, 'the stale addon was not replaced')
        assert.equal(recovery.webGLActive, true)
        assert.equal(recovery.recoveryAttempts, 1)
        assert.equal(host.redraws, 1)
        // shown again with the new renderer: nothing to recover
        assert.equal(recovery.reactivate(), false)
        assert.equal(host.attachCalls, 2)
    })

    it('does nothing once disposed', () => {
        const { host, recovery } = setup()
        recovery.init()
        host.canRecoverNow = false
        host.loseContext(recovery)
        recovery.dispose()
        host.canRecoverNow = true
        recovery.recover()
        assert.equal(recovery.reactivate(), false)
        assert.equal(host.attachCalls, 1)
    })
})
