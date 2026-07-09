# Phase 1 実装結果 — TSクイックフィックス

- 実施日: 2026-07-09
- ブランチ: `perf/bottleneck-analysis`
- 親ドキュメント: `PERFORMANCE-BOTTLENECK-REPORT.md` / `PERF-PHASE0-MEASUREMENTS.md`

## 実装した修正

| # | 仮説 | 修正内容 | ファイル |
|---|---|---|---|
| 1 | A2 | **ZModemミドルウェアのバイパス**: アイドル時、ZDLE(0x18)を含まないチャンクはsentryを完全スキップして直接出力。チャンク境界のヘッダ分断は末尾2バイトの持ち越し＋再出力抑制で対応。チャンク末尾24バイト以内にZDLEがある場合は次チャンクもsentryに通す | `tabby-terminal/src/features/zmodem.ts` |
| 2 | A5 | detectProgress: `data.includes('%')` の事前チェックで正規表現実行を回避（挙動同一） | `tabby-terminal/src/api/baseTerminalTab.component.ts` |
| 3 | B1 | ホットキー設定のメモ化: `getHotkeysConfig()` をキャッシュし `config.changed$` で無効化 | `tabby-core/src/services/hotkeys.service.ts` |
| 4 | A6 | DebugDecorator: 毎チャンクの文字列連結＋substringをチャンク配列＋遅延joinに変更 | `tabby-terminal/src/features/debug.ts` |
| 5 | B3 | focusFollowsMouse: フォーカス済み（`focusedTab === tab && tab.hasFocus`）なら mousemove を早期return（毎mousemoveの`layout()`を解消） | `tabby-core/src/components/splitTab.component.ts` |
| 6 | C1 | タブ復元保存を `requestIdleCallback`（timeout 5s）に遅延し、出力ストリーミング中のジャンクを回避 | `tabby-core/src/services/app.service.ts` |
| 7 | B4 | セレクタ: FuzzySearchインスタンスを毎キー生成せず再利用 | `tabby-core/src/components/selectorModal.component.ts` |

## 検証結果（Phase 0と同一手法・同一シナリオで再計測）

### S1: 大量出力スループット（cat 50MB）

| 指標 | Phase 0 ベースライン | Phase 1 適用後 | 変化 |
|---|---|---|---|
| スループット | 6.3 MB/s | **10.2 MB/s** | **+62%** |
| 表示完了時間 | 7.9 s | 4.9 s | −38% |
| レンダラCPU busy率 | 81.7% | 65.4% | CPU飽和解消 |

- zmodem.js `consume`（旧32.7%）はプロファイル上位から消滅
- 出力バイト数はベースラインと完全一致（52,691,450バイト）— データ欠落・重複なし
- 残余の上位は xterm.js（`print` 9.2%、`parse`等）と IPC `send` 7.2%

### S2: キー入力オーバーヘッド

| 指標 | Phase 0 | Phase 1 | 変化 |
|---|---|---|---|
| 1打鍵（down+up）あたり | 245 µs | **182 µs** | **−26%** |

- `getHotkeysConfigRecursive`（旧4.9%）と `ConfigProxy.__getValue`（旧4.2%）がプロファイルから消滅
- 残余の大半はAngular変更検出（`refreshView` 10%等）— B2構造課題としてPhase 2以降へ

### S3: タブ復元シリアライズ

- `saveTabs()` 単体の所要時間は不変（想定どおり — 修正は「実行タイミングをアイドル時に移す」もので、処理自体は同じ）
- 効果は「ストリーミング中のジャンク回避」であり、直接時間計測には現れない

### ZMODEM機能の回帰テスト

CDP経由でPlatformService.showMessageBoxをスタブ化し、実際のZRQINITヘッダのバイト列
（`rz\r**\x18B00000000000000\r\x8a\x11`）をシェルのprintfで出力して検証:

| ケース | 結果 |
|---|---|
| ヘッダが1チャンク内に完結 | ✅ 検出発火 |
| ヘッダがバイパス境界で分断（`**`でチャンク終了→1秒後にZDLE以降が到着） | ✅ 検出発火（末尾持ち越しが機能） |

※ zmodem.jsのSentryは「consume入力の末尾にヘッダがある場合のみ検出」する仕様のため、
テストではヘッダ直後にプロンプトが混ざらないよう `sleep` で保持している。

## 見送った項目（理由付き）

| 項目 | 理由 |
|---|---|
| A4 出力coalescing（bufferTime復活） | キーエコーに常時+10msのレイテンシが乗る副作用。ローカルはPTYDataQueueが100KBバッチ済みで効果も限定的 |
| B2 OnPush/zone外化の全面適用 | 影響範囲が広くPhase 1のスコープ外。S2残余の主因なのでPhase 2で個別に |
| D1 SFTP read-ahead | SSH接続先が必要で未検証のまま入れられない。別途SSH環境を用意して実装＋計測 |

## 次のステップ

1. この結果をもってコミット（`yarn lint` クリーン確認済み）
2. Phase 2判断: レンダラCPU飽和が解消したため、出力パイプラインのRust化の費用対効果は当初想定より低下。次の律速はmainプロセス（PTY読み取り＋IPC `send` 7.2%）— Rust化候補の再評価はmainプロセス計測後に
