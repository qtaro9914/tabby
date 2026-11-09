/** xterm's internal CoreMouseButton.WHEEL */
const WHEEL_BUTTON = 4
export const MAX_WHEEL_REPORTS = 10

interface MouseServiceLike {
    triggerMouseEvent: (event: { button: number }) => boolean
}

interface InputServiceLike {
    triggerDataEvent: (data: string, wasUserInput?: boolean) => void
    triggerBinaryEvent: (data: string) => void
}

interface ScrollableCoreLike {
    buffer: { ydisp: number, ybase: number }
    scrollToBottom: () => void
}

export function clampWheelReports (value: unknown): number {
    const n = Math.round(Number(value))
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_WHEEL_REPORTS) : 1
}

/**
 * xterm sends one report per wheel event to apps with mouse tracking on, however
 * far the wheel moved. Apps scroll a fixed amount per report (tmux and herdr
 * use 3 lines), so a notch moves a third as far as in Ghostty, which sends
 * three. Repeats every wheel report `getCount()` times. xterm still decides
 * whether an event produces a report at all (partial trackpad scrolls, Shift).
 *
 * The repeats go out as a single write: sent one by one they reach the PTY as
 * separate writes, the app often reads the first on its own, and redraws twice.
 */
export function repeatWheelReports (service: MouseServiceLike, input: InputServiceLike, getCount: () => number): void {
    const trigger = service.triggerMouseEvent.bind(service)
    service.triggerMouseEvent = event => {
        const count = event.button === WHEEL_BUTTON ? clampWheelReports(getCount()) : 1
        if (count === 1) {
            return trigger(event)
        }
        const sendData = input.triggerDataEvent
        const sendBinary = input.triggerBinaryEvent
        let data = ''
        let binary = ''
        input.triggerDataEvent = chunk => { data += chunk }
        input.triggerBinaryEvent = chunk => { binary += chunk }
        let sent = false
        try {
            // triggerMouseEvent rewrites the event's fields while encoding it
            sent = trigger({ ...event })
            for (let i = 1; sent && i < count; i++) {
                trigger({ ...event })
            }
        } finally {
            input.triggerDataEvent = sendData
            input.triggerBinaryEvent = sendBinary
        }
        // mouse reports are user input, as in xterm's own call
        if (data) {
            sendData.call(input, data, true)
        }
        if (binary) {
            sendBinary.call(input, binary)
        }
        return sent
    }
}

/**
 * xterm 6's scrollToBottom() goes through scrollLines(0), which repaints every
 * row even when the viewport is already at the bottom. The frontend calls it
 * after every output chunk and on every input (mouse reports included), which
 * doubles the renders while scrolling a TUI.
 */
export function scrollToBottomIfNeeded (core: ScrollableCoreLike, scrollToBottom: () => void): () => void {
    return () => {
        if (core.buffer.ydisp !== core.buffer.ybase) {
            scrollToBottom()
        }
    }
}

const SCROLLBAR_HIDE_DELAY = 500

interface HideTimerLike {
    _token: unknown
    cancelAndSet: (runner: () => void, timeout: number) => void
}

interface ScrollableElementLike {
    _hideTimeout?: HideTimerLike
    _mouseIsOver: boolean
    _isDragging: boolean
    _hide: () => void
    _scheduleHide: () => void
}

/**
 * xterm 6's scrollable element reveals the scrollbar on every scroll and
 * re-arms its 500ms hide timer each time with clearTimeout + setTimeout, both
 * through Zone.js. Output scrolls once per line, so a fast `cat` spent ~16% of
 * the renderer there. Keep one timer armed instead and push its deadline back:
 * it fires at most every 500ms and re-arms itself for the time left. The
 * scrollbar still hides 500ms after the last scroll.
 *
 * Returns false (and changes nothing) if xterm's internals no longer match.
 */
export function coalesceScrollbarHide (element: ScrollableElementLike|undefined, now: () => number = () => performance.now()): boolean {
    const timer = element?._hideTimeout
    if (
        !element || !timer ||
        typeof timer._token !== 'number' || typeof timer.cancelAndSet !== 'function' ||
        typeof element._hide !== 'function' || typeof element._scheduleHide !== 'function'
    ) {
        return false
    }
    let hideAt = 0
    const fire = () => {
        const rest = hideAt - now()
        if (rest > 1) {
            timer.cancelAndSet(fire, rest)
        } else {
            element._hide()
        }
    }
    element._scheduleHide = () => {
        if (element._mouseIsOver || element._isDragging) {
            return
        }
        hideAt = now() + SCROLLBAR_HIDE_DELAY
        // TimeoutTimer keeps -1 while nothing is armed
        if (timer._token === -1) {
            timer.cancelAndSet(fire, SCROLLBAR_HIDE_DELAY)
        }
    }
    return true
}
