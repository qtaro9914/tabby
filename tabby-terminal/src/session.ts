import { Observable, Subject } from 'rxjs'
import { Logger } from 'tabby-core'
import { LoginScriptProcessor, LoginScriptsOptions } from './middleware/loginScriptProcessing'
import { OSCProcessor } from './middleware/oscProcessing'
import { SessionMiddlewareStack } from './api/middleware'

const MAX_INITIAL_DATA_BYTES = 8 * 1024 * 1024

/**
 * A session object for a [[BaseTerminalTabComponent]]
 * Extend this to implement custom I/O and process management for your terminal tab
 */
export abstract class BaseSession {
    open: boolean
    readonly oscProcessor = new OSCProcessor()
    readonly middleware = new SessionMiddlewareStack()
    protected output = new Subject<string>()
    protected binaryOutput = new Subject<Buffer>()
    protected closed = new Subject<void>()
    protected destroyed = new Subject<void>()
    protected loginScriptProcessor: LoginScriptProcessor | null = null
    protected reportedCWD?: string
    private initialDataChunks: Buffer[] = []
    private initialDataBytes = 0
    private initialDataBufferReleased = false
    private initialDataTruncated = false

    get output$ (): Observable<string> { return this.output }
    get binaryOutput$ (): Observable<Buffer> { return this.binaryOutput }
    get closed$ (): Observable<void> { return this.closed }
    get destroyed$ (): Observable<void> { return this.destroyed }

    constructor (protected logger: Logger) {
        this.middleware.push(this.oscProcessor)
        this.oscProcessor.cwdReported$.subscribe(cwd => {
            this.reportedCWD = cwd
        })

        this.middleware.outputToTerminal$.subscribe(data => {
            if (!this.initialDataBufferReleased) {
                this.initialDataChunks.push(data)
                this.initialDataBytes += data.length
                this.trimInitialDataBuffer()
            } else {
                this.output.next(data.toString())
                this.binaryOutput.next(data)
            }
        })

        this.middleware.outputToSession$.subscribe(data => this.write(data))
    }

    feedFromTerminal (data: Buffer): void {
        this.middleware.feedFromTerminal(data)
    }

    protected emitOutput (data: Buffer): void {
        this.middleware.feedFromSession(data)
    }

    releaseInitialDataBuffer (): void {
        if (this.initialDataBufferReleased) {
            return
        }
        this.initialDataBufferReleased = true
        const initialData = Buffer.concat(this.initialDataChunks, this.initialDataBytes)
        this.initialDataChunks = []
        this.initialDataBytes = 0
        if (initialData.length) {
            this.output.next(initialData.toString())
            this.binaryOutput.next(initialData)
        }
    }

    setLoginScriptsOptions (options: LoginScriptsOptions): void {
        const newProcessor = new LoginScriptProcessor(this.logger, options)
        if (this.loginScriptProcessor) {
            this.middleware.replace(this.loginScriptProcessor, newProcessor)
        } else {
            this.middleware.push(newProcessor)
        }
        this.loginScriptProcessor = newProcessor
    }

    private trimInitialDataBuffer (): void {
        let excess = this.initialDataBytes - MAX_INITIAL_DATA_BYTES
        if (excess <= 0) {
            return
        }
        if (!this.initialDataTruncated) {
            this.initialDataTruncated = true
            this.logger.warn(`Discarding terminal output buffered before frontend attachment after ${MAX_INITIAL_DATA_BYTES} bytes`)
        }
        while (excess > 0 && this.initialDataChunks.length) {
            const chunk = this.initialDataChunks[0]
            if (chunk.length <= excess) {
                this.initialDataChunks.shift()
                this.initialDataBytes -= chunk.length
                excess -= chunk.length
            } else {
                this.initialDataChunks[0] = Buffer.from(chunk.subarray(excess))
                this.initialDataBytes -= excess
                excess = 0
            }
        }
    }

    async destroy (): Promise<void> {
        if (this.open) {
            this.logger.info('Destroying')
            this.open = false
            this.closed.next()
            this.destroyed.next()
            await this.gracefullyKillProcess()
        }
        this.middleware.close()
        this.closed.complete()
        this.destroyed.complete()
        this.output.complete()
        this.binaryOutput.complete()
    }

    abstract start (options: unknown): Promise<void>
    abstract resize (columns: number, rows: number): void
    abstract write (data: Buffer): void
    abstract kill (signal?: string): void
    abstract gracefullyKillProcess (): Promise<void>
    abstract supportsWorkingDirectory (): boolean
    abstract getWorkingDirectory (): Promise<string|null>
}
