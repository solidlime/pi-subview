# pi-subview

pi-web ブラウザで pi-subagents の非同期ラン（thinking / toolCall / toolResult / text）を全画面オーバーレイで閲覧する pi 拡張。pi-web 以外の pi ランタイムでも動く純粋な pi 拡張。

コマンド: `/subview` — ラン一覧 → `j/k` 選択 → thinking・tool 実行を `J/K` スクロール、`g/t` 先頭/末尾、`x` 折りたたみ、`i` info パネル、`?` ヘルプ、`r` リロード、`q` 終了。

## 技術構成
- TypeScript 1 ファイル（`extensions/subagent-viewer.ts`、外部依存なし・jiti 素読み pi 拡張）
- `ctx.ui.custom()` オーバーレイ + `setWidget` による常駐 1 行フッタ
- pi-subagents の `sessions/<...>/async-subagent-runs/<id>/events.jsonl` をポーリングで読む
- レンダリング: NullTheme 前提の ANSI 直書き（pi-web は ansi-to-html で描画）

## 運用
- pi 本体への導入: `cp extensions/subagent-viewer.ts ~/.pi/agent/extensions/`（開発ソースは本リポジトリで管理）
- 設計書・検収記録: `research/subagent-viewer-design-20260926.md`（§10 実装追補）
- 2026-09-26 検収完了: tsc --noEmit PASS（tsconfig.json コミット済み・再現可能） / pi 0.87.1 headless ロード / 実データ 3.17MB スモーク / pi-web 実機 e2e 全キー / レビュー PASS（BLOCK 0 件）

## 識別
- project: pi-subview
