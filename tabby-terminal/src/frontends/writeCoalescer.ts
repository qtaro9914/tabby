/**
 * Serializes frontend writes, merging chunks that arrive while a write is in
 * flight into a single follow-up write.
 *
 * Each frontend write waits for the parser (see TerminalWriteCompletion) so
 * that PTY/SSH receive credit is only returned for consumed output. Waiting
 * per chunk costs at least one macrotask hop in xterm's WriteBuffer, which
 * Chromium clamps to 4ms once timers nest. With 4KB PTY reads that alone
 * capped throughput at ~1MB/s. Merging the queued chunks pays the hop once
 * per batch instead. A write that arrives while nothing is in flight goes out
 * as is, so interactive echo gains no latency.
 *
 * Every caller's promise settles with the batch its chunk was written in.
 */
export class WriteCoalescer {
    private tail: Promise<void> = Promise.resolve()
    private open: { chunks: string[], done: Promise<void> }|null = null

    constructor (
        private sink: (data: string) => Promise<void>,
        private onError: (error: unknown) => void = () => undefined,
    ) { }

    write (data: string): Promise<void> {
        let batch = this.open
        if (!batch) {
            const chunks: string[] = []
            const created: { chunks: string[], done: Promise<void> } = {
                chunks,
                done: this.tail.then(() => {
                    // Closing the batch here, not in sink, means chunks that
                    // arrive while this batch is being written start a new one.
                    if (this.open === created) {
                        this.open = null
                    }
                    return this.sink(chunks.length === 1 ? chunks[0] : chunks.join(''))
                }),
            }
            this.tail = created.done.catch(this.onError)
            this.open = batch = created
        }
        batch.chunks.push(data)
        return batch.done
    }
}
