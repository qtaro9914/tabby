# Phase 0 計測結果 — 性能ボトルネック仮説の定量検証

- 計測日: 2026-07-09
- 対象: ブランチ `perf/bottleneck-analysis`（master `6955c4f8` ベース）
- 親ドキュメント: `PERFORMANCE-BOTTLENECK-REPORT.md`（仮説A1〜D3の番号はそちらを参照）

## 計測環境と方法

- 環境: WSL2 (Linux 6.6) + WSLg、Electron 38、Node 24
- ビルド: `TABBY_DEV=1 yarn run build`（webpack developmentモード、非minify）
- 方法: `--remote-debugging-port` でTabbyを起動し、Chrome DevTools Protocol 経由で
  - Angular injector（`window.ng.getInjector`）からサービスを取得してローカルシェルタブを開き
  - `Profiler.start/stop`（サンプリング間隔200µs）でレンダラプロセスのCPUプロファイルを取得
  - `session.binaryOutput$` の購読でスループットを実測
- 計測スクリプトと `.cpuprofile` 生データはセッションのscratchpad（`scratchpad/perf/`）に保存

### 注意（バイアス）

- devビルド＋Angular devモードのため**絶対値は本番ビルドより遅め**。カテゴリ間の比率が主目的
- WSLg環境のためGPUレンダラー（WebGL）はSwiftShaderフォールバックの可能性あり
- mainプロセス（node-pty・IPC送信側）のCPUは未計測。レンダラ側のみ

---

## S1: 大量出力スループット（`cat` 50MB / 26万行）

### ベースライン（現状の master 相当）

| 指標 | 値 |
|---|---|
| スループット | **6.3 MB/s**（50MBの表示に7.9秒） |
| レンダラCPU busy率 | **81.7%**（ほぼ飽和 = CPUバウンド） |

CPUプロファイル上位（全サンプル比）:

| self time | 関数 | 帰属 |
|---|---|---|
| **32.7%** | `consume` | **zmodem.js Sentry**（ZModemMiddleware、仮説A2） |
| 5.7% | `print` | xterm.js パーサ（バッファ書き込み） |
| 5.0% | `send` | IPC送信（バインディング） |
| 2.6% + 2.4% + 2.3% | `copyFrom` / `fromArrayLike` / `FastBuffer` | バッファコピー（仮説A3） |
| 2.2% | baseTerminalTab.component.ts 無名関数 | detectProgress正規表現ほか（仮説A5） |
| 1.6% + 1.5% | `decode` / `_parse` | xterm.js パーサ |
| 0.6% | debug.ts `handler` | DebugDecorator 文字列連結（仮説A6） |

### A/B比較: ZModemミドルウェア除去 + detectProgress OFF

同一アプリインスタンス・同一タブで、`session.middleware` から ZModemMiddleware を
実行時に remove し、`terminal.detectProgress = false` にして同じ `cat` を再実行:

| 指標 | ベースライン | 除去後 | 変化 |
|---|---|---|---|
| スループット | 6.3 MB/s | **10.4 MB/s** | **+65%** |
| 表示完了までの時間 | 7.9 s | 4.85 s | −39% |
| レンダラCPU busy率 | 81.7% | **63.9%**（idle 36%） | CPU飽和が解消 |

除去後のプロファイル上位は xterm.js（`print` 9.4%、`parse` 3.1%、`copyFrom` 4.4%、
`scroll`/`_syncTextArea` 等）と IPC の `send` 7.3% が中心。

### S1 の結論

1. **仮説A2が主犯と確定**: ZMODEM未使用時でも全バイトが zmodem.js の Sentry を通過し、大量出力時のレンダラCPUの約1/3を消費。これを外すだけでスループット+65%
2. **除去後はレンダラがCPUバウンドでなくなる**（idle 36%）— 律速は main プロセス側（node-pty読み取り＋IPC）へ移る。つまり **ミドルウェアのRust化よりも「不要な処理を通さない」TS修正が先で、それだけで大きく改善する**
3. 除去後に残るレンダラ負荷は xterm.js 本体（合計 ~20%程度）とバッファコピー。xterm.js 置換（Rust/WASM化）の効果上限はこの範囲で、S1シナリオでは「最大でもさらに2割前後」の改善余地。**仮説A1（xterm.jsが最大の消費者）は「ZModem除去後に限り正しい」に修正**

---

## S2: キー入力オーバーヘッド（合成keydown/keyup 3000組）

| 指標 | 値 |
|---|---|
| 1打鍵（down+up）あたり | **245 µs**（同期処理） |

プロファイル帰属: hotkeys.service（`pushKeyEvent` 4.0% + `matchActiveHotkey` 3.6% +
`getHotkeysConfigRecursive` 4.9%）≒ **12%強**、`ConfigProxy.__getValue` 4.2%、
残りの大半は Angular 変更検出（`refreshView` 8.2%、`setNgReflectProperty` 5.1%、
各種テンプレート実行）。

### S2 の結論

- 仮説B1（毎キーのホットキー設定再構築）とB2（CD野放し）を定量確認。1打鍵245µsは
  単発では小さいが、**キーリピートや高速タイピング中に常時CD＋設定再帰走査が走る**
  構造で、ジッタ（入力レイテンシのばらつき）の源になる
- 対処はメモ化＋OnPush/zone外化（TS修正）。Rust化の対象ではない

---

## S3: タブ復元シリアライズ（30秒ごとの定期処理）

| 構成 | `saveTabs()` 1回 | 内訳 |
|---|---|---|
| 1タブ（スクロールバック充填済み） | 5.5〜11 ms | `frontend.saveState()` 単体 4.3ms、ペイロード 69KB |
| 5タブ | 8.9〜20.3 ms | GCが profile の18.4%に上昇 |

プロファイルは serialize addon（`serialize` + `_diffStyle` + `_nextCell` 等で約60%）が支配的。

### S3 の結論

- 仮説C1は**方向は正しいが規模は穏当**: 既定の80桁端末では5タブで約10〜20ms/30秒。
  体感ジャンクになるのは多タブ（20+）×広い端末×分割の複合時と推定
- 対処は「変化タブのみ差分保存」「requestIdleCallback化」で十分。Rust化不要

---

## Phase 0 総合結論 → Phase 1 への入力

| 仮説 | 検証結果 | 対処の優先度 |
|---|---|---|
| A2 ZModem常時介在 | **確定・最重要**（CPU 33%、除去で+65% throughput） | Phase 1 最優先 |
| A5 detectProgress | A2と合算で確認（単独寄与は小） | Phase 1（条件付き実行に） |
| A1 xterm.jsが最大 | ZModem除去後は正 — ただし残余は~20%でCPU飽和もしていない | Phase 3判断は保留寄り |
| A3 バッファコピー | 合計 ~7%で存在は確認、単独では中規模 | Phase 1〜2 |
| B1/B2 ホットキー＋CD | 確認（245µs/打鍵、CD費が過半） | Phase 1 |
| C1 タブ復元 | 存在するが規模は穏当 | Phase 1（低優先） |
| D1 SFTP逐次転送 | 未計測（SSH接続先が必要） | Phase 1で実装前に別途計測 |

**Rust移行判断への示唆**: S1の結果は「出力パイプラインのRust化」の前に
**TS修正（ZModemバイパス等）で+65%が取れ、その時点でレンダラはCPU飽和しなくなる**
ことを示している。Rust化の費用対効果は Phase 1 適用後に再計測して判断するのが合理的。
律速が main プロセス（PTY/IPC）に移った場合、次の計測対象は mainプロセス側になる。
