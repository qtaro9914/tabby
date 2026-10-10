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

The four extra S3b tabs are closed again at the end (the S1 tab stays open for
the follow-up scripts), so the next launch doesn't restore them as background
tabs.

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

Writes a deterministic log with 1/2/3/4-byte UTF-8 characters in rotation,
padded so that multi-byte characters start at every offset mod 4096 of the
tty stream (both asserted before the run), `cat`s it and checks that every
IPC payload is valid UTF-8 on its own, that the received file output matches
byte for byte (sha256, with the tty's `\n` → `\r\n`) and that the tail is
rendered verbatim in xterm. Requires a prior `profiler.mjs` run.

### tui-load.mjs — synthetic full-screen TUI load

```bash
node scripts/perf/tui-load.mjs [--fps 30] [--churn 0.3] [--colors truecolor|256|16] [--duration 0]
```

Run inside a terminal tab. htop/btop-like screen in the alternate buffer:
cursor-addressed differential updates at a fixed frame rate (~50 KB/s at
30 fps on a 95×33 pane), periodic full-table re-sorts, SGR colors. With
`truecolor` the hues drift over time, so new glyph/color combinations keep
appearing (as with a long-running btop) — this grows the WebGL glyph atlas.
Every keystroke is echoed immediately as `ECHO:<key>` on the bottom line so a
harness can time input → echo. Quit with `q` or Ctrl+C.

### longrun.mjs — long-session degradation runner

```bash
nohup node scripts/perf/longrun.mjs --hours 4 --interval 300 --out /tmp/longrun > /tmp/longrun.log 2>&1 &
```

Launches the dev build itself (needs free ports 9222/9229; closes all tabs in
that instance), opens two terminals running `tui-load.mjs` — side by side by
default (`--layout split`, both rendering) or as two tabs (`--layout tabs`) —
and appends a sample every `--interval` seconds to `<out>/samples.jsonl`:

- per process type (main/renderer/GPU): CPU (`cpuCore` = % of one core from
  `/proc` on Linux; Electron's `cpu` is relative to all cores) and working set
- renderer and main JS heap before and after a forced GC
- renderer frame rate (rAF over 2 s), long tasks, S2-lite µs/keystroke
- per terminal: input → echo latency through `xterm.input()` → PTY → TUI echo
  (arrival / parsed / rendered), xterm write-queue latency, buffer lengths,
  renderer type, WebGL glyph atlas pages/pixels/glyphs, WebGL re-creations

The runner stops the app at the end (or on SIGTERM/SIGINT/errors). Electron's
own output goes to `<out>/electron.log`.

### longrun-summary.mjs — trend summary

```bash
node scripts/perf/longrun-summary.mjs /tmp/longrun/samples.jsonl [--window 60] [--json]
```

Compares the mean of each metric over the first and last `--window` minutes
(shrunk to a third of the run for short runs), with a least-squares slope per
hour and up/down step counts. Flags metrics that moved >10% end to end with
≥70% of steps in the same direction. Works on a run still in progress.

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
