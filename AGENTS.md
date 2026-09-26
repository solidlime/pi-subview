# Project guide line

## プロジェクト概要
- 本プロジェクトのプラン作成、および回答は全て日本語で行います。
- pi-web ブラウザで pi-subagents 非同期ラン（thinking/toolCall/toolResult/text）を全画面オーバーレイ閲覧する pi 拡張「subagent-viewer」（`/subview`）の開発リポジトリ。pi-web 以外の pi ランタイムでも動く純粋な pi 拡張。
- TypeScript 単一ファイル（`extensions/subagent-viewer.ts`）・外部依存なし・jiti 素読み拡張。
- pi 本体への導入は `cp extensions/subagent-viewer.ts ~/.pi/agent/extensions/`。運用稼働中（2026-09-26 検収完了）。

## プロジェクト識別
- project: pi-subview

# Nous 記憶運用（.agent/ は使わない）

## セッション開始時（必須）
セッション開始時、ユーザーへの最初の応答の前に session-start スキルを実行し、nous 記憶から状態を復元する:
- `session_begin` でペルソナ状態・直近サマリを取得
- `## プロジェクト識別` 節から `project: <slug>` タグを取得
- `memory_search(tags=["project:pi-subview", "task_state"], top_k=3)` 等で作業状態を復元
- `memory_search(tags=["session_summary"], top_k=1, sort="updated_at")` で前回の内容を把握

## メモリ管理
- 重要情報・決定・作業完了は nous に記録。`project:pi-subview` タグ必須
- 状態変化時は `update_context` → `memory_create` の順で永続化
- `.agent/memory/MEMORY.md` / `.agent/handoff/HANDOFF.md` は使用しない（nous 記憶が代替）
- ローカルの自動メモリ機能（~/.claude/ 配下）は使用しない

## ハンドオフ管理
- セッション終了時の session_summary 生成（終了フック）が引継を代替する
- 手動引継が必要な場合は `memory_create(tags=["project:pi-subview", "task_state"])` で記録

## 仕様駆動開発（SDD）ルール
- コーディングや業務作業を開始する前に、必ず `.spec/` 配下の4ファイルを確認・更新すること
- 作業の順序：PLAN（目的確認）→ SPEC（要件確認）→ TODO（タスク確認）→ 実作業
- **PLAN.mdは人間の口頭メモ・自由記述**であり、箇条書き・口語・断片的な内容で構わない
- PLAN.mdを読んだら、そのまま実装に入らず、不明点をヒアリングしながらSPEC.mdを作成・確定させること
- SPEC.mdが確定してからTODO.mdのタスク分解を行い、ユーザーの承認を得てから実作業を開始する
- 作業完了後は TODO.md の該当タスクにチェックを入れ、KNOWLEDGE.md に学びを記録する
- 仕様が不明確な場合は作業を開始せず、ユーザーに確認してから SPEC.md を更新する
