// Generate a deterministic ~50MB log file for throughput tests.
// Usage: node scripts/perf/gen-test-log.mjs [outPath] [sizeMB]
import { createWriteStream } from 'fs'

const out = process.argv[2] ?? '/tmp/huge.log'
const sizeMB = parseInt(process.argv[3] ?? '50')
const levels = ['INFO', 'WARN', 'DEBUG', 'ERROR', 'TRACE']
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// deterministic PRNG so runs are comparable
let seed = 42
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
}

const stream = createWriteStream(out)
let total = 0
let i = 0
const target = sizeMB * 1024 * 1024

function write () {
    while (total < target) {
        let payload = ''
        for (let j = 0; j < 80; j++) { payload += chars[Math.floor(rand() * chars.length)] }
        const line = `2026-07-09T12:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')} [${levels[i % 5]}] worker-${i % 16} request id=${i} path=/api/v1/items/${i % 9999} status=${200 + i % 3 * 100} duration=${i % 250}.${i % 97}ms payload=${payload}\n`
        i++
        total += line.length
        if (!stream.write(line)) {
            stream.once('drain', write)
            return
        }
    }
    stream.end(() => console.log(`wrote ${i} lines, ${total} bytes to ${out}`))
}
write()
