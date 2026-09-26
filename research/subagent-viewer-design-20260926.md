# pi 拡張 `subagent-viewer` 設計書

- 対象: pi-web（`@agegr/pi-web@0.9.3`）+ pi-subagents `0.70.0`
- 方針: **pi-web を一切パッチしない**。pi 拡張 1 ファイルのみを追加する
- 版の実測環境: pi `@earendil-works/pi-coding-agent`（`/root/.npm-global/...`）、`@earendil-works/pi-tui@0.87.1`
- 作成: 2026-09-26 / 人形 #002（設計参謀）

---

## 0. 前提（先に結論だけ）

1. **pi-web では「下部タブ」方式しか今まで無かった。** 既存の見え方の正体は `setWidget` であり、pi-web はそれを *タブ列 + 展開パネル* として描く（後述 §1.3 の実測）。thinking が出ないのは widget に渡す行に thinking が含まれていないからで、口が塞がっているわけではない。
2. **オーバーレイは本当に使える。** pi-web は `ctx.ui.custom()` を実装しており、チャット領域全面（`position:absolute; inset:0; zIndex:95`）に ANSI テキストを描き、キー入力も拡張へ転送する。しかも `ctx.mode === "rpc"` なのに動く（§1.2）。ここが今回の唯一の口。
3. **thinking は events.jsonl に「全文」だが「メッセージ境界ごと」にしか現れない。** `message_update`（トークン差分）は pi-subagents が意図的に捨てている（`shouldPersistChildEvent` が `event.type !== "message_update"`）。よって組み込み Agent と同等のトークン単位ストリームは**原理的に不可能**。`message_end` の `message.content[].thinking` に全文が入るので、「1 メッセージ単位のライブ表示」までは到達できる。これが本設計の到達点であり限界。
4. **pi-web のテーマは恒等関数。** `ctx.ui.custom` に渡る `theme` は全メソッドが入力をそのまま返す `NullTheme`。**色は自分で ANSI を書くしかない。** さらに pi-web の ANSI レンダラは `ansi-to-html` で、対応 SGR に制約がある（§4.4）。

---

## 1. 実測した pi-web 側の機構（一次ソースはビルド済みバンドル）

pi-web はソース配布していないため、`.next` のバンドルを直接読んで確定させた。ファイル: `.../pi-web/.next/server/chunks/6429.js`（サーバ側 = 拡張に渡る `ExtensionUIContext` の実装）と `.../pi-web/.next/static/chunks/app/page-b5a19d562a153b66.js`（クライアント側 = オーバーレイの実描画）。

### 1.1 `custom()` の実装（サーバ側）

```js
custom:(a,b)=>this.requestExtensionCustomUi(a,b)
requestExtensionCustomUi(a,b){
  if("function"!=typeof a)return Promise.resolve(void 0);
  let c=this.extensionUiAbortController.signal;
  if(c.aborted)return Promise.reject(c.reason);
  let d=randomUUID(), e=this.getCustomUiWidth(b);
  ... h = TQ(()=>{ let a=this.activeCustomUis.get(d); a&&this.emitCustomUiRender(d,a) }, e)
  ... Promise.resolve().then(()=>g?void 0:a(h,Z,$,j))            // factory(tui, theme, keybindings, done)
     .then(a=>{ ... activeCustomUis.set(d,{component:a,width:e,resolve,d,settled:!1}); this.emitCustomUiRender(d,b) })
}
getCustomUiWidth(a){
  if(!a||"object"!=typeof a)return s.p1;                 // p1 = 92
  let c = typeof a.overlayOptions==="function" ? a.overlayOptions() : a.overlayOptions;
  if(!c||"object"!=typeof c)return s.p1;
  let d=c.width;
  return "number"==typeof d&&Number.isFinite(d) ? Math.max(40,Math.min(140,Math.round(d))) : 92;
}
emitCustomUiRender(a,b){ let c=b.component.render(b.width); ... this.emit({type:"extension_ui_request",id:a,method:"custom",lines:c}) }
closeCustomUi(a,b){ ... this.emit({type:"extension_ui_request",id:a,method:"custom",lines:[],closed:!0}); c.resolve(b) }
handleExtensionUiInput(a,b){ ... c.component.handleInput?.(b); ... this.emitCustomUiRender(a,c) }
```

ヘッドレス TUI オブジェクト本体（同バンドル内 module 71069）:

```js
71069:(a,b,c)=>{ ... let d=92;
  function e(a,b=d,c=40){ return Object.freeze({
      terminal:Object.freeze({ columns:b, rows:c, kittyProtocolActive:!1 }),
      requestRender:a }) } }
```

**確定事項:**

| 項目 | 値 |
|---|---|
| `custom()` 引数の `tui.terminal` | `{ columns: 92, rows: 40, kittyProtocolActive: false }`（width 指定時は columns=clamp(40..140)、rows は常に 40） |
| `render(width)` が受ける width | 既定 92。`overlayOptions.width` を数値で渡すと 40〜140 に clamp |
| 返す値 | `string[]`（各行 = ANSI 付き 1 行）。`join("\n")` されてから HTML 化される |
| キー入力 | `handleInput(data: string)` が呼ばれる。data は端末エスケープ列（後述 §4.3） |
| 同時表示数 | サーバ側は Map だが **クライアント側の state は単一値**（下記 1.4）。よって実質 1 つ |
| `overlay` / `anchor` / `maxHeight` | **pi-web では無視**。`overlayOptions.width` のみ有効 |
| 終了 | 拡張が `done(result)` を呼ぶ → `closeCustomUi` → `lines:[], closed:true` → クライアントが state を null に |
| 中断 | `extensionUiAbortController.abort()` で拒否（reject）。コマンドハンドラは catch 必須 |
| `getCustomUiWidth` の引数 | 生の `options`（`{overlay, overlayOptions}`） |

### 1.2 拡張に渡る mode とテーマ

```js
// bindExtensions 呼び出し
await b.call(this.inner,{ uiContext:a, mode:"rpc", commandContextActions:..., shutdownHandler:..., onError:... })
```

```js
class Y extends e.Theme {
  constructor(){ super({muted:"",text:"",thinkingXhigh:"",searchMatchText:""},{selectedBg:""},"truecolor") }
  fg(...[,a]){return a}  bg(...[,a]){return a}  bold(a){return a}  italic(a){return a}
  underline(a){return a} inverse(a){return a}  strikethrough(a){return a}
  getFgAnsi(){return ""}  getBgAnsi(){return ""}
  getThinkingBorderColor(){return a=>a}  getBashModeBorderColor(){return a=>a}
}
let Z=new Y, $=new f.KeybindingsManager(f.TUI_KEYBINDINGS);
```

**確定事項:**
- pi-web では **`ctx.mode === "rpc"`、`ctx.hasUI === true`**。ドキュメント（`extensions.md`）の「`ctx.mode === "tui"` でガードせよ」を**そのまま適用してはいけない**。`custom()` は RPC モードでも実装済みなので、ガードは `typeof ctx.ui.custom === "function"` にする。
- **`theme` は恒等関数**。`theme.accent("x") === "x"`。pi-web では色ヘルパは全て無効 → **ANSI を直書きする**。
- `keybindings` は通常の `KeybindingsManager(TUI_KEYBINDINGS)`（TUI と同じ既定値）。
- `setFooter` / `setHeader` / `setEditorComponent` / `addAutocompleteProvider` / `setWorkingMessage` 等はサーバ側で `()=>{}` の no-op。`getEditorText()` は `""`。`setTheme` は `{success:false,error:"Theme switching is not supported in Pi Web extension UI yet"}`。`setWidget` / `setStatus` / `setTitle` / `set_editor_text` / `notify` / `select` / `confirm` / `input` / `editor` は動作する。

### 1.3 `setWidget` の実際の見え方（= ユーザーの言う「下部タブ」）

クライアント側:

```js
case"setWidget": e6(e=>(function(e,t,n,r="aboveEditor"){
    if(void 0===n)return e.filter(e=>e.key!==t);
    let i={key:t,lines:n,placement:r}, o=e.findIndex(e=>e.key===t);
    return -1===o?[...e,i]:e.map((e,t)=>t===o?i:e)})(e,t.widgetKey,t.widgetLines,t.widgetPlacement));
```

描画側（`page-b5a19d562a153b66.js` 付近）:

```jsx
<div className="extension-widget-panel-heading">{g.key}</div>
<pre className="extension-widget-content"><rf text={g.lines.join("\n")}/></pre>
...
<div className="extension-widget-triggers" aria-label={...}>
  {e.map(...)}   // widgetKey ごとに 1 ボタン。is-expanded / is-updating / placement 矢印付き
</div>
```

**つまり `setWidget(key,lines)` は「キー名のボタン = タブ」を作り、押すと `<pre>` パネルが開く。** 常時見えるのはタブだけ。これがユーザーの「現在の下部タブは status/結果しか見えない」の正体。`subagent-async` / `subagent-fleet-status` / `subagent-inspect` がそのタブとして並んでいる。

→ **`setWidget` を増やしても同じ問題を再生産する。** 全面オーバーレイが唯一の解。（ユーザー決定と一致）

### 1.4 オーバーレイのクライアント実装（`r5` コンポーネント）

```js
case"custom": e2(e=>t.closed ? (e?.id===t.id?null:e) : t)     // ← state は単一値。同時 1 つ
```

```jsx
<div style={{position:"absolute", inset:0, zIndex:95, display:"flex",
             alignItems:s?"flex-start":"center", justifyContent:"center",
             padding:20, pointerEvents:"none"}}>
  {s ? <button …（折りたたみバー）> : <div role="dialog" style={{pointerEvents:"auto",
        position:"relative", width:"min(920px, 100%)", maxHeight:"min(760px, 100%)",
        display:"flex", flexDirection:"column", border:"1px solid var(--border)",
        borderRadius:8, background:"var(--bg)", boxShadow:"0 20px 60px rgba(0,0,0,0.28)",
        overflow:"hidden", outline:"none"}}>
    <textarea … 1x1 opacity:0 で全キーを捕獲 → onInput で extension_ui_input を送信 />
    <div>拡張パネル見出し / 折りたたみボタン / 閉じるボタン(onClick → "\x03")</div>
    <pre style={{margin:0, padding:14, minHeight:0, overflow:"auto",
                 fontFamily:"var(--font-mono)", fontSize:13, lineHeight:1.45,
                 whiteSpace:"pre"}}>
      <rf text={d.join("\n")}/>
    </pre>
  </div>}
</div>
```

`d` = 描画前の行クリーナ。**ボックス罫線専用行を削除し、行頭/行末の `│`/`┃` を削り、行末空白を除去し、先頭/末尾の空行を落とす。** したがって**枠線を描いても消される**。

届くキー（`r5` 内の変換器）:

```js
if(e.metaKey || (e.ctrlKey&&!e.altKey && "v"===e.key.toLowerCase())) return null;      // paste は別処理
if(e.ctrlKey && !e.altKey){ t=upper(key).charCodeAt(0); if(t>=64&&t<=95) return String.fromCharCode(31&t) }
if(e.altKey && !e.ctrlKey){ if("Backspace"===key) return "\x1b\x7f"; const t=eb[key]; if(t) return t; if(key.length===1) return "\x1b"+key }
return "Enter"===key ? (e.shiftKey?"\n":"\r")
     : "Tab"===key   ? (e.shiftKey?"\x1b[Z":"\t")
     : ey[key] ?? null
```

```js
let ey={ArrowUp:"\x1b[A",ArrowDown:"\x1b[B",ArrowRight:"\x1b[C",ArrowLeft:"\x1b[D",
        Home:"\x1b[H",End:"\x1b[F",Insert:"\x1b[2~",Delete:"\x1b[3~",
        PageUp:"\x1b[5~",PageDown:"\x1b[6~",Escape:"\x1b",Backspace:"…"};
let eb={ArrowLeft:"\x1bb",ArrowRight:"\x1bf",ArrowUp:"\x1bp",ArrowDown:"\x1bn"};   // Alt+矢印
```

- paste は `"\x1b[200~" + text + "\x1b[201~"`（bracketed paste）として届く。
- **閉じるボタンは `"\x03"`（Ctrl+C）を送る。** 拡張はこれを「閉じる」として扱うべき。
- IME 変換中（`isComposing`）は送信されない。`\x1b[7m`（反転）は後述の通り pi-web では無効なので、選択行の強調は `>` マーカー + 太字色で行う。

### 1.5 行バジェットの算定

- 幅: `render(width)` に 92 が来る。クライアントの `<pre>` は `min(920px,100%)`、等幅 13px。92 桁 ≒ 718px で収まる。
- 高さ: `maxHeight: min(760px,100%)`、`fontSize:13px; lineHeight:1.45` → 18.85px/行。見出しバー約 48px、`<pre>` の padding 上下 28px を引くと本文 ≒ 684px ≒ **約 36 行**。
- ただし拡張は実ビューポート高を知りようがない（`render` は width しか受けない）。したがって **設計は「36 行固定の窓」を出す**。`<pre>` は `overflow:auto` なので、はみ出した分はブラウザのスクロールバー / ホイールでも見える（副次的な救済。主経路はキー操作）。

---

## 2. ファイル構成

**単一ファイル `~/.pi/agent/extensions/subagent-viewer.ts` で足りる。**

根拠:
- pi は jiti でその場トランスパイルする（`pi --extension ./x.ts` / `~/.pi/agent/extensions/*.ts` を直接読む）。ビルド工程も `package.json` も要らない。
- 追加ランタイム依存は `node:fs` / `node:path` / `node:os` と `@earendil-works/pi-tui` のみ。後者は jiti の alias / virtualModules で解決される（`loader.js` の `getAliases()` が `@earendil-works/pi-tui` → pi 同梱の `tui/dist/index.js` を張る）。`node_modules` を自前で置く必要はない。
  - **注意:** `~/.pi/agent/extensions/` から素の `require.resolve('@earendil-works/pi-tui')` は **MODULE_NOT_FOUND** になる（実測）。動くのは jiti 経由のみ。したがって実行時 import は必ず `import ... from "@earendil-works/pi-tui"` の形で書き、`require` や動的解決を自前でやらない。
  - 同じ理由で **`pi-subagents` の内部モジュールは import できない**（`require.resolve('pi-subagents')` も MODULE_NOT_FOUND）。パス計算は自前で持つ（§3.1）。
- ディレクトリ分割は「`index.ts` を持つサブディレクトリ」を pi が拡張としても読む、という追加の不確定要素を持ち込む。ここでは分割に見合う複雑さが無い。目安として 1000 行を超えたら分割を再検討する。

推定構成（1 ファイル内のセクション。実装はしないが、#011 が迷わない粒度で並べる）:

```
~/.pi/agent/extensions/subagent-viewer.ts
  A. 定数（TEMP_ROOT 解決、ROWS/COLS、ポーリング間隔、上限値）
  B. temp root / run dir 発見            §3.1
  C. events.jsonl パーサ                §3.3, §3.4
  D. ラン状態キャッシュ（status.json）    §3.2
  E. リングバッファ + 描画（render）      §4
  F. SubagentViewerComponent（handleInput / dispose）
  G. 登録（registerCommand("subview") / 任意で registerCommand("subview-selftest")）
  H. 任意: session_start での短い setStatus
```

**工数見積り:** おおむね 700〜950 行。1 ファイルで妥当。

---

## 3. データソースと発見ロジック

### 3.1 temp root とラン一覧

pi-subagents `src/shared/types.js` の実装（一次ソース）:

```js
export function resolveTempScopeId(options) {
  const env = options?.env ?? process.env;
  const getuid = options && Object.hasOwn(options,"getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;
  for (const key of ["USERNAME","USER","LOGNAME"]) { const value=env[key]; if(value) return `user-${sanitizeTempScopeSegment(value)}`; }
  ... os.userInfo().username → `user-…`
  const homedir = env.USERPROFILE ?? env.HOME; if(homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
  ... os.homedir() → `home-…`
  return "shared";
}
const configuredTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
export const TEMP_ROOT_DIR = configuredTempRoot ? path.resolve(configuredTempRoot)
                           : path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
```

**設計:** 同じ式を再実装する（`PI_SUBAGENTS_TEMP_ROOT` → それ以外は `uid-<getuid()>`、getuid が無い環境のみ user/home/shared フォールバック）。同じ pi プロセス内で動くので `process.env` と `process.getuid()` は pi-subagents 本体と完全に一致する。実測値は `/tmp/pi-subagents-uid-0/async-subagent-runs`。

ラン一覧:

1. `fs.readdirSync(ASYNC_DIR, {withFileTypes:true})`。
2. ディレクトリのみ。名前が `.` で始まるもの（`.active-runs`, `.terminal-runs`, `.deleting-run-*`, `.async-retention.*`）を除外。名前が長すぎる（>255B）ものも除外（pi-subagents 自身の `readStatus` と同じ判定）。
3. 各ディレクトリの `status.json` を読む。**`writeAtomicJson`（tmp に書いて rename）で書かれるので、読者は常に完全な JSON を見る。** それでも `JSON.parse` は try/catch し、失敗時は前回スナップショットを保持する。
4. active / ended:
   - **一次信号:** `<ASYNC_DIR>/.active-runs/<runId>` の存在（0 バイトマーカー）。`updateActiveRunIndex` は `isActiveAsyncState(state)`（`state==="queued"||"running"`）の間だけ作り、終端で `releaseActiveRunIndex` が消す。`terminal-run-index.js` は `.terminal-runs/~sha256-…` に別途最近の終端ランを残す。
   - **二次信号:** `status.json.state`。`AsyncStatus["state"]` の全値は `"queued"|"running"|"complete"|"failed"|"partial"|"paused"|"stopped"|"rejected"`。`queued|running` が active、`async-retention.js` の `TERMINAL_STATES = new Set(["complete","failed","stopped","rejected"])` を終端とみなす。`partial|paused` はどちらでもない（表示は「中断/一時停止」）。
   - **`.active-runs` を優先する理由:** status.json の state は runner 死亡時に `running` のまま残ることがある（`.active-runs` の marker age 側で stale 判定される。`DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS = 24h`）。両方見て、片方でも active なら active として扱い、行に `(stale marker)` を出すのが安全。
5. 既定フィルタ: **active + 直近 24h の終端**、上限 40 行。`a` キーで「全件」に切替（全件時は `lastUpdate`/`startedAt` 降順、さらに上限 200）。
6. 並び順: active 先 → `status.json.lastUpdate ?? startedAt` 降順。
7. 一覧表示に必要な値は全部 `status.json` から取れる（`.state`, `.steps[i].agent`, `.steps[i].turnCount`, `.steps[i].toolCount`, `.steps[i].recentTools`, `.steps[i].tokens`, `.startedAt`, `.lastActivityAt`, `.deadlineAt`, `.timeoutMs`, `.mode`, `.currentStep`, `.chainStepCount`, `.sessionId`, `.cwd`）。**一覧のために events.jsonl を読む必要はない。**

### 3.2 ポーリング周期

| 対象 | 周期 | 取得 |
|---|---|---|
| ラン一覧（ディレクトリ走査 + 全 run の status.json） | 1000 ms | `readdirSync` + `statSync` + `readFileSync`（各ファイル数 KB） |
| 選択中ランの events.jsonl 追記 | 500 ms | `fstatSync` + 差分 `readSync` のみ |
| 描画再送 | 変化時のみ、250 ms でスロットル | `tui.requestRender()` |

**一覧は status.json だけで足りるので、events.jsonl を尾行するのは「選択中の 1 ラン」だけにする。** これが本設計で最も効く刈り込み。同時 8 ランでも読むファイルは status.json × 8 + events.jsonl × 1。

### 3.3 events.jsonl の tail 戦略 — **fs.watch は使わない。バイトオフセットのポーリングにする**

根拠:
- pi-subagents 自身（`src/runs/background/async-job-tracker.js`）は `fs.watch` を使うが、`useNativeWatcher()`（`shouldUseNativeFsWatch`）でゲートし、**必ず setInterval のポーラーを並走させている**（`ensurePoller()`, 既定 `POLL_INTERVAL_MS = 250`）。つまり上流も watcher を信用しきっていない。
- `fs.watch` は Linux tmpfs で重複/合体イベントを出し、監視対象が消えるとエラーを出す。安全に使うにはフォールバックが要り、結局ポーリングを併設することになる。**なら最初からポーリングだけにする。**（ポニーテール: まずポーリング。実測でアイドル CPU が問題になったら fs.watch を「早起きのヒント」として足す）
- 2.5MB 級の成長ファイルでも、`statSync` 1 回/500ms + 追記バイト分の `readSync` だけなので定常コストは極小。

カーソル管理（**run ごとに 1 つ**。events.jsonl は run ディレクトリ単位で 1 ファイル、step は `subagentStepIndex` で区別）:

```
type Cursor = { offset: number; remainder: Buffer }
```

読み出し手順（毎ティック）:

1. `fd = openSync(eventsPath, "r")`（選択が変わったら閉じて開き直す。ENOENT は握って「成果物なし」状態へ）。
2. `stat = fstatSync(fd)`。
3. `if (stat.size < cursor.offset) { cursor = {offset:0, remainder: empty} }` ← ローテート/再生成の防御。
4. `if (stat.size === cursor.offset && cursor.remainder.length === 0) return []`。
5. `len = stat.size - cursor.offset; buf = Buffer.allocUnsafe(len); n = readSync(fd, buf, 0, len, cursor.offset); cursor.offset += n;`
6. `const joined = Buffer.concat([cursor.remainder, buf.subarray(0, n)])`
7. **最後の `\n`（0x0A）を探して分割する。** `idx = joined.lastIndexOf(0x0A)`。`idx < 0` なら `cursor.remainder = joined` として何も出さない（行がまだ完成していない）。
8. `const text = joined.subarray(0, idx).toString("utf8")`（`idx` は改行位置なので末尾に改行を含めず、`split("\n")` で行配列に）。`cursor.remainder = joined.subarray(idx + 1)`（= Buffer のまま保持）。
9. 各行を `JSON.parse`。失敗行は**捨ててログに残す**（§3.4 の寛容性）。

**Buffer のまま remainder を持つ理由:** 文字列で持つと、書き込みが UTF-8 の途中で切れた瞬間に壊れた文字が確定してしまう。日本語の thinking が普通に来るので、ここは妥協しない。pi-subagents 自身の tracker は `cursor-1` バイトを読んで「行頭から始まっているか」だけを見ており、多バイト境界は見ていない。我々はそこまでやる。

**初回オープンの扱い:**

- `stat.size <= INITIAL_FULL_READ_BYTES (4 MiB)` なら `offset = 0` から読む（= 全文）。
- それ以上なら `offset = stat.size - INITIAL_TAIL_BYTES (2 MiB)` に置き、**その位置の直後の最初の `\n` まで読み飛ばす**（途中行を捨てる）。古い終端ランを開いたときに 2.5MB を一気にパースしないため。
- どちらの場合も、リングバッファ側で古い方を落とすのでメモリは一定。

### 3.4 ランなし / 成果物なしの判定

- `ASYNC_DIR` が存在しない: 「pi-subagents 未導入、または `PI_SUBAGENTS_TEMP_ROOT` が違う」として、**解決した root パスを画面に出す**。黙って空にしない。
- ラン 0 件: 同様に root を出し、加えて「foreground 実行は親プロセス内で走るのでラン ディレクトリを残さない。`background:true` の実行だけが対象」と 1 行で説明する。

---

## 4. オーバーレイ UX 仕様

### 4.1 起動

```
/subview            # オーバーレイを開く（active + 直近 24h を表示）
/subview <runId>    # 指定ランを選択状態で開く（前方一致 8 桁まで許可）
/subview-selftest [runDir]   # パーサ自己診断（§7.2）。オーバーレイは開かない
```

登録（`extensions.md` と `types.d.ts` の一次ソース）:

```ts
pi.registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void
interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```

`custom()` の正確なシグネチャ（`dist/core/extensions/types.d.ts`）:

```ts
custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void)
          => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
       options?: {
         overlay?: boolean;
         /** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
         overlayOptions?: OverlayOptions | (() => OverlayOptions);
         /** Called with the overlay handle after the overlay is shown. Use to control visibility. */
         onHandle?: (handle: OverlayHandle) => void;
       }): Promise<T>;
```

呼び出し方（pi-web での実効値つき）:

```ts
await ctx.ui.custom<undefined>(
  (tui, _theme, _keybindings, done) => new SubagentViewerComponent(tui, done, opts),
  { overlay: true, overlayOptions: { width: 92 } }
);
```

- `overlay: true` は pi-web では効かない（常にオーバーレイ表示）が、他ホスト互換のため付ける。
- `width: 92` は既定値と同じだが、意図を明示するために書く。広げたい場合のみ `140` まで許可。
- **`ctx.mode === "tui"` ガードは禁止。** 代わりに `typeof ctx.ui.custom !== "function"` なら `ctx.ui.notify("このホストはカスタム UI 非対応", "warning")` して抜ける。
- `RegisterCommand.handler` は `ExtensionCommandContext`。`custom()` の reject（`extensionUiAbortController` による中断）を catch して `ctx.ui.notify` に落とす。
- 拡張の factory では**タイマーも fd も作らない**（`extensions.md`: "Do not start processes, sockets, watchers, or timers in the factory"）。起動はコマンドハンドラ内で行い、`dispose()` で確実に止める。

pi-web での実際の見え方:

1. チャット領域の上に `position:absolute; inset:0; zIndex:95` のレイヤが乗る。
2. 中身は `role="dialog"` の箱。幅 `min(920px,100%)`、最大高 `min(760px,100%)`、角丸 8、影付き、中央寄せ。
3. pi-web 自身が「Extension Panel」という見出しバーと、折りたたみボタン・**閉じるボタン（クリックで `\x03` を送る）** を付ける。
4. その下に等幅 13px の `<pre>` があり、拡張が返した ANSI 行が縦に並ぶ。
5. キーは非表示 1×1 textarea が全取りする。**マウスホイールでの `<pre>` スクロールはブラウザ任せで効く**（主経路はキー）。

### 4.2 画面レイアウト（92 桁 × 36 行）

```
行 0        ヘッダ:  subagent-viewer  2 runs (1 active)  root:/tmp/pi-subagents-uid-0
行 1        キー凡例: [q]close [j/k]run [J/K]scroll [space]follow [t]thinking [x]tools [a]all [i]info [r]reload
行 2        ────────────────────────────────────────────────────────────────────────────
行 3..11    ラン一覧（最大 9 行。カーソル行は ">" + 反転の代わりに太字色）
行 12       ────────────────────────────────────────────────────────────────────────────
行 13       STREAM  04e81279 · Plan · running · turn 29 · tools 44 · 179s · follow:ON · +312 lines
行 14..35   ストリーム本体（22 行）
```

ラン一覧 1 行の書式（固定幅・94 を超えないよう `truncateToWidth`）:

```
> ● 04e81279  Plan          running   t29/t44   step 1/1   ↓99.9k/1.0M   2m59s
  ○ 57c4df9d  builder #011  complete  t12/t31   step 1/1   ↓44.1k        41s
```

- 先頭 `>` = カーソル（`\x1b[7m` は使わない）。
- `●` = active、`○` = 終端、`◌` = partial/paused、`▲` = stale active marker。
- agent 名は budget に合わせ `truncateToWidth`。task/sessionName は `i` パネルに回す。
- 12 桁以上の runId は 8 桁に短縮し、衝突時のみ 12 桁に伸ばす。

ストリーム 1 行の書式（kind ごと）:

```
▸ thinking  ユーザーは pi-web をパッチしたくないと言っている。ならば口は custom() だけ…
  ┊ tool    bash({"command":"ls /tmp/pi-subagents-uid-0/…"})
  ⎿ result  MCP-Hub/ pac-unify/ probe/ research/ …   [1531 chars]
  ✎ text    I'll start by reading the required documentation…
```

### 4.3 キー操作（受け取るバイト列は §1.4 の実測テーブル）

| キー | 生バイト | 動作 |
|---|---|---|
| `j` / `↓` | `"j"` / `"\x1b[B"` | 次のラン |
| `k` / `↑` | `"k"` / `"\x1b[A"` | 前のラン |
| `J` / `PgDn` | `"J"` / `"\x1b[6~"` | ストリーム 1 行下 |
| `K` / `PgUp` | `"K"` / `"\x1b[5~"` | ストリーム 1 行上 |
| `g` / `G` | | バッファ先頭 / 末尾（末尾 = follow ON） |
| `space` | `" "` | follow の ON/OFF（既定 ON。手で上へ動かしたら自動で OFF にしてよい） |
| `t` | | thinking 行の表示切替（既定 ON） |
| `x` | | toolCall / toolResult 行の表示切替（既定 ON。`tt` 相当の「thinking だけ」も `t`+`x` の組合せで作れる） |
| `a` | | 「active + 24h」⇄「全件」 |
| `i` | | info パネル（model / thinking level / tokens / deadline / sessionFile / transcriptPath / cwd / 最終エラー） |
| `r` | | 全キャッシュ破棄して読み直し（カーソルも 0 に戻す） |
| `q` / `Esc` / Ctrl+C | `"q"` / `"\x1b"` / `"\x03"` | `done(undefined)` → 閉じる |
| `Tab` / `Shift+Tab` | `"\t"` / `"\x1b[Z"` | partial/paused のランと active の間でカーソルをジャンプ（任意） |

- **Backspace に依存しない**（pi-web のマップ値は `""` 相当で不明瞭）。
- 実装は `matchesKey` / `Key`（`@earendil-works/pi-tui` の `dist/keys.d.ts: export declare function matchesKey(data: string, keyId: KeyId): boolean`, `dist/keys.d.ts: export declare const Key: {...}`）を使う。生バイト表と一致することを実測済みなので `matchesKey(data, Key.up)` 等がそのまま機能する。
- 文字幅の正規化は必ず `@earendil-works/pi-tui` の `visibleWidth(str)` / `truncateToWidth(text, maxWidth, ellipsis?, pad?)` / `wrapTextWithAnsi(text, width): string[]` / `sliceByColumn(line, startCol, length, strict?)`（`dist/utils.d.ts:16,48,78,83`）で行う。**自前で `length` を数えない**（日本語の thinking が普通に来る）。

### 4.4 色（ANSI）の設計 — pi-web のレンダラに合わせる

pi-web の ANSI 変換は `ansi-to-html`（バンドル内 `9445-fde6feabcb39142c.js` の `ansi_to_html` / `process_ansi`）。対応 SGR は実測で:

- 対応: `0`(reset), `1`(bold), `2`(faint), `3`(italic), `4`(underline), `21`, `22`, `23`, `24`, `39`(fg reset), `49`(bg reset), `30-37`(fg), `40-47`(bg), `90-97`(fg bright), `100-107`(bg bright), `38;5;N`/`48;5;N`(256 色), `38;2;R;G;B`/`48;2;R;G;B`(24bit)。OSC 8 ハイパーリンクも可。
- **非対応（無視される）: `7`(反転), `5`(点滅), `9`(打ち消し), `53`(上線) など。** 解析は `"1;31"` を `;` で分割する素朴な方式なので、`\x1b[1;36m` も `\x1b[38;5;208m` も通る。

したがって:

- `\x1b[7m` は**使わない**。選択強調は `\x1b[1;36m`（bold cyan）+ 先頭 `>` マーカー。
- thinking 本文は無装飾（地の `var(--text)`）、thinking ラベル `▸ thinking` を `\x1b[2m`（faint）か `\x1b[35m`。
- toolCall は `\x1b[33m`、toolResult は `\x1b[2m`、エラーは `\x1b[31m`、active は `\x1b[32m`、終端は `\x1b[2m`。
- **行末で必ず `\x1b[0m` を打つ。** pi-web は行ごとにスタイルをリセットすると保証していない（`tui.md` は「Pi resets styling after every line」と言うが、それは本家 TUI の話。pi-web 側は `ansi-to-html` が行を跨いで状態を持ち越さない作りなので実害は薄いが、明示リセットは無害で保険になる）。
- `theme` 引数は**使わない**（pi-web では恒等関数。本家 TUI では使われるので、`theme.fg(...)` を呼ぶより直書きの方が両方で安定する。ここは「ホストに合わせて潰す」判断）。

### 4.5 再描画のスロットル

pi-web の `emitCustomUiRender` は `tui.requestRender()` のたびに無条件で `extension_ui_request` を発行する（SSE/HTTP でブラウザまで届く）。500ms ポーリング + 1 行追記ごとに送ると無駄が出る。

- コンポーネント内に `dirty` フラグと `lastEmitAt` を持つ。
- ポーリングでリングバッファが変化したら `dirty = true`。
- `lastEmitAt` から 250ms 未満なら `setTimeout` で 1 回だけ遅延送信、以上なら即 `tui.requestRender()`。
- さらに `render(width)` の結果（`join("\n")`）を前回と比較し、同文字列なら送らない。**これが一番効く。**

---

## 5. events.jsonl パーサ仕様

### 5.1 レコード一覧（実測した出現型と件数例）

1 ラン（`04e81279…`, 423 行時点）の内訳:

```
tool_execution_update: 114   message_start: 77   message_end: 77
tool_execution_start: 47     tool_execution_end: 45
turn_start: 30               turn_end: 29
subagent.run.started: 1      subagent.step.started: 1
session_info_changed: 1      agent_start: 1
```

`message_start` / `message_end` の role 内訳:

```
48 ('message_start','toolResult',('text',))   48 ('message_end','toolResult',('text',))
29 ('message_start','assistant',('thinking',)) 26 ('message_end','assistant',('thinking','toolCall'))
 3 ('message_end','assistant',('text','thinking','toolCall'))
 2 ('message_start','assistant',('toolCall',))  2 ('message_end','assistant',('toolCall',))
 1 ('message_start','system',('str',))          1 ('message_end','system',('str',))
 1 ('message_start','user',('text',))           1 ('message_end','user',('text',))
 1 ('message_end','assistant',('text','toolCall'))
```

### 5.2 各 case の扱い

| `type` | 判定 | 動作 |
|---|---|---|
| `message_end` / `role==="system"` | | **必ず無視。** `message.content` は文字列で、**システムプロンプト全文（数 KB〜数十 KB）**が入る。ここを拾うと表示が壊れる |
| `message_end` / `role==="user"` | | 最初の 1 件だけ `kind:"task"` として保持（子の task 全文）。以降は無視 |
| `message_end` / `role==="assistant"` | `message.content[]` を順に走査 | 下記 |
| `message_end` / `role==="toolResult"` | `message.toolCallId` / `message.toolName` / `message.content[]` / `message.isError` | `kind:"toolResult"` |
| `message_start` | | **内容は使わない。** assistant の thinking は部分スナップショット（実測で 1〜33 文字）しか入らない。`{kind:"activity", at: observedAt}` として「今 thinking 中」の表示にだけ使う（任意） |
| `tool_execution_start` | `toolCallId` / `toolName` / `args` | **無視**（`message_end` の `toolCall` と重複するため）。どうしても早期表示したければ `kind:"toolCall"` をここで出し、`message_end` 側の `toolCall` を抑制する（どちらか一方に統一） |
| `tool_execution_update` | `partialResult`（実測では `{content:[]}` が多く空） | **無視**（トークン差分の代替にならない） |
| `tool_execution_end` | `toolCallId` / `toolName` / `result.content[]` / `isError` | `kind:"toolResult"` の第 2 候補。**`message_end` の `toolResult` と重複**するので、**どちらか一方だけを採用**する（推奨: `message_end` 側。順序が thinking と揃い、`message_end` の方が 1 件多い実測がある） |
| `turn_start` / `turn_end` | | メタ更新のみ（ターン数、`turn_end.message` は `message_end` と重複するので内容は使わない） |
| `agent_start` | | メタ更新（child セッション開始時刻） |
| `subagent.run.started` | `ts` / `mode` / `cwd` / `pid` | メタ |
| `subagent.step.started` | `ts` / `stepIndex` / `agent` | **`stepIndex` → agent 名の対応表**を作る。以降の child 系レコードの `subagentStepIndex` をこの表で agent 名に解決する |
| `session_info_changed` | `name` / `subagentRunId` / `subagentStepIndex` / `subagentAgent` | メタ（sessionName を info パネルに出す） |
| `subagent.run.process_terminal` | `processTerminal` | 「プロセス終了の証明が立った」マーカー。行に `(process terminal: observed)` を出す |
| 不明な `type` | | **黙って無視**（前方互換） |

### 5.3 assistant `message_end` の content 展開

```ts
for (const part of message.content ?? []) {
  switch (part.type) {
    case "thinking":                                     // 実測: 1 メッセージにつき 1 ブロック、全文
      if (part.thinking?.trim()) push({kind:"thinking", text: part.thinking, ...});
      break;
    case "text":
      if (part.text?.trim()) push({kind:"text", text: part.text, ...});
      break;
    case "toolCall":                                     // id / name / arguments
      push({kind:"toolCall", tool: part.name, callId: part.id, args: preview(part.arguments), ...});
      break;
  }
}
```

実測で確認した形（`message_end`, assistant）:

```
[0] thinking len=62    sig=reasoning_content
[1] toolCall name=bash id=call_00_mj7cn8fkgmmh2sqcy3w31n13
[2] toolCall name=bash id=call_01_6znsau9zrx73d1r620kmg5eu
```

```
[0] thinking len=298   sig=reasoning_content
[1] text len=116
[2] toolCall name=bash id=call_00_p4qlgg04vwm9vlyexzlx3st1
[3] toolCall name=bash id=call_01_bldz74j9b2hhd0c5zo1sdcku
```

- **thinking の全長実測: 62 / 298 / 114 / 141 / 428 / 125 / 565 / 381 / 211 / 379 / 415 / 176 / 312 / 614 / 1624 / 423 / 2855 / 110 / 837 / 212 / 871 / 450 / 247 / 1593 / 3145 …**（1 メッセージあたり最大 3145 文字を確認）。`message_start` 側は 1〜33 文字しか無い。
- 1 つの assistant `message_end` に **toolCall が 2 個**並ぶことがある（並列ツール呼び出し）。1 行 1 ツールとして展開する。

### 5.4 toolResult の抽出と短縮

実測した `toolResult` message の形:

```json
{"role":"toolResult","toolCallId":"call_00_ut262f9tkbfkmqggbe3gxh53","toolName":"bash",
 "content":[{"type":"text","text":"…1531 chars…"}],"isError":false,"timestamp":1790371681327}
```

実測した `tool_execution_end` の形:

```json
{"type":"tool_execution_end","toolCallId":"call_00_…","toolName":"bash",
 "result":{"content":[{"type":"text","text":"…"}]},"isError":false,
 "subagentSource":"child","subagentRunId":"04e81279-…","subagentStepIndex":0,"subagentAgent":"Plan","observedAt":1790371680243}
```

仕様:

```
text = (message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n")
isError = message.isError === true
短縮:
  1. 改行を " ↵ " に潰す（1 エントリ = 原則 1 行。折り返しは描画側の wrapTextWithAnsi に任せる）
  2. TOOL_RESULT_MAX_CHARS = 400 で切る（要件「短い toolResult」）
  3. 切った場合は末尾に ` …[1531 chars]` を付ける（超えた分の正確な文字数を出す）
  4. 行そのものは描画時に truncateToWidth(line, 92)
toolCall の args プレビュー:
  1. JSON.stringify(part.arguments) を 1 行に
  2. TOOL_ARGS_MAX_CHARS = 160 で切る
toolCall → toolResult の対応は toolCallId で引く（行の色/ラベル用。対応が取れなくても表示は続ける）
```

### 5.5 副作用系・注意

- **`message_update` は events.jsonl に書かれない。**
  `src/runs/background/run-child-session.js:14`:
  ```js
  /** Events the child emits while the model streams; not persisted into the diagnostic log. */
  function shouldPersistChildEvent(event) { return event.type !== "message_update"; }
  ```
  さらに `projectChildSessionEventForJson` も `message_update` の場合は `partial` を落とす作り。**トークン単位の thinking ストリームは取得不能。**（§0-3）
- `output-<index>.log` には assistant の **text** とツール出力が行で入る（実測 3614 行 / 115KB）。**thinking は入らない。** `status.json.steps[i].recentOutput` はその末尾数件（実測 4 件）。
- child `session.jsonl`（`status.json.steps[i].sessionFile`）にも thinking はあるが、**セッション追記の境界 = `message_end` と同じ粒度**なので、events.jsonl を読むより情報が増えない。**読まない**（読む対象を 1 つに絞る）。
- レコードの重複を実測で 3 件確認（`message_start`/`message_end` の toolResult が `observedAt` まで同じ）。**同一 `(type, observedAt, role, content hash)` の連続重複は捨てる**防御を入れる（安価で、二重表示を防ぐ）。

---

## 6. エッジケース

| 状況 | 挙動 |
|---|---|
| ラン 0 件 | 画面に「no async subagent runs」+ 解決した `TEMP_ROOT_DIR` + 「foreground 実行はディレクトリを残さない」の 1 行説明。`/subview` 自体は開ける |
| pi-subagents 未導入 / `ASYNC_DIR` 無し | 同上。パスを必ず表示（ユーザーが `PI_SUBAGENTS_TEMP_ROOT` を疑えるように） |
| `PI_SUBAGENTS_TEMP_ROOT` が環境に設定済み | `path.resolve` してそのまま使う。pi 本体と同じ環境なので一致する |
| 終了済みランの閲覧 | 完全に読める。カーソルは進まない。`state` を `complete/failed/stopped/rejected/partial/paused` で表示。4 MiB 以下なら初回に全文、超えるなら末尾 2 MiB から |
| 複数同時ラン | 一覧に全部出る。**events.jsonl を尾行するのは選択中の 1 つだけ**。一覧の数値は status.json から（1000ms） |
| ネストした subagent（`isNested` / `workflowChildren`） | 一覧では `↳` を付けて親の下に並べる（`status.isNested===true` または `parentWorkflowRunId`）。深さは 2 まで。それ以上は info パネルに `workflowChildren` の件数だけ出す |
| ラン ディレクトリが消える（retention 30 日 / 手動 rm） | `readdir` から消える → 一覧から落とす。選択中だった場合は隣へ移る。選択中ランの events 読みが `ENOENT` → 画面に `[run artifacts deleted]` を出し、リングバッファの内容は残して読める状態を保つ。例外は投げない |
| status.json が壊れている / 読めない | 前回スナップショットを維持し、行に `!status unreadable` を出す。クラッシュしない |
| `.active-runs/<id>` はあるが status が終端で 24h 以上経過 | `▲ stale` として表示（`DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS = 24h` に合わせる） |
| events.jsonl が 0 バイト / 途中で切れている | remainder 方式で安全。内容が無い間はストリーム欄に `waiting for events…` |
| 巨大な 1 thinking ブロック（数千文字） | 描画側で `wrapTextWithAnsi`（幅 88 程度）し、**1 エントリあたり最大 200 行**までに制限。超過は `… (truncated for display)` を付ける。バッファは全文を保持するので `G`/`K` で遡れば読める |
| メモリ | リングバッファ: 1 ランあたり `MAX_BUFFER_ENTRIES = 4000` 件、かつ `MAX_BUFFER_BYTES = 8 MiB`。超えたら**古い方から捨てる**（最新の thinking 全文は常に残る）。選択中ラン以外はリングを持たない |
| session 終了 / `extensionUiAbortController` による reject | `custom()` の reject を catch。`dispose()` は必ず呼ばれる前提だが、`dispose()` を冪等に書く（タイマー clear、fd close を try/catch で二重実行安全に） |
| アイドル CPU（オーバーレイを開いたまま放置） | 500ms × (fstat 1 + 追記分 read) + 1000ms × (readdir + status.json × N)。数十 µs/回。実測で問題になったらポーリング間隔を 1s/2s に落とす（定数化しておく） |
| Windows | 対象外（この環境は Linux）。`resolveTempScopeId` の getuid 無しフォールバックだけは写す |
| `/tmp` の systemd-tmpfiles による削除 | ラン ディレクトリ消失と同じ扱い。「artifacts deleted」表示 |

---

## 7. テスト計画

### 7.1 ロード確認（実装後）

1. `pi --extension ~/.pi/agent/extensions/subagent-viewer.ts` を空ディレクトリで起動し、拡張ロードエラー（`extension_error`）が出ないこと、`/subview` がコマンド一覧に出ることを確認する。
2. pi-web のセッションで `/reload` し、pi の stderr ログ（`runner.stderr.log` ではなく pi 本体のログ）に `subagent-viewer` のロード失敗が無いことを確認する。
3. **factory 内でタイマー/fd を作っていないこと**をコードで確認（`session_start` でも作らない）。生成はコマンドハンドラ内のみ。

### 7.2 パーサ自己診断（残すべき 1 つの実行可能チェック）

`/subview-selftest` コマンドを拡張内に置く。オーバーレイを開かず、指定または最新の runDir に対して以下を assert し、結果を `ctx.ui.notify` と `pi.sendMessage` の片方で出す（フレームワーク不要・その場で走る）。

1. `message_end` / `role==="system"` が **0 件**バッファに取り込まれていること（システムプロンプト全文が混入しない）。
2. assistant `message_end` ごとに thinking エントリが 1 件あること。**取り込んだ thinking の文字数が、生 JSON の `part.thinking.length` と完全一致**すること（全文性の証明）。
3. すべての `toolCall` エントリの `callId` に対応する `toolResult` が存在すること（対応表が機能していること）。対応しないものは件数だけ報告。
4. **切り詰め耐性:** ファイル末尾を (a) 改行の直前で切った Buffer、(b) 日本語の途中バイトで切った Buffer の 2 通りで読み込み、どちらも「完成した行だけをパースした件数」に一致すること。remainder 実装が多バイトを壊さないことの直接検証。
5. 総エントリ数・種類別件数・最大 thinking 文字数を表示（人間が目視できる形）。

このチェックは `events.jsonl` を**読み取り専用**で触るだけで、副作用を持たない。

### 7.3 ライブ E2E（pi-web 実機）

前提: pi-web を起動し、pi-subagents が有効なセッションで操作する。

1. **子を 1 体走らせる。** pi に「background で 1 体サブエージェントを走らせて、thinking を多めに吐くタスク（例: ドキュメントを 2 ファイル読んで設計メモを書く）を依頼」させる。
2. **ラン ディレクトリの存在確認（別端末）:**
   ```bash
   R=$(ls -dt /tmp/pi-subagents-uid-0/async-subagent-runs/*/ | head -1)
   ls -la "$R"; ls /tmp/pi-subagents-uid-0/async-subagent-runs/.active-runs
   ```
   `.active-runs/<runId>` が存在し、`status.json` の `state` が `running` であること。
3. **`/subview` を pi-web で実行。** 中央に角丸の箱が出て、ヘッダにラン数、一覧に `● …running` が出ること。**1 秒以内に turn 数が増えること**（status.json 追従の確認）。
4. **thinking の一致検証:**
   ```bash
   python3 - "$R/events.jsonl" <<'PY'
   import json,sys
   last=None
   for l in open(sys.argv[1]):
       try:o=json.loads(l)
       except:continue
       if o.get("type")=="message_end" and o["message"]["role"]=="assistant":
           for p in o["message"]["content"]:
               if p.get("type")=="thinking" and p.get("thinking","").strip(): last=p["thinking"]
   print(len(last)); print(last[:400])
   PY
   ```
   画面の最後の thinking 行と**文字数・先頭部分が一致**すること。
5. **遅延の確認:** 子が 1 メッセージを終えたあと、`events.jsonl` の mtime 更新から **1.0 秒以内**に画面に反映されること（500ms ポーリング + 250ms スロットルの合計上限）。
6. **toolResult の短縮確認:** 画面の result 行が 400 文字以内 + `…[N chars]` 表示になっていること。
7. **キー操作:** `j`/`k` でラン選択、`t` で thinking 行の消滅/復活、`x` で tool 行の消滅/復活、`space` で follow の ON/OFF、`J`/`K` でスクロール、`i` で info、`r` で再読込、`q` で閉じてチャット領域が戻ること。**pi-web の見出しバーの「閉じる」ボタンでも閉じること**（`\x03` 経路）。
8. **終了後の閲覧:** 子が完了 → `state: complete` に変わり、行の色が終端に変わり、ストリームが読めること。
9. **古い終端ラン:** `a` で全件表示 → 数日前のランを選択 → 初回描画が 200ms 以内、`g` で遡ると「buffer start (N entries evicted)」の境界行が出ること。
10. **消失耐性:** オーバーレイを開いたまま `rm -rf "$R"` → クラッシュせず `[run artifacts deleted]` に変わること。
11. **未導入シミュレーション:** `PI_SUBAGENTS_TEMP_ROOT=/tmp/does-not-exist` で pi を再起動 → `/subview` が開き、パス付きの「not found」メッセージが出ること。

### 7.4 pi-web 固有の確認（パッチしない方針のため、確認であって修正しない）

1. **オーバーレイは 1 つだけ:** `/subagents-fleet` を開いてから `/subview` を開く。2 つ目が表示を奪い、1 つ目はサーバ側に生き残るはず。**実測して記録する**（未確定事項 §8 に上げる）。
2. **幅:** `overlayOptions: { width: 40 }` / `{ width: 140 }` を渡すと描画列数が変わること（clamp の確認）。
3. **テーマが恒等であること:** 一時的に `theme.accent("X")` を出力し `X` がそのまま出ることを確認（＝色は自前 ANSI が正しいという根拠）。
4. **`\x1b[7m` が効かないこと:** 反転を使わない設計の妥当性確認。もし将来 `ansi-to-html` が更新されたら、ここが変わる。

### 7.5 回帰を守るチェック（実装に残す 1 つ）

上記 7.2 の `/subview-selftest` がそれに当たる。**フレームワークもフィクスチャも置かない。** ディスク上に実在する run の `events.jsonl` を入力にするので、固定フィクスチャは不要。

---

## 8. 未確定 / リスク

### 8.1 実装前に確定させるべき未確認事項

1. **`OverlayOptions` の正確な型**（`@earendil-works/pi-tui` の `OverlayOptions`）。pi-web が参照するのは `width` のみと実測したが、型としては `anchor` / `maxHeight` / `margin` 等を持つ。`import type { OverlayOptions } from "@earendil-works/pi-tui"` で取れるか、`width` が `number` であることを実装時に型で確認する。
2. **pi-web のキーマップ `ey.Backspace` の実値**。バンドル表示が `""` に見えたが制御文字が潰れている可能性がある。**Backspace に機能を割り当てない**ことで回避する設計にしてある。割り当てたくなったら実機で `handleInput` の生バイトをログして確認する。
3. **`overlay: true` を渡さなかった場合の pi-web 挙動。** `getCustomUiWidth` は `overlayOptions` の有無しか見ないので差は無いはずだが、実機で両方試す。
4. **`notify` / `sendMessage` がオーバーレイ表示中に使えるか。** 自己診断の結果表示に使う。オーバーレイ中でも届くはずだが未確認。
5. **同時実行の上限**: `MAX_CONCURRENCY = 4`（pi-subagents 側）だが、run ディレクトリ数はもっと多い。一覧上限 40 が UX として妥当かは実機で見る。

### 8.2 リスク（設計で吸収しきれないもの）

| リスク | 影響 | 対処 |
|---|---|---|
| **トークン単位の thinking ストリームが原理的に不可**（`message_update` 非永続） | 「組み込み Agent のような視認性」は 1 メッセージ粒度止まり | 要件を満たす範囲を §0-3 で明示。真の token ストリームが必要なら pi-subagents 側に `message_update` を残させる必要があり、これは「pi-web をパッチしない」方針とは別の追加変更になる（**要ユーザー判断**） |
| pi-web のオーバーレイは同時 1 つ | `/subagents-fleet` 等と同時に開けない | 排他であることを受容。`/subview` を開く前に他を閉じる運用 |
| pi-web の内部実装（サーバチャンク）に依存 | pi-web の version up で `getCustomUiWidth` / ANSI 対応 / キー変換が変わり得る | pi-web 側の変更点は 3 つ（`custom` の実装・ANSI 対応・キー変換）。拡張側では「width は 92 前提、生 ANSI は最小限の SGR のみ、キーは `matchesKey` 経由」に留めて影響面を狭める。version を README コメントに記録する |
| `PI_SUBAGENTS_TEMP_ROOT` を pi-web 側だけ変えた場合 | パス不一致でランが見えない | 同じ pi プロセスなので `process.env` は一致する。ただし pi-web が pi を spawn するときの env 継承に依存する（実測では一致）。画面に解決パスを出すことで診断可能にする |
| `/tmp` が別マウント・tmpfs 上限 | ラン ディレクトリ消失 | §6 の消失経路で吸収 |
| events.jsonl のスキーマは versioned でない（`lifecycleArtifactVersion: 3` はある） | pi-subagents の version up でフィールドが変わり得る | 不明 `type` は無視、未知フィールドは無視（前方互換）。`lifecycleArtifactVersion !== 3` のときは画面に警告を 1 行出す |
| 大幅な thinking（実測最大 3145 文字 / 1 メッセージ）が連続する長い run | リングバッファ・描画コスト | `MAX_BUFFER_BYTES = 8 MiB`、1 エントリ描画 200 行上限で吸収 |
| レコード重複（実測 3 件） | 二重表示 | `(type, observedAt, role, content hash)` の連続重複除去 |
| pi の `--extension` 無しの `~/.pi/agent/extensions/` 直接ロードで `@earendil-works/pi-tui` の実行時解決が失敗する可能性 | 拡張全体がロード失敗 | jiti の alias / virtualModules で解決されることを実測済み（`loader.js: getAliases()`）。もし失敗する環境では、`visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi` の最小自前実装（ANSI を剥がして `Intl.Segmenter` で幅を数える）にフォールバックする余地を残す |
| ポーリングのアイドルコスト | pi プロセスが長時間オーバーレイを開いたまま | 定数で周期を上げられるようにする。`dispose()` でタイマー全停止を冪等に保証 |

### 8.3 却下した代替案（と理由）

1. **`/subagents-inspect-rpc` + `action:"status"` を使う** — 却下。thinking を落とす（要件の中核が取れない）。加えて RPC 応答は `subagent-inspect` ウィジェットに 1 行で出るだけで、pi-web ではタブになる。
2. **`setWidget` に thinking を流す** — 却下。タブを増やすだけで、常時見えない（§1.3）。ユーザーの現状不満の再生産。
3. **child `session.jsonl` を読む** — 却下。粒度が `message_end` と同じで情報が増えず、読む対象が増えるだけ。
4. **`output-<index>.log` を読む** — 補助としてのみ。thinking は入らない（text とツール出力のみ）。`recentOutput` の代用にはなるが必須ではない。
5. **`fs.watch` で events.jsonl を尾行** — 却下。上流自身がポーラーを併設している。まずポーリング。
6. **複数ファイル分割 / `package.json` 同梱** — 却下（§2）。1 ファイルで足りる。
7. **`theme` ヘルパで色付け** — 却下。pi-web では恒等関数（§1.2）。
8. **`\x1b[7m` で選択行を反転** — 却下。pi-web の ANSI レンダラが非対応（§4.4）。
9. **`ctx.mode === "tui"` ガード** — 却下。pi-web は `mode:"rpc"` で `custom()` が動く（§1.2）。
10. **`ctx.ui.setStatus` でヘッダに常時サマリ** — 任意。害はないが要件外なので既定 off。`setStatus` は pi-web のウィジェット棚の近くに出る（タブの一種ではない）。必要になったら 1 行追加。

---

## 9. 参照した一次ソース（すべて実測パス付き）

- `/root/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — 拡張の登録方法、`ctx.ui`、mode ガード
- 同 `docs/tui.md` — `ctx.ui.custom` と component/overlay、`visibleWidth` 等の推奨
- 同 `docs/rpc-extension-ui.md` — `setWidget`/`custom` の RPC 仕様（「RPC では `custom()` は `undefined` を返す」と書かれているが、**これは素の RPC モードの説明であり pi-web には当てはまらない**。pi-web は自前の `ExtensionUIContext` を差し込み、`custom` を実装している）
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ExtensionUIContext.custom` / `setWidget` / `RegisteredCommand` / `ExtensionContext.mode`
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` — `getAliases()`（`@earendil-works/pi-tui` の jiti alias）
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/virtual-modules.js` — `VIRTUAL_MODULES`
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-tui/dist/keys.d.ts` — `matchesKey`, `Key`
- 同 `dist/utils.d.ts` — `visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`, `sliceByColumn`
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/.next/server/chunks/6429.js` — pi-web の `ExtensionUIContext` 実装（`custom` / `setWidget` / null theme / `mode:"rpc"`）
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/.next/static/chunks/app/page-b5a19d562a153b66.js` — オーバーレイ（`zIndex:95`）とウィジェット棚の描画、キー変換テーブル
- `/root/.npm-global/lib/node_modules/@agegr/pi-web/.next/static/chunks/9445-fde6feabcb39142c.js` — `ansi-to-html` の `process_ansi`（対応 SGR の確定）
- `/root/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md` — run の場所・FleetView・inspect RPC
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/shared/types.js` — `resolveTempScopeId`, `TEMP_ROOT_DIR`, `ASYNC_DIR`, `WIDGET_KEY = "subagent-async"`
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/shared/types.d.ts` — `AsyncStatus`（`state` の全値）
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/active-run-index.js` — `.active-runs`, `isActiveAsyncState`, `DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS = 24h`
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/terminal-run-index.js` — `.terminal-runs`
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js` — `shouldPersistChildEvent`（`message_update` を捨てる）
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-job-tracker.js` — fs.watch + poller 併用、`controlEventCursor` の読み方
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/shared/atomic-json.js` — `writeAtomicJson`（status.json は tmp+rename）
- `/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-retention.js` — `ASYNC_RETENTION_DAYS = 30`, `TERMINAL_STATES`
- 実データ: `/tmp/pi-subagents-uid-0/async-subagent-runs/04e81279-eb63-41a7-97f7-87515a14877e/` の `status.json` / `events.jsonl` / `output-0.log`
- 書式の実例: `/root/.pi/agent/extensions/codegraph-autoinit.ts`
- 既存の widget キー（衝突回避のため使わない）: `subagent-async`（`src/shared/types.js`）, `subagent-fleet-status`（`src/tui/fleet-status.d.ts`）, `subagent-inspect`（`src/runs/background/inspect-rpc.js`）
- 今回使うキー（衝突しない）: **`subagent-viewer`**

---

## 10. 実装済み追補（2026-09-26 / 人形 #011）

実装: `/root/.pi/agent/extensions/subagent-viewer.ts`（単一ファイル、1254 行、jiti 素読み・ビルド不要）。
本節は #011 の実測結果の追補であり、§1〜§9 の設計判断を変更しない。

### 10.1 レビュー非ブロッキング指摘の反映

1. 単一 thinking エントリの表示上限を **500 行**（`MAX_THINKING_LINES`）に設定。実測最大 23319 文字（本ファイル内 `selftest` 出力で確認）を、幅 88 前後で折り返すと約 265 行 → 500 行内に収まる。
2. `/subview help` とオーバーレイ内 `?` ヘルプに「ヘッダの turn / tool カウンタが動いている間は処理中」「`tool_execution_update` は永続ログに残らないため無視する」を明記。
3. `/subview` コマンドの description とヘルプに「純 pi CLI（interactive TUI）でも同じ custom() API で動作する」を明記。
4. 重複除去キー `dedupKey()` は `type | observedAt | role | content hash` の形で **observedAt を常に含める**（重複未観測でも防御として保持）。

### 10.2 検証結果（実測）

- **型チェック**: `tsc -p tsconfig.json`（`@earendil-works/pi-tui` / `pi-coding-agent` の実型に解決）→ **exit 0 / 0 errors**。
- **実データ・スモーク**（`/tmp/sv-harness/`、実ラン `04e81279-eb63-41a7-97f7-87515a14877e` の events.jsonl 3,174,262 bytes）:
  - `/subview-selftest`: system 混入 0 / thinking **87,221 chars（buffer）== 87,221 chars（raw）** / toolCall 120 == toolResult 120（未対応 0）/ 切詰め耐性（改行前・多バイト途中）whole=319 cutA=319 cutB=319 / U+FFFD 無し / 総 319 エントリ（task:1 text:5 toolCall:120 toolResult:120 thinking:73）→ **RESULT: PASS**。
  - リング/尾行: 全読み 319 == 3 分割読み 319（rem 0）。2MiB tail 相当（`skipFirst`）99 == 素の末尾再パース 99。
  - factory stub: `ctx.mode="rpc"` + `custom()` stub → 36 行配列を返す（info/help ビューも 36 行）。`\x03` で done → Promise resolve。
- **実機 pi ロード**（`pi 0.87.1`）: `pi --mode rpc --no-session --no-extensions -e <path>` → **exit 0 / stderr 空**、`session_start` が `setWidget(widgetKey:"subagent-viewer")` を送信。`get_commands` に `/subview`・`/subview-selftest` が `source:"extension"` で出現。`/subview-selftest <runId>` を実走 → notify に `RESULT: PASS`。
- **未検証（#011 の権限外）**: pi-web ブラウザ実機でのオーバーレイ描画・キー・閉じるボタン（§7.3 の 3〜11、§7.4）。plain RPC mode の `custom()` は仕様どおり `undefined` を返すため、`/subview` は no-op（クラッシュ無し）。pi-web の `custom()` 実装での動作確認は #057（デザイン担当）への委譲を推奨。
