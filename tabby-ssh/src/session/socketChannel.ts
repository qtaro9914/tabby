import type { Socket } from 'net'
import type { Channel } from 'russh'
import type { Logger } from 'tabby-core'

export function forwardSocketChannel (channel: Pick<Channel, 'data$'|'eof$'|'closed$'|'write'|'eof'|'close'>, socket: Socket, logger: Pick<Logger, 'debug'|'error'>, logPrefix: string): void {
    const MAX_PENDING_SOCKET_BYTES = 8 * 1024 * 1024
    const pendingSocketWrites: Buffer[] = []
    let pendingSocketBytes = 0
    let socketBackpressured = false
    let remoteEnded = false
    let remoteClosed = false
    let socketEnded = false
    let closed = false
    let channelCloseRequested = false
    let channelWrite = Promise.resolve()

    const closeChannel = () => {
        if (channelCloseRequested || remoteClosed) {
            return
        }
        channelCloseRequested = true
        void channel.close().catch(error => {
            logger.debug(`${logPrefix}: channel close failed: ${error}`)
        })
    }
    const fail = (error: unknown) => {
        if (closed) {
            return
        }
        closed = true
        logger.error(`${logPrefix}: forwarding failed: ${error}`)
        pendingSocketWrites.length = 0
        pendingSocketBytes = 0
        socket.destroy()
        closeChannel()
    }
    const endSocketIfDrained = () => {
        if (remoteEnded && !pendingSocketWrites.length && !socketEnded) {
            socketEnded = true
            // end() flushes Node's own write buffer. Wait until our queue has
            // also been handed to the socket before requesting the final write.
            socket.end()
        }
    }
    const flushSocketWrites = () => {
        if (closed) {
            return
        }
        socketBackpressured = false
        while (pendingSocketWrites.length) {
            const data = pendingSocketWrites.shift()!
            pendingSocketBytes -= data.length
            if (!socket.write(data)) {
                socketBackpressured = true
                break
            }
        }
        endSocketIfDrained()
    }

    channel.data$.subscribe({
        next: data => {
            if (closed || remoteEnded) {
                return
            }
            const buffer = Buffer.from(data)
            if (!socketBackpressured && !pendingSocketWrites.length) {
                socketBackpressured = !socket.write(buffer)
                return
            }
            pendingSocketWrites.push(buffer)
            pendingSocketBytes += buffer.length
            if (pendingSocketBytes > MAX_PENDING_SOCKET_BYTES) {
                fail(new Error(`socket write queue exceeded ${MAX_PENDING_SOCKET_BYTES} bytes`))
            }
        },
        error: fail,
    })
    socket.on('drain', flushSocketWrites)

    socket.on('data', data => {
        if (closed || remoteClosed) {
            return
        }
        socket.pause()
        channelWrite = channelWrite.then(async () => {
            if (!closed && !remoteClosed) {
                await channel.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            }
        }).then(() => {
            if (!closed && !remoteClosed) {
                socket.resume()
            }
        }).catch(fail)
    })

    channel.eof$.subscribe(() => {
        logger.debug(`${logPrefix}: channel EOF received, draining socket`)
        remoteEnded = true
        endSocketIfDrained()
    })

    socket.on('finish', () => {
        if (remoteClosed) {
            closed = true
            socket.destroy()
        }
    })
    channel.closed$.subscribe(() => {
        logger.debug(`${logPrefix}: channel closed, draining socket`)
        remoteClosed = true
        remoteEnded = true
        socket.pause()
        if (socket.writableFinished) {
            closed = true
            socket.destroy()
        } else {
            endSocketIfDrained()
        }
    })

    socket.on('error', fail)
    socket.on('close', () => {
        logger.debug(`${logPrefix}: socket closed, closing channel`)
        closed = true
        closeChannel()
    })
    socket.on('end', () => {
        logger.debug(`${logPrefix}: socket end, sending EOF after pending writes`)
        channelWrite = channelWrite.then(async () => {
            if (!closed && !remoteClosed) {
                await channel.eof()
            }
        }).catch(fail)
    })
}
