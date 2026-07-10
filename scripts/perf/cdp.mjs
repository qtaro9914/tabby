// Minimal CDP client shared by the perf scripts. Node 21+ (global WebSocket).

export class CDP {
    constructor (ws) {
        this.ws = ws
        this.id = 0
        this.pending = new Map()
        ws.addEventListener('message', ev => {
            const msg = JSON.parse(ev.data)
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id)
                this.pending.delete(msg.id)
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
            }
        })
    }

    static async connect (url) {
        const ws = new WebSocket(url)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        return new CDP(ws)
    }

    send (method, params = {}) {
        const id = ++this.id
        this.ws.send(JSON.stringify({ id, method, params }))
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    }

    async eval (expression, awaitPromise = true) {
        if (typeof awaitPromise !== 'boolean') {
            throw new Error('awaitPromise must be a boolean')
        }
        const r = await this.send('Runtime.evaluate', {
            expression, awaitPromise, returnByValue: true,
        })
        if (r.exceptionDetails) {
            throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
        }
        return r.result.value
    }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function findRendererTarget (port = process.env.PERF_CDP_PORT ?? 9222) {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
            const page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools'))
            if (page) { return page }
        } catch { /* not up yet */ }
        await sleep(1000)
    }
    throw new Error('no CDP page target found — launch with --remote-debugging-port')
}

export async function findMainProcessTarget (port = process.env.PERF_INSPECT_PORT ?? 9229) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    const target = list[0]
    if (!target) { throw new Error('no Node inspector target — launch with --inspect') }
    return target
}

// Aggregate a V8 CPU profile: self-time per category and top functions
export function summarizeProfile (profile, categories = []) {
    const nodes = profile.nodes
    const total = nodes.reduce((a, n) => a + (n.hitCount || 0), 0)
    const cats = {}
    const funcs = new Map()
    let idle = 0
    for (const n of nodes) {
        const hits = n.hitCount || 0
        if (!hits) { continue }
        const { functionName, url } = n.callFrame
        if (['(idle)', '(program)', '(garbage collector)', '(root)'].includes(functionName)) {
            idle += functionName === '(idle)' ? hits : 0
            cats[functionName] = (cats[functionName] || 0) + hits
            continue
        }
        let cat = 'other JS'
        for (const [name, re] of categories) {
            if (re.test(url) || re.test(functionName)) { cat = name; break }
        }
        cats[cat] = (cats[cat] || 0) + hits
        const key = `${functionName || '(anonymous)'} @ ${url.replace(/^webpack:\/\//, '').slice(0, 100)}`
        funcs.set(key, (funcs.get(key) || 0) + hits)
    }
    const catPct = Object.fromEntries(
        Object.entries(cats).sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, +(v / total * 100).toFixed(1)]))
    const topFunctions = [...funcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
        .map(([k, v]) => `${(v / total * 100).toFixed(1)}% ${k}`)
    return { totalSamples: total, busyPct: +((total - idle) / total * 100).toFixed(1), categoriesPctOfTotal: catPct, topFunctions }
}
