import { Observable, Subject, Subscription } from 'rxjs'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { LogService } from 'tabby-core'
import { BaseSession, UTF8SplitterMiddleware, InputProcessor } from 'tabby-terminal'
import { SSHSession } from './ssh'
import { openShellChannelForProfile } from './shellChannel'
import { SSHProfile } from '../api'
import * as russh from 'russh'


export class SSHShellSession extends BaseSession {
    shell?: russh.Channel
    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private ssh: SSHSession|null
    private subscriptions = new Subscription()
    private sshReferenced = false

    constructor (
        injector: Injector,
        ssh: SSHSession,
        private profile: SSHProfile,
    ) {
        super(injector.get(LogService).create(`ssh-shell-${profile.options.host}-${profile.options.port}`))
        this.ssh = ssh
        this.setLoginScriptsOptions(this.profile.options)
        this.subscriptions.add(this.ssh.serviceMessage$.subscribe(m => this.serviceMessage.next(m)))
        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (): Promise<void> {
        if (this.isDestroyed) {
            return
        }
        if (!this.ssh) {
            throw new Error('SSH session not set')
        }

        this.ssh.ref()
        this.sshReferenced = true
        this.subscriptions.add(this.ssh.willDestroy$.subscribe(() => {
            this.destroy()
        }))

        this.logger.debug('Opening shell')

        try {
            const shell = await openShellChannelForProfile(this.ssh, this.profile, channel => {
                if (this.isDestroyed) {
                    throw new Error('SSH shell cancelled')
                }
                this.shell = channel
                this.open = true
                this.attachShellHandlers(channel)
            })
            // The parent connection or tab can close while the channel opens.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (this.isDestroyed) {
                await shell.close()
                return
            }
            this.shell = shell
        } catch (err) {
            if (err.toString().includes('Unable to request X11')) {
                this.emitServiceMessage('    Make sure `xauth` is installed on the remote side')
            }
            await this.destroy()
            throw new Error(`Remote rejected opening a shell channel: ${err}`)
        }

        this.open = true
        this.logger.debug('Shell open')

        this.loginScriptProcessor?.executeUnconditionalScripts()

        // Must run after the output subscriptions above are wired, otherwise the
        // command echo and anything the remote prints in response is dropped.
        if (this.profile.options.cwd) {
            this.changeInitialDirectory(this.profile.options.cwd)
        }
    }

    private attachShellHandlers (shell: russh.Channel): void {
        shell.setReceiveBufferLimit(256 * 1024)
        const consume = (data: Uint8Array) => {
            void this.emitOutput(Buffer.from(data)).then(() => {
                if (!this.isDestroyed && this.shell === shell) {
                    shell.acknowledgeData(data)
                }
            }).catch(error => {
                this.logger.warn('Could not consume SSH output', error)
                void this.destroy()
            })
        }
        this.subscriptions.add(shell.data$.subscribe(consume))
        this.subscriptions.add(shell.extendedData$.subscribe(([, data]) => consume(data)))

        this.subscriptions.add(shell.eof$.subscribe(() => {
            this.logger.info('Shell session ended (EOF)')
            if (!this.isDestroyed) {
                this.destroy()
            }
        }))

        // The server is not required to send CHANNEL_EOF before CHANNEL_CLOSE -
        // whether it does is timing-dependent (e.g. when a `sudo` child process
        // delays the pty EOF), so rely on the channel close as well, otherwise
        // the session sometimes stays open after the remote shell has exited.
        this.subscriptions.add(shell.closed$.subscribe(() => {
            this.logger.info('Shell session ended (channel closed)')
            if (!this.isDestroyed) {
                this.destroy()
            }
        }))
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    resize (columns: number, rows: number): void {
        this.shell?.resizePTY({
            columns,
            rows,
            pixHeight: 0,
            pixWidth: 0,
        })
    }

    write (data: Buffer): void {
        if (this.shell) {
            this.shell.write(new Uint8Array(data))
        }
    }

    kill (_signal?: string): void {
        void this.closeShell()
    }

    async destroy (): Promise<void> {
        if (this.isDestroyed) {
            return
        }
        this.logger.debug('Closing shell')
        this.subscriptions.unsubscribe()
        this.serviceMessage.complete()
        const ssh = this.ssh
        this.ssh = null
        const closing = super.destroy()
        // Request channel close first, but do not keep the last connection
        // reference alive while waiting for a stalled close to finish.
        if (this.sshReferenced) {
            this.sshReferenced = false
            ssh?.unref()
        }
        await closing
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        await this.closeShell()
    }

    private async closeShell (): Promise<void> {
        const shell = this.shell
        this.shell = undefined
        await shell?.close().catch(error => this.logger.warn('Could not close shell channel', error))
    }

    private changeInitialDirectory (dir: string): void {
        // The leading space keeps the command out of shell history on shells with HISTCONTROL=ignorespace
        this.write(Buffer.from(` cd -- '${dir.replace(/'/g, `'\\''`)}'\n`))
    }

    supportsWorkingDirectory (): boolean {
        return !!this.reportedCWD
    }

    async getWorkingDirectory (): Promise<string|null> {
        return this.reportedCWD ?? null
    }
}
