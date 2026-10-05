// Count the PTY output IPC messages of one S1 `cat`, on both ends:
//  - main: every `pty:<id>:data` payload handed to webContents.send — its
//    length and the size of its backing ArrayBuffer (Electron serializes the
//    whole backing store, so that is what actually crosses IPC)
//  - renderer: messages and bytes received on the tab's data channel
// Requires --inspect (main) and a previous profiler.mjs run (window.__perf).
//
//   PERF_LOG_FILE=/tmp/huge.log node scripts/perf/ipc-count.mjs
import { statSync } from 'fs'
import { CDP, findRendererTarget, findMainProcessTarget, sleep } from './cdp.mjs'

const LOG_FILE = process.env.PERF_LOG_FILE
if (!LOG_FILE) { throw new Error('set PERF_LOG_FILE') }
const LOG_SIZE = statSync(LOG_FILE).size

const renderer = await CDP.connect((await findRendererTarget()).webSocketDebuggerUrl)
await renderer.send('Runtime.enable')
const main = await CDP.connect((await findMainProcessTarget()).webSocketDebuggerUrl)
await main.send('Runtime.enable')

const channel = await renderer.eval(`(() => {
    const p = window.__perf
    const id = p?.term?.session?.pty?.id
    if (!id) { throw new Error('no live __perf tab with a local PTY — run profiler.mjs first') }
    const { ipcRenderer } = require('electron')
    if (p.ipcListener) { ipcRenderer.removeListener(p.ipcChannel, p.ipcListener) }
    p.ipcChannel = 'pty:' + id + ':data'
    p.ipcStats = { n: 0, bytes: 0 }
    p.ipcListener = (_e, data) => { p.ipcStats.n++; p.ipcStats.bytes += data.length }
    ipcRenderer.on(p.ipcChannel, p.ipcListener)
    return p.ipcChannel
})()`, false)

await main.evalNode(`(() => {
    const wc = require('electron').webContents.getAllWebContents().find(w => w.getURL().endsWith('index.html'))
    globalThis.__ipcCount = { lengths: [], backings: [] }
    // shadow the prototype method on this instance; removed again below
    wc.send = function (ch, ...args) {
        if (ch === ${JSON.stringify(channel)} && args[0]?.buffer) {
            globalThis.__ipcCount.lengths.push(args[0].length)
            globalThis.__ipcCount.backings.push(args[0].buffer.byteLength)
        }
        return Object.getPrototypeOf(wc).send.call(this, ch, ...args)
    }
})()`)

await renderer.eval(`(() => {
    const p = window.__perf
    p.bytes = 0
    p.lastGrowth = p.t0 = performance.now()
    p.term.sendInput(${JSON.stringify(`cat ${LOG_FILE}\n`)})
})()`, false)
let stats
for (let i = 0; i < 300; i++) {
    await sleep(500)
    stats = await renderer.eval(`(() => {
        const p = window.__perf
        return { bytes: p.bytes, sinceGrowth: performance.now() - p.lastGrowth, wall: p.lastGrowth - p.t0 }
    })()`, false)
    if (stats.bytes >= LOG_SIZE * 0.98 && stats.sinceGrowth > 2000) { break }
    if (stats.sinceGrowth > 15000) { break }
}

const sent = await main.evalNode(`(() => {
    const wc = require('electron').webContents.getAllWebContents().find(w => w.getURL().endsWith('index.html'))
    delete wc.send
    const { lengths, backings } = globalThis.__ipcCount
    delete globalThis.__ipcCount
    const sum = a => a.reduce((x, y) => x + y, 0)
    const median = a => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]
    return {
        msgs: lengths.length,
        payloadBytes: sum(lengths),
        serializedBytes: sum(backings),
        medianPayload: median(lengths),
        medianBacking: median(backings),
        maxBacking: Math.max(...backings),
        exactSize: backings.filter((b, i) => b === lengths[i]).length,
    }
})()`)
const received = await renderer.eval(`(() => {
    const p = window.__perf
    require('electron').ipcRenderer.removeListener(p.ipcChannel, p.ipcListener)
    p.ipcListener = null
    return p.ipcStats
})()`, false)

console.log(JSON.stringify({
    mbPerSec: +(stats.bytes / 1048576 / (stats.wall / 1000)).toFixed(1),
    main: { ...sent, serializedPerPayload: +(sent.serializedBytes / sent.payloadBytes).toFixed(2) },
    renderer: received,
}, null, 2))
process.exit(0)
