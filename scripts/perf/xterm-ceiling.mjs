// Measure xterm.js's own consumption ceiling, bypassing PTY/IPC/middleware:
//  A) live terminal: direct xterm.write() on the visible frontend (parse+render)
//  B) detached Terminal instance, never open()ed (parse+buffer only, no renderer)
//  C) B but fed Uint8Array instead of string (decode-cost delta)
// Requires a prior profiler.mjs-style setup (window.__perf) or sets one up.
import { statSync } from 'fs'
import { CDP, findRendererTarget, sleep } from './cdp.mjs'

const LOG_FILE = process.env.PERF_LOG_FILE
const LOG_SIZE = statSync(LOG_FILE).size

const target = await findRendererTarget()
const cdp = await CDP.connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.ng && document.querySelector('app-root') && window.pluginModules)`, false).catch(() => false)
    if (ok) { break }
    await sleep(1000)
}

// minimal setup: need one live terminal tab for its xterm instance
await cdp.eval(`(async () => {
    if (window.__perf?.term?.session?.open) { return true }
    const root = document.querySelector('app-root')
    const injector = window.ng.getInjector(root)
    const core = require('tabby-core')
    const profiles = injector.get(core.ProfilesService)
    const app = injector.get(core.AppService)
    const ngZone = injector.get(require('@angular/core').NgZone)
    window.localStorage.tabsRecovery = '[]'
    let term = null
    for (const t of app.tabs) {
        const cand = (t.getAllTabs?.() ?? [t]).find(x => typeof x.sendInput === 'function')
        if (cand) { term = cand; break }
    }
    if (!term) {
        const list = await profiles.getProfiles()
        const local = list.find(p => p.type === 'local')
        const tab = await ngZone.run(() => profiles.openNewTabForProfile(local))
        term = tab.getAllTabs ? tab.getAllTabs()[0] : tab
    }
    const wrapper = app.tabs.find(t => t.getAllTabs?.().includes(term) || t === term)
    if (wrapper && app.activeTab !== wrapper) { ngZone.run(() => app.selectTab(wrapper)) }
    for (let i = 0; i < 40 && !term.frontend?.xterm; i++) { await new Promise(r => setTimeout(r, 500)) }
    if (!term.frontend?.xterm) { throw new Error('no xterm frontend') }
    window.__perf = { term }
    return true
})()`)

const result = await cdp.eval(`(async () => {
    const fs = require('fs')
    const raw = fs.readFileSync(${JSON.stringify(LOG_FILE)})
    const CHUNK = 100 * 1024
    const chunksBin = []
    for (let o = 0; o < raw.length; o += CHUNK) {
        chunksBin.push(new Uint8Array(raw.buffer, raw.byteOffset + o, Math.min(CHUNK, raw.length - o)))
    }
    const chunksStr = chunksBin.map(c => Buffer.from(c).toString())

    const feed = async (t, chunks) => {
        const t0 = performance.now()
        for (const c of chunks) {
            await new Promise(r => t.write(c, r))
        }
        return performance.now() - t0
    }
    const mbps = ms => +(${LOG_SIZE} / 1048576 / (ms / 1000)).toFixed(1)

    // A) live visible terminal (parse + buffer + renderer)
    const live = window.__perf.term.frontend.xterm
    const liveMs = await feed(live, chunksStr)

    // B/C) detached instance, same options, never opened -> no renderer
    const Terminal = live.constructor
    const mk = () => new Terminal({
        cols: live.cols, rows: live.rows,
        scrollback: 1000, allowProposedApi: true, allowTransparency: true,
    })
    const detStr = mk()
    const detStrMs = await feed(detStr, chunksStr)
    detStr.dispose()
    const detBin = mk()
    const detBinMs = await feed(detBin, chunksBin)
    detBin.dispose()

    return {
        liveVisible_string: { ms: Math.round(liveMs), mbPerSec: mbps(liveMs) },
        detachedParseOnly_string: { ms: Math.round(detStrMs), mbPerSec: mbps(detStrMs) },
        detachedParseOnly_uint8: { ms: Math.round(detBinMs), mbPerSec: mbps(detBinMs) },
    }
})()`)
console.log(JSON.stringify(result, null, 2))
process.exit(0)
