// Output-correctness check for the local PTY -> IPC -> xterm path with
// multi-byte UTF-8 (2/3/4-byte sequences), so chunk boundaries land inside
// characters thousands of times. Checks that:
//  - every IPC payload is valid UTF-8 on its own (main's splitter never cuts
//    a character in half)
//  - the concatenated payloads equal the file (with the tty's \n -> \r\n)
//  - the tail of the file is rendered verbatim in the xterm buffer
// Requires a previous profiler.mjs run (window.__perf).
//
//   node scripts/perf/utf8-integrity.mjs [/tmp/utf8-test.log] [sizeMB=8]
import assert from 'assert/strict'
import { writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { CDP, findRendererTarget, sleep } from './cdp.mjs'

const FILE = process.argv[2] ?? '/tmp/utf8-test.log'
const sizeMB = parseInt(process.argv[3] ?? '8')

// Deterministic content (no PRNG - a previous LCG overflowed double precision
// and never produced 3/4-byte characters). Characters of every UTF-8 width
// (1/2/3/4 bytes) take turns, each preceded by 0..PADDING-1 ASCII bytes, so
// multi-byte characters start at every byte offset modulo BOUNDARY_PERIOD in
// the stream main splits (the tty output, with \n -> \r\n): a read boundary
// at any offset mod BOUNDARY_PERIOD (reads here are ~4095 bytes) falls inside
// characters of every width at every inner position somewhere in the file.
// Both properties are asserted below, not assumed.
const CHARS = {
    1: [...'abcdefghijklmnopqrstuvwxyz0123456789'],
    2: [...'éñüßЖЯλΩ'],
    3: [...'ログ出力の文字化け検証日本語漢字かなカナ処理完了接続端末転送'],
    4: [...'😀🚀🎉👍🔥🦀🧪🌏'],
}
const WIDTHS = [1, 2, 3, 4]
const PADDING = 5
const UNITS_PER_LINE = 24
const BOUNDARY_PERIOD = 4096
for (const w of WIDTHS) {
    for (const c of CHARS[w]) {
        assert.equal(Buffer.byteLength(c), w, `${c} is not a ${w}-byte character`)
    }
}

const lines = []
const charCount = { 1: 0, 2: 0, 3: 0, 4: 0 }
// for each multi-byte width: which offsets (mod BOUNDARY_PERIOD) a character starts at
const startOffsets = { 2: new Uint8Array(BOUNDARY_PERIOD), 3: new Uint8Array(BOUNDARY_PERIOD), 4: new Uint8Array(BOUNDARY_PERIOD) }
let size = 0
let streamOffset = 0
let unit = 0
for (let i = 0; size < sizeMB * 1048576; i++) {
    let s = `${String(i).padStart(7, '0')} `
    for (let j = 0; j < UNITS_PER_LINE; j++, unit++) {
        s += '.'.repeat(unit % PADDING)
        const w = WIDTHS[unit % WIDTHS.length]
        const c = CHARS[w][Math.floor(unit / WIDTHS.length) % CHARS[w].length]
        if (w > 1) {
            startOffsets[w][(streamOffset + Buffer.byteLength(s)) % BOUNDARY_PERIOD] = 1
        }
        charCount[w]++
        s += c
    }
    lines.push(s)
    size += Buffer.byteLength(s) + 1
    streamOffset += Buffer.byteLength(s) + 2
}
const boundaryCoverage = {}
for (const w of [2, 3, 4]) {
    const covered = startOffsets[w].reduce((a, b) => a + b, 0)
    boundaryCoverage[w] = `${covered}/${BOUNDARY_PERIOD}`
    assert.equal(covered, BOUNDARY_PERIOD, `${w}-byte characters don't start at every offset mod ${BOUNDARY_PERIOD}`)
}
for (const w of WIDTHS) {
    assert.ok(charCount[w] > 0, `no ${w}-byte characters generated`)
}
const content = lines.join('\n') + '\n'
writeFileSync(FILE, content)
const expected = Buffer.from(content.replace(/\n/g, '\r\n'))
const expectedSha = createHash('sha256').update(expected).digest('hex')
console.log(`wrote ${lines.length} lines, ${Buffer.byteLength(content)} bytes to ${FILE}`)
console.log(`characters by UTF-8 width: ${JSON.stringify(charCount)}, start offsets covered mod ${BOUNDARY_PERIOD}: ${JSON.stringify(boundaryCoverage)}`)

const cdp = await CDP.connect((await findRendererTarget()).webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.eval(`(() => {
    const p = window.__perf
    const id = p?.term?.session?.pty?.id
    if (!id) { throw new Error('no live __perf tab with a local PTY — run profiler.mjs first') }
    const { ipcRenderer } = require('electron')
    if (p.utf8Listener) { ipcRenderer.removeListener(p.utf8Channel, p.utf8Listener) }
    p.utf8Channel = 'pty:' + id + ':data'
    const fatal = new TextDecoder('utf-8', { fatal: true })
    p.utf8 = { chunks: [], invalid: 0, msgs: 0, lastGrowth: performance.now() }
    p.utf8Listener = (_e, data) => {
        const u = p.utf8
        u.msgs++
        u.chunks.push(Buffer.from(data))
        try { fatal.decode(data) } catch { u.invalid++ }
        u.lastGrowth = performance.now()
    }
    ipcRenderer.on(p.utf8Channel, p.utf8Listener)
    p.term.sendInput('clear\\n')
})()`, false)
await sleep(1000)
await cdp.eval(`(() => { const p = window.__perf; p.utf8.chunks = []; p.utf8.invalid = 0; p.utf8.msgs = 0; p.term.sendInput(${JSON.stringify(`cat ${FILE}\n`)}) })()`, false)
for (let i = 0; i < 240; i++) {
    await sleep(500)
    const idle = await cdp.eval('performance.now() - window.__perf.utf8.lastGrowth', false)
    if (idle > 3000) { break }
}

const tail = lines.slice(-10)
const r = await cdp.eval(`(() => {
    const p = window.__perf
    require('electron').ipcRenderer.removeListener(p.utf8Channel, p.utf8Listener)
    p.utf8Listener = null
    const all = Buffer.concat(p.utf8.chunks)
    const text = all.toString('utf8')
    // the stream is: echo of the command, the file output, the next prompt —
    // cut out the file output and hash it byte for byte
    const head = Buffer.from(${JSON.stringify(lines[0] + '\r\n')})
    const start = all.indexOf(head)
    const body = start >= 0 ? all.subarray(start, start + ${expected.length}) : Buffer.alloc(0)
    // rebuild logical lines from the xterm buffer (joining wrapped rows)
    const buf = p.term.frontend.xterm.buffer.active
    const rows = []
    for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y)
        const s = line.translateToString(true)
        if (line.isWrapped && rows.length) { rows[rows.length - 1] += s } else { rows.push(s) }
    }
    const tail = ${JSON.stringify(tail)}
    return {
        msgs: p.utf8.msgs,
        invalidPayloads: p.utf8.invalid,
        replacementChars: (text.match(/\\uFFFD/g) || []).length,
        receivedBytes: all.length,
        fileOutputSha256: require('crypto').createHash('sha256').update(body).digest('hex'),
        xtermTailRendered: tail.every(t => rows.includes(t)),
    }
})()`, false)

const ok = r.invalidPayloads === 0 && r.replacementChars === 0 && r.fileOutputSha256 === expectedSha && r.xtermTailRendered
console.log(JSON.stringify({ ...r, expectedSha256: expectedSha, sha256Match: r.fileOutputSha256 === expectedSha }, null, 2))
console.log(ok ? 'UTF-8 INTEGRITY: PASS' : 'UTF-8 INTEGRITY: FAIL')
process.exit(ok ? 0 : 1)
