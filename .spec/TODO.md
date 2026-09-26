# TODO - タスクリスト

## 優先度：高
- [x] T001：viewer 本体実装（extensions/subagent-viewer.ts 1254行）

## 優先度：中
- [x] T002：#003 レビュー OPTIONAL #4 対応 — pollStatus の表示ちらつき（存在確認が確認できた直後のみ戻す）
- [x] T003：OPTIONAL #6 対応 — module-level activeInstance で二重起動時に旧インスタンスを閉じる
- [x] T004：OPTIONAL #1 対応 — drainCursor.remainder に 16MiB 上限

## 優先度：低
- [x] T005：OPTIONAL #2 — statusCache の定期掃除（1分に1回）
- [x] T006：OPTIONAL #3 — tool 出力の ANSI SGR 以外 strip
- [x] T007：NIT #5 — help の `r` 説明文言修正

## 完了済み
- [x] 初期セットアップ（設計 → 実装 → 検收 → レビュー PASS）

## 完了メモ
- T002〜T007 は 1afc934（feat/todo-cleanup）で一括消化。#011 実装 → #003 レビュー PASS（BLOCK 0）。
- 残NIT全消化（2026-09-26 3844a00）: CSI 私用パラメータ対応・previewArgs 先 strip+末尾断片除去・dropExisting 冪等化。
