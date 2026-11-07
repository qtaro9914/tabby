// Reversible local native-addon override; release dependency/lockfile stay intact.
// node scripts/use-local-russh.mjs /path/to/russh-napi
// node scripts/use-local-russh.mjs --restore
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const installed = join(root, 'app/node_modules/russh')
const backup = join(root, '.native-work/russh-release-backup')
const source = process.argv[2]
if (source === '--restore') {
    if (!existsSync(backup)) { throw new Error('No saved release installation') }
    rmSync(installed, { recursive: true, force: true })
    renameSync(backup, installed)
    console.log('Restored release russh installation')
} else {
    if (!source) { throw new Error('Pass the built russh-napi directory or --restore') }
    const fork = resolve(source)
    for (const file of ['lib/index.js', 'lib/native.d.ts']) {
        if (!existsSync(join(fork, file))) { throw new Error(`Build the fork first: missing ${file}`) }
    }
    const bindings = readdirSync(fork).filter(x => x.endsWith('.node'))
    if (!bindings.length) { throw new Error('Build the fork first: no native addon') }
    mkdirSync(join(root, '.native-work'), { recursive: true })
    if (!existsSync(backup)) { cpSync(installed, backup, { recursive: true }) }
    cpSync(join(fork, 'lib'), join(installed, 'lib'), { recursive: true })
    for (const file of bindings) { cpSync(join(fork, file), join(installed, file)) }
    console.log(`Using local russh from ${fork}; release backup: ${backup}`)
}
