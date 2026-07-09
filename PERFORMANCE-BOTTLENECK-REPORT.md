# Tabby 性能ボトルネック調査レポート — Rust移行候補の検討

- 調査日: 2026-07-09
- 対象: master 相当のソースツリー（fork: qtaro9914/tabby）
- 目的: UX向上のため、性能ネックとなりうるモジュール/機能を特定し、Rust移行（napi-rs / WASM）の費用対効果を評価する

---

## 1. エグゼクティブサマリ

1. **SSHプロトコル層はすでにRust化済み**（`russh`, napi-rsバインディング）。暗号・鍵交換・チャンネル多重化・SFTPプロトコル・ポートフォワードのプロトコル部分はRust側で動いており、この領域の再移行は不要。
2. ホットパス（大量出力時）で最大のCPU消費者は **xterm.js本体のANSIパース＋端末エミュレーション（JS実装）**。ここのRust/WASM化は効果最大だが、xterm.js置換に相当する大工事。
3. 調査で見つかったボトルネックの多くは **言語速度ではなく設計起因**（Angularの変更検出、メモ化なしの毎キー再計算、逐次awaitのSFTP転送、チャンクごとの多重バッファコピー）。これらは **TypeScriptのままの修正が最も費用対効果が高い**。
4. Rust移行が現実的に効くのは、(a) **出力前処理パイプラインの一本化**（OSC走査＋UTF-8分割＋進捗検出を1回のネイティブ呼び出しに統合）、(b) **SFTP転送ループのRust側への移動**、(c) 長期的には **端末エミュレーションコアのRust/WASM化** の3点。

推奨順序: **計測 → TSクイックフィックス（数日〜） → 出力パイプラインのnapi-rs化（数週間） → 端末コア置換の検討（長期）**

---

## 2. アーキテクチャとデータパスの現状

### 2.1 ローカルシェルのデータフロー（プロセス境界とコピー回数）

```
子プロセス (cat huge.log 等)
  ↓ OS pty
node-pty (C++ネイティブ, v1.2.0-beta.8)            … raw Buffer を emit
  ↓
[Main] app/lib/pty.ts PTYDataQueue                  … 100KB単位バッチ + flow control + UTF8境界調整
  ↓ Buffer.from() コピー (pty.ts:106)、Buffer.concat (pty.ts:52-56)
=== Electron IPC (structured clone = プロセス間フルコピー。複数ウィンドウ時はウィンドウ数分) ===
  ↓
[Renderer] tabby-local/src/session.ts:119-126       … Uint8Array→Buffer 再コピー
  ↓
tabby-terminal ミドルウェアチェーン (毎チャンク実行)
  ① ZModemMiddleware    — 全バイトを zmodem.js sentry.consume() に通す（未使用でも常時）
  ② OSCProcessor        — Buffer.indexOf 線形スキャン + Buffer.concat（OSCなしでも毎回新規Buffer生成）
  ③ LoginScriptProcessor— 有効時、毎チャンク toString() フルデコード
  ↓
tabby-terminal/src/session.ts:39                    … data.toString() で string 化（Buffer と string を毎回両方生成）
  ↓
baseTerminalTab.component.ts:508-517                … detectProgress 正規表現を全チャンクに実行（既定ON）
  ↓
xtermFrontend.ts FlowControl (29-63)                … 128KB閾値 + high/low watermark バックプレッシャ
  ↓
xterm.js Terminal.write()                           … ANSIパース・エミュレーション・描画（すべてJS）
```

SSH/Serial/Telnetは main を経由せず renderer 内で直接 I/O する（russh / serialport / net.Socket）。
ミドルウェア以降の経路は全接続種別で共通。

### 2.2 すでに最適化されている箇所（再発明不要）

| 箇所 | 内容 |
|---|---|
| `app/lib/pty.ts:1-83` | PTYDataQueue: 100KBバッチ + 500KB超で `pty.pause()` によるOSレベルバックプレッシャ（perfチューニングコミット `60046da4` あり） |
| `app/lib/utfSplitter.ts` | チャンク境界でのマルチバイト分断防止 |
| `xtermFrontend.ts:29-63` | xterm.write() のバックプレッシャ制御（FlowControl） |
| `xtermFrontend.ts:246-274` | リサイズの32msレート制限 + requestAnimationFrame |
| `xtermFrontend.ts:695-731` | WebGLコンテキストロスト回復（3回試行→DOMレンダラーへデグレード） |
| `baseTerminalTab.component.ts:445-451` | 非表示タブの30秒後アンロード |
| `oscProcessing.ts:16-22,55-58` | チャンク跨ぎOSCシーケンスのバッファリング（`4885888a`） |

---

## 3. ボトルネック一覧（影響度順）

### 【A】スループット系 — 大量出力時（`cat huge.log`、ビルドログ等）

| # | 内容 | 場所 | 影響 |
|---|---|---|---|
| A1 | **xterm.js のANSIパース＋端末エミュレーションがJS実装**。WebGL/Canvasで描画はGPUオフロードされるが、エスケープシーケンス解析・バッファ管理はすべてJSでCPU消費の主因 | xterm.js (`@xterm/xterm ^5.4.0`) | 最大 |
| A2 | **ZModemMiddleware が全出力に常時介在**。ZMODEM未使用のローカルシェルでも全バイトが `sentry.consume()` を通過 | `tabby-terminal/src/features/zmodem.ts:104-129`, `src/index.ts:56` | 大 |
| A3 | **チャンクごとの多重バッファコピー/変換**: Buffer.from ×2回、Buffer.concat ×2回、IPC structured clone、`toString()` フルデコード（string と Buffer を両方毎回生成） | 2.1 のフロー参照 | 中〜大（チャンク数×レイヤー数で線形増加） |
| A4 | **出力バッチ処理が無効化されている**。`bufferTime(10)` 実装がコメントアウトされたまま。小チャンク高頻度出力（プログレスバー等）で write()/Promiseチェーンのオーバーヘッド増 | `baseTerminalTab.component.ts:802` | 中 |
| A5 | **detectProgress 正規表現が全チャンクに実行**（既定ON） | `baseTerminalTab.component.ts:508-517`, `config.ts:50` | 小〜中 |
| A6 | **DebugDecorator が常時文字列連結**（8192文字リングバッファ、未使用でも稼働） | `tabby-terminal/src/features/debug.ts:16-24` | 小 |
| A7 | OSCProcessor の `Buffer.indexOf` 線形スキャン + OSCなしでも毎チャンク `Buffer.concat` | `middleware/oscProcessing.ts:27,47,91-93` | 小 |

### 【B】レイテンシ系 — 入力遅延・操作の引っかかり

| # | 内容 | 場所 | 影響 |
|---|---|---|---|
| B1 | **ホットキー設定を毎キー入力（keydown/keyup 両方、リピート含む）ごとに再帰的に再構築**。メモ化なし。全ホットキー×シーケンスをネストループでスキャン。タイピング速度に比例するCPU＋GCコスト＋`zone.run()` によるCD誘発 | `hotkeys.service.ts:129-242, 251-302, 371-398` | 大（体感入力遅延に直結） |
| B2 | **Angular変更検出が野放し**。`OnPush` 採用は全リポジトリで5コンポーネントのみ、`runOutsideAngular` は3箇所のみ。wheel/mousemove/スプリッタードラッグのたびに全コンポーネントツリーのCDが走る | `splitTabSpanner.component.ts:39-47`, `xtermFrontend.ts:358-365,395` ほか | 大（構造的） |
| B3 | **focusFollowsMouse 有効時、mousemove ごとに無スロットルで `layout()`**（全ペイン走査＋DOM style書き込み＋spanners再構築） | `splitTab.component.ts:838-843, 781-786` | 中（該当設定利用者のみ） |
| B4 | **セレクタ（プロファイル選択/コマンドパレット）の fuzzy search がデバウンスなし・毎キーで FuzzySearch インスタンス再生成**（インデックス再構築） | `selectorModal.component.ts:75-97` | 中（プロファイル数が多いユーザー） |

### 【C】定期処理・バックグラウンド

| # | 内容 | 場所 | 影響 |
|---|---|---|---|
| C1 | **タブ復元状態の保存が30秒ごと＋タブ変化ごと（1秒デバウンス）に全タブをフルシリアライズ**。serialize addon がタブごとに最大1000行×列数のセルを走査 → O(タブ数×20万セル) → `JSON.stringify` → 同期 `localStorage` 書き込み。多タブ・多分割環境で周期的なジャンク（カクつき）の有力候補 | `app.service.ts:88-98`, `tabRecovery.service.ts:22-31`, `xtermFrontend.ts:644-650` | 大（多タブ環境） |
| C2 | config.save() が `JSON.parse(JSON.stringify(store))` ディープクローン＋ `yaml.dump()` の同期処理。ただし発火は設定変更時のみ | `config.service.ts:230-249` | 小 |
| C3 | 起動時のプラグイン `require()` が同期直列（十数モジュールのバンドル評価が集中） | `app/src/plugins.ts:229-263` | 小〜中（起動時間） |

### 【D】接続種別ごとの固有問題

| # | 内容 | 場所 | 影響 |
|---|---|---|---|
| D1 | **SFTP転送が256KBチャンクの逐次await（パイプライン化なし）**。Rust側I/Oの完了を待ってから次を読むため、napi境界＋ネットワークRTTがそのままスループット上限に | `tabby-ssh/src/session/sftp.ts:29, 113-153` | 大（大容量ファイル転送） |
| D2 | SSHローカル/ダイナミックフォワードの受け口が純JS（`net.Server` / `@luminati-io/socksv5`）で、ソケット↔チャンネルブリッジもJS | `ssh.ts:786-815, 881-930`, `forwards.ts` | 中（高トラフィックのフォワード時） |
| D3 | Telnetがプロトコル処理含め全面JS。`UnescapeFFMiddleware` は0xFF出現ごとに slice する実質O(n×m)実装 | `tabby-telnet/src/session.ts:46-59, 150-242` | 小（Telnet利用者が限定的） |

---

## 4. Rust移行候補の評価

### 4.1 すでにRust化されている領域（移行不要）

- **SSH全体**: `russh` 0.1.37（napi-rs、prebuiltバイナリ）— 暗号/鍵交換/MAC/圧縮、認証、チャンネル多重化、SFTPプロトコル操作、TCP/X11/Agentフォワード、SOCKS/HTTPアウトバウンドプロキシ。JS側は薄いRxJSラッパーのみ。
- なお、Rust製ネイティブモジュールは russh が唯一で、他はすべてC/C++（node-pty, keytar, serialport, fontmanager-redux 等）。napi-rs のビルド・配布基盤（マルチプラットフォーム prebuilt）は russh で実績があり、**新規Rustモジュール追加の技術的障壁は低い**。

### 4.2 Rust移行の費用対効果が高い候補

| 優先 | 候補 | 対応するボトルネック | 内容と論点 |
|---|---|---|---|
| ◎ | **出力前処理パイプラインの一本化**（napi-rs 新規モジュール） | A2, A3, A5, A6, A7 | OSC走査・UTF-8境界調整・ZMODEM検出・進捗検出を **Rust側の単一パス** に統合。現在チャンクごとに5〜6レイヤーのJS処理＋複数回のコピーが走っているものを、ネイティブ境界1回の呼び出しに集約。全接続種別（local/SSH/serial/telnet）共通の経路なので効果範囲が広い |
| ◎ | **SFTP転送ループを russh 側へ移動** | D1 | 現状はJSが256KBごとに read→write を逐次awaitしており、napi境界越えとRTTが積算される。転送ループ（read-ahead/パイプライン込み）をRust側に実装すれば、JSは進捗コールバックを受けるだけになる。russh に手を入れる必要あり（upstream: Eugeny/russh バインディング） |
| ○ | **端末エミュレーションコアのRust/WASM化**（xterm.js置換） | A1 | 効果は最大だが、xterm.jsのアドオンエコシステム（webgl/search/serialize/ligatures/image）ごと置換になるフォーク級プロジェクト。参考実装として alacritty_terminal クレートや WASM端末エミュレータがあるが、**長期テーマとして分離して検討すべき** |
| △ | フォワードのソケットブリッジ/SOCKS5サーバのRust化 | D2 | russh 側に「ローカルリスナーごとRustで持つ」APIを足せば実現可能。高トラフィックのフォワードを常用するユーザー以外には効果が薄い |
| △ | Telnetプロトコル処理のRust化 | D3 | 技術的には容易だが利用者母数が小さく優先度低。`UnescapeFFMiddleware` のTS修正で十分 |

### 4.3 Rust移行では解決しない（TS/設計修正が正解）

以下は言語速度の問題ではないため、Rustに置き換えても改善しない。**先にこちらを潰すべき**:

- **B1 ホットキー**: 設定変更時にのみ再構築するメモ化を入れるだけで毎キーコストがほぼ消える
- **B2/B3 Angular CD**: `runOutseideAngular` の適用（wheel/mousemove/ドラッグ）、`OnPush` 化、focusFollowsMouse のスロットリング
- **B4 セレクタ**: `debounceTime` 追加＋FuzzySearchインスタンスの再利用
- **C1 タブ復元**: 「変化したタブのみ再シリアライズ」「アイドル時（requestIdleCallback）に実行」「scrollback保存行数の削減オプション」で解決可能
- **A4 バッチ処理**: コメントアウトされた `bufferTime` 相当の再導入（10ms程度のcoalescing）
- **D1 の暫定対応**: Rust側改修の前でも、JSのままread-aheadで2〜4並列化すればRTT起因の律速はかなり緩和できる
- **C3 起動時間**: プラグインrequireの遅延化/分割 — 言語の問題ではない

---

## 5. 推奨ロードマップ

1. **Phase 0 — 計測基盤（必須）** ✅ **実施済み（2026-07-09）→ 結果は `PERF-PHASE0-MEASUREMENTS.md`**
   主要な確定事項: ZModemミドルウェア（A2）が大量出力時のレンダラCPUの約33%を消費しており、除去だけでスループット+65%（6.3→10.4 MB/s）。除去後はレンダラのCPU飽和が解消（idle 36%）し、律速はmainプロセス側へ移る。よってPhase 2/3のRust化判断はPhase 1適用後の再計測を待つのが合理的。
2. **Phase 1 — TSクイックフィックス（数日〜2週間、リスク小）**
   B1（ホットキーメモ化）、B4（セレクタdebounce）、A2/A6（ZModem/Debugの条件付き有効化）、A4（出力coalescing再導入）、C1（タブ復元の差分化・アイドル実行）、B2/B3（runOutsideAngular・スロットル）、D1（JSでのSFTP read-ahead）。
3. **Phase 2 — Rust化第1弾（数週間）**
   出力前処理パイプラインの napi-rs モジュール化（4.2の◎1）。russh の SFTP 転送ループRust化（◎2、upstream連携）。
4. **Phase 3 — 長期検討**
   端末エミュレーションコアのRust/WASM化はPhase 0の計測で「xterm.js本体が支配的」と確認できた場合にのみ着手判断。

---

## 6. 参考: ネイティブ依存一覧

| モジュール | 言語 | 用途 | 備考 |
|---|---|---|---|
| russh 0.1.37 | **Rust** (napi-rs) | SSH全体 | 唯一のRust製。prebuilt配布でrebuild不要 |
| node-pty 1.2.0-beta.8 | C++ | ローカルPTY | mainプロセスで使用 |
| @serialport/bindings-cpp | C++ | シリアルI/O | |
| keytar | C++ | OSキーチェーン | |
| fontmanager-redux | C++ | フォント列挙 | |
| glasstron / windows-blurbehind | C++ | ウィンドウ効果 | Windows |
| native-process-working-directory | C++ | CWD取得 | |
| @tabby-gang/windows-process-tree / macos-native-processlist / windows-native-registry | C++/ObjC | プロセス/レジストリ | OS別optional |

ビルド面: `scripts/build-native.mjs:16` のrebuild対象は5ディレクトリだが、実体のネイティブ依存は `app/node_modules` 配下のみ。napi-rs モジュールを追加する場合は russh と同様 prebuilt 配布にすれば electron-rebuild 対象を増やさずに済む。
