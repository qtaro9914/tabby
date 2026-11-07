// Run from the Tabby repository: node scripts/audit-memory-leaks.cjs
// Exercises actual transpiled source methods with in-memory platform fixtures.
// Regression assertions cover repaired lifetimes; direct writes still require producer backpressure.
// See MEMORY-LEAK-AUDIT.md for scope and the acceptance checks to use after fixes.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const repoRequire = createRequire(path.join(root, 'package.json'))
const ts = repoRequire('typescript')
const rx = repoRequire('rxjs')
const { EventEmitter, setMaxListeners } = require('node:events')
const angular = new Proxy({}, { get: () => () => () => {} })
const log = { info () {}, debug () {}, warn () {}, error () {} }

function load (file, imports = {}, extra = '', globals = {}) {
    const module = { exports: {} }
    const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8') + '\n' + extra, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true, esModuleInterop: true,
        },
    }).outputText
    const localRequire = id => {
        if (id in imports) { return imports[id] }
        if (id === 'rxjs') { return rx }
        if (id === '@angular/core') { return angular }
        if (id === '@biesbjerg/ngx-translate-extract-marker') { return { marker: x => x } }
        if (id === '@angular/animations') { return new Proxy({}, { get: () => () => ({}) }) }
        if (/\.(pug|scss)$/.test(id)) { return '' }
        return {}
    }
    vm.runInNewContext(source, {
        module, exports: module.exports, require: localRequire, Buffer, process,
        console: { ...console, debug () {} }, performance, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval,
        window: { localStorage: {} },
        ...globals,
    }, { filename: file })
    return module.exports
}

const { BaseComponent, SubscriptionContainer } = load('tabby-core/src/components/base.component.ts')
const core = { BaseComponent, SubscriptionContainer, LogService: class {}, ConfigService: class {} }
const { BaseTabComponent } = load('tabby-core/src/components/baseTab.component.ts', {
    './base.component': { BaseComponent }, '../services/config.service': core,
})
core.BaseTabComponent = BaseTabComponent
const middleware = load('tabby-terminal/src/api/middleware.ts', { 'tabby-core': core })
const osc = load('tabby-terminal/src/middleware/oscProcessing.ts', {
    '../api/middleware': middleware, os: require('node:os'),
})
const login = load('tabby-terminal/src/middleware/loginScriptProcessing.ts', {
    '../api/middleware': middleware, 'clone-deep': repoRequire('clone-deep'),
})
const { BaseSession } = load('tabby-terminal/src/session.ts', {
    './api/middleware': middleware,
    './middleware/oscProcessing': osc,
    './middleware/loginScriptProcessing': login,
})
const results = []

async function main () {
    const ipcMain = new EventEmitter()
    const autoUpdater = new EventEmitter()
    ipcMain.setMaxListeners(0)
    autoUpdater.setMaxListeners(0)
    const { Window } = load('app/lib/window.ts', {
        electron: { ipcMain, nativeImage: { createFromPath () {} }, app: { getAppPath: () => '/tmp' } },
        'electron-updater': { autoUpdater }, './windows': { isWindowsBuild: () => false },
    })
    for (let i = 0; i < 20; i++) {
        const w = Object.create(Window.prototype)
        w.listenerCleanup = []
        w.window = new EventEmitter()
        w.window.webContents = { setWindowOpenHandler () {} }
        w.visible = new rx.Subject()
        w.closed = new rx.Subject()
        w.setupWindowManagement()
        w.setupUpdater()
        w.destroy()
    }
    assert.equal(ipcMain.listenerCount('window-set-title'), 0)
    assert.equal(autoUpdater.listenerCount('update-available'), 0)
    results.push({ case: 'closed windows release global listeners', iterations: 20,
        ipcListeners: ipcMain.eventNames().reduce((n, k) => n + ipcMain.listenerCount(k), 0),
        updaterListeners: autoUpdater.eventNames().reduce((n, k) => n + autoUpdater.listenerCount(k), 0) })

    const { ProfileTreeComponent } = load('tabby-core/src/components/profileTree.component.ts', {
        './base.component': { BaseComponent },
    })
    const app = { tabsChanged$: new rx.Subject(), activeTabChange$: new rx.Subject() }
    const config = { changed$: new rx.Subject() }
    for (let i = 0; i < 50; i++) {
        const tree = new ProfileTreeComponent(app, {}, config, {}, {}, {})
        tree.loadTreeItems = async () => {}
        await tree.ngOnInit()
        tree.ngOnDestroy()
    }
    assert.equal(app.tabsChanged$.observers.length, 0)
    assert.equal(app.activeTabChange$.observers.length, 0)
    assert.equal(config.changed$.observers.length, 0)
    results.push({ case: 'destroyed profile trees', iterations: 50,
        tabObservers: app.tabsChanged$.observers.length,
        activeTabObservers: app.activeTabChange$.observers.length,
        configObservers: config.changed$.observers.length })

    core.LocaleService = { allLanguages: [] }
    core.Platform = { macOS: 1 }
    const { SettingsTabComponent } = load('tabby-settings/src/components/settingsTab.component.ts', {
        'tabby-core': core,
        '@biesbjerg/ngx-translate-extract-marker': { marker: x => x },
        'js-yaml': { dump: () => '' },
        'utils-decorators/dist/esm/debounce/debounce': { debounce: () => () => {} },
    })
    const settingsConfig = {
        changed$: new rx.Subject(), enabledServices: x => x, getDefaults: () => ({}),
        readRaw: () => '', store: { appearance: {} }, save () {},
    }
    for (let i = 0; i < 50; i++) {
        const settings = new SettingsTabComponent(settingsConfig, {}, {}, {}, {}, {}, {}, {}, [],
            { instant: x => x }, { get: () => settingsConfig })
        settings.destroy()
        settings.ngOnDestroy()
    }
    assert.equal(settingsConfig.changed$.observers.length, 0)
    results.push({ case: 'closed settings tabs run base cleanup', iterations: 50,
        remainingConfigObservers: settingsConfig.changed$.observers.length })

    const channels = []
    const ssh = {
        serviceMessage$: new rx.Subject(), willDestroy$: new rx.Subject(), refs: 1,
        ref () { this.refs++ }, unref () { this.refs-- },
    }
    const terminal = { BaseSession, UTF8SplitterMiddleware: middleware.SessionMiddleware,
        InputProcessor: middleware.SessionMiddleware }
    let failOpen = false
    const { SSHShellSession } = load('tabby-ssh/src/session/shell.ts', {
        'tabby-core': core, 'tabby-terminal': terminal,
        'strip-ansi': x => x,
        './shellChannel': { openShellChannelForProfile: async () => {
            if (failOpen) { throw new Error('server refused shell') }
            const channel = { data$: new rx.Subject(), eof$: new rx.Subject(), closed$: new rx.Subject(),
                closeCalls: 0, async close () { this.closeCalls++ } }
            channels.push(channel)
            return channel
        } },
    })
    const injector = { get: () => ({ create: () => log }) }
    const profile = { options: { scripts: [], host: 'fixture', input: {} } }
    for (let i = 0; i < 50; i++) {
        const shell = new SSHShellSession(injector, ssh, profile)
        await shell.start()
        await shell.destroy()
    }
    assert.equal(ssh.refs, 1)
    assert.equal(ssh.willDestroy$.observers.length, 0)
    assert.equal(ssh.serviceMessage$.observers.length, 0)
    assert.equal(channels.reduce((n, ch) => n + ch.closeCalls, 0), 50)
    assert.equal(channels.reduce((n, ch) => n + ch.data$.observers.length, 0), 0)
    results.push({ case: 'destroyed shells on a shared SSH connection', iterations: 50,
        serviceObservers: ssh.serviceMessage$.observers.length,
        destroyObservers: ssh.willDestroy$.observers.length,
        channelCloseCalls: channels.reduce((n, ch) => n + ch.closeCalls, 0),
        channelDataObservers: channels.reduce((n, ch) => n + ch.data$.observers.length, 0) })
    failOpen = true
    for (let i = 0; i < 2; i++) {
        const shell = new SSHShellSession(injector, ssh, profile)
        await assert.rejects(shell.start(), /Remote rejected/)
    }
    assert.equal(ssh.refs, 1)
    results.push({ case: 'failed SSH shell opens release references', failures: 2,
        expectedRefs: 1, actualRefs: ssh.refs })

    const timers = new Map()
    let nextTimer = 0
    const { AppService } = load('tabby-core/src/services/app.service.ts', {},
        'export { CompletionObserver }', {
            setInterval: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
            clearInterval: id => timers.delete(id),
        })
    const tab = { destroyed$: new rx.Subject(), getCurrentProcess: async () => ({ name: 'long-running' }) }
    const service = Object.create(AppService.prototype)
    service.completionObservers = new Map()
    for (let i = 0; i < 50; i++) {
        service.observeTabCompletion(tab).subscribe(() => {})
        service.stopObservingTabCompletion(tab)
    }
    assert.equal(timers.size, 0)
    results.push({ case: 'disable task notification stops polling', iterations: 50,
        activeIntervals: timers.size, observerMapSize: service.completionObservers.size })
    tab.destroyed$.next()
    assert.equal(timers.size, 0)

    const { SplitTabComponent } = load('tabby-core/src/components/splitTab.component.ts', {
        './base.component': { SubscriptionContainer },
        './baseTab.component': { BaseTabComponent }, '../api/tabRecovery': { TabRecoveryProvider: class {} },
    })
    const child = new BaseComponent()
    const destroyed = new rx.Subject()
    Object.defineProperty(child, 'destroyed$', { get: () => destroyed })
    for (const name of ['focused', 'titleChange', 'activity', 'progress', 'recoveryStateChangedHint']) {
        child[name + '$'] = new rx.Subject()
    }
    const node = new EventTarget()
    setMaxListeners(0, node)
    child.insertIntoContainer = () => ({ rootNodes: [node] })
    for (let i = 0; i < 50; i++) {
        const parent = Object.create(SplitTabComponent.prototype)
        parent.viewRefs = new Map()
        parent.childSubscriptions = new Map()
        parent.focusedTab = child
        parent.maximizedTab = child
        parent.config = { store: { terminal: {} } }
        parent.getAllTabs = () => [child]
        parent.attachTabView(child)
        const children = [child, {}]
        parent.root = { children, ratios: [0.5, 0.5] }
        parent.getParentOf = () => parent.root
        parent.layout = () => {}
        parent.focusAnyIn = () => {}
        parent.tabRemoved = new rx.Subject()
        child.removeFromContainer = () => {}
        parent.removeTab(child)
        assert.notEqual(parent.focusedTab, child)
        assert.notEqual(parent.maximizedTab, child)
    }
    assert.equal(destroyed.observers.length, 0)
    assert.equal(child.progress$.observers.length, 0)
    results.push({ case: 'moving a live pane releases former parents', iterations: 50,
        destroyedObservers: destroyed.observers.length,
        idleProgressObservers: child.progress$.observers.length,
        registeredDOMListeners: child._subscriptionContainer.events.length })
    child.ngOnDestroy()
    destroyed.complete()

    const { TerminalDecorator } = load('tabby-terminal/src/api/decorator.ts')
    const { BaseTerminalTabComponent } = load('tabby-terminal/src/api/baseTerminalTab.component.ts', {
        'tabby-core': core, './decorator': { TerminalDecorator },
    }, '', { setTimeout: () => 0 })
    const globalKeys = new rx.Subject()
    class FixtureDecorator extends TerminalDecorator {
        attach (t) { this.subscribeUntilDetached(t, globalKeys.subscribe(() => t.marker)) }
    }
    const decorator = new FixtureDecorator()
    const closingTab = Object.create(BaseTerminalTabComponent.prototype)
    let resume
    Object.assign(closingTab, {
        visibility: new rx.Subject(),
        sessionHandlers: new SubscriptionContainer(),
        marker: 'closed', config: { enabledServices: x => x }, decorators: [decorator], logger: log,
        frontendReady: new rx.Subject(), sessionChanged: new rx.Subject(),
        onFrontendReady: () => new Promise(resolve => { resume = resolve }),
        frontend: { detach () {}, destroy () {} }, content: { nativeElement: { remove () {} } },
        detachTermContainerHandlers () {}, output: new rx.Subject(), binaryOutput: new rx.Subject(),
        focused: new rx.Subject(), blurred: new rx.Subject(), titleChange: new rx.Subject(),
        progress: new rx.Subject(), activity: new rx.Subject(), recoveryStateChangedHint: new rx.Subject(),
        destroyed: new rx.Subject(), toolbarRevealTimeout: { clear () {} }, stopSpinner () {},
    })
    const initializing = closingTab.initializeFrontend(80, 24)
    await closingTab.destroy()
    resume()
    await initializing
    assert.equal(globalKeys.observers.length, 0)
    assert.equal(decorator.smartSubscriptions.size, 0)
    results.push({ case: 'late initialization cannot attach after tab destruction',
        tabDestroyed: closingTab._destroyCalled,
        decoratorRetainedTabs: decorator.smartSubscriptions.size,
        lateGlobalObservers: globalKeys.observers.length })
    decorator.detach(closingTab)

    const { ZModemMiddleware } = load('tabby-terminal/src/features/zmodem.ts', {
        '../api/middleware': middleware, '../api/decorator': { TerminalDecorator },
        'ansi-colors': createRequire(path.join(root, 'tabby-terminal/package.json'))('ansi-colors'),
    }, 'export { ZModemMiddleware }')
    const zmodem = Object.create(ZModemMiddleware.prototype)
    const cancel = new rx.Subject()
    Object.assign(zmodem, {
        cancelEvent: cancel, logger: log, showMessage () {},
        platform: { startDownload: async () => ({
            setFinalizing () {}, async finalize () {}, setCompleted () {}, fail () {}, cancel () {},
        }) },
    })
    for (let i = 0; i < 50; i++) {
        await zmodem.receiveFile({
            get_details: () => ({ name: 'empty', size: 0 }), accept: async () => {},
        }, {})
    }
    assert.equal(cancel.observers.length, 0)
    results.push({ case: 'successful ZMODEM downloads release cancellation subscriptions',
        iterations: 50, remainingCancelObservers: cancel.observers.length })
    cancel.next(Buffer.from([3]))

    let releaseWrite
    let frontendWrites = 0
    const queueTab = Object.create(BaseTerminalTabComponent.prototype)
    const blockedWrite = new Promise(resolve => { releaseWrite = resolve })
    Object.assign(queueTab, {
        frontendWriteLock: Promise.resolve(), logger: log,
        withSpinnerPaused: fn => fn(),
        writeRaw: async () => { frontendWrites++; await blockedWrite },
    })
    const pendingWrites = Array.from({ length: 100 }, () => queueTab.write('x'.repeat(65536)))
    await Promise.resolve()
    assert.equal(frontendWrites, 1)
    results.push({ case: 'direct renderer writes require producer backpressure', inputChunks: 100,
        chunksReachedRenderer: frontendWrites, queuedChunks: 100 - frontendWrites,
        queuedCharacters: (100 - frontendWrites) * 65536 })
    releaseWrite()
    await Promise.all(pendingWrites)

    let rejectParser
    const parserWaiting = new Promise((_resolve, reject) => { rejectParser = reject })
    const cancelTab = Object.assign(Object.create(BaseTerminalTabComponent.prototype), {
        frontendWriteLock: Promise.resolve(), logger: log, withSpinnerPaused: fn => fn(),
        writeRaw: () => parserWaiting,
    })
    const cancelledWrites = Array.from({ length: 20 }, () => cancelTab.write('pending'))
    await Promise.resolve()
    cancelTab._isDestroyed = true
    rejectParser(new Error('Terminal frontend disposed'))
    await Promise.all(cancelledWrites)
    results.push({ case: 'tab destruction settles queued parser writes without rejection', writes: 20 })

    const hotkeysUtil = load('tabby-core/src/services/hotkeys.util.ts')
    const { HotkeysService, fixtureJSON } = load('tabby-core/src/services/hotkeys.service.ts', {
        './hotkeys.util': hotkeysUtil,
    }, 'export const fixtureJSON = (s: string) => JSON.parse(s)')
    const keys = Object.create(HotkeysService.prototype)
    Object.assign(keys, {
        disabledLevel: 0, pressedKeys: new Set(), pressedKeyTimestamps: new Map(),
        lastKeystrokes: [], lastEventTimestamp: 0, recognitionPhase: true,
        suppressNextKeyupKeystroke: false, lastWheelTimestamp: null,
        pressedKeystroke: null, pressedHotkey: null,
        cachedHotkeysConfig: null, config: { store: { hotkeys: fixtureJSON('{"copy":[["Ctrl-C"]]}') } },
        zone: { run: fn => fn() },
        _keystroke: new rx.Subject(), _key: new rx.Subject(), _hotkey: new rx.Subject(), _hotkeyOff: new rx.Subject(),
    })
    let timestamp = 0
    for (let i = 0; i < 1000; i++) {
        for (const eventName of ['keydown', 'keyup']) {
            keys.pushKeyEvent(eventName, { key: 'a', code: 'KeyA', timeStamp: ++timestamp })
        }
    }
    for (let i = 0; i < 200; i++) {
        keys.pushKeyEvent('wheel', { deltaY: 1, timeStamp: ++timestamp })
    }
    assert.ok(keys.lastKeystrokes.length <= 1)
    keys.pushKeyEvent('keydown', { key: 'a', code: 'KeyA', timeStamp: ++timestamp })
    assert.ok(keys.getCurrentKeystrokes().length <= 2)
    results.push({ case: 'keystroke history stays bounded across typing and wheel input',
        keyPairs: 1000, wheelEvents: 200, retainedHistory: keys.lastKeystrokes.length,
        copiedSequenceLength: keys.getCurrentKeystrokes().length })

    const recognized = []
    keys._hotkey.subscribe(id => recognized.push(id))
    function keyPair (key, ctrlKey = false) {
        for (const eventName of ['keydown', 'keyup']) {
            keys.pushKeyEvent(eventName, { key, code: `Key${key.toUpperCase()}`, ctrlKey, timeStamp: ++timestamp })
        }
    }
    keys.clearCurrentKeystrokes()
    keyPair('c', true)
    assert.equal(recognized.pop(), 'copy', 'single-stroke hotkey still works')
    keys.config.store.hotkeys = fixtureJSON('{"sequence":[["Ctrl-K","Ctrl-C"]],"wheel":[["A","WheelDown"]]}')
    keys.cachedHotkeysConfig = null
    keys.clearCurrentKeystrokes()
    keyPair('k', true)
    keyPair('c', true)
    assert.equal(recognized.pop(), 'sequence', 'multi-stroke hotkey still works')
    keys.clearCurrentKeystrokes()
    keyPair('a')
    keys.pushKeyEvent('wheel', { deltaY: 1, timeStamp: ++timestamp })
    assert.equal(recognized.pop(), 'wheel', 'wheel sequences retain the preceding stroke')
    keys.disable()
    let recorded = 0
    keys._keystroke.subscribe(() => recorded++)
    for (let i = 0; i < 100; i++) { keyPair('b') }
    assert.equal(recorded, 100, 'hotkey recording still sees every stroke')
    assert.ok(keys.lastKeystrokes.length <= 2)

    const cdkFile = 'node_modules/@angular/cdk/fesm2020/drag-drop.mjs'
    const cdkText = fs.readFileSync(path.join(root, cdkFile), 'utf8')
    const cdkAST = ts.createSourceFile(cdkFile, cdkText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const cdkClass = cdkAST.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CdkDropList')
    const cdkDestroy = cdkClass.members.find(node => node.name?.getText(cdkAST) === 'ngOnDestroy')
    // Run the installed CDK's real destructor, with only its DOM/native fields replaced.
    const CdkDropList = vm.runInNewContext(`class CdkDropList {
        static _dropLists = []
        ${cdkDestroy.getText(cdkAST)}
    }; CdkDropList`)
    const { CdkAutoDropGroup } = load('tabby-core/src/directives/cdkAutoDropGroup.directive.ts')
    for (let i = 0; i < 200; i++) {
        const drop = new CdkDropList()
        Object.assign(drop, { _unsortedItems: new Set(), _dropListRef: { dispose () {} }, _destroyed: new rx.Subject() })
        CdkDropList._dropLists.push(drop)
        const group = new CdkAutoDropGroup(drop)
        group.groupName = 'app-tabs'
        group.ngOnInit()
        drop.ngOnDestroy()
    }
    assert.equal(CdkAutoDropGroup.groups['app-tabs']._items.size, 0)
    results.push({ case: 'Claude H2 excluded because CDK destroys group membership', iterations: 200,
        remainingGroupItems: CdkAutoDropGroup.groups['app-tabs']._items.size,
        cdkVersion: repoRequire('@angular/cdk/package.json').version })

    core.HostAppService = class {}
    core.BOOTSTRAP_DATA = Symbol('bootstrap')
    core.Platform.Windows = 2
    core.Platform.macOS = 1
    const localAPI = { PTYInterface: class {} }
    let restoreReady
    const restorePromise = new Promise(resolve => { restoreReady = resolve })
    const ptyEvents = new Map()
    let ptyKillCalls = 0
    let ptyUnsubscribeCalls = 0
    const pty = {
        getTruePID: async () => 1, getWorkingDirectory: async () => '/tmp',
        subscribe: (event, fn) => ptyEvents.set(event, fn),
        unsubscribeAll () { ptyUnsubscribeCalls++; ptyEvents.clear() },
        kill () { ptyKillCalls++ },
    }
    const localConfig = { store: { terminal: {} } }
    const { Session } = load('tabby-local/src/session.ts', {
        'tabby-core': core, 'tabby-terminal': { BaseSession }, './api': localAPI,
        'mz/fs': { realpath: async x => x },
        './util': { isDirectory: async () => true },
    })
    const local = new Session({ get: token => {
        if (token === core.LogService) { return { create: () => log } }
        if (token === core.ConfigService) { return localConfig }
        if (token === core.HostAppService) { return { platform: 0 } }
        if (token === localAPI.PTYInterface) { return { restore: () => restorePromise } }
        return {}
    } })
    const startingLocal = local.start({ restoreFromPTYID: 'delayed-fixture' })
    await local.destroy()
    restoreReady(pty)
    await startingLocal
    await local.destroy()
    assert.equal(local.open, false)
    assert.equal(ptyEvents.size, 0)
    assert.equal(ptyKillCalls, 1)
    assert.equal(ptyUnsubscribeCalls, 1)
    results.push({ case: 'delayed local PTY acquisition is released after destroy',
        simulatedAsyncAcquisition: true, openAfterDestroy: local.open,
        listenerCount: ptyEvents.size, killCalls: ptyKillCalls, unsubscribeCalls: ptyUnsubscribeCalls })
    ptyEvents.clear()

    class StreamProcessor extends middleware.SessionMiddleware {
        start () {} resize () {}
    }
    const connectableTerminal = { ...terminal, SessionMiddleware: middleware.SessionMiddleware, TerminalStreamProcessor: StreamProcessor }
    let connectSocket
    let socketCloses = 0
    class SocketFixture extends EventEmitter {
        connect (_port, _host, callback) { connectSocket = callback }
        destroy () { if (!this.destroyed) { this.destroyed = true; socketCloses++ } }
    }
    const { TelnetSession } = load('tabby-telnet/src/session.ts', {
        net: { Socket: SocketFixture }, 'tabby-core': core, 'tabby-terminal': connectableTerminal,
        'strip-ansi': x => x,
    })
    const telnet = new TelnetSession(injector, { options: { ...profile.options, port: 23 } })
    const telnetConnecting = telnet.start()
    await telnet.destroy()
    connectSocket()
    await telnetConnecting
    assert.equal(telnet.open, false)
    assert.equal(socketCloses, 1)

    const zoneToken = class {}
    const serialToken = class {}
    core.NotificationsService = class {}
    let nativePort
    let portCloses = 0
    class SerialFixture extends EventEmitter {
        constructor () { super(); this.isOpen = false; nativePort = this }
        open () {}
        close () { this.isOpen = false; portCloses++; this.emit('close') }
    }
    const { SerialSession } = load('tabby-serial/src/api.ts', {
        '@angular/core': { NgZone: zoneToken },
        '@serialport/stream': { SerialPortStream: SerialFixture },
        './services/serial.service': { SerialService: serialToken },
        'tabby-core': core, 'tabby-terminal': connectableTerminal, 'strip-ansi': x => x,
    })
    const serial = new SerialSession({ get: token => {
        if (token === core.LogService) { return { create: () => log } }
        if (token === zoneToken) { return { run: fn => fn() } }
        if (token === serialToken) { return { detectBinding: () => ({}) } }
        return {}
    } }, { options: { ...profile.options, port: 'fixture', baudrate: 9600 } })
    const serialConnecting = serial.start()
    await serial.destroy()
    nativePort.isOpen = true
    nativePort.emit('open')
    await serialConnecting
    assert.equal(serial.open, false)
    assert.equal(portCloses, 1)
    results.push({ case: 'pending telnet and serial connections cannot reopen after destruction', socketCloses, portCloses })

    const { ConnectableTerminalTabComponent } = load('tabby-terminal/src/api/connectableTerminalTab.component.ts', {
        './baseTerminalTab.component': { BaseTerminalTabComponent }, 'tabby-core': core,
    })
    class FixtureSession extends BaseSession {
        constructor (open = true) { super(log); this.open = open }
        async start () {} resize () {} write () {} kill () {}
        async gracefullyKillProcess () {} supportsWorkingDirectory () { return false }
        async getWorkingDirectory () { return null }
    }
    for (const initiallyOpen of [true, false]) {
        const reconnectTab = Object.create(ConnectableTerminalTabComponent.prototype)
        const created = []
        Object.assign(reconnectTab, {
            profile: { behaviorOnSessionEnd: 'reconnect' },
            frontend: { resetTerminalModes () {} },
            injector: { get: () => ({ refreshConfigProxyForProfile: x => x }) },
            sessionHandlers: new SubscriptionContainer(), sessionChanged: new rx.Subject(),
            output: new rx.Subject(), binaryOutput: new rx.Subject(),
            async initializeSession () {
                await Promise.resolve()
                const session = new FixtureSession()
                created.push(session)
                this.setSession(session)
            },
        })
        reconnectTab.setSession(new FixtureSession(initiallyOpen))
        await reconnectTab.reconnect()
        assert.equal(created.length, 1)
        results.push({ case: 'manual reconnect creates one connection',
            initiallyOpen, createdSessions: created.length,
            openSessionsReplacedWithoutDestroy: created.filter(x => x !== reconnectTab.session && x.open).length })
        reconnectTab.profile.behaviorOnSessionEnd = 'keep'
        reconnectTab.setSession(null)
        for (const session of created) { await session.destroy() }
    }

    const sshTransports = []
    const sshShells = []
    let allowConnect
    let signalConnecting
    const connected = new Promise(resolve => { allowConnect = resolve })
    const connecting = new Promise(resolve => { signalConnecting = resolve })
    class FixtureSSHSession {
        constructor () {
            this.serviceMessage$ = new rx.Subject()
            this.willDestroy$ = new rx.Subject()
            this.keyboardInteractivePrompt$ = new rx.Subject()
            this.profile = { name: 'fixture' }
            this.open = false
            this.refs = 0
            this.isDestroyed = false
            sshTransports.push(this)
        }
        ref () { this.refs++ }
        unref () { if (--this.refs === 0) { void this.destroy() } }
        async destroy () { this.isDestroyed = true; this.open = false; this.willDestroy$.next(); this.willDestroy$.complete() }
        async start () { signalConnecting(); await connected; if (this.isDestroyed) { throw new Error('SSH connection cancelled') }; this.open = true }
    }
    class FixtureSSHShell extends FixtureSession {
        constructor () { super(false); this.serviceMessage$ = new rx.Subject(); sshShells.push(this) }
        async start () { this.open = true }
    }
    const { SSHTabComponent } = load('tabby-ssh/src/components/sshTab.component.ts', {
        'tabby-core': core,
        'ansi-colors': createRequire(path.join(root, 'tabby-terminal/package.json'))('ansi-colors'),
        'tabby-terminal': { BaseTerminalTabComponent, ConnectableTerminalTabComponent },
        '../session/ssh': { SSHSession: FixtureSSHSession },
        '../session/shell': { SSHShellSession: FixtureSSHShell },
    })
    const sshTab = Object.create(SSHTabComponent.prototype)
    const multiplexed = new Set()
    Object.assign(sshTab, {
        visibility: new rx.Subject(),
        profile: { options: { reuseSession: false } }, pendingSSH: new Set(),
        toolbarRevealTimeout: { clear () {} },
        sshMultiplexer: { getSession: async () => null, addSession: session => multiplexed.add(session) },
        session: null, sessionHandlers: new SubscriptionContainer(), sessionChanged: new rx.Subject(),
        frontend: { detach () {}, destroy () {} }, content: { nativeElement: { remove () {} } },
        config: { enabledServices: x => x }, decorators: [], injector: {}, size: { columns: 80, rows: 24 },
        output: new rx.Subject(), binaryOutput: new rx.Subject(), frontendReady: new rx.Subject(),
        focused: new rx.Subject(), blurred: new rx.Subject(), titleChange: new rx.Subject(),
        progress: new rx.Subject(), activity: new rx.Subject(), recoveryStateChangedHint: new rx.Subject(),
        destroyed: new rx.Subject(),
        detachTermContainerHandlers () {}, startSpinner () {}, stopSpinner () {},
        translate: { instant: x => x }, write: async () => {}, logger: log,
    })
    const startingSSH = sshTab.initializeSessionMaybeMultiplex()
    await connecting
    await sshTab.destroy()
    allowConnect()
    await assert.rejects(startingSSH, /cancelled/)
    assert.equal(multiplexed.size, 0)
    assert.equal(sshTab.session, null)
    results.push({ case: 'SSH connection completion cannot populate a destroyed tab',
        tabDestroyed: sshTab._destroyCalled, multiplexerEntries: multiplexed.size,
        openTransports: sshTransports.filter(x => x.open).length,
        openShells: sshShells.filter(x => x.open).length })

    const { KeyboardInteractivePrompt, SSHSession } = load('tabby-ssh/src/session/ssh.ts')
    const prompt = new KeyboardInteractivePrompt('fixture', '', [{ prompt: 'Password' }])
    let promptSettled = false
    prompt.promise.then(() => { promptSettled = true }, () => { promptSettled = true })
    const promptSession = Object.create(SSHSession.prototype)
    Object.assign(promptSession, { logger: log, willDestroy: new rx.Subject(), serviceMessage: new rx.Subject(),
        authModals: new Set(), activePrompt: prompt, cancellation: { cancel () {} }, keyboardInteractivePrompt: new rx.Subject(),
        ssh: { async disconnect () {} } })
    await promptSession.destroy()
    await Promise.resolve()
    assert.equal(promptSettled, true)
    results.push({ case: 'SSH destroy settles an outstanding keyboard-interactive prompt',
        promptSettledAfterDestroy: promptSettled,
        scope: 'destructor and prompt only; authentication chain inspected statically' })
    prompt.reject()

    const sshOptions = { host: 'fixture', algorithms: { cipher: [], kex: [], hmac: [], hostkey: [], compression: [] } }
    const algorithmTypes = { CIPHER: 'cipher', KEX: 'kex', HMAC: 'hmac', HOSTKEY: 'hostkey', COMPRESSION: 'compression' }
    let finishConnect
    let notifyConnect
    let nativeDisconnects = 0
    const connectDelay = new Promise(resolve => { finishConnect = resolve })
    const connectStarted = new Promise(resolve => { notifyConnect = resolve })
    const channelFixture = { async requestPTY () { throw new Error('PTY refused') }, async close () { this.closes++ }, closes: 0 }
    class AuthenticatedClient {
        async openSessionChannel () { return {} }
        async activateChannel () { return channelFixture }
    }
    class NativeClient {
        static async connect () { notifyConnect(); await connectDelay; return new NativeClient() }
        async disconnect () { nativeDisconnects++ }
    }
    const { SSHSession: RealSSHSession } = load('tabby-ssh/src/session/ssh.ts', {
        russh: { SSHClient: NativeClient, AuthenticatedSSHClient: AuthenticatedClient,
            SshTransport: { newSocket: async () => ({ async close () {} }) } },
        '../api': { SSHAlgorithmType: algorithmTypes },
        './algorithms': { supportedAlgorithms: sshOptions.algorithms },
        '../algorithms': { supportedAlgorithms: sshOptions.algorithms },
        './shellChannel': load('tabby-ssh/src/session/shellChannel.ts'),
    })
    function realSSHFixture () {
        return Object.assign(Object.create(RealSSHSession.prototype), {
            logger: log, profile: { options: sshOptions }, cancellation: { cancel () {} },
            authModals: new Set(), activePrompt: null, willDestroy: new rx.Subject(),
            serviceMessage: new rx.Subject(), keyboardInteractivePrompt: new rx.Subject(),
            async init () {},
        })
    }
    const pendingNative = realSSHFixture()
    const nativeStarting = pendingNative.start()
    await connectStarted
    await pendingNative.destroy()
    finishConnect()
    await assert.rejects(nativeStarting, /cancelled/)
    assert.equal(nativeDisconnects, 1, 'client returned after cancellation must be disconnected')

    const refusingSSH = realSSHFixture()
    refusingSSH.ssh = new AuthenticatedClient()
    await assert.rejects(refusingSSH.openShellChannel({ x11: false }), /PTY refused/)
    assert.equal(channelFixture.closes, 1, 'partially initialized channel is closed after PTY failure')

    let dismissModal
    let modalDismissals = 0
    const modalSSH = realSSHFixture()
    const modalResult = new Promise((_resolve, reject) => { dismissModal = reject })
    modalSSH.ngbModal = { open: () => ({ result: modalResult,
        dismiss () { modalDismissals++; dismissModal(new Error('closed')) } }) }
    modalSSH.openAuthModal({})
    await modalSSH.destroy()
    await assert.rejects(modalResult, /closed/)
    assert.equal(modalDismissals, 1)
    assert.equal(modalSSH.authModals.size, 0)

    const delayedEvents = new rx.Subject()
    let loadTree
    const loadingTree = new ProfileTreeComponent({ tabsChanged$: delayedEvents, activeTabChange$: delayedEvents }, {}, config, {}, {}, {})
    loadingTree.loadTreeItems = () => new Promise(resolve => { loadTree = resolve })
    const loading = loadingTree.ngOnInit()
    loadingTree.ngOnDestroy()
    loadTree()
    await loading
    assert.equal(delayedEvents.observers.length, 0, 'destroy during tree loading cannot register late subscriptions')

    let completeProcess
    const waitingTab = { destroyed$: new rx.Subject(), getCurrentProcess: () => new Promise(resolve => { completeProcess = resolve }) }
    let notices = 0
    service.observeTabCompletion(waitingTab).subscribe(() => notices++)
    const polling = [...timers.values()][0]()
    service.stopObservingTabCompletion(waitingTab)
    completeProcess(null)
    await polling
    assert.equal(notices, 0, 'in-flight process check cannot notify after cancellation')
    assert.equal(timers.size, 0)

    const delays = new Map()
    let delayId = 0
    let directories = 0
    let cleanups = 0
    let downloads = 0
    let watches = 0
    let closedWatches = 0
    let saves = 0
    let onFileEvent
    const { EditSFTPContextMenu } = load('tabby-electron/src/sftpContextMenu.ts', {
        'tabby-ssh': { SFTPContextMenuItemProvider: class {} },
        'tmp-promise': { dir: async () => ({ path: `/tmp/edit-fixture-${++directories}`, cleanup: async () => { cleanups++ } }) },
        fs: { chmodSync () {}, watch (_path, callback) {
            watches++
            onFileEvent = callback
            const watcher = new EventEmitter()
            watcher.close = () => { closedWatches++ }
            return watcher
        } },
        './services/platform.service': { resolveInsideBase: (base, file) => path.join(base, file) },
        rxjs: { ...rx, debounceTime: () => source => source },
    }, '', {
        setTimeout: fn => { const id = ++delayId; delays.set(id, fn); return id },
        clearTimeout: id => delays.delete(id),
    })
    const platform = {
        async startDownload () { downloads++; return { cancel () {} } },
        async startUpload () { return [{ cancel () {} }] },
        async openPath () {},
    }
    const edits = new EditSFTPContextMenu({}, platform)
    const file = { name: 'fixture.txt', fullPath: '/remote/fixture.txt', mode: 0o644, size: 0 }
    const editSFTP = { isClosed: false, closed$: new rx.Subject(), async download () {},
        async upload () { saves++ }, async chmod () {} }
    const panel = { openTransferSFTP: async () => editSFTP }
    await Promise.all([edits.edit(file, panel), edits.edit(file, panel)])
    assert.equal(directories, 1, 'reopening a file reuses its temporary directory')
    assert.equal(downloads, 1)
    editSFTP.isClosed = true
    editSFTP.closed$.next()
    await new Promise(setImmediate)
    assert.equal(delays.size, 0, 'disconnect cancels watcher creation')
    assert.equal(watches, 0)
    assert.equal(cleanups, 1)

    editSFTP.isClosed = false
    editSFTP.closed$ = new rx.Subject()
    await edits.edit(file, panel)
    const delay = [...delays.values()][0]
    delays.clear()
    delay()
    assert.equal(watches, 1)
    onFileEvent('rename')
    await new Promise(setImmediate)
    assert.equal(saves, 1, 'atomic-save change is uploaded')
    assert.equal(watches, 2, 'watcher follows the replaced inode')
    assert.equal(closedWatches, 1)
    editSFTP.isClosed = true
    editSFTP.closed$.next()
    await new Promise(setImmediate)
    assert.equal(closedWatches, 2)
    assert.equal(cleanups, 2)

    editSFTP.isClosed = false
    editSFTP.closed$ = new rx.Subject()
    platform.startDownload = async () => null
    await edits.edit(file, panel)
    await new Promise(setImmediate)
    assert.equal(cleanups, 3, 'cancelled edit removes its temporary directory')
    assert.equal(delays.size, 0)
    platform.startDownload = async () => ({ cancel () {} })
    editSFTP.download = async () => { throw new Error('download failed') }
    await assert.rejects(edits.edit(file, panel), /download failed/)
    await new Promise(setImmediate)
    assert.equal(cleanups, 4, 'failed edit removes its temporary directory')
    results.push({ case: 'SFTP editing follows connection lifetime', directories, cleanups, watches, closedWatches, saves })

    console.log(JSON.stringify(results, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
