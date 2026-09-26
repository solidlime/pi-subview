# SPEC - 技術仕様・要件定義

## 機能要件
- [x] 機能1: `/subview` コマンドで events.jsonl ラン一覧をオーバーレイ表示（active + 24h）
- [x] 機能2: ラン選択（j/k）→ thinking / toolCall / toolResult / text の時系列閲覧
- [x] 機能3: スクロール（J/K）、先頭/末尾ジャンプ（g/t）、折りたたみ（x）、info パネル（i）、ヘルプ（?）、リロード（r）
- [x] 機能4: 常駐 1 行 widget フッタ（ラン進行状況）
- [x] 機能5: pi-web / TUI 両ランタイム対応（ガードは typeof ctx.ui.custom === "function" のみ）

## 非機能要件
- パフォーマンス: 巨大 events.jsonl（3.17MB 実測）をポーリングで追従増分読み
- セキュリティ: ansi-to-html が HTML escape（SGR 以外シーケンスは無洗浄＝既知の OPTIONAL）
- 制約条件: 単一ファイル・外部依存ゼロ・NullTheme 前提 ANSI 直書き（\x1b[7m 不使用）

## 技術構成
- 言語・フレームワーク: TypeScript（pi 拡張 API: ctx.ui.custom / setWidget / registerCommand）
- インフラ・環境: pi 0.87.1（TUI / pi-web）
- 外部サービス・API: なし（ファイルシステムの events.jsonl のみ）

## データ構造・インターフェース
- runs ディレクトリ: `/tmp/pi-subagents-uid-0/async-subagent-runs/<uuid>/status.json + events.jsonl`
- events.jsonl 1 行 = { type: thinking|toolCall|toolResult|text, callId?, ... }
