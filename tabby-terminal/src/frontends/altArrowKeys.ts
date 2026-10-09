/**
 * xterm 6 sends Alt+Left/Right as ESC[1;3D/C, which shells don't bind by default.
 * Sends xterm 5's word-jump sequence instead and claims the event.
 *
 * @returns whether the event was an Alt+Left/Right keydown that was handled
 */
export function handleAltArrowWordJump (event: KeyboardEvent, macOS: boolean, send: (sequence: string) => void): boolean {
    if (
        event.type !== 'keydown' || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey ||
        event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
    ) {
        return false
    }
    // Returning false from xterm's custom key handler skips xterm's own event
    // cancellation, so cancel it here - otherwise the browser also runs its
    // default action (Alt+Left is history back in a browser build)
    event.preventDefault()
    event.stopPropagation()
    const left = event.key === 'ArrowLeft'
    send(macOS ? left ? '\x1bb' : '\x1bf' : left ? '\x1b[1;5D' : '\x1b[1;5C')
    return true
}
