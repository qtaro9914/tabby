// Long-running degradation harness. Launches the dev build with CDP +
// inspector, opens two terminals running tui-load.mjs, and samples memory,
// CPU, responsiveness and xterm/WebGL state at a fixed interval into JSONL.
// Summarize with longrun-summary.mjs. Meant to run detached:
//
//   nohup node scripts/perf/longrun.mjs --hours 4 --out /tmp/longrun > /tmp/longrun.log 2>&1 &
//
// Options (defaults in brackets):
//   --hours 4          run length
//   --interval 300     seconds between samples (first sample after --warmup)
//   --warmup 60        seconds before the first sample
//   --fps 30 --churn 0.3 --colors truecolor   passed to tui-load.mjs
//   --layout split     split: both terminals side by side, both rendering
//                      (closest to "two full-screen TUIs"); tabs: two tabs,
//                      only the active one renders
//   --out <dir>        output directory [./longrun-<timestamp>]
//
// Needs TABBY_DEV builds (Angular debug tools) and free ports 9222/9229.
// WARNING: closes all tabs in the launched instance. App code is not modified.
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, appendFileSync, openSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CDP, findRendererTarget, findMainProcessTarget, sleep } from './cdp.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
const HOURS = parseFloat(opt('hours', '4'))
const INTERVAL = parseFloat(opt('interval', '300'))
const WARMUP = parseFloat(opt('warmup', '60'))
const FPS = opt('fps', '30')
const CHURN = opt('churn', '0.3')
const COLORS = opt('colors', 'truecolor')
const LAYOUT = opt('layout', 'split')
const OUT = resolve(opt('out', `longrun-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const CDP_PORT = process.env.PERF_CDP_PORT ?? '9222'
const INSPECT_PORT = process.env.PERF_INSPECT_PORT ?? '9229'

mkdirSync(OUT, { recursive: true })
const JSONL = join(OUT, 'samples.jsonl')
const record = obj => appendFileSync(JSONL, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
const log = (...a) => console.log(new Date().toISOString(), ...a)

for (const port of [CDP_PORT, INSPECT_PORT]) {
    const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)
    if (busy) { throw new Error(`port ${port} is already in use — stop the running instance first`) }
}

// --- launch -----------------------------------------------------------------
const electronLog = openSync(join(OUT, 'electron.log'), 'a')
const extraArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
// the electron package's main export is the path of the real binary — spawning
// it directly (not the .bin wrapper) means killing it really ends the app
const ELECTRON_BIN = createRequire(join(REPO, 'package.json'))('electron')
const electron = spawn(ELECTRON_BIN,
    ['app', `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`, ...extraArgs],
    { cwd: REPO, env: { ...process.env, TABBY_DEV: '1' }, stdio: ['ignore', electronLog, electronLog] })
let ending = false
electron.on('exit', (code, signal) => {
    if (!ending) {
        record({ event: 'electron-exit', code, signal })
        log('electron exited unexpectedly', code, signal)
        process.exit(1)
    }
})
const shutdown = async reason => {
    if (ending) { return }
    ending = true
    record({ event: 'end', reason })
    log('ending:', reason)
    electron.kill('SIGTERM')
    await sleep(5000)
    if (electron.exitCode === null) { electron.kill('SIGKILL') }
    process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', e => { log('fatal', e); shutdown(`error: ${e?.message ?? e}`) })
process.on('unhandledRejection', e => { log('fatal', e); shutdown(`error: ${e?.message ?? e}`) })
process.on('SIGINT', () => shutdown('SIGINT'))

const renderer = await CDP.connect((await findRendererTarget(CDP_PORT)).webSocketDebuggerUrl)
await renderer.send('Runtime.enable')
for (let i = 0; i < 90; i++) {
    const ok = await renderer.eval(`!!(window.ng && document.querySelector('app-root') && window.pluginModules)`, false).catch(() => false)
    if (ok) { break }
    if (i === 89) { await shutdown('app did not bootstrap (TABBY_DEV build required)') }
    await sleep(1000)
}
let main = null
for (let i = 0; i < 30 && !main; i++) {
    try {
        main = await CDP.connect((await findMainProcessTarget(INSPECT_PORT)).webSocketDebuggerUrl)
    } catch { await sleep(1000) }
}
await main.send('Runtime.enable')
await main.send('HeapProfiler.enable')
await renderer.send('HeapProfiler.enable')

// renderer console warnings/errors (e.g. xterm's WebGL fallbacks) as events
let consoleEvents = 0
renderer.ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.method !== 'Runtime.consoleAPICalled' || !['warning', 'error'].includes(msg.params.type)) { return }
    if (++consoleEvents > 300) { return }
    const text = msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 500)
    record({ event: 'console', level: msg.params.type, text })
})

// --- set up two terminals running the TUI load ------------------------------
const tuiCmd = `${process.execPath} ${join(REPO, 'scripts/perf/tui-load.mjs')} --fps ${FPS} --churn ${CHURN} --colors ${COLORS}`
const setup = await renderer.eval(`(async () => {
    const root = document.querySelector('app-root')
    const injector = window.ng.getInjector(root)
    const core = require('tabby-core')
    const profiles = injector.get(core.ProfilesService)
    const app = injector.get(core.AppService)
    // tab mutations must run inside the Angular zone (see README)
    const ngZone = injector.get(require('@angular/core').NgZone)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const local = (await profiles.getProfiles()).find(p => p.type === 'local')
    if (!local) { throw new Error('no local profile') }
    const before = new Set(app.tabs)
    const tab = await ngZone.run(() => profiles.openNewTabForProfile(local))
    for (const t of [...app.tabs]) {
        if (before.has(t)) { try { await ngZone.run(() => app.closeTab(t, false)) } catch {} }
    }
    const first = tab.getAllTabs ? tab.getAllTabs()[0] : tab
    ngZone.run(() => app.selectTab(app.tabs.find(t => t === tab || (t.getAllTabs?.() ?? []).includes(first))))
    for (let i = 0; i < 40 && !first.session; i++) { await wait(500) }
    let second
    if (${JSON.stringify(LAYOUT)} === 'split') {
        // openNewTabForProfile may hand back the terminal itself; the split
        // container is the top-level tab holding it
        const wrapper = app.tabs.find(t => t === tab || (t.getAllTabs?.() ?? []).includes(first))
        second = await ngZone.run(() => wrapper.splitTab(first, 'r'))
    } else {
        const t2 = await ngZone.run(() => profiles.openNewTabForProfile(local))
        second = t2.getAllTabs ? t2.getAllTabs()[0] : t2
    }
    for (let i = 0; i < 40 && !second?.session; i++) { await wait(500) }
    if (!first.session || !second?.session) { throw new Error('terminal sessions did not start') }
    await wait(1500)
    const terms = [first, second]
    for (const t of terms) { t.sendInput(${JSON.stringify(`clear; ${tuiCmd}\n`)}) }

    // persistent probes
    const lr = window.__longrun = { terms, app, ngZone, longTaskMs: 0, longTasks: 0, seenAddons: new WeakSet(), webglRecreated: [0, 0] }
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) { lr.longTaskMs += e.duration; lr.longTasks++ }
        }).observe({ entryTypes: ['longtask'] })
    } catch { lr.noLongTask = true }
    lr.contextLosses = [[], []]
    lr.hook = (i, addon) => {
        if (!addon || lr.seenAddons.has(addon)) { return false }
        lr.seenAddons.add(addon)
        addon.onContextLoss(() => lr.contextLosses[i].push(Date.now()))
        return true
    }
    terms.forEach((t, i) => lr.hook(i, t.frontend.webGLAddon))
    return terms.map(t => ({ cols: t.frontend.xterm.cols, rows: t.frontend.xterm.rows, frontend: t.frontend.constructor.name, webgl: !!t.frontend.webGLAddon }))
})()`)
record({ event: 'start', options: { HOURS, INTERVAL, WARMUP, FPS, CHURN, COLORS, LAYOUT }, setup, electron: await main.evalNode('process.versions.electron') })
log('started:', JSON.stringify(setup), 'out:', OUT)

// --- sampling ----------------------------------------------------------------
const ECHO_KEYS = 'abcdefghijklmnoprstuvwxyz0123456789' // no 'q' (quits the TUI)
let echoKeyIdx = 0

const RENDERER_SAMPLE = keys => `(async () => {
    const lr = window.__longrun
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2) : null }
    const out = { tabs: [] }

    // renderer frame rate over 2 s (UI responsiveness)
    let frames = 0
    const t0 = performance.now()
    await new Promise(r => { const f = () => { frames++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : r() }; requestAnimationFrame(f) })
    out.fps = +(frames / ((performance.now() - t0) / 1000)).toFixed(1)

    // long tasks since the previous sample
    out.longTaskMs = Math.round(lr.longTaskMs); out.longTasks = lr.longTasks
    lr.longTaskMs = 0; lr.longTasks = 0

    // S2-lite: synchronous keydown/keyup handling cost (document-level, hotkeys path)
    {
        const N = 200, letters = 'abcdefghijklmnopqrstuvwxyz'
        const ts = performance.now()
        for (let i = 0; i < N; i++) {
            const key = letters[i % 26]
            document.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), bubbles: true }))
            document.dispatchEvent(new KeyboardEvent('keyup', { key, code: 'Key' + key.toUpperCase(), bubbles: true }))
        }
        out.s2UsPerKey = +((performance.now() - ts) / N * 1000).toFixed(1)
    }

    const keys = ${JSON.stringify(keys)}
    for (const [i, term] of lr.terms.entries()) {
        const fe = term.frontend, xt = fe.xterm
        const tab = { i }

        // xterm write-queue latency: time until an empty write's callback runs
        const wl = []
        for (let k = 0; k < 5; k++) {
            const ts = performance.now()
            await new Promise(r => xt.write('', r))
            wl.push(performance.now() - ts)
            await wait(50)
        }
        tab.writeLatMs = { median: q(wl, 0.5), max: q(wl, 1) }

        // input -> echo latency through the real input path (xterm.input -> PTY -> TUI echo)
        const arrive = [], parsed = [], rendered = []
        let timeouts = 0
        for (const ch of keys[i]) {
            const r = await new Promise(resolve => {
                const marker = 'ECHO:' + ch
                let acc = '', got = false
                const ts = performance.now()
                const timer = setTimeout(() => { sub.unsubscribe(); resolve(null) }, 5000)
                const sub = term.session.binaryOutput$.subscribe(d => {
                    if (got) { return }
                    acc = (acc + Buffer.from(d).toString('latin1')).slice(-256)
                    if (!acc.includes(marker)) { return }
                    got = true
                    const ta = performance.now()
                    sub.unsubscribe()
                    setTimeout(() => xt.write('', () => {
                        const tp = performance.now()
                        const disp = xt.onRender(() => { disp.dispose(); clearTimeout(timer); resolve([ta - ts, tp - ts, performance.now() - ts]) })
                    }), 0)
                })
                xt.input(ch, true)
            })
            if (r) { arrive.push(r[0]); parsed.push(r[1]); rendered.push(r[2]) } else { timeouts++ }
            await wait(100)
        }
        tab.echoMs = { arriveMedian: q(arrive, 0.5), parsedMedian: q(parsed, 0.5), renderedMedian: q(rendered, 0.5), renderedMax: q(rendered, 1), timeouts }

        // buffers
        tab.activeBuffer = xt.buffer.active.type
        tab.normalLen = xt.buffer.normal.length
        tab.altLen = xt.buffer.alternate.length
        tab.cols = xt.cols; tab.rows = xt.rows

        // renderer + WebGL glyph atlas
        const addon = fe.webGLAddon
        tab.renderer = addon ? 'webgl' : fe.canvasAddon ? 'canvas' : 'dom'
        if (lr.hook(i, addon)) { lr.webglRecreated[i]++ }
        tab.webglRecreated = lr.webglRecreated[i]
        tab.contextLosses = lr.contextLosses[i].length
        tab.lastContextLoss = lr.contextLosses[i].length ? new Date(lr.contextLosses[i].at(-1)).toISOString() : null
        const atlas = addon?._renderer?._charAtlas
        if (atlas) {
            const countGlyphs = (o, depth = 0) => {
                if (!o || typeof o !== 'object' || depth > 8) { return 0 }
                if ('texturePage' in o) { return 1 }
                let n = 0
                for (const k in o) { n += countGlyphs(o[k], depth + 1) }
                return n
            }
            const pages = atlas.pages ?? []
            tab.atlas = {
                pages: pages.length,
                activePages: atlas._activePages?.length ?? null,
                pagePixelsM: +(pages.reduce((a, p) => a + p.canvas.width * p.canvas.height, 0) / 1e6).toFixed(2),
                glyphs: countGlyphs(atlas._cacheMap?._data),
                combinedGlyphs: countGlyphs(atlas._cacheMapCombined?._data),
            }
        }
        out.tabs.push(tab)
    }

    const mu = process.memoryUsage()
    out.rssMB = +(mu.rss / 1048576).toFixed(1)
    out.externalMB = +(mu.external / 1048576).toFixed(1)
    out.arrayBuffersMB = +(mu.arrayBuffers / 1048576).toFixed(1)
    out.domNodes = document.getElementsByTagName('*').length
    out.canvases = document.getElementsByTagName('canvas').length
    out.tabCount = lr.app.tabs.length
    return out
})()`

async function heap (conn) {
    const pre = await conn.send('Runtime.getHeapUsage')
    await conn.send('HeapProfiler.collectGarbage')
    const post = await conn.send('Runtime.getHeapUsage')
    return { usedMB: +(pre.usedSize / 1048576).toFixed(1), afterGcMB: +(post.usedSize / 1048576).toFixed(1), totalMB: +(post.totalSize / 1048576).toFixed(1) }
}

const MAIN_SAMPLE = `(() => {
    const mu = process.memoryUsage()
    const metrics = {}
    // summed per process type (Browser = main, Tab = renderer(s), GPU, Utility, ...).
    // percentCPUUsage is relative to ALL cores here (12-core box: 1.6 = ~19% of one
    // core) — longrun.mjs adds cpuCore from /proc for a per-core figure on Linux
    for (const m of require('electron').app.getAppMetrics()) {
        const e = metrics[m.type] ??= { n: 0, cpu: 0, wsMB: 0, peakMB: 0, pids: [] }
        e.n++
        e.pids.push(m.pid)
        e.cpu = +(e.cpu + m.cpu.percentCPUUsage).toFixed(1)
        e.wsMB = +(e.wsMB + m.memory.workingSetSize / 1024).toFixed(1)
        e.peakMB = +(e.peakMB + m.memory.peakWorkingSetSize / 1024).toFixed(1)
    }
    return { rssMB: +(mu.rss / 1048576).toFixed(1), heapUsedMB: +(mu.heapUsed / 1048576).toFixed(1), metrics }
})()`

// Linux: CPU time per process type from /proc/<pid>/stat (utime+stime), as %
// of ONE core over the interval since the previous call
const CLK_TCK = 100
let prevCpu = null
function procCpu (metrics) {
    if (process.platform !== 'linux') { return }
    const now = Date.now()
    const ticks = {}
    for (const [type, e] of Object.entries(metrics)) {
        ticks[type] = 0
        for (const pid of e.pids ?? []) {
            try {
                const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
                ticks[type] += parseInt(f[11]) + parseInt(f[12]) // utime, stime
            } catch { /* process gone */ }
        }
    }
    if (prevCpu) {
        const secs = (now - prevCpu.at) / 1000
        for (const [type, e] of Object.entries(metrics)) {
            if (type in prevCpu.ticks) { e.cpuCore = +((ticks[type] - prevCpu.ticks[type]) / CLK_TCK / secs * 100).toFixed(1) }
        }
    }
    prevCpu = { at: now, ticks }
}

// flatten the interesting numbers into one map for the summary script
function flatten (s) {
    const m = {}
    const put = (k, v) => { if (typeof v === 'number' && Number.isFinite(v)) { m[k] = v } }
    put('renderer.heapAfterGcMB', s.rendererHeap?.afterGcMB)
    put('renderer.heapUsedMB', s.rendererHeap?.usedMB)
    put('renderer.rssMB', s.renderer?.rssMB)
    put('renderer.arrayBuffersMB', s.renderer?.arrayBuffersMB)
    put('renderer.fps', s.renderer?.fps)
    put('renderer.longTaskMsPerMin', s.renderer && s.intervalSec ? s.renderer.longTaskMs / (s.intervalSec / 60) : undefined)
    put('renderer.s2UsPerKey', s.renderer?.s2UsPerKey)
    put('renderer.domNodes', s.renderer?.domNodes)
    put('main.heapAfterGcMB', s.mainHeap?.afterGcMB)
    put('main.rssMB', s.main?.rssMB)
    for (const [type, e] of Object.entries(s.main?.metrics ?? {})) {
        if (!['Browser', 'Tab', 'GPU'].includes(type)) { continue }
        put(`proc.${type}.cpu`, e.cpu)
        put(`proc.${type}.cpuCore`, e.cpuCore)
        put(`proc.${type}.wsMB`, e.wsMB)
    }
    for (const t of s.renderer?.tabs ?? []) {
        put(`tab${t.i}.echoRenderedMedianMs`, t.echoMs?.renderedMedian)
        put(`tab${t.i}.echoRenderedMaxMs`, t.echoMs?.renderedMax)
        put(`tab${t.i}.echoArriveMedianMs`, t.echoMs?.arriveMedian)
        put(`tab${t.i}.echoTimeouts`, t.echoMs?.timeouts)
        put(`tab${t.i}.writeLatMedianMs`, t.writeLatMs?.median)
        put(`tab${t.i}.writeLatMaxMs`, t.writeLatMs?.max)
        put(`tab${t.i}.normalLen`, t.normalLen)
        put(`tab${t.i}.atlasPages`, t.atlas?.pages)
        put(`tab${t.i}.atlasPagePixelsM`, t.atlas?.pagePixelsM)
        put(`tab${t.i}.atlasGlyphs`, t.atlas?.glyphs)
        put(`tab${t.i}.webglRecreated`, t.webglRecreated)
        put(`tab${t.i}.contextLosses`, t.contextLosses)
    }
    return m
}

const startedAt = Date.now()
const endAt = startedAt + HOURS * 3600 * 1000
let failures = 0
let lastSampleAt = startedAt
procCpu((await main.evalNode(MAIN_SAMPLE)).metrics) // prime getAppMetrics and /proc CPU deltas
await sleep(WARMUP * 1000)
for (let n = 0; ; n++) {
    const s = { event: 'sample', n, elapsedMin: +((Date.now() - startedAt) / 60000).toFixed(2), intervalSec: +((Date.now() - lastSampleAt) / 1000).toFixed(1) }
    lastSampleAt = Date.now()
    try {
        s.main = await main.evalNode(MAIN_SAMPLE)
        procCpu(s.main.metrics)
        const keys = [0, 1].map(() => Array.from({ length: 5 }, () => ECHO_KEYS[echoKeyIdx++ % ECHO_KEYS.length]).join(''))
        s.renderer = await renderer.eval(RENDERER_SAMPLE(keys))
        s.rendererHeap = await heap(renderer)
        s.mainHeap = await heap(main)
        s.m = flatten(s)
        failures = 0
    } catch (e) {
        s.error = String(e?.message ?? e)
        failures++
    }
    record(s)
    const m = s.m ?? {}
    log(`sample ${n} t=${s.elapsedMin}min`, s.error ? `ERROR ${s.error}` :
        `rHeapGC=${m['renderer.heapAfterGcMB']}MB rRSS=${m['proc.Tab.wsMB']}MB gpu=${m['proc.GPU.wsMB']}MB ` +
        `core%(main/r/gpu)=${m['proc.Browser.cpuCore']}/${m['proc.Tab.cpuCore']}/${m['proc.GPU.cpuCore']} fps=${m['renderer.fps']} ` +
        `echo=${m['tab0.echoRenderedMedianMs']}/${m['tab1.echoRenderedMedianMs']}ms glyphs=${m['tab0.atlasGlyphs']}/${m['tab1.atlasGlyphs']}`)
    if (failures >= 3) { await shutdown('3 consecutive sample failures') }
    if (Date.now() + INTERVAL * 1000 > endAt + 30000) { break }
    await sleep(Math.max(0, INTERVAL * 1000 - (Date.now() - lastSampleAt)))
}
await renderer.eval(`window.__longrun.terms.forEach(t => t.sendInput('q'))`, false).catch(() => undefined)
await sleep(2000)
await shutdown('completed')
