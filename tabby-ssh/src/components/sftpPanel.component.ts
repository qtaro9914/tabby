import * as C from 'constants'
import { posix as path } from 'path'
import { Component, Input, Output, EventEmitter, Inject, Optional } from '@angular/core'
import { FileUpload, DirectoryUpload, DirectoryDownload, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'
import { SFTPSession, SFTPFile } from '../session/sftp'
import { SSHSession } from '../session/ssh'
import { SFTPContextMenuItemProvider } from '../api'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { SFTPCreateDirectoryModalComponent } from './sftpCreateDirectoryModal.component'

interface PathSegment {
    name: string
    path: string
}

@Component({
    selector: 'sftp-panel',
    templateUrl: './sftpPanel.component.pug',
    styleUrls: ['./sftpPanel.component.scss'],
})
export class SFTPPanelComponent {
    @Input() session: SSHSession
    @Output() closed = new EventEmitter<void>()
    sftp: SFTPSession
    fileList: SFTPFile[]|null = null
    filteredFileList: SFTPFile[] = []
    @Input() path = '/'
    @Output() pathChange = new EventEmitter<string>()
    pathSegments: PathSegment[] = []
    @Input() cwdDetectionAvailable = false
    editingPath: string|null = null
    showFilter = false
    filterText = ''

    constructor (
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        public platform: PlatformService,
        @Optional() @Inject(SFTPContextMenuItemProvider) protected contextMenuProviders: SFTPContextMenuItemProvider[],
    ) {
        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    async ngOnInit (): Promise<void> {
        this.sftp = await this.session.openSFTP()
        try {
            await this.navigate(this.path)
        } catch (error) {
            console.warn('Could not navigate to', this.path, ':', error)
            this.notifications.error(error.message)
            await this.navigate('/')
        }
    }

    async navigate (newPath: string, fallbackOnError = true): Promise<void> {
        const previousPath = this.path
        this.path = newPath
        this.pathChange.next(this.path)

        this.clearFilter()

        let p = newPath
        this.pathSegments = []
        while (p !== '/' && p !== '.') {
            this.pathSegments.unshift({
                name: path.basename(p),
                path: p,
            })
            const parent = path.dirname(p)
            if (parent === p) {
                break
            }
            p = parent
        }

        this.fileList = null
        this.filteredFileList = []
        try {
            this.fileList = await this.sftp.readdir(this.path)
        } catch (error) {
            this.notifications.error(error.message)
            if (previousPath && fallbackOnError) {
                this.navigate(previousPath, false)
            }
            return
        }

        const dirKey = a => a.isDirectory ? 1 : 0
        this.fileList.sort((a, b) =>
            dirKey(b) - dirKey(a) ||
            a.name.localeCompare(b.name))

        this.updateFilteredList()
    }

    getFileType (fileExtension: string): string {
        const codeExtensions = ['js', 'ts', 'py', 'java', 'cpp', 'h', 'cs', 'html', 'css', 'rb', 'php', 'swift', 'go', 'kt', 'sh', 'json', 'cc', 'c', 'xml']
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp']
        const pdfExtensions = ['pdf']
        const archiveExtensions = ['zip', 'rar', 'tar', 'gz']
        const wordExtensions = ['doc', 'docx']
        const videoExtensions = ['mp4', 'avi', 'mkv', 'mov']
        const powerpointExtensions = ['ppt', 'pptx']
        const textExtensions = ['txt', 'log']
        const audioExtensions = ['mp3', 'wav', 'flac']
        const excelExtensions = ['xls', 'xlsx']

        const lowerCaseExtension = fileExtension.toLowerCase()

        if (codeExtensions.includes(lowerCaseExtension)) {
            return 'code'
        } else if (imageExtensions.includes(lowerCaseExtension)) {
            return 'image'
        } else if (pdfExtensions.includes(lowerCaseExtension)) {
            return 'pdf'
        } else if (archiveExtensions.includes(lowerCaseExtension)) {
            return 'archive'
        } else if (wordExtensions.includes(lowerCaseExtension)) {
            return 'word'
        } else if (videoExtensions.includes(lowerCaseExtension)) {
            return 'video'
        } else if (powerpointExtensions.includes(lowerCaseExtension)) {
            return 'powerpoint'
        } else if (textExtensions.includes(lowerCaseExtension)) {
            return 'text'
        } else if (audioExtensions.includes(lowerCaseExtension)) {
            return 'audio'
        } else if (excelExtensions.includes(lowerCaseExtension)) {
            return 'excel'
        } else {
            return 'unknown'
        }
    }

    getIcon (item: SFTPFile): string {
        if (item.isDirectory) {
            return 'fas fa-folder text-info'
        }
        if (item.isSymlink) {
            return 'fas fa-link text-warning'
        }
        const fileMatch = /\.([^.]+)$/.exec(item.name)
        const extension = fileMatch ? fileMatch[1] : null
        if (extension !== null) {
            const fileType = this.getFileType(extension)

            switch (fileType) {
                case 'unknown':
                    return 'fas fa-file'
                default:
                    return `fa-solid fa-file-${fileType} `
            }
        }
        return 'fas fa-file'
    }

    goUp (): void {
        this.navigate(path.dirname(this.path))
    }

    async open (item: SFTPFile): Promise<void> {
        if (item.isDirectory) {
            await this.navigate(item.fullPath)
        } else if (item.isSymlink) {
            const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
            const stat = await this.sftp.stat(target)
            if (stat.isDirectory) {
                await this.navigate(item.fullPath)
            } else {
                await this.download(item.fullPath, stat.mode, stat.size)
            }
        } else {
            await this.download(item.fullPath, item.mode, item.size)
        }
    }

    async downloadItem (item: SFTPFile): Promise<void> {
        if (item.isDirectory) {
            await this.downloadFolder(item)
            return
        }

        if (item.isSymlink) {
            const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
            const stat = await this.sftp.stat(target)
            if (stat.isDirectory) {
                await this.downloadFolder(item)
                return
            }
            await this.download(item.fullPath, stat.mode, stat.size)
            return
        }

        await this.download(item.fullPath, item.mode, item.size)
    }

    async openCreateDirectoryModal (): Promise<void> {
        const modal = this.ngbModal.open(SFTPCreateDirectoryModalComponent)
        const directoryName = await modal.result.catch(() => null)
        if (directoryName?.trim()) {
            this.sftp.mkdir(path.join(this.path, directoryName)).then(() => {
                this.notifications.notice('The directory was created successfully')
                this.navigate(path.join(this.path, directoryName))
            }).catch(() => {
                this.notifications.error('The directory could not be created')
            })
        }
    }

    async upload (): Promise<void> {
        const transfers = await this.platform.startUpload({ multiple: true })
        if (!transfers.length) {
            return
        }
        const savedPath = this.path
        try {
            const sftp = await this.openTransferSFTP()
            await this.runWithConcurrency(transfers, 4, transfer =>
                sftp.upload(path.join(savedPath, transfer.getName()), transfer),
            )
        } catch (error) {
            for (const transfer of transfers) {
                transfer.cancel()
            }
            throw error
        }
        if (this.path === savedPath) {
            await this.navigate(this.path)
        }
    }

    async uploadFolder (): Promise<void> {
        const transfer = await this.platform.startUploadDirectory()
        const savedPath = this.path
        await this.uploadOneFolder(transfer)
        if (this.path === savedPath) {
            await this.navigate(this.path)
        }
    }

    async uploadOneFolder (transfer: DirectoryUpload): Promise<void> {
        const basePath = this.path
        try {
            const sftp = await this.openTransferSFTP()
            await this.uploadFolderContents(transfer, sftp, basePath)
        } catch (error) {
            this.cancelDirectoryUpload(transfer)
            throw error
        }
    }

    async openTransferSFTP (): Promise<SFTPSession> {
        return this.session.openSFTP('transfer')
    }

    private async uploadFolderContents (
        transfer: DirectoryUpload,
        sftp: SFTPSession,
        basePath: string,
        accumPath = '',
    ): Promise<void> {
        for(const t of transfer.getChildrens()) {
            if (t instanceof DirectoryUpload) {
                const remotePath = path.posix.join(basePath, accumPath, t.getName())
                try {
                    await sftp.mkdir(remotePath)
                } catch (error) {
                    const existing = await sftp.stat(remotePath).catch(() => null)
                    if (!existing?.isDirectory) {
                        throw error
                    }
                }
                await this.uploadFolderContents(t, sftp, basePath, path.posix.join(accumPath, t.getName()))
                await sftp.chmod(remotePath, t.getMode() & 0o7777).catch(error => {
                    console.warn('Could not preserve SFTP directory permissions:', remotePath, error)
                })
            } else {
                await sftp.upload(path.posix.join(basePath, accumPath, t.getName()), t)
            }
        }
    }

    async uploadOne (transfer: FileUpload): Promise<void> {
        const savedPath = this.path
        try {
            const sftp = await this.openTransferSFTP()
            await sftp.upload(path.join(savedPath, transfer.getName()), transfer)
        } catch (error) {
            transfer.fail(error)
            throw error
        }
        if (this.path === savedPath) {
            await this.navigate(this.path)
        }
    }

    async download (itemPath: string, mode: number, size: number): Promise<void> {
        const transfer = await this.platform.startDownload(path.basename(itemPath), mode, size)
        if (!transfer) {
            return
        }
        try {
            const sftp = await this.openTransferSFTP()
            await sftp.download(itemPath, transfer)
        } catch (error) {
            transfer.fail(error)
            this.notifications.error(`Failed to download ${path.basename(itemPath)}: ${error.message}`)
            throw error
        }
    }

    async downloadFolder (folder: SFTPFile): Promise<void> {
        try {
            const transfer = await this.platform.startDownloadDirectory(folder.name, 0)
            if (!transfer) {
                return
            }

            try {
                const sftp = await this.openTransferSFTP()
                transfer.setStatus('Downloading')
                const totalSize = await this.downloadFolderContents(folder, '', transfer, sftp)
                if (folder.mode) {
                    await transfer.setDirectoryMode('', folder.mode)
                }
                transfer.setTotalSize(totalSize)
                transfer.setStatus('')
                transfer.setFinalizing()
                transfer.close()
                transfer.setCompleted(true)
            } catch (error) {
                transfer.fail(error)
                throw error
            } finally {
                if (!transfer.isComplete()) {
                    transfer.close()
                }
            }
        } catch (error) {
            this.notifications.error(`Failed to download folder: ${error.message}`)
            throw error
        }
    }

    private async downloadFolderContents (
        folder: SFTPFile,
        relativePath: string,
        transfer: DirectoryDownload,
        sftp: SFTPSession,
    ): Promise<number> {
        let totalSize = 0
        const items = await sftp.readdir(folder.fullPath)
        for (const item of items) {
            if (transfer.isCancelled()) {
                throw new Error('Download cancelled')
            }
            const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name
            transfer.setStatus(itemRelativePath)
            if (item.isSymlink) {
                const target = await sftp.readlink(item.fullPath)
                const targetPath = path.resolve(path.dirname(item.fullPath), target)
                const targetIsDirectory = await sftp.stat(targetPath).then(stat => stat.isDirectory, () => false)
                await transfer.createSymbolicLink(itemRelativePath, target, targetIsDirectory)
            } else if (item.isDirectory) {
                await transfer.createDirectory(itemRelativePath)
                totalSize += await this.downloadFolderContents(item, itemRelativePath, transfer, sftp)
                if (item.mode) {
                    await transfer.setDirectoryMode(itemRelativePath, item.mode)
                }
            } else {
                const fileDownload = await transfer.createFile(itemRelativePath, item.mode, item.size)
                await sftp.download(item.fullPath, fileDownload)
                transfer.reportFileCompleted(item.size)
                totalSize += item.size
            }
        }
        return totalSize
    }

    private async runWithConcurrency<T> (items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
        let nextIndex = 0
        const errors: unknown[] = []
        const worker = async () => {
            while (!errors.length && nextIndex < items.length) {
                const item = items[nextIndex++]
                try {
                    await task(item)
                } catch (error) {
                    errors.push(error)
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
        if (errors.length) {
            throw errors[0]
        }
    }

    private cancelDirectoryUpload (directory: DirectoryUpload): void {
        for (const child of directory.getChildrens()) {
            if (child instanceof DirectoryUpload) {
                this.cancelDirectoryUpload(child)
            } else {
                child.cancel()
            }
        }
    }

    getModeString (item: SFTPFile): string {
        const s = 'SGdrwxrwxrwx'
        const e = '   ---------'
        const c = [
            0o4000, 0o2000, C.S_IFDIR,
            C.S_IRUSR, C.S_IWUSR, C.S_IXUSR,
            C.S_IRGRP, C.S_IWGRP, C.S_IXGRP,
            C.S_IROTH, C.S_IWOTH, C.S_IXOTH,
        ]
        let result = ''
        for (let i = 0; i < c.length; i++) {
            result += item.mode & c[i] ? s[i] : e[i]
        }
        return result
    }

    async buildContextMenu (item: SFTPFile): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(item, this)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        return items.slice(1)
    }

    async showContextMenu (item: SFTPFile, event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(item), event)
    }

    get shouldShowCWDTip (): boolean {
        return !window.localStorage.sshCWDTipDismissed
    }

    dismissCWDTip (): void {
        window.localStorage.sshCWDTipDismissed = 'true'
    }

    editPath (): void {
        this.editingPath = this.path
    }

    confirmPath (): void {
        if (this.editingPath === null) {
            return
        }
        this.navigate(this.editingPath)
        this.editingPath = null
    }

    close (): void {
        this.closed.emit()
    }

    clearFilter (): void {
        this.showFilter = false
        this.filterText = ''
        this.updateFilteredList()
    }

    onFilterChange (): void {
        this.updateFilteredList()
    }

    private updateFilteredList (): void {
        if (!this.fileList) {
            this.filteredFileList = []
            return
        }

        if (!this.showFilter || this.filterText.trim() === '') {
            this.filteredFileList = this.fileList
            return
        }

        this.filteredFileList = this.fileList.filter(item =>
            item.name.toLowerCase().includes(this.filterText.toLowerCase()),
        )
    }
}
