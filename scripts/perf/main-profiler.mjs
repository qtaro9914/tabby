// Profile the Electron MAIN process while the renderer streams bulk output
// (the S1 scenario). Requires the app to be launched with BOTH
// --remote-debugging-port (renderer) and --inspect (main process), and a
// previous profiler.mjs run in the same instance (reuses window.__perf).
//
//   PERF_LOG_FILE=/tmp/huge.log PERF_OUT_DIR=/tmp/perf node scripts/perf/main-profiler.mjs
import { writeFileSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CDP, findRendererTarget, findMainProcessTarget, sleep, summarizeProfile } from './cdp.mjs'

const OUT_DIR = process.env.PERF_OUT_DIR ?? process.cwd()
const LOG_FILE = process.env.PERF_LOG_FILE
if (!LOG_FILE) { throw new Error('set PERF_LOG_FILE') }
const LOG_SIZE = statSync(LOG_FILE).size
mkdirSync(OUT_DIR, { recursive: true })

const MAIN_CATEGORIES = [
    ['pty data queue', /app\/lib\/pty|PTYDataQueue|utfSplitter/i],
    ['ipc/webContents send', /electron\/js2c|WebContents|ipc/i],
    ['node streams/net', /^node:(stream|net|internal\/stream)/],
    ['node buffers', /^node:(buffer|internal\/buffer)/],
    ['node internals other', /^node:/],
]

const rendererTarget = await findRendererTarget()
const renderer = await CDP.connect(rendererTarget.webSocketDebuggerUrl)
await renderer.send('Runtime.enable')

const hasPerf = await renderer.eval(`!!window.__perf?.term?.session?.open`, false)
if (!hasPerf) { throw new Error('no live __perf tab — run profiler.mjs first in this app instance') }

const mainTarget = await findMainProcessTarget()
console.log('main process target:', mainTarget.title ?? mainTarget.url)
const main = await CDP.connect(mainTarget.webSocketDebuggerUrl)
await main.send('Runtime.enable')
await main.send('Profiler.enable')
await main.send('Profiler.setSamplingInterval', { interval: 200 })
await main.send('Profiler.start')

await renderer.eval(`(() => {
    const p = window.__perf
    p.bytes = 0
    p.lastGrowth = performance.now()
    p.t0 = performance.now()
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

const { profile } = await main.send('Profiler.stop')
writeFileSync(join(OUT_DIR, 'main-s1.cpuprofile'), JSON.stringify(profile))

const result = {
    bytes: stats.bytes,
    wallMs: Math.round(stats.wall),
    mbPerSec: +(stats.bytes / 1048576 / (stats.wall / 1000)).toFixed(1),
    mainProfileSummary: summarizeProfile(profile, MAIN_CATEGORIES),
}
writeFileSync(join(OUT_DIR, 'results-main.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(0)
