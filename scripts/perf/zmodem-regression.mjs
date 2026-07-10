// ZMODEM detection regression test for the sentry-bypass optimization in
// tabby-terminal/src/features/zmodem.ts. Requires a previous profiler.mjs
// run in the same app instance (reuses window.__perf).
//
// zmodem.js only detects a session when the ZRQINIT header is at the END of
// the consumed input, so each printf is followed by `sleep` to keep the
// shell prompt from arriving in the same chunk.
import { CDP, findRendererTarget, sleep } from './cdp.mjs'

const target = await findRendererTarget()
const cdp = await CDP.connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

const hasPerf = await cdp.eval(`!!window.__perf?.term?.session?.open`, false)
if (!hasPerf) { throw new Error('no live __perf tab — run profiler.mjs first in this app instance') }

// stub the accept dialog: count detections, always reject
await cdp.eval(`(() => {
    const p = window.__perf
    const ps = p.injector.get(p.core.PlatformService)
    window.__zmDetections = 0
    ps.showMessageBox = async () => { window.__zmDetections++; return { response: 1 } }
})()`, false)

// Test 1: ZRQINIT header entirely within one chunk
await cdp.eval(`window.__perf.term.sendInput("printf 'rz\\\\r**\\\\030B00000000000000\\\\r\\\\212\\\\021'; sleep 3\\n")`, false)
await sleep(6000)
const t1 = await cdp.eval(`window.__zmDetections`, false)

// Test 2: header split across two chunks at the bypass boundary —
// the first chunk ends with the "**" prefix, ZDLE arrives 1s later
await cdp.eval(`window.__perf.term.sendInput("printf 'plain text then **'; sleep 1; printf '\\\\030B00000000000000\\\\r\\\\212\\\\021'; sleep 3\\n")`, false)
await sleep(8000)
const t2 = await cdp.eval(`window.__zmDetections`, false)

const pass = t1 >= 1 && t2 >= 2
console.log(JSON.stringify({ detectionsAfterTest1: t1, detectionsAfterTest2: t2, pass }))
process.exit(pass ? 0 : 1)
