/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import * as russh from 'russh'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

// The fork binding surfaces russh-sftp's request timeout from readAt/writeAt
// as the Debug form of its `Error::Timeout`, i.e. exactly "Timeout". Every
// other error carries a payload (`Status(...)`, `IO(...)`, `Custom { .. }`),
// so an exact match is unambiguous — and if the format ever changes, this
// merely stops matching and the error propagates as before
function isRequestTimeout (error: unknown): boolean {
    return error instanceof Error && error.message === 'Timeout'
}

// The cursor-based calls (writeAll/flush/shutdown) go through russh-sftp's
// AsyncWrite impl, which wraps the same timeout in an io::Error — both stock
// and fork bindings surface it as this exact Debug form
function isCursorRequestTimeout (error: unknown): boolean {
    return error instanceof Error && error.message === 'Custom { kind: Other, error: "Timeout" }'
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private inner: russh.SFTPFile|null,
    ) { }

    async read (): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return this.inner.read(1024 * 1024)
    }

    // readAt/readLimit/writeAt exist only in the patched russh fork
    // (positional, request-id multiplexed I/O) — access via `any` and
    // feature-detect so this still builds and runs against the stock npm russh

    get supportsReadAt (): boolean {
        return typeof (this.inner as any)?.readAt === 'function'
    }

    async readAt (offset: number, n: number): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return (this.inner as any).readAt(offset, n)
    }

    async readLimit (): Promise<number|null> {
        if (!this.inner || typeof (this.inner as any).readLimit !== 'function') {
            return null
        }
        return (this.inner as any).readLimit()
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.writeAll(chunk)
    }

    get supportsWriteAt (): boolean {
        return typeof (this.inner as any)?.writeAt === 'function'
    }

    async writeAt (offset: number, chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await (this.inner as any).writeAt(offset, chunk)
    }

    async flush (): Promise<void> {
        if (typeof (this.inner as any)?.flush === 'function') {
            await (this.inner as any).flush()
        }
    }

    async close (): Promise<void> {
        await this.inner?.shutdown()
        this.inner = null
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger

    constructor (private sftp: russh.SFTP, injector: Injector) {
        this.logger = injector.get(LogService).create('sftp')
        sftp.closed$.subscribe(() => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries = await this.sftp.readDirectory(p)
        return entries.map(entry => this._makeFile(
            posixPath.join(p, entry.name), entry,
        ))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.sftp.readlink(p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await this.sftp.stat(p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.type === russh.SFTPFileType.Directory,
            isSymlink: stats.type === russh.SFTPFileType.Symlink,
            mode: stats.permissions ?? 0,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handle = await this.sftp.open(p, mode)
        return new SFTPFileHandle(handle)
    }

    async rmdir (p: string): Promise<void> {
        await this.sftp.removeDirectory(p)
    }

    async mkdir (p: string): Promise<void> {
        await this.sftp.createDirectory(p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.sftp.rename(oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.sftp.removeFile(p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.sftp.chmod(p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        const tempPath = `${path}.tabby-upload-${suffix}`
        const backupPath = `${path}.tabby-backup-${suffix}`
        let handle: SFTPFileHandle|null = null
        let temporaryFileExists = false
        try {
            handle = await this.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE | russh.OPEN_TRUNCATE)
            temporaryFileExists = true
            if (handle.supportsWriteAt) {
                await this.uploadWithWriteBehind(handle, transfer)
            } else {
                // Stock russh: overlap reading the next local chunk with the
                // in-flight network write. Only one read and one write are ever
                // outstanding — the russh handle does not guarantee ordering
                // for concurrent cursor writes
                let chunk = await transfer.read()
                while (chunk.length) {
                    const nextChunk = transfer.read()
                    nextChunk.catch(() => undefined)
                    await handle.write(chunk)
                    chunk = await nextChunk
                }
            }
            transfer.setFinalizing()
            await transfer.finalize()
            // fsync@openssh.com can outlast russh-sftp's 10 s request timeout
            // on large files / slow disks. Reissuing it is a harmless re-sync
            // and the first one keeps progressing server-side. Only flush is
            // retried — reissuing close could double-close the handle
            const fileHandle = handle
            await this.retryOnTimeout(`flush of ${tempPath}`, isCursorRequestTimeout, () => fileHandle.flush())
            await handle.close()
            handle = null
            await this.chmod(tempPath, transfer.getMode() & 0o7777).catch(error => {
                this.logger.warn('Could not preserve SFTP upload permissions', error)
            })

            let destinationExists = false
            try {
                await this.stat(path)
                destinationExists = true
            } catch (error) {
                if (!this.isNotFoundError(error)) {
                    throw error
                }
            }
            if (destinationExists) {
                await this.rename(path, backupPath)
            }
            try {
                await this.rename(tempPath, path)
                temporaryFileExists = false
            } catch (e) {
                if (destinationExists) {
                    await this.rename(backupPath, path)
                }
                throw e
            }
            if (destinationExists) {
                await this.unlink(backupPath).catch(e => {
                    this.logger.warn('Could not remove SFTP upload backup', e)
                })
            }
            transfer.setCompleted(true)
        } catch (e) {
            transfer.setStatus(e instanceof Error ? e.message : String(e))
            transfer.fail(e)
            throw e
        } finally {
            try {
                await handle?.close()
            } catch (e) {
                this.logger.warn('Could not close SFTP upload handle', e)
            }
            if (temporaryFileExists) {
                await this.unlink(tempPath).catch(() => undefined)
            }
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        let handle: SFTPFileHandle|null = null
        try {
            handle = await this.open(path, russh.OPEN_READ)
            if (handle.supportsReadAt) {
                await this.downloadWithReadAhead(handle, transfer)
            } else {
                // Stock russh: cursor reads are not ordering-safe when issued
                // concurrently, so keep exactly one read in flight and only
                // overlap it with the local write of the previous chunk
                let chunk = await handle.read()
                while (chunk.length) {
                    const nextChunk = handle.read()
                    nextChunk.catch(() => undefined)
                    await transfer.write(chunk)
                    chunk = await nextChunk
                }
            }
            transfer.setFinalizing()
            await transfer.finalize()
            transfer.setCompleted(true)
        } catch (e) {
            transfer.setStatus(e instanceof Error ? e.message : String(e))
            transfer.fail(e)
            throw e
        } finally {
            try {
                await handle?.close()
            } catch (e) {
                this.logger.warn('Could not close SFTP download handle', e)
            }
        }
    }

    // Keep multiple positional writes in flight (matched by SFTP request id)
    // while local chunks are still read sequentially. Mirrors the download
    // read-ahead — ~3x faster than one write at a time over loopback.
    private async uploadWithWriteBehind (handle: SFTPFileHandle, transfer: FileUpload): Promise<void> {
        const DEPTH = 8
        let offset = 0
        const queue: Promise<void>[] = []
        try {
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                const chunkOffset = offset
                const p = this.retryOnTimeout(`write at offset ${chunkOffset}`, isRequestTimeout, () => handle.writeAt(chunkOffset, chunk))
                p.catch(() => undefined)
                queue.push(p)
                offset += chunk.length
                if (queue.length >= DEPTH) {
                    await queue.shift()
                }
            }
            while (queue.length) {
                await queue.shift()
            }
        } finally {
            // never close the handle with writes still in flight
            await Promise.allSettled(queue)
        }
    }

    // Keep multiple positional reads in flight (matched by SFTP request id)
    // and reassemble them in offset order. Hides the request round-trip
    // behind the transfer — ~2.5x faster than sequential reads even over
    // loopback, more on high-latency links.
    private async downloadWithReadAhead (handle: SFTPFileHandle, transfer: FileDownload): Promise<void> {
        const DEPTH = 8
        const DEFAULT_CHUNK_SIZE = 128 * 1024
        // Bound the eight in-flight reads to 8 MiB even if the server advertises more.
        const MAX_CHUNK_SIZE = 1024 * 1024
        const readLimit = await handle.readLimit()
        const chunkSize = readLimit !== null && Number.isSafeInteger(readLimit) && readLimit > 0
            ? Math.min(readLimit, MAX_CHUNK_SIZE)
            : DEFAULT_CHUNK_SIZE

        // One protocol READ per call; servers may return short reads, so
        // extend at the adjusted offset until the slot is full or EOF
        const readAt = (offset: number, n: number) => this.retryOnTimeout(`read at offset ${offset}`, isRequestTimeout, () => handle.readAt(offset, n))
        const readFull = async (offset: number): Promise<Buffer> => {
            let buf = Buffer.from(await readAt(offset, chunkSize))
            while (buf.length && buf.length < chunkSize) {
                const rest = Buffer.from(await readAt(offset + buf.length, chunkSize - buf.length))
                if (!rest.length) {
                    break
                }
                buf = Buffer.concat([buf, rest])
            }
            return buf
        }

        let nextOffset = 0
        let eof = false
        const queue: Promise<Buffer>[] = []
        const enqueue = () => {
            const p = readFull(nextOffset)
            p.catch(() => undefined)
            queue.push(p)
            nextOffset += chunkSize
        }
        for (let i = 0; i < DEPTH; i++) {
            enqueue()
        }
        try {
            while (queue.length) {
                const buf = await queue.shift()!
                if (!buf.length) {
                    eof = true
                    continue
                }
                if (!eof) {
                    enqueue()
                }
                await transfer.write(buf)
            }
        } finally {
            await Promise.allSettled(queue)
        }
    }

    // russh-sftp fails any request that gets no response within a fixed
    // 10 s. For idempotent operations (positional reads/writes, fsync) one
    // that timed out — e.g. while the server stalled on disk I/O — can safely
    // be reissued a bounded number of times. `isTimeout` must match the error
    // form of the call being retried (positional vs. cursor-based)
    private async retryOnTimeout<T> (what: string, isTimeout: (error: unknown) => boolean, op: () => Promise<T>): Promise<T> {
        const MAX_RETRIES = 2
        for (let attempt = 1; ; attempt++) {
            try {
                return await op()
            } catch (e) {
                if (attempt > MAX_RETRIES || !isTimeout(e)) {
                    throw e
                }
                this.logger.warn(`SFTP ${what} timed out (attempt ${attempt}/${MAX_RETRIES + 1}), retrying`)
            }
        }
    }

    private _makeFile (p: string, entry: russh.SFTPDirectoryEntry): SFTPFile {
        return {
            fullPath: p,
            name: posixPath.basename(p),
            isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
            isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
            mode: entry.metadata.permissions ?? 0,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }

    private isNotFoundError (error: unknown): boolean {
        return /NoSuchFile|no such file|SSH_FX_NO_SUCH_FILE/i.test(String(error))
    }
}
