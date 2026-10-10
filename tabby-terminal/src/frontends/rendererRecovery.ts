// How many times to recreate the WebGL renderer after a lost GPU context
// before giving up and staying on xterm's DOM renderer.
export const MAX_WEBGL_RECOVERY_ATTEMPTS = 3

export interface WebGLRendererRecoveryHost {
    /** Load a new WebGL addon, disposing a stale one first; false if WebGL couldn't be initialized */
    attachWebGL: () => boolean
    /** Whether the loaded WebGL renderer still has its canvas and GPU context */
    webGLRendererAlive: () => boolean
    /** Whether a new GPU context can be created now (terminal open, visible and focused) */
    canRecover: () => boolean
    redraw: () => void
}

/**
 * Keeps a WebGL terminal on the WebGL renderer across GPU context losses. A lost
 * renderer is recreated once a new context can be created, up to
 * MAX_WEBGL_RECOVERY_ATTEMPTS times. After that - or if WebGL can't be
 * initialized at all - the terminal stays on xterm's DOM renderer for good
 * (disposing the WebGL addon restores it).
 */
export class WebGLRendererRecovery {
    private initialized = false
    private disposed = false
    private active = false
    private pending = false
    private attempts = 0
    private fallenBack = false

    constructor (private host: WebGLRendererRecoveryHost) { }

    get webGLActive (): boolean { return this.active }
    get fallenBackToDOM (): boolean { return this.fallenBack }
    get recoveryPending (): boolean { return this.pending }
    get recoveryAttempts (): number { return this.attempts }

    /**
     * Initial renderer setup, once the terminal is opened. Recovery requests
     * before this are ignored - this attach is what they would have done.
     */
    init (): void {
        if (this.initialized || this.disposed) {
            return
        }
        this.initialized = true
        this.pending = false
        this.attach()
    }

    contextLost (): void {
        this.active = false
        if (!this.initialized || this.disposed || this.fallenBack) {
            return
        }
        this.pending = true
        this.recover()
    }

    /**
     * Called when the terminal is shown again.
     *
     * @returns whether a recovery ran (and redrew); otherwise the caller should redraw
     */
    reactivate (): boolean {
        if (!this.initialized || this.disposed || this.fallenBack) {
            return false
        }
        // An app- or window-level GPU reset can blank the canvas without firing
        // xterm's per-canvas contextlost event. Treat a renderer that has lost its
        // canvas or context as lost too, so a shown-but-blank pane always gets its
        // context back instead of relying on a manual window resize.
        if (this.active && !this.host.webGLRendererAlive()) {
            this.active = false
        }
        if (this.pending || !this.active) {
            this.pending = true
            this.recover()
            return true
        }
        // The pane is shown with a live renderer, so earlier transient losses
        // shouldn't count against a future recovery - reset the budget to avoid
        // permanently downgrading the pane to the DOM renderer.
        this.attempts = 0
        return false
    }

    /**
     * Recreate a lost renderer. A new context can only be created on a visible,
     * focused canvas, so this no-ops until the host can recover and is retried
     * on reactivation or window focus.
     */
    recover (): void {
        if (!this.pending || !this.initialized || this.disposed || this.fallenBack || !this.host.canRecover()) {
            return
        }
        this.pending = false
        if (!this.active) {
            if (this.attempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
                this.attempts++
                this.attach()
            } else {
                this.fallBack()
            }
        }
        this.host.redraw()
    }

    dispose (): void {
        this.disposed = true
        this.pending = false
    }

    private attach (): void {
        if (this.active) {
            return
        }
        if (this.host.attachWebGL()) {
            this.active = true
        } else {
            this.fallBack()
        }
    }

    private fallBack (): void {
        this.fallenBack = true
        this.pending = false
    }
}
