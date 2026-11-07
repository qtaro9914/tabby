import * as tmp from 'tmp-promise'
import * as fs from 'fs'
import { Subject, Subscription, debounceTime, concatMap } from 'rxjs'
import { Injectable } from '@angular/core'
import { MenuItemOptions, TranslateService } from 'tabby-core'
import { SFTPFile, SFTPSession, SFTPPanelComponent, SFTPContextMenuItemProvider } from 'tabby-ssh'
import { ElectronPlatformService, resolveInsideBase } from './services/platform.service'


/** @hidden */
@Injectable()
export class EditSFTPContextMenu extends SFTPContextMenuItemProvider {
    weight = 0
    private edits = new WeakMap<SFTPSession, Map<string, Promise<string|null>>>()

    constructor (
        private translate: TranslateService,
        private platform: ElectronPlatformService,
    ) {
        super()
    }

    async getItems (item: SFTPFile, panel: SFTPPanelComponent): Promise<MenuItemOptions[]> {
        const items: MenuItemOptions[] = [
            {
                click: () => this.platform.setClipboard({
                    text: item.fullPath,
                }),
                label: this.translate.instant('Copy full path'),
            },
        ]
        if (!item.isDirectory) {
            items.push({
                click: () => this.edit(item, panel),
                label: this.translate.instant('Edit locally'),
            })
        }
        return items
    }

    private async edit (item: SFTPFile, panel: SFTPPanelComponent) {
        const sftp = await panel.openTransferSFTP()
        if (sftp.isClosed) {
            return
        }
        let edits = this.edits.get(sftp)
        if (!edits) {
            edits = new Map()
            this.edits.set(sftp, edits)
        }
        let opening = edits.get(item.fullPath)
        const existing = !!opening
        if (!opening) {
            opening = this.startEdit(item, sftp, () => edits!.delete(item.fullPath))
            edits.set(item.fullPath, opening)
            void opening.catch(() => edits!.delete(item.fullPath))
        }
        const tempPath = await opening
        // Connection state can change while the asynchronous edit opens.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (existing && tempPath && !sftp.isClosed) {
            this.platform.openPath(tempPath)
        }
    }

    private async startEdit (item: SFTPFile, sftp: SFTPSession, onClose: () => void): Promise<string|null> {
        const temporary = await tmp.dir({ unsafeCleanup: true })
        let tempPath = temporary.path
        try {
            tempPath = resolveInsideBase(temporary.path, item.name)
        } catch (error) {
            await temporary.cleanup()
            throw error
        }
        const events = new Subject<string>()
        const subscriptions = new Subscription()
        let watcher: fs.FSWatcher|undefined = undefined
        let watchTimeout: ReturnType<typeof setTimeout>|undefined = undefined
        let closed = false
        const isClosed = () => closed
        let operation: Promise<void> = Promise.resolve()
        const close = () => {
            if (closed) {
                return
            }
            closed = true
            onClose()
            clearTimeout(watchTimeout)
            subscriptions.unsubscribe()
            watcher?.close()
            events.complete()
            // A transfer can still be writing the temporary file when the
            // connection closes. Delete it only after that operation settles.
            void operation.catch(() => undefined).then(() => temporary.cleanup()).catch(error => {
                console.warn('Could not clean up local SFTP edit', error)
            })
        }
        subscriptions.add(sftp.closed$.subscribe(close))
        const watchFile = () => {
            watcher?.close()
            watcher = undefined
            try {
                watcher = fs.watch(tempPath, event => events.next(event))
                watcher.on('error', error => {
                    watcher?.close()
                    watcher = undefined
                    console.warn('Could not watch local SFTP edit', error)
                })
            } catch (error) {
                console.warn('Could not watch local SFTP edit', error)
            }
        }
        if (sftp.isClosed) {
            close()
            return null
        }
        try {
            const transfer = await this.platform.startDownload(item.name, item.mode, item.size, tempPath)
            if (!transfer || isClosed()) {
                transfer?.cancel()
                close()
                return null
            }
            operation = sftp.download(item.fullPath, transfer)
            await operation
            if (isClosed()) {
                return null
            }
            fs.chmodSync(tempPath, 0o700)
            this.platform.openPath(tempPath)
            if (isClosed()) {
                return null
            }

            // Skip the initial editor-open burst. The close subscription above
            // is already active during this delay and during the download.
            watchTimeout = setTimeout(() => {
                if (isClosed()) {
                    return
                }
                watchFile()
                if (isClosed()) {
                    return
                }
                subscriptions.add(events.pipe(debounceTime(1000), concatMap(event => {
                    operation = (async () => {
                        if (isClosed()) {
                            return
                        }
                        const upload = await this.platform.startUpload({ multiple: false }, [tempPath])
                        if (!upload.length) {
                            return
                        }
                        if (isClosed()) {
                            upload[0].cancel()
                            return
                        }
                        await sftp.upload(item.fullPath, upload[0])
                        await sftp.chmod(item.fullPath, item.mode)
                        if (event === 'rename' && !isClosed()) {
                            watchFile()
                        }
                    })().catch(error => {
                        // Keep the local copy and the edit session on transient
                        // upload errors; a later save can retry synchronization.
                        console.warn('Could not sync local SFTP edit', error)
                        if (event === 'rename' && !isClosed()) {
                            watchFile()
                        }
                    })
                    return operation
                })).subscribe({ error: close }))
            }, 1000)
            return tempPath
        } catch (error) {
            close()
            throw error
        }
    }
}
