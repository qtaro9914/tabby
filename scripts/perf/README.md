# Performance measurement scripts

CDP (Chrome DevTools Protocol) based profiling harness used for the
`PERF-*.md` reports in the repository root. Requires Node 21+ (global
`WebSocket` / `fetch`).

## Setup

1. Build in development mode so profiles have readable function names:

   ```bash
   TABBY_DEV=1 yarn run build
   ```

2. Launch Tabby with a remote debugging port (and `--inspect` if you also
   want to profile the main process):

   ```bash
   TABBY_DEV=1 node_modules/.bin/electron app -d --remote-debugging-port=9222 --inspect=9229
   ```

3. Generate a test log file:

   ```bash
   node scripts/perf/gen-test-log.mjs /tmp/huge.log   # ~50 MB
   ```

## Scripts

### profiler.mjs — renderer scenarios

```bash
PERF_LOG_FILE=/tmp/huge.log PERF_OUT_DIR=/tmp/perf node scripts/perf/profiler.mjs
```

Opens a local shell tab (closing all pre-existing tabs!) and runs:

- **S1** throughput: `cat` the log file, measures MB/s and captures a CPU profile
- **S2** input: 3000 synthetic keydown/keyup pairs, measures µs/keystroke
- **S3** tab recovery: times `saveTabs()` with 1 and 5 tabs

Writes `results.json` and `*.cpuprofile` files (open in Chrome DevTools →
Performance → Load profile) to `PERF_OUT_DIR` (default: cwd).

### main-profiler.mjs — main process during S1

```bash
PERF_LOG_FILE=/tmp/huge.log PERF_OUT_DIR=/tmp/perf node scripts/perf/main-profiler.mjs
```

Connects to the Node inspector (`--inspect=9229`) and the renderer at the
same time, profiles the **main process** while the renderer runs the S1
`cat`. Requires a tab set up by a previous `profiler.mjs` run (reuses
`window.__perf`), or run it right after `profiler.mjs` in the same app
instance.

### zmodem-regression.mjs — ZMODEM detection regression test

```bash
node scripts/perf/zmodem-regression.mjs
```

Verifies that the ZMODEM sentry bypass optimization (see
`tabby-terminal/src/features/zmodem.ts`) still detects sessions: stubs the
accept dialog, then emits a real ZRQINIT header via shell `printf` — once
within a single chunk and once split across the bypass boundary. Requires a
prior `profiler.mjs` run in the same app instance (reuses `window.__perf`).

### s1-repeat.mjs — S1 without a profiler

```bash
PERF_LOG_FILE=/tmp/huge.log node scripts/perf/s1-repeat.mjs [runs=4]
```

Repeats the S1 `cat` with no CPU profiler attached (profiling slows the
renderer) and prints per-run and mean MB/s. Closes all other tabs and
selects the `window.__perf` tab first. Requires a prior `profiler.mjs` run.

### ipc-count.mjs — PTY output IPC messages and their real size

```bash
PERF_LOG_FILE=/tmp/huge.log node scripts/perf/ipc-count.mjs
```

During one S1 `cat`, records every `pty:<id>:data` payload in the main
process (length and backing `ArrayBuffer` size — Electron serializes the
whole backing store, so `serializedBytes` is what actually crosses IPC) and
the messages received in the renderer. Requires `--inspect` and a prior
`profiler.mjs` run.

### ipc-bench.mjs — main → renderer IPC micro-benchmark

```bash
node scripts/perf/ipc-bench.mjs
```

Sends 12,800 × 4095-byte Buffers via `webContents.send`, varying only where
the Buffer's memory comes from (own `ArrayBuffer`, Node's allocation pool,
a slice of a large Buffer). Shows the per-message cost of shipping pool
views (`Buffer.poolSize` is 64 KiB on Node 24). Requires `--inspect`.

### utf8-integrity.mjs — multi-byte output correctness

```bash
node scripts/perf/utf8-integrity.mjs [/tmp/utf8-test.log] [sizeMB=8]
```

Writes a deterministic log of 2/3/4-byte UTF-8 characters, `cat`s it and
checks that every IPC payload is valid UTF-8 on its own, that the received
file output matches byte for byte (sha256, with the tty's `\n` → `\r\n`) and
that the tail is rendered verbatim in xterm. Requires a prior `profiler.mjs`
run.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PERF_CDP_PORT` | `9222` | renderer remote debugging port |
| `PERF_INSPECT_PORT` | `9229` | main-process Node inspector port |
| `PERF_LOG_FILE` | (required for S1) | absolute path of the test log |
| `PERF_OUT_DIR` | cwd | where results/profiles are written |

## Caveats

- Development builds (unminified, Angular dev mode) are slower than
  production; compare ratios between runs of the same build type, not
  absolute values across build types.
- CDP `Runtime.evaluate` must receive `awaitPromise` as a boolean — passing
  anything else makes the call fail silently.
- CDP evaluations run outside the Angular zone. Any state mutation that
  needs rendering (opening/selecting/closing tabs) must be wrapped in
  `injector.get(require('@angular/core').NgZone).run(...)` — without it the
  tab body is never rendered and the terminal session never starts.
- PTY flow control can be tuned per launch via `TABBY_FLOW_MAX_DELTA` /
  `TABBY_FLOW_MAX_CHUNK` (bytes; see `app/lib/pty.ts`).
