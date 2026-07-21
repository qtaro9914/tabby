import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, Subscription, debounceTime } from 'rxjs'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = parseInt(process.env.TABBY_FLOW_MAX_CHUNK ?? '') || 1024 * 100
    private maxDelta = parseInt(process.env.TABBY_FLOW_MAX_DELTA ?? '') || this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()
    private outputSubscription: Subscription
    private disposed = false

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.outputSubscription = this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        if (this.disposed) {
            return
        }
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        if (this.disposed) {
            return
        }
        this.delta -= length
        this.maybeEmit()
    }

    dispose (): void {
        if (this.disposed) {
            return
        }
        this.disposed = true
        if (this.buffers.length) {
            const remainder = this.decoder.write(Buffer.concat(this.buffers))
            if (remainder.length) {
                this.onData(remainder)
            }
        }
        const decoderRemainder = this.decoder.flush()
        if (decoderRemainder.length) {
            this.onData(decoderRemainder)
        }
        this.buffers = []
        this.outputSubscription.unsubscribe()
        this.output$.complete()
    }

    private maybeEmit () {
        if (this.disposed) {
            return
        }
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    exited = false

    constructor (private id: string, private app: Application, onExit: () => void, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit(() => {
            this.exited = true
            this.outputQueue.dispose()
            onExit()
        })
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer as any)
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
    }
}

export class PTYManager {
    private ptys = new Map<string, PTY>()

    init (app: Application): void {
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            const pty = new PTY(id, app, () => {
                if (this.ptys.get(id) === pty) {
                    this.ptys.delete(id)
                }
            }, ...options)
            this.ptys.set(id, pty)
        })

        ipcMain.on('pty:exists', (event, id) => {
            const pty = this.ptys.get(id)
            event.returnValue = !!pty && !pty.exited
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys.get(id)?.getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys.get(id)?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys.get(id)?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys.get(id)?.kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys.get(id)?.ackData(length)
        })
    }
}
