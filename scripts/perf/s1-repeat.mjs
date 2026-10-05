// Repeat the S1 `cat` throughput run WITHOUT a CPU profiler attached, on the
// tab set up by a previous profiler.mjs run (reuses window.__perf). Closes all
// other tabs first and selects ours so the terminal is visible.
//
//   PERF_LOG_FILE=/tmp/huge.log node scripts/perf/s1-repeat.mjs [runs=4]
import { statSync } from 'fs'
import { CDP, findRendererTarget, sleep } from './cdp.mjs'

const LOG_FILE = process.env.PERF_LOG_FILE
if (!LOG_FILE) { throw new Error('set PERF_LOG_FILE') }
const LOG_SIZE = statSync(LOG_FILE).size
const runs = parseInt(process.argv[2] ?? '4')

const cdp = await CDP.connect((await findRendererTarget()).webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

console.log('prepare:', JSON.stringify(await cdp.eval(`(async () => {
    const p = window.__perf
    if (!p?.term?.session?.open) { throw new Error('no live __perf tab — run profiler.mjs first in this app instance') }
    const ngZone = p.injector.get(require('@angular/core').NgZone)
    const ours = p.app.tabs.find(t => t === p.tab || (t.getAllTabs?.() ?? []).includes(p.term))
    for (const t of [...p.app.tabs]) {
        if (t !== ours) { try { await ngZone.run(() => p.app.closeTab(t, false)) } catch {} }
    }
    ngZone.run(() => p.app.selectTab(ours))
    await new Promise(r => setTimeout(r, 1500))
    p.term.sendInput('clear\\n')
    await new Promise(r => setTimeout(r, 1000))
    return { tabs: p.app.tabs.length, active: p.app.activeTab === ours, cols: p.term.frontend.xterm.cols, rows: p.term.frontend.xterm.rows }
})()`)))

const results = []
for (let r = 0; r < runs; r++) {
    await cdp.eval(`(() => {
        const p = window.__perf
        p.bytes = 0
        p.lastGrowth = performance.now()
        p.t0 = performance.now()
        p.term.sendInput(${JSON.stringify(`cat ${LOG_FILE}\n`)})
    })()`, false)
    let stats
    for (let i = 0; i < 300; i++) {
        await sleep(500)
        stats = await cdp.eval(`(() => {
            const p = window.__perf
            return { bytes: p.bytes, sinceGrowth: performance.now() - p.lastGrowth, wall: p.lastGrowth - p.t0 }
        })()`, false)
        if (stats.bytes >= LOG_SIZE * 0.98 && stats.sinceGrowth > 2000) { break }
        if (stats.sinceGrowth > 15000) { break }
    }
    const mbps = +(stats.bytes / 1048576 / (stats.wall / 1000)).toFixed(1)
    results.push(mbps)
    console.log(`run ${r + 1}: ${mbps} MB/s  bytes=${stats.bytes} wall=${Math.round(stats.wall)}ms`)
    await sleep(3000)
}
const mean = results.reduce((a, b) => a + b, 0) / results.length
console.log(`mean ${mean.toFixed(2)} MB/s  (min ${Math.min(...results)}, max ${Math.max(...results)}, n=${results.length})`)
process.exit(0)
