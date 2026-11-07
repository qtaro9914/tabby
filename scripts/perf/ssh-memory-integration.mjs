// Real Electron + loopback SSH integration check. Uses an isolated config/userData.
// First: node scripts/use-local-russh.mjs /path/to/built/russh-napi
// Build: TABBY_DEV=1 yarn run build
// Run: node scripts/perf/ssh-memory-integration.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { CDP, findRendererTarget, sleep } from './cdp.mjs'

const root = resolve(import.meta.dirname, '../..')
const out = resolve(root, '.native-work/integration')
mkdirSync(resolve(out, 'config'), { recursive: true })
writeFileSync(resolve(out, 'config/config.yaml'), 'version: 7\nenableWelcomeTab: false\nssh:\n  verifyHostKeys: false\n')
const require = createRequire(import.meta.url)
const results = []
const children = []
let renderer
let consoleErrors = []
const peers = new Set()
const bannerServer = createServer(socket => {
    peers.add(socket)
    socket.on('error', () => {})
    socket.resume()
    socket.once('close', () => peers.delete(socket))
})
await new Promise(resolve => bannerServer.listen(0, '127.0.0.1', resolve))
async function until(check, label, seconds = 30) {
    const end = Date.now() + seconds * 1000
    while (!await check()) {
        if (Date.now() >= end) { throw new Error(`Timed out: ${label}`) }
        await sleep(50)
    }
}
const report = (name, evidence) => { const row = { name, ...evidence }; results.push(row); console.log(JSON.stringify(row)) }
try {
    const fixture = spawn('python3', ['scripts/perf/ssh-fixture.py'], { cwd: root, stdio: ['ignore', 'pipe', openSync(resolve(out, 'ssh-fixture.log'), 'w')] })
    children.push(fixture)
    const addresses = JSON.parse((await once(fixture.stdout, 'data'))[0].toString().trim())
    const metrics = () => fetch(`http://127.0.0.1:${addresses.metrics}`).then(x => x.json())
    const electron = spawn(require('electron'), ['app', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=49322', `--user-data-dir=${resolve(out, 'user-data')}`], {
        cwd: root, env: { ...process.env, TABBY_DEV: '1', TABBY_CONFIG_DIRECTORY: resolve(out, 'config') },
        stdio: ['ignore', openSync(resolve(out, 'electron.log'), 'w'), openSync(resolve(out, 'electron-error.log'), 'w')],
    })
    children.push(electron)
    renderer = await CDP.connect((await findRendererTarget(49322)).webSocketDebuggerUrl)
    const send = renderer.send.bind(renderer)
    renderer.send = async (...args) => {
        let timer
        try {
            return await Promise.race([send(...args), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('CDP timed out: ' + args[0])), 60000)
            })])
        } finally { clearTimeout(timer) }
    }
    await renderer.send('Runtime.enable')
    renderer.ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data)
        if (msg.method === 'Runtime.exceptionThrown') { consoleErrors.push(JSON.stringify(msg.params.exceptionDetails)) }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            consoleErrors.push(msg.params.args.map(x => x.value ?? x.description).join(' ').slice(0, 1000))
        }
    })
    await until(() => renderer.eval("!!(window.ng && document.querySelector('app-root') && window.pluginModules)", false).catch(() => false), 'Angular bootstrap', 60)
    await renderer.eval(`(async () => {
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const core = require('tabby-core')
        const zone = injector.get(require('@angular/core').NgZone)
        const app = injector.get(core.AppService)
        const profiles = injector.get(core.ProfilesService)
        const config = injector.get(core.ConfigService)
        await require('rxjs').firstValueFrom(config.ready$)
        config.store.ssh.verifyHostKeys = false
        window.__memoryIntegration = {
            zone, app, profiles, config, current: null,
            async open(options = {}, type = 'ssh') {
                const local = type === 'local' ? { options: { command: '/bin/bash', args: ['--noprofile', '--norc'], homeDirArgs: [], env: { HISTFILE: '/dev/null' } } } : {}
                const profile = { ...local, id: 'memory-fixture-' + Math.random(), type, name: 'Memory fixture',
                    behaviorOnSessionEnd: 'keep', clearServiceMessagesOnConnect: false,
                    options: type === 'ssh' ? { host: '127.0.0.1', port: ${addresses.ssh}, user: 'normal', auth: 'password', reuseSession: false, ...options } : { ...local.options, ...options } }
                const opened = await zone.run(() => profiles.openNewTabForProfile(profile))
                const term = opened.getAllTabs ? opened.getAllTabs()[0] : opened
                const state = { term, closed: false, bytes: 0, held: [], paused: false }
                this.current = state
                return term.constructor.name
            },
            pending() { return [...this.current.term.pendingSSH][0] },
            text() {
                const b = this.current.term.frontend?.xterm.buffer.active
                return b ? Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('\\n') : ''
            },
            capture() {
                const p = this.current
                p.session = p.term.session
                p.frontend = p.term.frontend
                p.native = p.term.sshSession?.ssh
                p.hash = require('crypto').createHash('sha256')
                p.chunks = []
                p.subscription = p.session.binaryOutput$.subscribe(data => {
                    p.bytes += data.length
                    p.hash.update(data)
                    if (p.collect) { p.chunks.push(Buffer.from(data)) }
                })
                p.originalWrite = p.frontend.xterm.write.bind(p.frontend.xterm)
                p.frontend.xterm.write = (data, callback) => p.originalWrite(data, () => {
                    if (p.paused && callback) { p.held.push(callback) } else { callback?.() }
                })
            },
            resume() {
                const p = this.current
                p.paused = false
                for (const callback of p.held.splice(0)) { callback() }
            },
            async close() {
                const p = this.current
                const parent = app.tabs.find(t => t === p.term || (t.getAllTabs?.() ?? []).includes(p.term))
                if (parent) { await zone.run(() => app.closeTab(parent, false)) }
                p.subscription?.unsubscribe()
                p.held = []
                p.closed = true
            },
        }
        if (!require('russh').SshCancellation) { throw new Error('Local russh override is missing') }
    })()`)
    const open = options => renderer.eval(`window.__memoryIntegration.open(${JSON.stringify(options ?? {})})`)
    const ready = () => until(() => renderer.eval("!!window.__memoryIntegration.current.term.session?.shell && window.__memoryIntegration.text().includes('FIXTURE READY')", false), 'SSH shell ready')
    const close = async () => {
        await renderer.eval('window.__memoryIntegration.close()')
        await until(async () => (await metrics()).connections === 0 && (await metrics()).channels === 0, 'SSH connections released')
    }
    // Native budget stays charged until the real xterm write callback completes.
    await open()
    await ready()
    await renderer.eval("(() => { const m = window.__memoryIntegration; m.capture(); m.current.paused = true; m.current.term.sendInput('flood 8388608\\n') })()")
    await until(() => renderer.eval('window.__memoryIntegration.current.native.receiveBufferStats().pendingBytes >= 262144', false), 'receive budget full')
    const paused = await renderer.eval('({ bytes: window.__memoryIntegration.current.bytes, ...window.__memoryIntegration.current.native.receiveBufferStats() })', false)
    await sleep(500)
    const stable = await renderer.eval('({ bytes: window.__memoryIntegration.current.bytes, ...window.__memoryIntegration.current.native.receiveBufferStats() })', false)
    assert.deepEqual(stable, paused)
    assert(paused.pendingBytes <= 262144)
    assert(paused.pendingPackets <= 1024)
    await renderer.eval('window.__memoryIntegration.resume()')
    await until(() => renderer.eval("window.__memoryIntegration.text().includes('FLOOD DONE')", false), '8 MiB rendered', 60)
    const received = await renderer.eval("({ bytes: window.__memoryIntegration.current.bytes, sha256: window.__memoryIntegration.current.hash.digest('hex'), stats: window.__memoryIntegration.current.native.receiveBufferStats() })", false)
    const chunk = Buffer.from('0123456789abcdef'.repeat(1023) + '0123456789abcd\r\n')
    const expected = Buffer.concat([...Array(512).fill(chunk), Buffer.from('\r\nFLOOD DONE\r\n')])
    assert.equal(received.bytes, expected.length)
    assert.equal(received.sha256, require('node:crypto').createHash('sha256').update(expected).digest('hex'))
    assert.equal(received.stats.pendingBytes, 0)
    report('SSH render backpressure and lossless resume', { paused, received })
    await renderer.eval("(() => { const p = window.__memoryIntegration.current; p.subscription.unsubscribe(); p.unicode = ''; p.subscription = p.session.output$.subscribe(x => { p.unicode += x }); p.term.sendInput('unicode\\n') })()")
    await until(() => renderer.eval("window.__memoryIntegration.text().includes('UNICODE DONE')", false), 'split UTF-8 rendered')
    const unicode = await renderer.eval('window.__memoryIntegration.current.unicode', false)
    assert(unicode.includes('日本語'))
    assert(!unicode.includes('\ufffd'))
    report('split UTF-8 and OSC', { intact: true })
    const shared = await renderer.eval(`(async () => {
        const client = window.__memoryIntegration.current.native
        for (let i = 0; i < 20; i++) {
            const channel = await client.activateChannel(await client.openSessionChannel())
            channel.setReceiveBufferLimit(4096)
            const subscriptions = [channel.data$.subscribe(data => channel.acknowledgeData(data)),
                channel.extendedData$.subscribe(([, data]) => channel.acknowledgeData(data))]
            let closedSubscription
            const closed = new Promise(resolve => { closedSubscription = channel.closed$.subscribe(resolve) })
            await channel.requestShell()
            await channel.write(Buffer.from('exit\\n'))
            await closed
            await channel.close()
            await channel.close()
            subscriptions.forEach(s => s.unsubscribe())
            closedSubscription.unsubscribe()
            if (client.receiveBufferStats().managedChannels !== 1) {
                throw new Error('Closed channel receive state accumulated')
            }
        }
        return client.receiveBufferStats()
    })()`)
    assert.equal(shared.managedChannels, 1)
    assert.equal(shared.pendingBytes, 0)
    report('shared connection releases receive state after remote close', { repetitions: 20, remainingLiveChannels: shared.managedChannels })
    await renderer.eval("window.__memoryIntegration.current.term.sendInput('exit\\n')")
    await until(() => renderer.eval('window.__memoryIntegration.current.session.isDestroyed', false), 'remote EOF closes shell')
    assert(await renderer.eval("window.__memoryIntegration.text().includes('FINAL OUTPUT')", false))
    report('final output precedes EOF teardown', { rendered: true })
    await close()

    // Closing while the actual parser callback is withheld must release both sides.
    await open()
    await ready()
    await renderer.eval("(() => { const m = window.__memoryIntegration; m.capture(); m.current.paused = true; m.current.term.sendInput('flood 8388608\\n') })()")
    await until(() => renderer.eval('window.__memoryIntegration.current.native.receiveBufferStats().pendingBytes >= 262144', false), 'paused close setup')
    const closeStarted = Date.now()
    await close()
    const closed = await renderer.eval('({ pendingBytes: window.__memoryIntegration.current.native.receiveBufferStats().pendingBytes, parserWaiters: window.__memoryIntegration.current.frontend.flowControl.pending.size, destroyed: window.__memoryIntegration.current.session.isDestroyed })', false)
    assert.deepEqual(closed, { pendingBytes: 0, parserWaiters: 0, destroyed: true })
    report('close while renderer paused', { elapsedMs: Date.now() - closeStarted, ...closed })

    await renderer.eval('window.__memoryIntegration.current = null', false)
    await renderer.send('HeapProfiler.collectGarbage')
    const heapBefore = (await renderer.send('Runtime.getHeapUsage')).usedSize
    for (let i = 0; i < 10; i++) {
        await open({ port: bannerServer.address().port })
        await until(() => peers.size === 1, 'banner wait starts')
        await renderer.eval('window.__memoryIntegration.close()')
        await until(() => peers.size === 0, 'banner socket closes')
    }
    await renderer.eval('window.__memoryIntegration.current = null', false)
    await renderer.send('HeapProfiler.collectGarbage')
    const heapAfter = (await renderer.send('Runtime.getHeapUsage')).usedSize
    report('close during SSH banner wait', { repetitions: 10, remainingSockets: peers.size, heapBefore, heapAfter, heapDelta: heapAfter - heapBefore })

    await open({ user: 'stall-auth' })
    await until(async () => (await metrics()).auth_waiting === 1, 'authentication waiting')
    await close()
    report('close during authentication', await metrics())

    await renderer.eval('window.__memoryIntegration.config.store.ssh.verifyHostKeys = true', false)
    await open()
    await until(() => renderer.eval('!!window.__memoryIntegration.pending()?.authModals.size', false), 'host key prompt')
    await close()
    await until(() => renderer.eval("document.querySelectorAll('ngb-modal-window').length === 0", false), 'host-key modal dismissed')
    report('close during host key prompt', { remainingModals: 0 })

    // Also exercise the local PTY ACK -> main-process pause path.
    await renderer.eval("window.__memoryIntegration.open({}, 'local')")
    await until(() => renderer.eval('!!window.__memoryIntegration.current.term.session?.open', false), 'local PTY ready')
    await sleep(1000)
    const localCommand = `python3 -c "import sys;sys.stdout.write('LOCAL'+'-START\\n'+'x'*8388608+'LOCAL'+'-END\\n')"\n`
    await renderer.eval(`(() => {
        const m = window.__memoryIntegration; m.capture(); const p = m.current
        p.collect = true; p.paused = true; p.acks = 0
        const ack = p.session.pty.ackData.bind(p.session.pty)
        p.session.pty.ackData = bytes => { p.acks += bytes; ack(bytes) }
        p.term.sendInput(${JSON.stringify(localCommand)})
    })()`)
    await until(() => renderer.eval('window.__memoryIntegration.current.bytes > 100000', false), 'local producer paused')
    await sleep(500)
    const localPaused = await renderer.eval('({ bytes: window.__memoryIntegration.current.bytes, acks: window.__memoryIntegration.current.acks })', false)
    assert.equal(localPaused.acks, 0)
    assert(localPaused.bytes < 750000)
    await renderer.eval('window.__memoryIntegration.resume()')
    await until(() => renderer.eval("window.__memoryIntegration.text().includes('LOCAL-END')", false), 'local output rendered', 60)
    const localOutput = await renderer.eval(`(() => {
        const p = window.__memoryIntegration.current
        const bytes = Buffer.concat(p.chunks)
        const start = bytes.indexOf('LOCAL-START\\r\\n') + Buffer.byteLength('LOCAL-START\\r\\n')
        const end = bytes.indexOf('LOCAL-END\\r\\n', start)
        return { length: end - start, sha256: require('crypto').createHash('sha256').update(bytes.subarray(start, end)).digest('hex') }
    })()`)
    assert.equal(localOutput.length, 8388608)
    assert.equal(localOutput.sha256, require('node:crypto').createHash('sha256').update(Buffer.alloc(8388608, 'x')).digest('hex'))
    report('local PTY waits for parser ACK and resumes without loss', { paused: localPaused, received: localOutput })
    const outputScreenshot = await renderer.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(out, 'output.png'), Buffer.from(outputScreenshot.data, 'base64'))
    const exitCommand = `python3 -c "import sys;sys.stdout.write('x'*1048576+'FINAL'+'-LOCAL\\n')"; exit\n`
    await renderer.eval(`(() => {
        const p = window.__memoryIntegration.current
        p.bytes = 0; p.chunks = []; p.acks = 0; p.paused = true
        p.term.sendInput(${JSON.stringify(exitCommand)})
    })()`)
    await until(() => renderer.eval('window.__memoryIntegration.current.bytes > 100000', false), 'local exit output paused')
    await renderer.eval('window.__memoryIntegration.resume()')
    await until(() => renderer.eval('window.__memoryIntegration.current.session.isDestroyed', false), 'local exit drains output')
    assert(await renderer.eval("window.__memoryIntegration.text().includes('FINAL-LOCAL')", false))
    report('local process exit preserves pending final output', { rendered: true })
    await renderer.eval('window.__memoryIntegration.close()')
    const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(out, 'final.png'), Buffer.from(screenshot.data, 'base64'))
    report('final resources', await metrics())
    assert.equal(consoleErrors.filter(x => /Unhandled|Uncaught|TypeError|ReferenceError/.test(x)).length, 0, 'No unhandled renderer errors')
} catch (error) {
    if (renderer) {
        console.error('Renderer state:', await renderer.eval(`(() => {
            const m = window.__memoryIntegration, p = m?.current
            return { type: p?.term?.constructor.name, session: p?.term?.session?.constructor.name,
                open: p?.term?.session?.open, bytes: p?.bytes, text: m?.text().slice(-1000) }
        })()`, false).catch(() => null))
    }
    throw error
} finally {
    writeFileSync(resolve(out, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2))
    renderer?.ws.close()
    for (const child of children.reverse()) { child.kill('SIGTERM') }
    for (const socket of peers) { socket.destroy() }
    await new Promise(resolve => bannerServer.close(resolve))
}
