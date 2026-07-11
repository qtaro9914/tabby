# Phase 2 準備 — mainプロセス計測・B2/D1実装結果

- 実施日: 2026-07-10
- ブランチ: `perf/bottleneck-analysis`
- 親ドキュメント: `PERFORMANCE-BOTTLENECK-REPORT.md` / `PERF-PHASE0-MEASUREMENTS.md` / `PERF-PHASE1-RESULTS.md`
- 計測スクリプトを `scripts/perf/` に収載（使い方は同ディレクトリのREADME）

## 1. mainプロセスのCPU計測（S1大量出力中）

`--inspect` のNode inspector経由でmainプロセスをプロファイル（`scripts/perf/main-profiler.mjs`）。
レンダラがS1（cat 50MB、10.4 MB/s）を実行している間の計測:

| 指標 | 値 |
|---|---|
| mainプロセス busy率 | **35.3%**（idle 64.7%） |
| 上位関数 | `_send`(IPC内部) 13.3%、Buffer生成/コピー ~5%、electron ipc ~3% |
| node-pty / PTYDataQueue | 合計 1%未満 |

### 結論: 現在のスループット律速はCPUではない

Phase 1適用後、**レンダラ（busy 65%）もmain（busy 35%)もCPU飽和していない**のに
スループットは ~10 MB/s で頭打ち。律速は `app/lib/pty.ts` のフロー制御
（unacked 500KBで `pty.pause()`、レンダラのack往復で再開）の**ウィンドウ待ち**と
考えられる。

**Rust移行判断への含意（重要）**:
- mainプロセスのCPU内訳はIPC送信とバッファコピーが主で、node-pty自体はほぼゼロ。
  出力経路をRust化してもこの構造は変わらない（IPC境界のコストは残る）
- スループットをさらに上げたい場合の正攻法は「フロー制御ウィンドウの拡大 or
  適応化」「IPCあたりのバッチサイズ拡大」といった**プロトコル調整**であり、
  言語移行ではない
- ただし10 MB/s＋UI応答性維持は端末用途として十分実用域。これ以上の
  スループット投資は体感効果が薄い

## 2. B2: 高頻度リスナーのNgZone外化（実装済み）

zone-patchedリスナーは**ハンドラが何もしなくても**イベントごとにAngularの
変更検出を誘発するため、ガード追加だけでは不十分だった。以下をzone外に移動:

| リスナー | ファイル | zone再入 |
|---|---|---|
| ターミナルの `wheel`（スクロールピン制御） | `xtermFrontend.ts` | 不要（frontend内部状態のみ） |
| ターミナルの `mousewheel`（alt+wheel→矢印キー変換） | `xtermFrontend.ts` | 不要（sendInputのみ） |
| スプリッタードラッグ中の `mousemove` | `splitTabSpanner.component.ts` | mouseup側はzone内のまま（layout反映） |
| focusFollowsMouse の `mousemove` | `splitTab.component.ts` | フォーカス変更時のみ `zone.run()` |
| **hotkeysサービスのdocumentレベル `keydown`/`keyup`/`wheel`/`mouseup`/`auxclick`** | `hotkeys.service.ts` | **ホットキーがマッチした時のみ `zone.run()`** |

`mousedown`/`mouseup`（コンテキストメニュー・ペースト）はUI更新を伴うためzone内に残した。

hotkeysサービスは従来、リスナーがzone内登録なうえ `pushKeyEvent` 内で毎イベント
無条件に `zone.run()` していた（＝全キー入力・全ホイールでCD強制）。マッチ時のみ
zone再入に変更。なお `key$`/`keyEvent$`/`keystroke$` はリポジトリ内に購読者が
存在しないことを確認済み（zone外emitになるため、サードパーティプラグインが
これらを購読してUIを更新している場合のみ影響があり得る）。

### 実測効果（S2: 合成キー入力3000組）

| | Phase 0 | Phase 1 | **B2適用後** |
|---|---|---|---|
| 1打鍵あたり | 245 µs | 182〜233 µs | **10.9 µs（Phase 0比 約1/22）** |

Angular変更検出（`refreshView` 等）がプロファイルから完全に消滅。残余はイベント
ディスパッチとホットキー照合のみ。タイピング・スクロール・ドラッグ中のCD誘発が
ゼロになり、入力レイテンシのジッタ源を除去。

### 機能回帰テスト（PASS）

- Ctrl-Shift-E → `hotkey$` 発火＋プロファイルセレクタのモーダルがDOMに描画される
  （zone再入とCDが正しく機能）
- wheel-up → `pinnedToBottom` が false に遷移（zone外リスナーが機能）
- ZMODEM検出（1チャンク内・境界分断の両ケース）

## 3. D1: SFTP転送の改善（実装済み）と russh の制約発見

ローカルsshd（ユーザー権限、port 2222、internal-sftp）＋russhバインディング直叩きの
ベンチで転送戦略を比較（`sha256`で整合性検証）:

| 戦略 | スループット(localhost) | 整合性 |
|---|---|---|
| 現行: 256KB逐次 read→write直列 | 69.5 MB/s | OK |
| 1MBチャンク逐次 | 75.8 MB/s | OK |
| **並行read×4**（in-flight 4本） | 94.7 MB/s | OK（5/5回）だが— |
| **並行read×8** | 83.8 MB/s | **❌ ハッシュ不一致（データ破損）** |
| **採用: 単一in-flight read＋ローカル書込オーバーラップ、1MB** | **90.0 MB/s（+29%）** | OK |

### 発見: russhの並行read順序保証なし

`SftpFile.read(n)` はカーソル型（位置指定なし）で、並行発行時の結果順序が
保証されない（×8で実証）。×4が通ったのは偶然であり、**JS側からの真の
パイプライン化は安全に実装できない**。

`sftp.ts` に実装したのは安全な範囲の最適化:
- download/upload とも「次のread/writeを発行してから前チャンクの書込/読出をawait」
  する単一in-flightオーバーラップ（SFTP要求は厳密に逐次のまま）
- 読み出しチャンクを 256KB → 1MB に拡大

localhost実測で+29%。RTTの大きいリンクでは1MBチャンクの往復削減効果がさらに乗る。

### Phase 2への確定インプット

**「SFTP転送ループのRust側実装」の必要性が証拠付きで確定**。russh側に
(a) 位置指定read（positional read）API、または (b) Rust内部での順序保証付き
read-ahead付き転送ループ、のどちらかが入らない限り、多重in-flightによる
RTT隠蔽（WANで数倍の効果が見込める）は実現できない。upstream
（Eugeny/russh バインディング）への提案・実装が Phase 2 の最有力候補。

## 4. Phase 2候補B: フロー制御ウィンドウの実験結果（仮説棄却）

`app/lib/pty.ts` に環境変数ノブ（`TABBY_FLOW_MAX_DELTA` / `TABBY_FLOW_MAX_CHUNK`）を
追加し、S1相当のスループットとCtrl+C応答性（^C送信→出力静止までの時間と流入量）を
7構成で計測（2026-07-10、WSL2 devビルド）:

| maxDelta | maxChunk | MB/s | ^C静止 | ^C後流入 |
|---|---|---|---|---|
| 512KB（現行） | 100KB（現行） | 9.9 | 36ms | 351KB |
| 1MB | 100KB | 10.7 | 25ms | 227KB |
| 2MB | 100KB | 9.9 | 40ms | 324KB |
| 4MB | 100KB | 10.8 | 30ms | 264KB |
| 8MB | 100KB | 10.1 | 26ms | 191KB |
| 2MB | 256KB | 10.4 | 36ms | 248KB |
| 4MB | 256KB | 8.6 | 40ms | 372KB |

**結論: ウィンドウを16倍にしてもスループットは~10MB/sでフラット（差は測定ノイズ）。
「フロー制御ウィンドウが律速」仮説は棄却**。真の律速はレンダラの毎バイト処理
（xterm.jsのANSIパース）で、フロー制御はその消費速度に正しく追従している。
現行既定値（512KB/100KB）は適正であり**変更しない**。

- 環境変数ノブは残置 — Windows実機（ConPTY）では特性が異なる可能性があり、
  リビルドなしで `TABBY_FLOW_MAX_DELTA=4194304` 等を試せる
- ハーネス上の知見: B2適用後はCDP経由のタブ操作を `NgZone.run()` で包む必要がある
  （zone外からの状態変更はCDが走らずタブが描画されない。実UI操作はzone内なので
  実アプリには影響なし）— `scripts/perf/profiler.mjs` に反映済み

## 5. 更新後のロードマップ

| 項目 | 状態 |
|---|---|
| Phase 1 TSクイックフィックス | ✅ 完了（+62% throughput 等） |
| B2 zone外化（wheel/drag/focusFollowsMouse/hotkeys） | ✅ 完了（S2 245→10.9µs） |
| D1 安全域のSFTP改善（オーバーラップ+1MB） | ✅ 完了（localhost +29%） |
| mainプロセス計測 | ✅ 完了 — CPU律速ではないと判明 |
| Phase 2候補B: フロー制御ウィンドウ調整 | ✅ **実験の結果、変更不要と判断**（本節） |
| **Phase 2候補A**: russhへのSFTP read-ahead実装（Rust） | ✅ **実装完了（2026-07-11、下記6節）** |
| Phase 2候補C: 出力ミドルウェアのRust化 | 優先度降格（両プロセスともCPU非飽和のため） |
| Phase 3: 端末コアRust/WASM化 | ローカル出力スループットの唯一の上限要因と確定したが、10MB/s＋UI応答性維持で実用十分のため保留 |

## 6. Phase 2候補A: russh-napiへの`readAt`実装（2026-07-11実施）

フォークした `qtaro9914/russh-napi`（ブランチ `feat/sftp-read-at`、ローカル
`~/work/russh-napi`）に位置指定readを実装した。

### 実装内容

- **`SftpFile.readAt(offset, n)`**: 絶対オフセットでの単発プロトコルREAD。
  SFTPのリクエストID多重化により**複数readAtの同時in-flightが安全**
  （カーソル型`read()`はMutexのwakeup順序が不定で×8並行時にデータ破損を実証済み）。
  EOFは空配列で返す。サーバの`limits@openssh.com` read上限を超える要求はクランプ
- **`SftpFile.readLimit()`**: サーバ広告のread上限（OpenSSH=261120B）を公開。
  呼び出し側が最適チャンクサイズを選べる
- russh-sftp 2.0.6 に追加アクセサ3点（`raw_handle`/`raw_session`/`configured_limits`）
  が必要 → crates.ioソースそのままにパッチを当てた**vendoredコピー**を
  `vendored/russh-sftp` としてrusshi-napiリポジトリに同梱（`[patch.crates-io]`適用、
  upstream取り込み後に撤去予定）
- オフセットはf64（2^53=9PBまで正確）。napiのBigIntフィーチャー追加を回避

### 検証（ローカルsshd、50MB、sha256全数照合）

| 方式 | スループット | 整合性 |
|---|---|---|
| 現行実装（カーソル逐次＋書込オーバーラップ、1MB） | 96 MB/s | OK |
| readAt ×4（261120Bチャンク） | 176 MB/s | OK |
| **readAt ×8 ← 採用** | **237 MB/s（現行比 約2.5倍）** | OK（反復4回すべて） |
| readAt ×16 | 250 MB/s | OK |

カーソルread×8で破損した並行度が、readAtでは全数一致。深度8が性能の膝。
RTTの大きい実リンクでは相対効果はさらに拡大する（in-flight窓 ≈ 8×255KB ≈ 2MB）。

### Tabby側の対応（`tabby-ssh/src/session/sftp.ts`）

- `download()` は `readAt` 対応バインディング検出時に**深度8の先読みパイプライン**
  （チャンク=readLimit、short read再要求つき）で転送。**非対応（stock npm russh）
  ならば従来の安全な逐次＋オーバーラップにフォールバック**するため、
  `app/package.json` を差し替えるまでは従来動作のまま壊れない
- upload側のパイプライン化（`writeAt`）は同じパターンで実装可能な将来課題

### 配布パイプライン（2026-07-11 完了）

1. ✅ fork push・CI実行（run 29140477604、7ターゲット全成功。注意: ワークフローの
   `paths-ignore` により空コミットではCIが走らない。`workflow_dispatch` を追加済み）
2. ✅ GitHub Release **v0.1.38-readat.0** にnpm tarball添付
   （win32-x64/arm64・darwin-x64/arm64・linux-x64/arm64/armv7 のprebuilt同梱）
3. ✅ `app/package.json` の `russh` をRelease URLに変更・`yarn`で導入確認。
   **Release artifact現物での再計測: 98 → 224 MB/s（×8、sha256一致）**
4. 残: upstream還元 — russh-sftpへアクセサPR ＋ russh-napiへreadAt PR（データ破損の
   再現手順付き）。取り込まれたらvendoredコピーと参照を公式版に戻す
