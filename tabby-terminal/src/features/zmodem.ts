import colors from 'ansi-colors'
import * as ZModem from 'zmodem.js'
import { Observable, filter, first } from 'rxjs'
import { EnvironmentInjector, inject, Injectable } from '@angular/core'
import { TerminalDecorator } from '../api/decorator'
import { BaseTerminalTabComponent } from '../api/baseTerminalTab.component'
import { SessionMiddleware } from '../api/middleware'
import { LogService, Logger, PlatformService, FileUpload, TranslateService } from 'tabby-core'

const SPACER = '            '

class ZModemMiddleware extends SessionMiddleware {
    private sentry: ZModem.Sentry
    private isActive = false
    private logger: Logger
    private activeSession: any = null
    private cancelEvent: Observable<any>

    // While non-null, terminal output is buffered here instead of being sent
    // straight to the terminal. Used to hold back a receive session's trailing
    // bytes (the shell prompt redrawn after sz exits) until after the final
    // "Received"/"Complete" messages have been printed, so the prompt is not
    // overwritten by showMessage()'s leading "\r".
    private trailingBuffer: Buffer[] | null = null

    // Fast-path state: while no session is active, chunks that cannot contain
    // a ZMODEM header (no ZDLE byte) bypass the sentry entirely. A header
    // split across the bypass/feed boundary is covered by carrying the last
    // bytes of the bypassed chunk into the sentry with suppressed re-emission.
    private bypassTail = Buffer.alloc(0)
    private wasBypassing = false
    private feedNextChunk = false
    private suppressBytes = 0

    private flushTrailingBuffer () {
        const buffered = this.trailingBuffer
        this.trailingBuffer = null
        if (!buffered?.length) {
            return
        }
        for (const chunk of buffered) {
            this.outputToTerminal.next(chunk)
        }
    }

    private log = inject(LogService)
    private translate = inject(TranslateService)
    private platform = inject(PlatformService)

    constructor () {
        super()
        this.cancelEvent = this.outputToSession$.pipe(filter(x => x.length === 1 && x[0] === 3))

        this.logger = this.log.create('zmodem')
        this.sentry = new ZModem.Sentry({
            // to_terminal is zmodem.js' single terminal-output channel. It
            // receives normal passthrough data (while no session is active),
            // protocol "garbage", and crucially the trailing bytes that follow
            // a session's "OO" terminator (e.g. the shell prompt redrawn after
            // sz/rz exits). These trailing bytes are emitted synchronously from
            // within the same consume() call that fires session_end, so any
            // guard based on isActive/activeSession would drop them on platforms
            // where "OO" and the prompt arrive in the same chunk (Linux).
            // While trailingBuffer is active they are queued so the final
            // status messages can be printed first; otherwise forward directly.
            to_terminal: data => {
                let buf = Buffer.from(data)
                if (this.suppressBytes) {
                    // These bytes were already emitted by the bypass fast path
                    const skip = Math.min(this.suppressBytes, buf.length)
                    this.suppressBytes -= skip
                    if (skip >= buf.length) {
                        return
                    }
                    buf = buf.subarray(skip)
                }
                if (this.trailingBuffer) {
                    this.trailingBuffer.push(buf)
                } else {
                    this.outputToTerminal.next(buf)
                }
            },
            sender: data => this.outputToSession.next(Buffer.from(data)),
            on_detect: async detection => {
                if ((await this.platform.showMessageBox({
                    type: 'warning',
                    message: this.translate.instant('Accept a ZMODEM session?'),
                    detail: this.translate.instant('If you have not requested it, it could be a sign of malicious activity.'),
                    buttons: [
                        this.translate.instant('Accept'),
                        this.translate.instant('Reject'),
                    ],
                    defaultId: 0,
                    cancelId: 1,
                })).response === 1) {
                    // Accept the detection to get a session, then immediately
                    // abort so that proper ZABORT frames are sent to the remote
                    // side, causing the remote rz/sz process to terminate.
                    try {
                        const zsession = detection.confirm()
                        zsession.abort()
                    } catch { }
                    // Clean up terminal output after rejection
                    this.showMessage(colors.bgRed.black(' Rejected ') + ' ZMODEM session')
                    return
                }

                try {
                    this.isActive = true
                    await this.process(detection)
                } finally {
                    this.isActive = false
                }
            },
            on_retract: () => {
                this.showMessage('transfer cancelled')
                this.activeSession = null
                this.isActive = false
            },
        })
    }

    feedFromSession (data: Buffer): void {
        if (this.isActive || this.activeSession) {
            try {
                this.sentry.consume(data)
            } catch (e) {
                this.showMessage(colors.bgRed.black(' Error ') + ' ' + e)
                this.logger.error('protocol error', e)
                this.activeSession?.abort()
                this.activeSession = null
                this.isActive = false
                // Don't forward the problematic data to terminal
                return
            }
        } else {
            // Fast path: every ZMODEM header contains a ZDLE (0x18) byte. If
            // the chunk has none and the previous chunk did not end near one,
            // it cannot start or continue a header — skip the sentry (and its
            // per-byte scan) entirely.
            const zdleIndex = data.lastIndexOf(0x18)
            if (zdleIndex === -1 && !this.feedNextChunk) {
                this.wasBypassing = true
                this.bypassTail = data.length >= 2
                    ? data.subarray(data.length - 2)
                    : Buffer.concat([this.bypassTail, data]).subarray(-2)
                this.outputToTerminal.next(data)
                return
            }

            // A header may span the bypass/feed boundary — prepend the
            // bypassed tail so the sentry sees the full "**\x18" prefix, and
            // suppress its re-emission since it has already been shown.
            let toFeed = data
            if (this.wasBypassing && this.bypassTail.length) {
                toFeed = Buffer.concat([this.bypassTail, data])
                this.suppressBytes = this.bypassTail.length
            }
            this.wasBypassing = false

            // If the chunk ends shortly after a ZDLE, the header may continue
            // in the next chunk — keep feeding the sentry until it resolves
            this.feedNextChunk = zdleIndex !== -1 && data.length - zdleIndex < 24

            // No active session: sentry.consume() routes everything straight
            // back through to_terminal, so we must not output here as well or
            // the data would be duplicated. Only on a consume() failure do we
            // forward the raw data as a fallback so nothing is lost.
            try {
                this.sentry.consume(toFeed)
            } catch (e) {
                this.logger.error('zmodem detection error', e)
                this.suppressBytes = 0
                this.outputToTerminal.next(data)
            }
        }
    }

    private async process (detection): Promise<void> {
        this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Session started')
        this.showMessage('------------------------')

        const zsession = detection.confirm()
        this.activeSession = zsession
        this.logger.info('new session', zsession)

        try {
            if (zsession.type === 'send') {
                const transfers = await this.platform.startUpload({ multiple: true })
                const pendingTransfers = [...transfers]
                let filesRemaining = pendingTransfers.length
                let sizeRemaining = pendingTransfers.reduce((a, b) => a + b.getSize(), 0)
                try {
                    while (pendingTransfers.length) {
                        const transfer = pendingTransfers.shift()!
                        await this.sendFile(zsession, transfer, filesRemaining, sizeRemaining)
                        filesRemaining--
                        sizeRemaining -= transfer.getSize()
                    }
                } finally {
                    for (const transfer of pendingTransfers) {
                        transfer.cancel()
                    }
                }
                await zsession.close()

                this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Complete')
            } else {
                const pendingReceives: Promise<void>[] = []
                const receiveErrors: any[] = []
                zsession.on('offer', xfer => {
                    pendingReceives.push(this.receiveFile(xfer, zsession).catch(error => {
                        receiveErrors.push(error)
                    }))
                })

                // session_end fires synchronously inside sentry.consume(),
                // immediately before the session's trailing bytes (the shell
                // prompt redrawn after sz exits) are flushed via to_terminal.
                // Start buffering here so those bytes are held back until after
                // all "Received" messages and the "Complete" message have been
                // printed; otherwise the prompt would be emitted first and then
                // overwritten by showMessage()'s leading "\r".
                zsession.on('session_end', () => {
                    this.trailingBuffer = []
                })

                zsession.start()

                await new Promise(resolve => zsession.on('session_end', resolve))
                await Promise.all(pendingReceives)
                if (receiveErrors.length) {
                    throw receiveErrors[0]
                }

                this.showMessage(colors.bgBlue.black(' ZMODEM ') + ' Complete')
                this.flushTrailingBuffer()
            }
        } catch (error) {
            this.logger.error('ZMODEM session error', error)
            this.showMessage(colors.bgRed.black(' ZMODEM ') + ` Session failed: ${error.message}`)
            try {
                zsession.abort()
            } catch { }
        } finally {
            this.activeSession = null

            // Safety net: if an error left bytes buffered (e.g. session_end
            // started buffering but the flush above was skipped), release them
            // so terminal output is never permanently swallowed.
            if (this.trailingBuffer) {
                this.flushTrailingBuffer()
            }
        }
    }

    private async receiveFile (xfer, zsession) {
        const details: {
            name: string,
            size: number,
        } = xfer.get_details()
        this.showMessage(colors.bgYellow.black(' Offered ') + ' ' + details.name, true)
        this.logger.info('offered', xfer)

        const transfer = await this.platform.startDownload(details.name, 0o644, details.size)
        if (!transfer) {
            this.showMessage(colors.bgRed.black(' Rejected ') + ' ' + details.name)
            xfer.skip()
            return
        }

        let canceled = false
        const cancelSubscription = this.cancelEvent.subscribe(() => {
            try {
                zsession._skip()
            } catch {}
            canceled = true
        })

        let writeQueue: Promise<void> = Promise.resolve()
        let writeError: any = null
        let receivedBytes = 0
        let lastUpdateTime = 0

        try {
            await Promise.race([
                xfer.accept({
                    on_input: chunk => {
                        if (canceled) {
                            return
                        }

                        receivedBytes += chunk.length
                        const now = Date.now()
                        if (now - lastUpdateTime > 500) {
                            lastUpdateTime = now
                            const percent = Math.round(100 * receivedBytes / details.size)
                            const percentStr = percent.toString().padStart(3, ' ')
                            this.showMessage(colors.bgYellow.black(` ${percentStr}% `) + ' ' + details.name, true)
                        }

                        writeQueue = writeQueue.then(async () => {
                            if (writeError) {
                                return
                            }
                            try {
                                await transfer.write(Buffer.from(chunk))
                            } catch (error) {
                                writeError = error
                                this.logger.error('Zmodem write error', error)
                                try {
                                    zsession._skip()
                                } catch {}
                            }
                        })
                    },
                }),
                this.cancelEvent.pipe(first()).toPromise(),
            ])

            await writeQueue
            if (writeError) {
                throw writeError
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (canceled) {
                transfer.cancel()
                this.showMessage(colors.bgRed.black(' Canceled ') + ' ' + details.name)
            } else {
                transfer.setFinalizing()
                if (receivedBytes !== details.size) {
                    throw new Error(`Expected ${details.size} bytes, received ${receivedBytes}`)
                }
                await transfer.finalize()
                transfer.setCompleted(true)
                this.showMessage(colors.bgGreen.black(' Received ') + ' ' + details.name)
            }
        } catch (error) {
            transfer.fail(error)
            this.logger.error('ZMODEM receive error', error)
            this.showMessage(colors.bgRed.black(' Error ') + ' ' + details.name)
            throw error
        } finally {
            cancelSubscription.unsubscribe()
        }
    }

    private async sendFile (zsession, transfer: FileUpload, filesRemaining, sizeRemaining) {
        const offer = {
            name: transfer.getName(),
            size: transfer.getSize(),
            mode: transfer.getMode(),
            files_remaining: filesRemaining,
            bytes_remaining: sizeRemaining,
        }
        this.logger.info('offering', offer)
        this.showMessage(colors.bgYellow.black(' Offered ') + ' ' + offer.name, true)

        let canceled = false
        let transferClosed = false
        let cancelSubscription: { unsubscribe: () => void } | null = null
        try {
            const xfer = await zsession.send_offer(offer)
            if (!xfer) {
                this.showMessage(colors.bgRed.black(' Rejected ') + ' ' + offer.name)
                this.logger.warn('rejected by the other side')
                return
            }

            cancelSubscription = this.cancelEvent.subscribe(() => {
                canceled = true
            })

            while (true) {
                const chunk = await transfer.read()
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (canceled || !chunk.length) {
                    break
                }

                await xfer.send(chunk)
                this.showMessage(colors.bgYellow.black(' ' + Math.round(100 * transfer.getCompletedBytes() / offer.size).toString().padStart(3, ' ') + '% ') + offer.name, true)
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (canceled) {
                transfer.cancel()
            } else {
                transfer.setFinalizing()
                await transfer.finalize()
            }
            transferClosed = true

            await xfer.end()
            transfer.setCompleted(true)

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (canceled) {
                this.showMessage(colors.bgRed.black(' Canceled ') + ' ' + offer.name)
            } else {
                this.showMessage(colors.bgGreen.black(' Sent ') + ' ' + offer.name)
            }
        } catch (error) {
            transfer.fail(error)
            throw error
        } finally {
            cancelSubscription?.unsubscribe()
            if (!transferClosed) {
                transfer.cancel()
            }
        }
    }

    private showMessage (msg: string, overwrite = false) {
        this.outputToTerminal.next(Buffer.from(`\r${msg}${SPACER}`))
        if (!overwrite) {
            this.outputToTerminal.next(Buffer.from('\r\n'))
        }
    }
}

/** @hidden */
@Injectable()
export class ZModemDecorator extends TerminalDecorator {
    #injector = inject(EnvironmentInjector)

    attach (terminal: BaseTerminalTabComponent<any>): void {
        setTimeout(() => {
            this.attachToSession(terminal)
            this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => {
                this.attachToSession(terminal)
            }))
        })
    }

    private attachToSession (terminal: BaseTerminalTabComponent<any>) {
        if (!terminal.session) {
            return
        }
        terminal.session.middleware.unshift(this.#injector.runInContext(() => new ZModemMiddleware()))
    }
}
