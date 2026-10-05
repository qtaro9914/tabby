// Main -> renderer IPC micro-benchmark: 12,800 x 4095-byte Buffers via
// webContents.send, varying only where the Buffer's memory comes from.
// Electron serializes a Buffer's whole backing ArrayBuffer, so views into
// Node's allocation pool (Buffer.poolSize: 8 KiB on Node 22, 64 KiB on
// Node 24) cost far more than exactly-sized Buffers. Requires --inspect.
//
//   node scripts/perf/ipc-bench.mjs
import { CDP, findRendererTarget, findMainProcessTarget, sleep } from './cdp.mjs'

const renderer = await CDP.connect((await findRendererTarget()).webSocketDebuggerUrl)
await renderer.send('Runtime.enable')
const main = await CDP.connect((await findMainProcessTarget()).webSocketDebuggerUrl)
await main.send('Runtime.enable')

const N = 12800
const VARIANTS = {
    'Buffer.alloc(4095) — own ArrayBuffer': '() => Buffer.alloc(4095, 97)',
    'Buffer.from(4095-char string) — pooled view': '(i) => Buffer.from(String.fromCharCode(97 + i % 26).repeat(4095))',
    'Buffer.allocUnsafe(4095) — pooled view': '() => Buffer.allocUnsafe(4095).fill(98)',
    'subarray of a 1 MiB Buffer': '(() => { const big = Buffer.alloc(1048576, 99); return (i) => big.subarray((i * 4095) % 1040000, (i * 4095) % 1040000 + 4095) })()',
}

const results = { electron: await main.evalNode('process.versions.electron'), poolSize: await main.evalNode('Buffer.poolSize') }
for (const [name, make] of Object.entries(VARIANTS)) {
    await renderer.eval(`(() => {
        const { ipcRenderer } = require('electron')
        window.__ipcBench = { n: 0, done: 0 }
        ipcRenderer.removeAllListeners('perf:ipc-bench')
        ipcRenderer.on('perf:ipc-bench', () => { const b = window.__ipcBench; if (++b.n === ${N}) { b.done = performance.now() } })
    })()`, false)
    const r = await main.evalNode(`(() => {
        const wc = require('electron').webContents.getAllWebContents().find(w => w.getURL().endsWith('index.html'))
        const make = ${make}
        const bufs = Array.from({ length: ${N} }, (_, i) => make(i))
        const t0 = Date.now()
        for (const b of bufs) { wc.send('perf:ipc-bench', b) }
        return { sendMs: Date.now() - t0, t0, backing: bufs[0].buffer.byteLength }
    })()`)
    let got
    for (let i = 0; i < 240; i++) {
        await sleep(250)
        got = await renderer.eval('({ ...window.__ipcBench, origin: performance.timeOrigin })', false)
        if (got.done) { break }
    }
    results[name] = {
        backingBytes: r.backing,
        mainSendMs: r.sendMs,
        usPerMessage: +(r.sendMs * 1000 / N).toFixed(1),
        endToEndMs: got.done ? Math.round(got.origin + got.done - r.t0) : 'timeout',
        received: got.n,
    }
    await sleep(1500)
}
await renderer.eval(`require('electron').ipcRenderer.removeAllListeners('perf:ipc-bench')`, false)
console.log(JSON.stringify(results, null, 2))
process.exit(0)
