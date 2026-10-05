// Synthetic full-screen TUI load (htop/btop-like): alternate screen, cursor
// addressing, SGR colors, and a steady stream of differential updates. Run it
// INSIDE a terminal tab; longrun.mjs starts it in each pane.
//
//   node scripts/perf/tui-load.mjs [--fps 30] [--churn 0.3] [--colors truecolor|256|16] [--duration 0]
//
//   --fps       frames per second
//   --churn     fraction of process rows rewritten per frame (0..1)
//   --colors    truecolor slowly rotates hues, so new fg/bg combinations keep
//               appearing over time (stresses the WebGL glyph atlas like a
//               long-running btop); 256/16 cycle a bounded palette
//   --duration  seconds, 0 = until q / Ctrl+C
//
// Input: every keystroke is echoed immediately (not on the next frame) as
// "ECHO:<key>" on the bottom line, so a harness can measure input -> echo
// latency through the PTY while the TUI is busy.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) { acc.push([a.slice(2), all[i + 1]]) }
    return acc
}, []))
const FPS = parseFloat(args.fps ?? '30')
const CHURN = parseFloat(args.churn ?? '0.3')
const COLORS = args.colors ?? 'truecolor'
const DURATION = parseFloat(args.duration ?? '0')

const out = process.stdout
const ESC = '\x1b['
let cols = out.columns || 80
let rows = out.rows || 24
let seed = 12345
const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
const frameStart = Date.now()
let frame = 0

const at = (r, c) => `${ESC}${r + 1};${c + 1}H`
const pad = (s, n) => (s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length))

function hsl (h, s, l) {
    const a = s * Math.min(l, 1 - l)
    const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
    return [f(0), f(8), f(4)]
}
function fg (value, slot) {
    if (COLORS === '16') { return `${ESC}${31 + (slot + Math.floor(value / 20)) % 6}m` }
    if (COLORS === '256') { return `${ESC}38;5;${16 + (slot * 7 + Math.floor(value * 2.15)) % 216}m` }
    // truecolor: hue drifts with time — a long run keeps producing new colors
    const hue = (120 - value * 1.2 + (Date.now() - frameStart) / 1000 + slot * 3) % 360
    const [r, g, b] = hsl((hue + 360) % 360, 0.75, 0.55)
    return `${ESC}38;2;${r};${g};${b}m`
}
const RESET = `${ESC}0m`

const USERS = ['root', 'www-data', 'postgres', 'morikyu', 'nobody', 'systemd+']
const CMDS = ['/usr/bin/node server.js', 'postgres: writer process', 'nginx: worker process', 'python3 -m http.server',
    '/usr/lib/systemd/systemd-journald', 'cargo build --release', 'rg --files', 'tmux new -s work', 'vim src/main.rs',
    'sshd: morikyu@pts/3', 'dockerd --containerd', 'java -jar app.jar', 'redis-server *:6379', 'containerd-shim']
let procs = []
function initProcs () {
    procs = Array.from({ length: Math.max(0, rows - 7) }, (_, i) => ({
        pid: 1000 + rand(60000), user: USERS[rand(USERS.length)], cpu: rand(1000) / 10, mem: rand(500) / 10,
        time: rand(100000), cmd: CMDS[rand(CMDS.length)], slot: i,
    }))
}
const fmtTime = t => `${Math.floor(t / 6000)}:${String(Math.floor(t / 100) % 60).padStart(2, '0')}.${String(t % 100).padStart(2, '0')}`

function header () {
    let s = ''
    const ncpu = 8
    const barW = Math.max(10, Math.floor(cols / 2) - 12)
    for (let i = 0; i < ncpu; i++) {
        const r = Math.floor(i / 2)
        const c = (i % 2) * Math.floor(cols / 2)
        const v = (Math.sin((frame + i * 17) / 9) * 0.5 + 0.5) * 100 * (0.6 + rand(40) / 100)
        const filled = Math.round(barW * Math.min(v, 100) / 100)
        s += at(r, c) + `${pad(String(i), 2)}[` + fg(v, i) + '|'.repeat(filled) + RESET + ' '.repeat(barW - filled) + `${pad(v.toFixed(1), 5)}%]`
    }
    const load = (Math.sin(frame / 50) + 2).toFixed(2)
    s += at(4, 0) + `${ESC}1mTasks:${RESET} ${procs.length} total  ${ESC}1mLoad average:${RESET} ${load} ${(load * 0.9).toFixed(2)}  ${ESC}1mUptime:${RESET} ${fmtTime(frame * 100 / FPS)}  frame ${frame}`
    return s
}
function tableHeader () {
    return at(5, 0) + `${ESC}30;46m` + pad('    PID USER      CPU%  MEM%     TIME+  COMMAND', cols) + RESET
}
function procLine (p, r) {
    return at(r, 0) + pad(String(p.pid), 7).padStart(7) + ' ' + pad(p.user, 9) + fg(p.cpu, p.slot) + p.cpu.toFixed(1).padStart(5) + RESET +
        ' ' + p.mem.toFixed(1).padStart(5) + ' ' + fmtTime(p.time).padStart(9) + '  ' + pad(p.cmd, Math.max(0, cols - 42))
}
function footer (extra = '') {
    const keys = 'F1Help F2Setup F3Search F4Filter F5Tree F6SortBy F9Kill F10Quit'
    return at(rows - 1, 0) + `${ESC}30;46m` + pad(keys, cols - 16) + RESET + pad(extra, 16)
}

function fullRedraw () {
    let s = `${ESC}2J` + header() + tableHeader()
    procs.forEach((p, i) => { s += procLine(p, 6 + i) })
    s += footer()
    out.write(s)
}

function tick () {
    frame++
    let s = header()
    if (frame % (FPS * 5 | 0 || 1) === 0) {
        // periodic re-sort: whole table repaints, like htop sorting by CPU
        procs.sort((a, b) => b.cpu - a.cpu)
        procs.forEach((p, i) => { s += procLine(p, 6 + i) })
    } else {
        const n = Math.max(1, Math.round(procs.length * CHURN))
        for (let k = 0; k < n && procs.length; k++) {
            const i = rand(procs.length)
            const p = procs[i]
            p.cpu = Math.max(0, Math.min(100, p.cpu + (rand(200) - 100) / 10))
            p.mem = Math.max(0, Math.min(100, p.mem + (rand(20) - 10) / 10))
            p.time += rand(FPS > 0 ? Math.ceil(100 / FPS) + 1 : 2)
            s += procLine(p, 6 + i)
        }
    }
    out.write(s)
    if (DURATION && Date.now() - frameStart > DURATION * 1000) { quit() }
}

function quit () {
    out.write(`${RESET}${ESC}?25h${ESC}?1049l`)
    process.exit(0)
}

out.on('resize', () => { cols = out.columns; rows = out.rows; initProcs(); fullRedraw() })
if (process.stdin.isTTY) { process.stdin.setRawMode(true) }
process.stdin.on('data', d => {
    const key = d.toString()
    if (key === 'q' || key === '\x03') { quit() }
    // echo right away so input latency excludes frame pacing
    out.write(footer(`ECHO:${key.replace(/[\x00-\x1f]/g, '?')}`))
})
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

out.write(`${ESC}?1049h${ESC}?25l`)
initProcs()
fullRedraw()
setInterval(tick, 1000 / FPS)
