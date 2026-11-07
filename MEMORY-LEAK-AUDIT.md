# Tabby メモリリーク調査と対応台帳

更新日: 2026-11-07。対象: `perf/bottleneck-analysis`、`1496c223`。前回のCodex調査は `58832586` と当時の作業ツリー、今回の照合は `1496c223` を基準とする。

順次修正するための対応項目を **15件** に統合した。前回のCodex報告11件（解放漏れ9件、無制限キュー1件、一時ファイルの静的所見1件）に、Claude報告から新規候補4件を追加した。Claude H2のドロップグループ漏れは、導入済みAngular CDKの破棄処理を確認して除外した。2026-11-07に実装修正を開始した。13項目は実装と隔離回帰確認済み。ML-03は公開Release版russh-napiを依存に設定し、Tabby統合確認まで実施、ML-14はSSH・ローカルPTYの受信制御を実装して実機確認済み（他の出力源は残る）。ネイティブリリース公開とTabbyの依存更新は完了。Tabby側も作業ブランチにコミット済み（pushは未実施）。長時間計測、Windows/macOSでの実行確認は未実施。

各項目の固定IDをPR・コミット・回帰テストに引き継ぎ、完了条件を満たした項目だけを完了にする。

## 調査範囲と証拠の読み方

`app/lib`、`app/src` と各 `tabby-*/src` のTS／JS 291ファイルを対象に、購読、DOM／IPCリスナー、タイマー、接続、プロセス、出力バッファ、コンポーネントの破棄経路を横断調査した。全実行経路の網羅や、実アプリでの保持メモリ量を保証する調査ではない。

| 表記 | 意味 |
| --- | --- |
| 隔離再現 | 実ソースをTypeScriptで変換して実行し、外部接続・Electron・DOM等を模擬して、購読数やリソース状態を確認した |
| 静的確認 | 生成から解放までのコード経路を確認した。実機での発生頻度・保持量は未測定 |
| 到達条件要確認 | 模擬した非同期境界では再現したが、現在の実環境で同じ操作順序になる条件が未確定 |
| 追加調査候補 | 継続的に保持される根拠や影響が不足している |
| 除外 | 指摘された経路に解放処理があり、今回の修正対象として採用しない |

優先度「高」は日常入力での蓄積、閉じたタブや外部接続の残存、無制限の出力蓄積を対象とする。「中」は特定機能や操作の繰り返しで増えるものを対象とする。確度とは別の判断である。

過去の4時間ランでメモリ増加が目立たなかったことと、今回の指摘は矛盾しない。ただし「ローカルタブ1枚を開いたまま」という元報告の説明は正確ではない。[既存の性能記録](PERF-REVIEW-2026-10.md)の「P4 結果（2026-10-11）」には、45×33の分割ペイン2個、TUI 30fpsという条件が記載されている。この結果だけで、開閉・入力・再接続を反復した場合の安全性は判断できない。

## 対応一覧

「自動確認済」は実装修正と隔離回帰確認が済んだ状態を表す。GUI・実接続での完了条件は未確認のため、全項目の完全解消を意味しない。

| 実装状態 | ID | 優先度 | 内容 | 証拠 | 出典・重複 |
| --- | --- | --- | --- | --- | --- |
| 自動確認済 | ML-01 | 高 | キーストローク履歴が無制限に増える | 隔離再現 | Claude H1から新規 |
| 自動確認済 | ML-02 | 高 | PTY取得待ちのローカルセッションが破棄後に起動する | 隔離再現・到達条件要確認 | Claude H3から新規 |
| Release導入確認済 | ML-03 | 高 | SSH接続・認証をタブ終了で中止できない | 接続・認証・ホスト鍵待ちの終了をElectronで確認 | Claude H4から新規 |
| 自動確認済 | ML-04 | 高 | 手動再接続と自動再接続が二重に走る | 隔離再現・条件訂正 | Claude M3から新規 |
| 自動確認済 | ML-05 | 高 | 設定タブが基底クラスの解放処理を呼ばない | 隔離再現 | Codex前回報告 |
| 自動確認済 | ML-06 | 高 | ウィンドウ終了後もIPC・更新リスナーが残る | 隔離再現 | Codex／Claude M1 |
| 自動確認済 | ML-07 | 高 | 共有SSH接続でシェルと購読の終了が不足する | 隔離再現 | Codex／Claude Lowの共有SSH購読 |
| 自動確認済 | ML-08 | 高 | SSHシェル開始失敗時に参照数が戻らない | 隔離再現 | Codex前回報告 |
| 自動確認済 | ML-09 | 高 | 端末の破棄後にデコレーターが登録される | 隔離再現 | Codex／Claude M4 |
| 自動確認済 | ML-10 | 中 | プロファイル一覧の購読が破棄時に解除されない | 隔離再現 | Codex前回報告 |
| 自動確認済 | ML-11 | 中 | ペイン移動後も旧親への登録が残る | 隔離再現 | Codex／Claude M2 |
| 自動確認済 | ML-12 | 中 | 完了通知を無効にしても監視タイマーが止まらない | 隔離再現 | Codex前回報告 |
| 自動確認済 | ML-13 | 中 | ZMODEM受信完了後もキャンセル待ちが残る | 隔離再現 | Codex前回報告 |
| 部分対応 | ML-14 | 高 | 描画待ちの端末出力にキュー上限がない | SSH・PTYをElectronで確認。他の流入経路は未対応 | Codex前回報告 |
| 自動確認済 | ML-15 | 中 | SFTPローカル編集の一時ファイルと監視の終了方針が不足する | 隔離回帰済 | Codex静的所見／Claude M5 |

## 実装修正の進捗 2026-11-07

| 対象 | 実装と修正後の自動確認 |
| --- | --- |
| ML-01 | 履歴を設定内の最長シーケンス長以内に制限。1,200入力後も履歴1件、照合配列2件。単一打鍵・複数打鍵・ホイール・キー記録も確認 |
| ML-02 | 破棄状態を共通化し、遅れて取得したPTYを終了・解除。破棄後のopen復活なし、リスナー0、kill／解除各1回。共通終了処理の変更に合わせ、telnet／serialの遅延した接続完了でも復活しないことを確認 |
| ML-03 | 既存の参照管理・KI reject・モーダルdismissに加え、SshCancellationをtransportとconnectへ渡し、destroyで中断。未使用transportもclose。Electronで接続待ち終了10回、認証・ホスト鍵待ち終了時のソケット／モーダル解放を確認 |
| ML-04 | 初回接続も再接続も同時実行を抑制し、旧セッションを切り離して終了を待つ。初期化1回、置換されたopenセッション0。処理中の自然切断による再試行は終了後へ繰り越す |
| ML-05／ML-10 | 基底クラスの終了処理と購読解除を実施。50回後の残存0。プロファイル読み込み中の破棄でも後付け購読0 |
| ML-06 | IPC・更新リスナーを登録したWindowが解除。20回後の残存0。ready前の終了時もready待ちを解放する実装 |
| ML-07／ML-08 | シェルの購読解除、チャネルclose、失敗時のref返却を追加。50回後の購読0、close 50回。2回失敗してもrefは基準1。PTY要求失敗時の部分チャネルcloseも確認 |
| ML-09 | 破棄後のattachと購読追加を阻止し、sessionChangedを終了。管理タブ・グローバル購読は0 |
| ML-11 | 親子の接続単位でリスナー・購読を所有し、remove／replaceで解除。50回移動後の残存0。旧親のフォーカス／最大化参照も解除 |
| ML-12 | 無効化時にタイマーを止め、進行中のプロセス確認からの遅延通知も阻止。50回後のタイマー0、キャンセル後の通知0 |
| ML-13 | race用キャンセル購読もfinallyで解除。50転送後の残存0 |
| ML-15 | ユーザー指定でSSH接続終了まで編集を維持。同じファイルの同時・再オープンは編集セッションを共有し、切断・開始失敗・キャンセルで解放。rename保存では新しいファイルを監視し直す。同期中の一時エラーはローカルコピーを保持し、次の保存で再試行する |

ML-03はキャンセルトークン受け渡しと破棄時のcancel呼び出しを実装し、公開済み [qtaro9914/russh-napi v0.1.38-rw.2](https://github.com/qtaro9914/russh-napi/releases/tag/v0.1.38-rw.2) へ依存を更新した。`app/package.json` と `app/yarn.lock` は新ReleaseのURLを参照し、インストール済みの7バイナリ・JS・型定義がCI成果物に一致することを確認。ローカル上書きは解消済み。forkの修正コミットは `ea2a289`、版更新は `8c44384`、mainへのマージは `aa0db6d`。mainと作業ブランチのpush、およびマージコミットを指すタグの公開が完了した。Tabby側の変更は `perf/bottleneck-analysis` にコミット済み（pushは未実施）。KIは隔離回帰確認であり、実SSHサーバーとのKI対話・jump hostの組み合わせ確認は今後の対象。

ML-14は、xtermのwriteコールバック（パーサー処理完了）を待ち、その入力から同期的に生じた全出力の書き込み完了後にSSH／PTYのACKを返すよう変更した。SSHではstdout・stderr双方を開始要求前に接続し、チャネル予算を256KiBに設定。PTYでは既存のIPC予算へACKを連動する。破棄時は書き込み待ちを解消し、PTY終了通知は最終データより後に送り、最終書き込みも待つ。GPUが画面へ描画し終わる時点を保証するものではない。

SSHの制御は共有接続全体を一時停止する方式。チャネルごとの独立した流量制御は未実装であり、他チャネルやkeepaliveにも影響する。管理対象のコールバックには8MiB／1,024件の全体上限があり、単一パケットによるチャネル予算超過は許容する。serial／telnet、任意の直接write、非同期ミドルウェア内部のI/O待ちは今回の上流制御の対象外。初期非表示出力に対する既存8MiBのバッファ方針も維持する。従ってML-14全体は部分対応とする。


統合時のレビューで、遠隔終了済みチャネルを後からcloseすると受信管理情報が再登録される経路も修正した。ローカルcloseは既存の管理対象だけを停止状態にし、既に回収したチャネルを再登録しない。統計のmanagedChannelsには回収待ちの停止中チャネルも含め、残存を確認できるようにした。

ネイティブforkの変更先は [`~/work/russh-napi`](/home/morikyu/work/russh-napi/README.md)。`~/work/russh` 本体（0.62.2）は変更せず、bindingが利用するrussh 0.60.1も維持した。接続キャンセル、受信ACK制御、非同期のプロキシ子プロセス終了・回収を実装し、forkの作業ツリーへ反映済み。APIと制約は同forkのREADMEに記載。[CI #42354939976](https://github.com/qtaro9914/russh-napi/actions/runs/42354939976) の7ターゲット＋packが成功し、Release公開とTabby側の依存更新まで完了。

追加した回帰テストは実ネイティブアドオンとループバックSSHサーバーを使う13件。SSHバナー待ち、HTTP/SOCKS待ち、ホスト鍵確認待ち、認証待ちとtimeout、未使用transportのclose、受信制御、ACK重複、上限超過1パケット、制限解除、停止中のclose/disconnect、プロキシ子プロセスの終了・回収を確認する。8MiBのstdout/stderrを64KiBで一旦停止し、ACK後に全バイトの分布と総量が一致した。型チェック・デバッグビルド・Rust整形チェックも成功。長時間のヒープ計測、Windows/macOSでの実行確認は未実施。


### Tabby統合確認（ローカル版・公開Release版とも実施済み）

Linux上で開発ビルドのElectronを起動し、専用のconfig／user-dataとローカルParamikoサーバーで確認した。ローカルPTYは `/bin/bash --noprofile --norc`、`HISTFILE=/dev/null` を使用。普段の設定は書き換えていない。公開Release版へ切り替えた後にも同じ11項目を再実行した。ハーネスは [ssh-memory-integration.mjs](scripts/perf/ssh-memory-integration.mjs)、サーバーは [ssh-fixture.py](scripts/perf/ssh-fixture.py)。実行結果は `.native-work/integration/results.json` と `.native-work/integration-run.log`、画面は `.native-work/integration/output.png` に保存。Release版の記録は `.native-work/release-rw2/integration-results.json`、`.native-work/release-rw2/tabby-integration.log`、`.native-work/release-rw2/output.png` にも保存。

| 確認 | 結果 |
| --- | --- |
| SSHのxterm処理完了を意図的に保留 | 262,144 bytes／16件で受信が停止し、500ms後も増加なし |
| 保留解除後のSSH stdout＋stderr | 8MiB＋終端マーカーの全バイトがSHA-256一致、未ACK 0 |
| UTF-8の1バイト分割とOSC | 日本語の欠落・置換文字なし。完了マーカーを画面で確認 |
| SSHのEOF直前の最終出力 | 最終マーカーの描画後にセッション終了 |
| 書き込み保留中のタブ終了 | 41ms、受信予算0・パーサー待ち0・セッション破棄済み |
| 共有SSH接続で20チャネルを遠隔終了し、各2回close | 稼働中の1チャネル以外の受信管理情報0 |
| SSHバナー待ちで開閉10回 | 残存ソケット0 |
| 認証待ち・ホスト鍵確認待ちで終了 | 接続0、チャネル0、認証待ち0、残存モーダル0 |
| ローカルPTYのxterm処理保留 | 516,070 bytesで停止、ACK 0 |
| PTY再開後の8MiB | SHA-256一致 |
| ローカルプロセス終了直前の大量出力 | 最終マーカーを表示してからセッション終了 |
| 終了後 | SSH接続・チャネル・認証待ち0、未処理のrenderer例外0 |

バナー待ち開閉10回の前後でGC後のrenderer heapは 79,860,712 → 80,188,524 bytes（差分 +327,812 bytes）。短時間の1組の比較であり、横ばい・リーク不在の証明とはしない。Chrome DevToolsやAngularの保持も含む。長時間計測と他OS確認は未実施。

検証済み: `TABBY_DEV=1 yarn run build`、最終端末モジュールの再ビルド、`yarn lint`、`yarn test:unit`、`yarn test:ssh-term`、`yarn test:transfers`、`yarn test:memory`。追加した出力完了・破棄契約はNodeのプロセス分離を無効にした実行でも確認した。Electron統合ハーネスは11項目を通過。Nodeプロセス分離なしの単体テストは59件成功。存在しないユーザーSSH configを読む既存のログ2件はあり、未処理Promise拒否は0。


### 公開・導入の記録

- Release: `v0.1.38-rw.2`、パッケージ版 `0.1.38-rw.2+0.60.1`、タグとmainは `aa0db6d63cc778f34be7dbc8643d9d6f34ca0060`。
- パッケージ: `russh-0.1.38-rw.2+0.60.1.tgz`（15,595,397 bytes）。SHA-256は `1f0d0953df676633fffd1b2ed3eebcd1ab032224a6c864211fb604566456aaab`。GitHubの添付ファイルdigest、ダウンロードしたCI成果物、インストール済みバイナリが一致。
- 収録ターゲット: macOS x64/arm64、Windows x64/arm64、Linux GNU x64/arm64/armv7。7ターゲットのビルドとpackは成功。ランタイム確認はLinuxのみ。
- 公開前にCI成果物そのものでネイティブ回帰13件成功。依存更新後にTabbyの全モジュールビルド、単体59件、メモリ監査スクリプト、lint、Electron統合11項目が成功。
- 今回の依存取得は `yarn --cwd app install --ignore-scripts --ignore-engines --non-interactive --network-timeout 1000000`。既存lockfileのnode-gyp 13.0.2が要求するengine条件をNode 24.12.0が満たさないため、ビルドスクリプトを動かさない取得処理に限定してengine検査を外した。node-gypやNode本体、他の依存の版は変更していない。lockfileの変更はrusshの1エントリーのみ。
- ローカル検証前のrw.1バックアップは `.native-work/release-rw2/russh-original-rw1-backup` へ退避。現在の `app/node_modules/russh` はRelease版であり、ローカルビルドの上書きではない。

以下の各項目と診断値は、初回監査時の原因・再現記録と完了条件。修正後の値は上の進捗表を参照する。

## 各項目の修正方針と完了条件

### ML-01 キーストローク履歴の蓄積

根拠: [hotkeys.service.ts](tabby-core/src/services/hotkeys.service.ts#L77) の `lastKeystrokes`、`pushKeyEvent()`、`getCurrentKeystrokes()`、`matchActiveHotkey()`。

- 条件と原因: 通常打鍵・ホイール・中クリックを繰り返し、複数打鍵シーケンスの成立や明示的なクリアが起きない場合。履歴に長さ・時間上限がなく、照合時に全履歴をコピーするため、メモリと処理量が増える。`time` は履歴の失効判定に使っていない。
- 隔離再現: 単一打鍵のホットキー設定で1,000組のkeydown／keyupと200回のwheelを与えると履歴は1,200件。次のkeydownで作る配列は1,201件になった。upstream由来との主張は今回未確認。
- 修正方針: 必要な最大シーケンス長に基づく件数上限を設ける。時間切れや不一致時の扱いも定義する。
- 完了条件: 大量入力後も履歴が設計上限以内。単一打鍵、複数打鍵、キーリピート、修飾キー、ホイール、記録モードが成立する。入力回数に比例して照合対象配列が増えない。

### ML-02 ローカルセッションの破棄後起動

根拠: [local/session.ts](tabby-local/src/session.ts#L59)、[local/terminalTab.component.ts](tabby-local/src/components/terminalTab.component.ts#L66)、[BaseSession.destroy](tabby-terminal/src/session.ts#L118)。

- 原因: PTY取得を待つ `start()` と `destroy()` の状態を共有していない。まだ開いていない間に破棄すると `destroyed$` は値を発行せず完了し、後から再開した `start()` が `open=true` とリスナーを設定する。以後の `destroy()` は再入防止で何もしない。
- 隔離再現: `restore()` を遅延させ、先に破棄してからPTYを渡すと、再度破棄しても `open=true`、リスナー3個、kill 0回、unsubscribe 0回だった。
- 到達条件: 現在の[ElectronPTYInterface](tabby-electron/src/pty.ts#L17)は `async` 宣言の内部で `sendSync()` を使う。通常のクリックが同期IPCの途中に割り込めるとは言えない。「WSLの起動が遅いほど起きやすい」は未確認。非同期取得契約の不備として採用し、実機での操作到達性は別途確認する。
- 修正方針: セッション共通の破棄状態を持ち、取得直後とイベント登録前に確認する。破棄後に受け取ったPTYは利用せず、所有権に応じて終了・購読解除する。完了済みSubjectへの後付け購読に解放を頼らない。
- 完了条件: spawn／restoreの各await境界で破棄してもopenが復活せず、取得したPTYの解放が一度だけ実行される。実機では起動直後と復元タブの終了も確認する。

### ML-03 SSH接続と認証のキャンセル不足

根拠: [sshTab.component.ts](tabby-ssh/src/components/sshTab.component.ts#L76) の `setupOneSession()`／`initializeSessionMaybeMultiplex()`、[ssh.ts](tabby-ssh/src/session/ssh.ts#L76) の `KeyboardInteractivePrompt`、`_handleAuth()`、`destroy()`。

- 条件と原因: 接続・認証完了前にタブを閉じる。接続途中のSSHSessionを中止する所有関係がなく、完了後にもマルチプレクサ登録、シェル生成、`setSession()` を続行する。BaseTerminalの終了処理はまだ開いていないセッションを終了しない。KIの応答待ちにも終了時のreject経路がない。
- 隔離再現: 接続を待たせ、タブ破棄後に成功させると、破棄済みタブに開いたシェル1個、マルチプレクサに接続1個が残った。別の確認でSSHSessionの `destroy()` は未回答KIをsettleしなかった。認証チェーン全体は静的確認で、実サーバーの保持時間は未測定。
- 修正方針: 接続試行をタブが所有し、終了時にキャンセルする。各await後に試行の有効性を確認してから登録・シェル作成を行う。未回答KIをrejectし、関連モーダルも当該試行に限定して終了する。既存の共有接続の所有権を壊さない。
- 完了条件: 接続前、ホスト鍵確認、パスワード、KI、シェル作成中に閉じても接続・チャネル・応答待ちが残らない。共有接続とjump hostの参照数が戻り、再試行が閉じたタブを復活させない。

### ML-04 手動再接続と自動再接続の二重実行

根拠: [connectableTerminalTab.component.ts](tabby-terminal/src/api/connectableTerminalTab.component.ts#L63) の `onSessionDestroyed()`／`reconnect()`、[setSession](tabby-terminal/src/api/baseTerminalTab.component.ts#L795)。

- 条件の訂正: `behaviorOnSessionEnd='reconnect'`、frontendが存在し、旧セッションが **接続済み（open=true）** の状態で手動再接続する。元報告の「接続中」から訂正する。
- 原因: 旧セッションを破棄したときの同期 `destroyed$` から自動の `reconnect()` が入れ子で走る。2本の初期化が開始され、後の `setSession()` は置き換える側を終了しない。
- 隔離再現: open=trueでは初期化2回、置換後も開いたセッション1個。open=falseでは初期化1回で、この再入経路は発生しなかった。すでに進行中の初期化との競合はML-02／ML-03で扱う。
- 修正方針: 手動置換と自然切断を区別し、同時に有効な接続試行を1つにする。単に `await destroy()` を追加しても同期イベントの再入は防げないため、再入防止と試行の世代管理を合わせて設計する。
- 完了条件: 自動再接続設定で手動再接続を連打しても採用する試行は1つ。自然切断では自動再接続が働く。SSH／telnet／serialで置換されたセッションが残らない。

### ML-05 設定タブの基底クラス解放漏れ

根拠: [settingsTab.component.ts](tabby-settings/src/components/settingsTab.component.ts#L70) の購読と `ngOnDestroy()`。

- 原因: `ngOnDestroy()` が設定保存だけを実行し、親の処理を呼ばない。`subscribeUntilDestroyed()` の購読コンテナが解放されない。
- 隔離再現: 50回の生成・終了後に設定変更の購読が50個残った。
- 修正方針: `super.ngOnDestroy()` を必ず呼び、保存と破棄の順序を決める。
- 完了条件: 設定タブを50回開閉して購読数が基準値へ戻る。閉じたタブの設定変更処理が呼ばれず、設定保存は継続する。

### ML-06 ウィンドウのIPCと更新リスナー

根拠: [window.ts](app/lib/window.ts#L521) の `on()`、`setupUpdater()`、`destroy()`。

- 原因: グローバルなipcMain／autoUpdaterにWindowを捕捉する関数を登録し、破棄時に外さない。`this.window=undefined` だけではWindowへの参照は切れない。
- 隔離再現: 管理処理と更新処理を登録した20ウィンドウの破棄後、IPCリスナー360個、更新リスナー80個が残った。1ウィンドウあたり18+4個で、Claude M1の合計22個と整合する。コンストラクターのapp:ready監視は数に含めていない。
- 修正方針: 登録先、イベント名、関数参照を管理し、そのWindowの登録だけを解除する。ready到達前の終了も処理する。
- 完了条件: 反復開閉とready前の終了でリスナー数が戻り、他のWindowのIPCと更新通知は動作する。

### ML-07 共有SSH接続でのシェル終了不足

根拠: [shell.ts](tabby-ssh/src/session/shell.ts#L26) のSSHSession購読、`kill()`、`destroy()`。

- 条件と原因: ほかのタブが同じSSH接続を維持している間にシェルを終了する。親へのserviceMessage／willDestroy購読を解除せず、killは空でチャネルcloseもない。親のunrefだけでは共有中の個別シェルは閉じない。
- 隔離再現: 親接続を維持して50シェルを終了すると、親への各購読が50個残り、チャネルcloseは0回だった。遠隔プロセス数は実サーバーで未測定。
- 修正方針: シェル所有の購読とチャネルを解放し、親のrefを一度だけ返す。EOF、CHANNEL_CLOSE、手動終了、親切断が重複しても安全にする。
- 完了条件: 終了したシェルの購読・チャネル・遠隔プロセスが残らず、ほかの共有タブは切断されない。

### ML-08 SSHシェル開始失敗時の参照数

根拠: [shell.ts](tabby-ssh/src/session/shell.ts#L31) のrefと失敗処理、[sshTab.component.ts](tabby-ssh/src/components/sshTab.component.ts#L178) の再試行処理。

- 原因: ref後のシェル作成失敗に対応するunrefがない。呼び出し側は失敗したシェルを終了せず別試行へ進む。
- 隔離再現: シェル作成を2回失敗させると、基準のref 1に対して3が残った。
- 修正方針: 参照とチャネル取得を失敗時にも対称に解放する。部分初期化を破棄できるようにし、ML-07と共通の一度だけ行う終了処理を使う。
- 完了条件: PTY要求、X11要求、シェル開始の各失敗後にrefが戻る。フォールバック成功時も失敗した接続・チャネルが残らない。

### ML-09 破棄後のデコレーター登録

根拠: [baseTerminalTab.component.ts](tabby-terminal/src/api/baseTerminalTab.component.ts#L451) の `initializeFrontend()`／`destroy()`、[decorator.ts](tabby-terminal/src/api/decorator.ts#L8)。

- 原因: `await onFrontendReady()` 後に破棄状態を確認せずattachする。detach済みなので、後付けした購読を解放する機会がない。sessionChangedも終了時にcompleteされない。
- 隔離再現: 実ソースの初期化・破棄・デコレーター管理に、グローバルイベントを購読する模擬デコレーターを組み合わせた。破棄後に初期化を再開すると管理Mapにタブ1個、グローバル購読1個が残った。Claude M4の「推定」より強い証拠がある。
- 修正方針: 破棄状態／初期化世代をawait後とattach前に確認する。デコレーター内の遅延attachにも同じ終了契約を適用し、タブ所有のSubjectを終了する。
- 完了条件: 閉じたタブがデコレーターの管理Mapとグローバル購読から消える。接続キャンセルとは別にattach競合も検証する。

### ML-10 プロファイル一覧の購読漏れ

根拠: [profileTree.component.ts](tabby-core/src/components/profileTree.component.ts#L52)、[appRoot.component.pug](tabby-core/src/components/appRoot.component.pug) の条件付き表示。

- 原因: tabsChanged／activeTabChangeの購読が通常のsubscribeで、解除されない。
- 隔離再現: 50回破棄後に各50購読が残った。対照のconfig.changedは0個に戻った。
- 修正方針: 終了に購読を結び付ける。loadTreeItemsのawait中に終了した場合も後付け登録しない。
- 完了条件: 表示切り替えを反復して購読が戻る。読み込み中の非表示切り替えでも同じ結果になる。

### ML-11 ペイン移動時の旧親への登録

根拠: [splitTab.component.ts](tabby-core/src/components/splitTab.component.ts#L848) の `attachTabView()`／`observeUntilChildDetached()`／`removeTab()`。

- 原因: 親へのclick／mousemoveを子タブの寿命で管理し、移動時に解除しない。終了監視も残る。takeWhileは次の値が来るまで切り離しを検出しない。
- 隔離再現: 生きた子を50個の親へ順次接続すると、click登録、終了監視、未発行progress監視が各50個残った。通常操作で一部のtakeWhileが終了しても、DOMリスナーと終了監視は解決しない。
- 修正方針: 親子の接続ごとに購読コンテナを作り、移動・除去・置換時に解除する。
- 完了条件: 移動、結合、分離を反復して旧親への参照が残らず、クリックが現在の親だけへ届く。

### ML-12 完了通知のタイマー停止漏れ

根拠: [app.service.ts](tabby-core/src/services/app.service.ts#L26) のCompletionObserver、observeTabCompletion、stopObservingTabCompletion。

- 原因: 通知無効化がMap削除だけで、監視のstopを呼ばない。プロセス完了かタブ破棄までタイマーが存続する。
- 隔離再現: 長時間プロセスを想定して有効・無効を50回繰り返すと、Map 0件に対してタイマー50個。タブ破棄を通知すると0個になった。
- 修正方針: Mapから削除し、監視を停止する。停止通知による再入と、古い監視が新しい監視を削除する競合も防ぐ。
- 完了条件: 無効化直後にポーリングが止まり、反復で増えず、無効化した通知も発行されない。

### ML-13 ZMODEM受信のキャンセル待ち

根拠: [zmodem.ts](tabby-terminal/src/features/zmodem.ts#L286) のreceiveFile内Promise.raceとfinally。

- 原因: 受信が先に完了しても、raceの相手のキャンセル待ちtoPromiseは解除されない。finallyで解除しているのは別の購読。
- 隔離再現: 空ファイル50回の正常受信後に50購読が残った。Ctrl+Cやミドルウェア終了で解消するが、同一セッション中に蓄積する。
- 修正方針: raceのキャンセル購読も所有・解除し、正常完了、失敗、キャンセル、ミドルウェア終了を扱う。
- 完了条件: 各転送終了後に購読が戻り、連続受信、途中キャンセル、切断で未処理の拒否が出ない。

### ML-14 端末出力の待ち行列

根拠: [baseTerminalTab.component.ts](tabby-terminal/src/api/baseTerminalTab.component.ts#L530) のwrite／attachSessionHandlers、[local/session.ts](tabby-local/src/session.ts#L151) の受信直後ACK、[xtermFrontend.ts](tabby-terminal/src/frontends/xtermFrontend.ts#L65) のFlowControl。

- 性質と原因: 解放不能なオブジェクトとは別の、負荷に応じたメモリ増大。描画が追いつけば減る可能性がある。xtermへの投入制限はあるが、前段のfrontendWriteLockへPromiseを追加し続け、前段キューのバイト上限や送信元まで届く流量制御がない。
- 隔離再現: 描画を待たせて64 Ki文字を100回投入すると、描画到達1件に対し99件、6,488,064文字が待機した。文字数は実メモリ使用量ではない。
- 修正方針: 待機バイト数を計測し、上限と送信元へのバックプレッシャーを接続する。PTYのACK、SSH出力、ZMODEM受信の書き込み待ちも含め、流量を止める場所を設計する。データを失う切り捨ては別の製品判断とする。
- 完了条件: 意図的に遅い描画と大量出力を組み合わせても待機量が設計上限内。入力応答、出力順序、切断時の後処理が維持される。

### ML-15 SFTPローカル編集の一時ファイルと監視

根拠: [sftpContextMenu.ts](tabby-electron/src/sftpContextMenu.ts#L40)。tmp-promiseのdirはpathとcleanupを返すが、呼び出し側はpathだけを残す。

- 静的確認: cleanupを呼ばず、キャンセル・ダウンロード失敗・接続終了時も一時ファイルを削除しない。watcherはrenameまたはSFTPのclosedで閉じるため、上書き保存型エディターで別の編集を繰り返すと接続中の監視が増える。
- 条件の限定: watcherは原則としてローカル編集開始ごとに1個で、保存ごとの新規生成ではない。接続終了を観測できれば閉じる。ただし1秒の遅延中に接続が閉じると、完了済みの非Replay Subjectへ後から購読する経路がある。
- 修正方針: 編集セッションが一時ディレクトリ、watcher、購読を所有し、開始失敗・キャンセル・編集終了・切断で解放する。外部エディターの終了を起動APIから特定できないため、終了操作や期限の製品仕様を決める。自動同期を継続する機能なので、最初のアップロード直後の無条件削除は避ける。
- 完了条件: キャンセルと失敗で一時ファイルが消える。上書き保存・rename保存で同期でき、編集終了／切断で監視とファイルが解放される。遅延watcher作成前の切断でも残らない。

## Claude報告との照合

| Claude ID | 判定 | 統合先・補正 |
| --- | --- | --- |
| H1 | 新規追加 | ML-01。履歴1,200件を隔離再現。upstream由来は今回未確認 |
| H2 | 除外 | CDK側の破棄処理でメンバーが削除される |
| H3 | 条件付き新規追加 | ML-02。遅延取得で再現。同期IPCに通常のクリックが割り込むという説明は採用しない |
| H4 | 新規追加 | ML-03。接続完了後の復活を隔離再現。KI以外の各モーダルは実機確認が必要 |
| M1 | 重複 | ML-06。18 IPC＋4更新リスナー。ready前終了は追加検証 |
| M2 | 重複 | ML-11。DOM、終了監視、未発行ストリームの購読が対象 |
| M3 | 条件訂正して新規追加 | ML-04。同期的な自動再接続の再入はopen=trueで確認 |
| M4 | 重複・確度更新 | ML-09。隔離再現済みとして扱う |
| M5 | 重複・範囲拡張 | ML-15。ディスク残存、編集単位の監視、遅延作成との競合を区別 |

### H2を除外した根拠

[CdkAutoDropGroup](tabby-core/src/directives/cdkAutoDropGroup.directive.ts#L24)自身にはngOnDestroyがない。しかしcdkDropListの `_group` に同じグループを渡しており、導入済みAngular CDK **15.2.9** の `CdkDropList.ngOnDestroy()` は `this._group._items.delete(this)` を呼ぶ。

対象依存コードは `node_modules/@angular/cdk/fesm2020/drag-drop.mjs`。診断スクリプトはこの実メソッドを抽出し、アプリ側の登録と組み合わせて200回実行した。Setの残存は **0件**。

通常のAngular破棄経路について「切り替えるたびに4個以上漏れる」は採用しない。ドロップゾーン再生成のCPU負荷と、staticなグループ名の空エントリーが残る点は別問題。重複したメンバー削除の追加は不要とする。

### Claudeの参考指摘の扱い

以下は15件に追加して数えない。保持経路と影響を確認してから独立した修正項目へ昇格させる。

| 指摘 | 扱い | 次に必要な確認 |
| --- | --- | --- |
| 共有SSHへの購読 | ML-07へ統合 | 個別チャネルと遠隔プロセスを含めて終了を検証 |
| SettingsTabBody／EditProfileModalの遅延createComponent | 追加調査候補 | [settingsTabBody](tabby-settings/src/components/settingsTabBody.component.ts#L23)、[editProfileModal](tabby-settings/src/components/editProfileModal.component.ts#L62)。破棄後のコンテナーが作成を許すか、例外だけか、参照が残るかを再現 |
| SplitTabの一部Subjectがcompleteされない | 単独のリークとして未採用 | 外部の保持元を特定。Subjectと購読の循環だけでGC不能とは判断しない。ML-11とは区別 |
| Multifocusが閉じたタブを保持する | 追加調査候補 | [multifocus.service.ts](tabby-terminal/src/services/multifocus.service.ts#L35)のstart／cancel。終了・blur時の順序、保持期間、反復で増えるかを確認 |
| activateChannel後の失敗でcloseしない | ML-08と関連する追加調査候補 | [openShellChannel](tabby-ssh/src/session/ssh.ts#L951)のPTY／X11／shell要求失敗、agent経路で所有者とrussh側の解放を確認 |
| プラグイン検索fetchをabortしない | 通信・終了処理の改善候補 | [pluginManager.service.ts](tabby-plugin-manager/src/services/pluginManager.service.ts#L51)。リクエスト終了後の回収と無期限保持を区別 |

## 推奨する対応順

1. **ML-01**: 普段の入力で増える履歴を制限する。体感の劣化にも直結する。
2. **ML-05、ML-06、ML-10、ML-12**: 個々に修正できる解放漏れ。項目ごとに変更を分け、基準値への復帰を検証する。
3. **ML-02、ML-03、ML-09**: 共通の破棄状態と接続試行のキャンセル契約を決め、破棄後の起動・登録を止める。ML-02の実機到達条件も詰める。
4. **ML-04、ML-07、ML-08**: 所有権、再接続、参照数、個別チャネルの終了を整合させる。共有SSHを切断しないことも回帰条件とする。
5. **ML-11、ML-13、ML-15**: ペイン接続、転送、編集の終了単位へ解放を集約する。ML-15は編集終了仕様を先に決める。
6. **ML-14**: 出力のバックプレッシャーを扱う独立した変更。高速出力時の症状が主目的なら計測を早める。

## 再現資料と検証結果

### 診断スクリプト

[scripts/audit-memory-leaks.cjs](scripts/audit-memory-leaks.cjs) に前回の一時スクリプトを保存し、新規候補とCDK除外の確認を追加した。リポジトリの依存関係と実ソースを使用する。外部通信、実PTY起動、製品コードの変更は行わない。

```bash
node scripts/audit-memory-leaks.cjs
```

修正した項目は **解放後の正常値をassertする回帰確認** に変更済み。ML-14の直接writeを100回投入する観測は上流制御を通さないため引き続き待ち行列を作れる。SSH／PTYの流入上限は別途Electron統合ハーネスで確認する。スクリプト成功だけでML-14全体の解消を意味しない。元の異常値は下の監査記録に保持する。実行には `yarn test:memory` も使える。

模擬対象はElectronのイベント登録先、Angular装飾子とUI依存、接続・チャネル、遅延する非同期処理。実ソースのメソッドを呼び、購読数、ref数、終了呼び出し、採用されたセッションを測る。ヒープスナップショット、GC後の保持量、実サーバーのプロセス数を代替しない。

| 対象 | 実行条件 | 観測結果 |
| --- | --- | --- |
| ML-01 | 1,000打鍵＋200wheel | 履歴1,200、次の照合配列1,201 |
| ML-02 | PTY復元を遅延し先にdestroy | open復活、リスナー3、kill／解除0 |
| ML-03 | SSH接続完了をタブ終了後へ遅延 | 開いた接続1、シェル1、登録1 |
| ML-03認証 | 未回答KIとSSHSession.destroyを照合 | prompt未settle。認証全体は静的確認 |
| ML-04 | open=true／falseで手動reconnect | 初期化2回／1回。接続済みでは置換されたopenセッション1 |
| ML-05 | 設定タブ50回終了 | 設定購読50 |
| ML-06 | ウィンドウ20回破棄 | IPC 360、更新80 |
| ML-07 | 共有接続で50シェル終了 | 親への各購読50、チャネルclose 0 |
| ML-08 | シェル開始2回失敗 | refは基準1に対して3 |
| ML-09 | 初期化を破棄後に再開 | 管理タブ1、グローバル購読1 |
| ML-10 | プロファイル一覧50回破棄 | 各イベント購読50 |
| ML-11 | 子を50個の親へ接続・切り離し | DOM、終了監視、未発行progress監視が各50 |
| ML-12 | 通知の有効・無効50回 | Map 0、タイマー50 |
| ML-13 | 空ファイル50回正常受信 | キャンセル待ち購読50 |
| ML-14 | 描画停止下で100チャンク投入 | 描画到達1、前段待機99 |
| Claude H2 | グループ登録とCDK破棄200回 | 残存0、CDK 15.2.9 |
| ML-15 | コード経路確認 | スクリプトでの再現は未実施 |

### 既存テスト

2026-11-06、1496c223のチェックアウトで次を再実行し、すべて成功した。

```bash
yarn test:unit
yarn test:ssh-term
yarn test:transfers
```

既存の検証範囲が通ることを示す。今回の各競合・解放漏れが既存テストで検出されるという意味ではない。

### 修正後の自動検証 2026-11-07

次のコマンドが成功した。全体ビルド後に追加したペインのフォーカス参照補正については、core単体ビルドとメモリ回帰確認、lintを再実行した。

```bash
yarn test:memory
yarn test:unit
yarn test:ssh-term
yarn test:transfers
yarn lint
yarn run build
yarn webpack --config tabby-core/webpack.config.mjs
```

`sessionDestroy.test.ts` に、起動前の終了通知とプロセス終了処理が失敗した場合のストリーム解放を追加した。メモリ回帰確認では、既存の残存数に加え、単一・複数打鍵とホイールの認識、キー記録、ツリー読み込み中の破棄、通知確認中のキャンセル、遅れて返るSSH clientの終了、認証モーダルの終了、PTY要求失敗時のチャネル解放、telnet／serialの遅延接続、SFTPの再オープン・rename保存・切断・キャンセル・ダウンロード失敗を検証した。

SFTPの隔離確認では一時ディレクトリ4個に対してcleanup 4回、作成した監視2個に対してclose 2回。同じファイルの同時オープンではディレクトリとダウンロードを共有した。SFTPについて、実ファイル・外部エディターを使った確認と、GUI操作・実接続でのヒープ測定は未実施。

### 修正ごとの共通完了手順

1. 各項目の完了条件を回帰テストにする。必要な箇所で遅延、失敗、二重終了、置換を注入する。
2. 変更に対応するテストと、リポジトリ標準の `yarn lint`／`yarn run build` を実行する。
3. GUIで該当操作を反復し、購読・リスナー・プロセス・チャネルが基準値に戻ることを確認する。
4. 影響が大きい項目はGC後のヒープと保持経路を比較する。JS heap、main／rendererのRSS、Buffer等の外部メモリ、必要ならGPUも分ける。
5. 対応一覧を完了にし、修正コミット、検証コマンド、実機条件、残る制限を項目へ追記する。

## 正常な解放や上限を確認した箇所

- app/lib/pty.tsの管理Mapはプロセス終了時に削除される。起動・所有権の競合はML-02、描画前段への流入はML-14として別に扱う。
- 初期出力は8 MiB、OSC解析は1 MiB、転送用ソケットの待機データは8 MiBに上限がある。SFTPの先読みは並列8件、1件最大1 MiBで制限される。
- xterm frontendにはDOMリスナー、ResizeObserver、リサイズ待ちタイマー／rAF、WebGLの解放処理があり、WebGLのカーソル点滅タイマーへの回避処理もある。
- SFTPの通常の転送ハンドルはfinallyでcloseする。ローカル編集の寿命はML-15で扱う。
- AppServiceのtabs／MRUからの除去と、閉じたタブ履歴の上限5件は実装されている。completionObserversのMap削除だけではタイマーが止まらない点はML-12。
- setSessionは旧ハンドラを解除するが、旧セッションの終了や二重接続の所有権を保証しない。
- subscribeUntilDestroyedは基底クラスの破棄処理が実行された場合に有効。設定タブはML-05の例外で、「設定の各タブはすべて問題なし」という元報告の断定は採用しない。
