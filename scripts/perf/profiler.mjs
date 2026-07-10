// Renderer-process performance scenarios. See README.md in this directory.
//
//   PERF_LOG_FILE=/tmp/huge.log PERF_OUT_DIR=/tmp/perf node scripts/perf/profiler.mjs
//
// WARNING: closes all tabs open in the running Tabby instance.
import { writeFileSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CDP, findRendererTarget, sleep, summarizeProfile } from './cdp.mjs'

const OUT_DIR = process.env.PERF_OUT_DIR ?? process.cwd()
const LOG_FILE = process.env.PERF_LOG_FILE
if (!LOG_FILE) { throw new Error('set PERF_LOG_FILE') }
const LOG_SIZE = statSync(LOG_FILE).size
mkdirSync(OUT_DIR, { recursive: true })

const CATEGORIES = [
    ['xterm serialize addon', /addon-serialize|_diffStyle|_nextCell|_rowEnd/],
    ['tabby middleware (OSC/UTF8/loginScript)', /tabby-terminal\/(\.\/)?src\/middleware/],
    ['zmodem', /zmodem/i],
    ['tabby session/base component', /tabby-terminal\/(\.\/)?src\/(session|api)/],
    ['tabby frontends', /tabby-terminal\/(\.\/)?src\/frontends/],
    ['hotkeys service', /hotkeys\.service/],
    ['tabby-core other', /tabby-core/],
    ['zone.js/angular', /zone\.js|zone-|@angular/],
    ['rxjs', /rxjs/],
    ['electron/node internals', /^node:|electron\/js2c/],
    // bundled deps (xterm.js etc.) fall through to 'other JS' — in dev
    // builds they live in tabby-terminal/dist/index.js without eval
    // source maps, so tell them apart by function name in topFunctions
]

async function waitForBootstrap (cdp) {
    for (let i = 0; i < 60; i++) {
        const ok = await cdp.eval(`!!(window.ng && document.querySelector('app-root') && window.pluginModules)`, false).catch(() => false)
        if (ok) { return }
        await sleep(1000)
    }
    throw new Error('app did not bootstrap — launch with TABBY_DEV=1 (Angular debug tools required)')
}

async function setup (cdp) {
    return await cdp.eval(`(async () => {
        const root = document.querySelector('app-root')
        const injector = window.ng.getInjector(root)
        const core = require('tabby-core')
        const profiles = injector.get(core.ProfilesService)
        const app = injector.get(core.AppService)
        // CDP evaluations run OUTSIDE the Angular zone; tab mutations must
        // happen inside it or change detection never renders the tab body
        const ngZone = injector.get(require('@angular/core').NgZone)
        const list = await profiles.getProfiles()
        const local = list.find(p => p.type === 'local')
        if (!local) { throw new Error('no local profile') }
        const before = new Set(app.tabs)
        const tab = await ngZone.run(() => profiles.openNewTabForProfile(local))
        if (!tab) { throw new Error('openNewTabForProfile returned null') }
        for (const t of [...app.tabs]) {
            if (before.has(t)) { try { await ngZone.run(() => app.closeTab(t, false)) } catch {} }
        }
        // closing the pre-existing tabs can steal selection from the new tab
        // mid-initialization — re-select the surviving (wrapper) tab explicitly
        const term = tab.getAllTabs ? tab.getAllTabs()[0] : tab
        const selectOurs = () => ngZone.run(() => {
            const wrapper = app.tabs.find(t => t === tab || (t.getAllTabs?.() ?? []).includes(term))
            if (wrapper && app.activeTab !== wrapper) { app.selectTab(wrapper) }
        })
        selectOurs()
        for (let i = 0; i < 40 && !term.session; i++) {
            if (i % 4 === 3) { selectOurs() }
            await new Promise(r => setTimeout(r, 500))
        }
        if (!term.session) { throw new Error('session never started on ' + term.constructor.name) }
        await new Promise(r => setTimeout(r, 1500))
        window.__perf = { injector, core, app, profiles, localProfile: local, tab, term, bytes: 0, lastGrowth: 0, t0: 0 }
        term.session.binaryOutput$.subscribe(d => {
            const p = window.__perf
            p.bytes += d.length
            p.lastGrowth = performance.now()
        })
        return { profile: local.name, open: !!term.session?.open }
    })()`)
}

async function startProfile (cdp) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
}

async function stopProfile (cdp, name) {
    const { profile } = await cdp.send('Profiler.stop')
    writeFileSync(join(OUT_DIR, `${name}.cpuprofile`), JSON.stringify(profile))
    return profile
}

async function scenarioThroughput (cdp) {
    await startProfile(cdp)
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
    const profile = await stopProfile(cdp, 's1-throughput')
    return {
        bytes: stats.bytes,
        wallMs: Math.round(stats.wall),
        mbPerSec: +(stats.bytes / 1048576 / (stats.wall / 1000)).toFixed(1),
        profileSummary: summarizeProfile(profile, CATEGORIES),
    }
}

async function scenarioHotkeys (cdp) {
    await startProfile(cdp)
    const r = await cdp.eval(`(() => {
        const N = 3000
        const keys = 'abcdefghijklmnopqrstuvwxyz'
        const t0 = performance.now()
        for (let i = 0; i < N; i++) {
            const key = keys[i % 26]
            document.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), bubbles: true }))
            document.dispatchEvent(new KeyboardEvent('keyup', { key, code: 'Key' + key.toUpperCase(), bubbles: true }))
        }
        const dt = performance.now() - t0
        return { n: N, totalMs: +dt.toFixed(1), usPerKeystroke: +(dt / N * 1000).toFixed(1) }
    })()`, false)
    const profile = await stopProfile(cdp, 's2-hotkeys')
    return { ...r, profileSummary: summarizeProfile(profile, CATEGORIES) }
}

async function scenarioRecovery (cdp, label) {
    await startProfile(cdp)
    const r = await cdp.eval(`(async () => {
        const p = window.__perf
        const rec = p.injector.get(p.core.TabRecoveryService)
        const runs = []
        for (let i = 0; i < 5; i++) {
            const t0 = performance.now()
            await rec.saveTabs(p.app.tabs)
            runs.push(+(performance.now() - t0).toFixed(1))
        }
        let stateMs = null, stateLen = null
        if (p.term.frontend?.saveState) {
            const t0 = performance.now()
            const s = p.term.frontend.saveState()
            stateMs = +(performance.now() - t0).toFixed(1)
            stateLen = s.length
        }
        return { tabs: p.app.tabs.length, saveTabsRunsMs: runs, singleSaveStateMs: stateMs, serializedLen: stateLen }
    })()`)
    const profile = await stopProfile(cdp, `s3-recovery-${label}`)
    return { ...r, profileSummary: summarizeProfile(profile, CATEGORIES) }
}

async function openExtraTabs (cdp, n) {
    return await cdp.eval(`(async () => {
        const p = window.__perf
        for (let i = 0; i < ${n}; i++) {
            const tab = await p.profiles.openNewTabForProfile(p.localProfile)
            await new Promise(r => setTimeout(r, 1500))
            const term = tab.getAllTabs ? tab.getAllTabs()[0] : tab
            term.sendInput(${JSON.stringify(`head -n 20000 ${LOG_FILE}\n`)})
        }
        await new Promise(r => setTimeout(r, 8000))
        return { tabs: p.app.tabs.length }
    })()`)
}

async function main () {
    const target = await findRendererTarget()
    console.log('CDP target:', target.title, target.url)
    const cdp = await CDP.connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await waitForBootstrap(cdp)
    console.log('app bootstrapped, setting up...')
    const setupInfo = await setup(cdp)
    console.log('setup:', JSON.stringify(setupInfo))

    const results = { setupInfo }

    console.log('S1: throughput (cat test log)...')
    results.s1_throughput = await scenarioThroughput(cdp)
    console.log(`  ${results.s1_throughput.mbPerSec} MB/s, busy ${results.s1_throughput.profileSummary.busyPct}%`)
    await sleep(2000)

    console.log('S2: hotkeys (3000 synthetic keystrokes)...')
    results.s2_hotkeys = await scenarioHotkeys(cdp)
    console.log(`  ${results.s2_hotkeys.usPerKeystroke} us/keystroke`)
    await sleep(1000)

    console.log('S3a: tab recovery, 1 tab...')
    results.s3a_recovery_1tab = await scenarioRecovery(cdp, '1tab')

    console.log('S3b: opening 4 extra tabs with scrollback...')
    await openExtraTabs(cdp, 4)
    results.s3b_recovery_5tabs = await scenarioRecovery(cdp, '5tabs')

    writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2))
    console.log('DONE — results written to', join(OUT_DIR, 'results.json'))
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1) })
