# KNOWLEDGE - ドメイン知識・調査結果

## 業務・ドメイン知識
- pi-subagents の非同期ランは `/tmp/pi-subagents-uid-0/async-subagent-runs/<uuid>/` に status.json（lifecycle）+ events.jsonl（append-only イベント）を書く
- pi-web は extension UI を `handleExtensionUiInput` で受けて、クローズ経路（q/Esc/ホスト Close）すべてで `closeCustomUi → component.dispose` を呼ぶ（pi-coding-agent docs/tui.md:69）

## 調査・リサーチ結果
- Agent/subagent ツールのスキル・MCP 対応調査の経緯 → 設計書 `research/subagent-viewer-design-20260926.md`

## 技術的な知見
- pi-web では ctx.mode が "rpc" でも ctx.ui.custom は動く（typeof チェックのみでよい）
- ansi-to-html は HTML escape をするが SGR 以外シーケンスは素通りする可能性（OPTIONAL #3）
- pi-web 入力欄への文字入力は type コマンドが効かず press ベース（検証時の教訓）
- theme 依存を絶たないため NullTheme 前提 ANSI 直書きを選択（反転 \x1b[7m は不使用、選択行は > + 1;36m）

## 決定事項と理由
- 単一ファイル維持（1コミット100行ルールの例外＝単一ファイル要件・実測 1254行）
- ポーリング方式（コマンドハンドラ内で起動、dispose() で停止。ホスト契約上 done() 経由の dispose が担保のため）
- #003 レビューの OPTIONAL/NIT は初期リリースでは対応しない（BLOCK 0 件。次点は T002 ちらつき修正＝1行）
