/** Wait for xterm parsing; false means frontend disposal cancelled the wait. */
export class TerminalWriteCompletion {
    private pending = new Set<(parsed: boolean) => void>()
    private disposed = false

    constructor (private terminal: { write: (data: string, callback: () => void) => void }) { }

    write (data: string): Promise<boolean> {
        if (this.disposed) {
            return Promise.resolve(false)
        }
        if (!data.length) {
            return Promise.resolve(true)
        }
        return new Promise((resolve, reject) => {
            this.pending.add(resolve)
            try {
                this.terminal.write(data, () => {
                    if (this.pending.delete(resolve)) {
                        resolve(true)
                    }
                })
            } catch (error) {
                this.pending.delete(resolve)
                reject(error)
            }
        })
    }

    dispose (): void {
        this.disposed = true
        // Cancellation is a normal outcome, not a rejected write. Zone.js can
        // report intermediate rejections while async disposal drains the queue.
        for (const resolve of this.pending) {
            resolve(false)
        }
        this.pending.clear()
    }
}
