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
