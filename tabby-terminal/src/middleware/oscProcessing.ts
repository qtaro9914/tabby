import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const ESC = 0x1b
const BEL = 0x07
const ST_END = 0x5c
const OSCPrefix = Buffer.from('\x1b]')
const OSCStringTerminator = Buffer.from('\x1b\\')
const MAX_OSC_BYTES = 1024 * 1024
const MAX_CLIPBOARD_BYTES = 768 * 1024

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private copyRequested = new Subject<string>()
    private oscChunks: Buffer[] | null = null
    private oscBytes = 0
    private prefixPending = false

    feedFromSession (data: Buffer): void {
        let offset = 0

        if (this.prefixPending) {
            this.prefixPending = false
            if (data[0] === OSCPrefix[1]) {
                this.startOSC()
                offset = 1
            } else {
                super.feedFromSession(Buffer.from([ESC]))
            }
        }

        while (offset < data.length) {
            if (this.oscChunks) {
                offset = this.consumeOSC(data, offset)
                continue
            }

            const prefixIndex = data.indexOf(OSCPrefix, offset)
            if (prefixIndex === -1) {
                const endIndex = data[data.length - 1] === ESC ? data.length - 1 : data.length
                if (offset < endIndex) {
                    super.feedFromSession(data.subarray(offset, endIndex))
                }
                this.prefixPending = endIndex < data.length
                break
            }

            if (prefixIndex > offset) {
                super.feedFromSession(data.subarray(offset, prefixIndex))
            }
            this.startOSC()
            offset = prefixIndex + OSCPrefix.length
        }
    }

    close (): void {
        if (this.prefixPending) {
            super.feedFromSession(Buffer.from([ESC]))
            this.prefixPending = false
        }
        if (this.oscChunks) {
            for (const chunk of this.oscChunks) {
                super.feedFromSession(chunk)
            }
            this.resetOSC()
        }
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }

    private startOSC (): void {
        this.oscChunks = [OSCPrefix]
        this.oscBytes = OSCPrefix.length
    }

    private consumeOSC (data: Buffer, offset: number): number {
        let suffixIndex = -1
        let suffixLength = 0

        if (this.lastOSCByte() === ESC && data[offset] === ST_END) {
            suffixIndex = offset
            suffixLength = 1
        } else {
            const belIndex = data.indexOf(BEL, offset)
            const stIndex = data.indexOf(OSCStringTerminator, offset)
            if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
                suffixIndex = belIndex
                suffixLength = 1
            } else if (stIndex !== -1) {
                suffixIndex = stIndex
                suffixLength = OSCStringTerminator.length
            }
        }

        const endIndex = suffixIndex === -1 ? data.length : suffixIndex + suffixLength
        if (!this.appendOSC(data.subarray(offset, endIndex))) {
            // Drop the oversized control sequence. Subsequent chunks resume as
            // ordinary terminal data instead of extending an unbounded buffer.
            this.resetOSC()
            return endIndex
        }

        if (suffixIndex === -1) {
            return data.length
        }

        const sequence = Buffer.concat(this.oscChunks!, this.oscBytes)
        this.resetOSC()
        const completeSuffixLength = sequence.subarray(-OSCStringTerminator.length).equals(OSCStringTerminator)
            ? OSCStringTerminator.length
            : 1
        if (!this.processOSC(sequence, completeSuffixLength)) {
            super.feedFromSession(sequence)
        }
        return endIndex
    }

    private appendOSC (chunk: Buffer): boolean {
        if (this.oscBytes + chunk.length > MAX_OSC_BYTES) {
            console.warn(`Discarding OSC sequence larger than ${MAX_OSC_BYTES} bytes`)
            return false
        }
        if (chunk.length) {
            this.oscChunks!.push(chunk)
            this.oscBytes += chunk.length
        }
        return true
    }

    private processOSC (sequence: Buffer, suffixLength: number): boolean {
        const oscString = sequence.subarray(OSCPrefix.length, sequence.length - suffixLength).toString()
        const separatorIndex = oscString.indexOf(';')
        if (separatorIndex === -1) {
            return false
        }

        const oscCode = Number(oscString.substring(0, separatorIndex))
        const parameters = oscString.substring(separatorIndex + 1)
        if (oscCode === 1337 && parameters.startsWith('CurrentDir=')) {
            let reportedCWD = parameters.substring('CurrentDir='.length)
            if (reportedCWD.startsWith('~')) {
                reportedCWD = os.homedir() + reportedCWD.substring(1)
            }
            this.cwdReported.next(reportedCWD)
            return true
        }

        if (oscCode !== 52) {
            return false
        }
        const valueSeparatorIndex = parameters.indexOf(';')
        if (valueSeparatorIndex === -1) {
            return false
        }
        const selection = parameters.substring(0, valueSeparatorIndex)
        const encodedContent = parameters.substring(valueSeparatorIndex + 1)
        if (selection !== 'c' && selection !== '') {
            return false
        }
        if (!this.isValidBase64(encodedContent)) {
            return false
        }
        if (encodedContent.length > Math.ceil(MAX_CLIPBOARD_BYTES * 4 / 3) + 2) {
            console.warn(`Discarding OSC 52 clipboard payload larger than ${MAX_CLIPBOARD_BYTES} bytes`)
            return true
        }

        const content = Buffer.from(encodedContent, 'base64')
        if (content.length > MAX_CLIPBOARD_BYTES) {
            console.warn(`Discarding OSC 52 clipboard payload larger than ${MAX_CLIPBOARD_BYTES} bytes`)
            return true
        }
        this.copyRequested.next(content.toString())
        return true
    }

    private isValidBase64 (value: string): boolean {
        const paddingIndex = value.indexOf('=')
        return value.length % 4 !== 1
            && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
            && (paddingIndex === -1 || paddingIndex >= value.length - 2)
    }

    private lastOSCByte (): number | undefined {
        const lastChunk = this.oscChunks?.[this.oscChunks.length - 1]
        return lastChunk?.[lastChunk.length - 1]
    }

    private resetOSC (): void {
        this.oscChunks = null
        this.oscBytes = 0
    }
}
