import '@vaadin/vaadin-context-menu'
import copyToClipboard from 'copy-text-to-clipboard'
import { Injectable, Inject } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { PlatformService, ClipboardContent, MenuItemOptions, MessageBoxOptions, MessageBoxResult, FileUpload, FileUploadOptions, FileDownload, DirectoryDownload, HTMLFileUpload, DirectoryUpload } from 'tabby-core'

// eslint-disable-next-line no-duplicate-imports
import type { ContextMenuElement, ContextMenuItem } from '@vaadin/vaadin-context-menu'

import { MessageBoxModalComponent } from './components/messageBoxModal.component'
import './styles.scss'

interface BrowserFileWriter {
    write: (data: Uint8Array) => Promise<void>
    close: () => Promise<void>
    abort: () => Promise<void>
}

interface BrowserFileHandle {
    createWritable: () => Promise<BrowserFileWriter>
}

@Injectable()
export class WebPlatformService extends PlatformService {
    private menu: ContextMenuElement
    private contextMenuHandlers = new Map<ContextMenuItem, () => void>()
    private fileSelector: HTMLInputElement

    constructor (
        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        @Inject('WEB_CONNECTOR') private connector: any,
        private ngbModal: NgbModal,
    ) {
        super()
        this.menu = window.document.createElement('vaadin-context-menu')
        this.menu.addEventListener('item-selected', e => {
            this.contextMenuHandlers.get(e.detail.value)?.()
        })
        document.body.appendChild(this.menu)

        this.fileSelector = document.createElement('input')
        this.fileSelector.type = 'file'
        this.fileSelector.style.visibility = 'hidden'
        document.body.appendChild(this.fileSelector)
    }

    readClipboard (): string {
        return ''
    }

    setClipboard (content: ClipboardContent): void {
        copyToClipboard(content.text)
    }

    async loadConfig (): Promise<string> {
        return this.connector.loadConfig()
    }

    async saveConfig (content: string): Promise<void> {
        await this.connector.saveConfig(content)
    }

    getOSRelease (): string {
        return '1.0'
    }

    async openExternal (url: string): Promise<void> {
        window.open(url)
    }

    getAppVersion (): string {
        return this.connector.getAppVersion()
    }

    async listFonts (): Promise<string[]> {
        return []
    }

    popupContextMenu (menu: MenuItemOptions[], event?: MouseEvent): void {
        this.contextMenuHandlers.clear()
        this.menu.items = menu
            .filter(x => x.type !== 'separator')
            .map(x => this.remapMenuItem(x))
        setTimeout(() => {
            this.menu.open(event)
        }, 10)
    }

    private remapMenuItem (item: MenuItemOptions): ContextMenuItem {
        const cmi = {
            text: item.label,
            disabled: !(item.enabled ?? true),
            checked: item.checked,
            children: item.submenu?.map(i => this.remapMenuItem(i)),
        }
        if (item.click) {
            this.contextMenuHandlers.set(cmi, item.click)
        }
        return cmi
    }

    async showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult> {
        const modal = this.ngbModal.open(MessageBoxModalComponent, {
            backdrop: 'static',
        })
        const instance: MessageBoxModalComponent = modal.componentInstance
        instance.options = options
        try {
            const response = await modal.result
            return { response }
        } catch {
            return { response: options.cancelId ?? 1 }
        }
    }

    quit (): void {
        window.close()
    }

    async startDownload (name: string, mode: number, size: number): Promise<FileDownload|null> {
        let writer: BrowserFileWriter | null = null
        const showSaveFilePicker = (window as any).showSaveFilePicker as ((options: { suggestedName: string }) => Promise<BrowserFileHandle>) | undefined
        if (showSaveFilePicker) {
            try {
                const handle = await showSaveFilePicker.call(window, { suggestedName: name })
                writer = await handle.createWritable()
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    return null
                }
                console.warn('Could not open a streaming browser download, falling back to an in-memory download', error)
            }
        }

        const transfer = new HTMLFileDownload(name, mode, size, writer)
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startDownloadDirectory (_name: string, _estimatedSize?: number): Promise<DirectoryDownload|null> {
        throw new Error('Unsupported')
    }

    startUpload (options?: FileUploadOptions): Promise<FileUpload[]> {
        return new Promise(resolve => {
            this.fileSelector.onchange = () => {
                const transfers: FileUpload[] = []
                const fileList = this.fileSelector.files!
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                for (let i = 0; i < (fileList.length ?? 0); i++) {
                    const file = fileList[i]
                    const transfer = new HTMLFileUpload(file)
                    this.fileTransferStarted.next(transfer)
                    transfers.push(transfer)
                    if (!options?.multiple) {
                        break
                    }
                }
                resolve(transfers)
            }
            this.fileSelector.click()
        })
    }

    async startUploadDirectory (_paths?: string[]): Promise<DirectoryUpload> {
        return new DirectoryUpload()
    }

    setErrorHandler (handler: (_: any) => void): void {
        window.addEventListener('error', handler)
    }

    async pickDirectory (): Promise<string> {
        throw new Error('Unsupported')
    }
}

class HTMLFileDownload extends FileDownload {
    private buffers: Uint8Array[] = []
    private finalization?: Promise<void>
    private aborted = false

    constructor (
        private name: string,
        private mode: number,
        private size: number,
        private writer: BrowserFileWriter | null,
    ) {
        super()
    }

    getName (): string {
        return this.name
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async write (buffer: Uint8Array): Promise<void> {
        if (this.getState() !== 'running') {
            throw new Error('Download is no longer writable')
        }
        if (this.writer) {
            await this.writer.write(buffer)
        } else {
            this.buffers.push(Uint8Array.from(buffer))
        }
        this.increaseProgress(buffer.length)
    }

    async finalize (): Promise<void> {
        this.finalization ??= this.commit()
        await this.finalization
    }

    close (): void {
        void this.abortDownload()
    }

    protected abort (): void {
        void this.abortDownload()
    }

    private async commit (): Promise<void> {
        this.setFinalizing()
        try {
            if (this.getCompletedBytes() !== this.size) {
                throw new Error(`Expected ${this.size} bytes, received ${this.getCompletedBytes()}`)
            }
            if (this.writer) {
                const writer = this.writer
                this.writer = null
                await writer.close()
            } else {
                this.finish()
            }
            this.setCompleted(true)
        } catch (error) {
            this.fail(error)
            throw error
        }
    }

    private finish (): void {
        const blob = new Blob(this.buffers, { type: 'application/octet-stream' })
        this.buffers = []
        const element = window.document.createElement('a')
        const objectURL = window.URL.createObjectURL(blob)
        element.href = objectURL
        element.download = this.name
        document.body.appendChild(element)
        element.click()
        document.body.removeChild(element)
        setTimeout(() => window.URL.revokeObjectURL(objectURL), 1000)
    }

    private async abortDownload (): Promise<void> {
        if (this.aborted) {
            return
        }
        this.aborted = true
        this.buffers = []
        const writer = this.writer
        this.writer = null
        await writer?.abort().catch(() => undefined)
    }
}
