// Trend summary for a longrun.mjs JSONL: first window vs last window means,
// least-squares slope per hour over all samples, and how consistently each
// metric moved in one direction.
//
//   node scripts/perf/longrun-summary.mjs <samples.jsonl> [--window 60] [--json]
//
// --window  minutes compared at each end (default 60; shrunk to a third of the
//           run for short runs)
import { readFileSync } from 'fs'

const argv = process.argv.slice(2)
const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--window')
if (!file) { throw new Error('usage: longrun-summary.mjs <samples.jsonl> [--window 60] [--json]') }
const wi = argv.indexOf('--window')
const WINDOW = wi >= 0 ? parseFloat(argv[wi + 1]) : 60

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const start = lines.find(l => l.event === 'start')
const end = lines.find(l => l.event === 'end' || l.event === 'electron-exit')
const samples = lines.filter(l => l.event === 'sample' && l.m)
const errors = lines.filter(l => l.event === 'sample' && l.error)
const consoleEvents = lines.filter(l => l.event === 'console')
if (samples.length < 2) { throw new Error(`need at least 2 good samples, have ${samples.length}`) }

const t0 = samples[0].elapsedMin
const t1 = samples[samples.length - 1].elapsedMin
const span = t1 - t0
const w = Math.min(WINDOW, span / 3)
const head = samples.filter(s => s.elapsedMin <= t0 + w)
const tail = samples.filter(s => s.elapsedMin >= t1 - w)

const mean = a => a.reduce((x, y) => x + y, 0) / a.length
const keys = [...new Set(samples.flatMap(s => Object.keys(s.m)))].sort()
const rows = []
for (const k of keys) {
    const pts = samples.filter(s => k in s.m).map(s => [s.elapsedMin / 60, s.m[k]])
    if (pts.length < 2) { continue }
    const h = head.filter(s => k in s.m).map(s => s.m[k])
    const t = tail.filter(s => k in s.m).map(s => s.m[k])
    if (!h.length || !t.length) { continue }
    const mx = mean(pts.map(p => p[0]))
    const my = mean(pts.map(p => p[1]))
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
    const slope = sxx ? pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : 0
    let ups = 0, downs = 0
    for (let i = 1; i < pts.length; i++) {
        if (pts[i][1] > pts[i - 1][1]) { ups++ } else if (pts[i][1] < pts[i - 1][1]) { downs++ }
    }
    const first = mean(h)
    const last = mean(t)
    const changePct = first ? (last - first) / Math.abs(first) * 100 : (last ? Infinity : 0)
    const steps = pts.length - 1
    // a "trend": moved >10% end to end and most steps went the same way
    const trend = Math.abs(changePct) > 10 && Math.max(ups, downs) / steps >= 0.7
        ? (changePct > 0 ? 'UP' : 'DOWN') : ''
    rows.push({ metric: k, first: +first.toFixed(2), last: +last.toFixed(2), changePct: +changePct.toFixed(1), slopePerHour: +slope.toFixed(3), ups, downs, steps, trend })
}

const result = {
    file,
    options: start?.options,
    electron: start?.electron,
    end: end ? { event: end.event, reason: end.reason, code: end.code } : 'still running (no end event)',
    samples: samples.length,
    sampleErrors: errors.length,
    consoleWarningsErrors: consoleEvents.length,
    consoleSamples: [...new Set(consoleEvents.map(c => `${c.level}: ${c.text.slice(0, 120)}`))].slice(0, 10),
    spanMin: +span.toFixed(1),
    windowMin: +w.toFixed(1),
    trends: rows.filter(r => r.trend).map(r => `${r.metric} ${r.trend} ${r.changePct}%`),
    metrics: rows,
}

if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
} else {
    console.log(`file: ${file}`)
    console.log(`electron ${result.electron}  options ${JSON.stringify(result.options)}`)
    console.log(`samples ${result.samples} (errors ${result.sampleErrors}), span ${result.spanMin} min, comparing first vs last ${result.windowMin} min`)
    console.log(`end: ${JSON.stringify(result.end)}`)
    console.log(`renderer console warnings/errors: ${result.consoleWarningsErrors}`)
    for (const c of result.consoleSamples) { console.log(`  ${c}`) }
    console.log('')
    const cols = ['metric', 'first', 'last', 'changePct', 'slopePerHour', 'ups', 'downs', 'trend']
    const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)))
    console.log(cols.map((c, i) => c.padEnd(width[i])).join('  '))
    for (const r of rows) { console.log(cols.map((c, i) => String(r[c]).padEnd(width[i])).join('  ')) }
    console.log('')
    console.log(result.trends.length ? `TRENDS (>10% and >=70% of steps one way): ${result.trends.join(', ')}` : 'no consistent trends detected')
}
