// subagent-viewer.ts — pi 拡張（background subagent の thinking / ツール実行ビューア）
//
// 設計書: research/subagent-viewer-design-20260926.md（2026-09-26 / #002）
// 一次仕様に基づく単一ファイル実装。jiti 素読みなので TypeScript のまま・ビルド不要。
//
// == 何をするか ==
// pi-subagents が残す async run の events.jsonl を尾行し、選択中 1 ランの
// thinking / toolCall / toolResult / assistant text を全画面オーバーレイに表示する。
// 一覧は status.json だけを読む（events.jsonl を尾行するのは選択中の 1 ランだけ）。
//
// == なぜオーバーレイか ==
// pi-web の setWidget は「キー名のボタン = 下部タブ」になり常時は見えない（設計書 §1.3）。
// ctx.ui.custom() の全画面オーバーレイだけがライブ表示の口（設計書 §1.1-1.2）。
//
// == ホスト差の吸収（重要）==
// - ガードは `typeof ctx.ui.custom === "function"`。pi-web は ctx.mode === "rpc" で
//   custom() を実装するため、`ctx.mode === "tui"` ガードは禁止（設計書 §1.2）。
// - custom() に渡る theme は pi-web では恒等関数（NullTheme）。色は ANSI 直書き。
//   `\x1b[7m`（反転）は pi-web の ansi-to-html 非対応 → 選択行は ">" + 1;36m。
// - 純 pi CLI（interactive TUI）でも同じ custom() API で動作する。
//
// == pi-tui の解決 ==
// 実行時 import は必ず `@earendil-works/pi-tui` の形で書く。jiti の alias が pi 同梱の
// tui/dist/index.js に張るため素の require.resolve は MODULE_NOT_FOUND になる（設計書 §0/§2）。
//
// == ライフサイクル ==
// extensions.md:「factory でプロセス/ソケット/watcher/タイマーを起動しない」。
// 本拡張のポーリングタイマーはコマンドハンドラ（= custom() の factory、コマンド実行中）で
// 起動し、dispose() で冪等に停止する。常駐 widget は置かない（ユーザー指定: 常駐表示不要）。
//
// == 検証 ==
// `/subview-selftest [runDir]` が events.jsonl を読み取り専用で触り、パーサの assert を出す。
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================
// A. 定数
// ============================================================

const WIDGET_KEY = "subagent-viewer"; // subagent-async / subagent-fleet-status / subagent-inspect と非衝突

const POLL_STATUS_MS = 1000; // ラン一覧（readdir + status.json）
const POLL_EVENTS_MS = 500; // 選択中ランの events.jsonl 追記
const RENDER_THROTTLE_MS = 250; // 描画再送のスロットル
const STATUS_CACHE_SWEEP_MS = 60 * 1000; // statusCache を全消去する間隔（T005）

const INITIAL_FULL_READ_BYTES = 4 * 1024 * 1024; // これ以下なら初回に全文
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024; // これ以上は末尾 2MiB から

const MAX_BUFFER_ENTRIES = 4000; // 1 ランあたりのリングバッファ件数
const MAX_BUFFER_BYTES = 8 * 1024 * 1024; // 同 バイト上限
const MAX_REMAINDER_BYTES = 16 * 1024 * 1024; // 未完行 remainder の上限、超過で破棄（T004）

const TOOL_RESULT_MAX_CHARS = 400;
const TOOL_ARGS_MAX_CHARS = 160;
const MAX_ENTRY_LINES = 200; // 1 エントリの表示行上限（thinking 以外）
const MAX_THINKING_LINES = 500; // 単一 thinking エントリの表示上限（実測最大 23319 文字のため 500）

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // active + 直近 24h
const STALE_MARKER_MS = 24 * 60 * 60 * 1000; // .active-runs marker の stale 判定
const DEFAULT_LIST_LIMIT = 40;
const ALL_LIST_LIMIT = 200;

const TOTAL_ROWS = 36; // 設計書 §1.5 の行バジェット
const LIST_ROWS = 5;
const STREAM_ROWS = TOTAL_ROWS - LIST_ROWS - 6; // 25（chrome 3行 + 区切り2行 + ラン一覧 LIST_ROWS + 下罫線1行を引いて TOTAL_ROWS を維持）

const TERMINAL_STATES = new Set(["complete", "failed", "stopped", "rejected"]);

const R = "\x1b[0m";
const dim = (s: string): string => `\x1b[2m${s}${R}`;
const bold = (s: string): string => `\x1b[1m${s}${R}`;
const cyan = (s: string): string => `\x1b[1;36m${s}${R}`;
const yellow = (s: string): string => `\x1b[33m${s}${R}`;
const red = (s: string): string => `\x1b[31m${s}${R}`;
const green = (s: string): string => `\x1b[32m${s}${R}`;
const magenta = (s: string): string => `\x1b[35m${s}${R}`;

const LEGEND =
  dim("[q]") + "close " + dim("[j/k]") + "run " + dim("[J/K]") + "scroll " + dim("[space]") + "follow " +
  dim("[t]") + "think " + dim("[x]") + "tools " + dim("[a]") + "all " + dim("[i]") + "info " +
  dim("[r]") + "reload " + dim("[?]") + "help";

// ============================================================
// B. temp root / run 発見
// ============================================================

function sanitizeScopeSegment(v: string): string {
  const s = v.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (s || "x").slice(0, 40);
}

/** pi-subagents src/shared/types.js の resolveTempScopeId と同じ式（同一プロセスなので一致する）。 */
function resolveTempScopeId(env: NodeJS.ProcessEnv = process.env): string {
  const getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined;
  if (getuid) {
    try {
      return `uid-${getuid()}`;
    } catch {
      /* fall through */
    }
  }
  for (const k of ["USERNAME", "USER", "LOGNAME"]) {
    const v = env[k];
    if (v) return `user-${sanitizeScopeSegment(v)}`;
  }
  try {
    const u = userInfo().username;
    if (u) return `user-${sanitizeScopeSegment(u)}`;
  } catch {
    /* fall through */
  }
  const home = env.USERPROFILE ?? env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;
  try {
    const h = homedir();
    if (h) return `home-${sanitizeScopeSegment(h)}`;
  } catch {
    /* fall through */
  }
  return "shared";
}

const TEMP_ROOT_DIR = (() => {
  const cfg = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return cfg ? resolvePath(cfg) : join(tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
})();
const ASYNC_DIR = join(TEMP_ROOT_DIR, "async-subagent-runs");
const ACTIVE_DIR = join(ASYNC_DIR, ".active-runs");

interface RunRec {
  runId: string;
  dir: string;
  state: string;
  status: any;
  statusError: boolean;
  active: boolean;
  staleMarker: boolean;
  isNested: boolean;
  parentRunId?: string;
  lastUpdate: number;
}

interface StatusSnapshot {
  mtimeMs: number;
  status: any;
  error: boolean;
}
const statusCache = new Map<string, StatusSnapshot>();

function readStatusCached(dir: string): StatusSnapshot {
  const p = join(dir, "status.json");
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    /* gone */
  }
  const c = statusCache.get(dir);
  if (mtimeMs !== 0 && c && c.mtimeMs === mtimeMs) return c;
  if (mtimeMs === 0) return c ?? { mtimeMs: 0, status: null, error: true };
  let status: any = null;
  let error = false;
  try {
    status = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    error = true;
  }
  if (error && c) return c; // 壊れていても前回スナップショットを維持（設計書 §6）
  const rec: StatusSnapshot = { mtimeMs, status, error };
  statusCache.set(dir, rec);
  return rec;
}

function discoverRuns(showAll: boolean): { runs: RunRec[]; rootMissing: boolean } {
  if (!existsSync(ASYNC_DIR)) return { runs: [], rootMissing: true };
  const activeSet = new Set<string>();
  try {
    for (const n of readdirSync(ACTIVE_DIR)) activeSet.add(n);
  } catch {
    /* no active index */
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(ASYNC_DIR, { withFileTypes: true });
  } catch {
    return { runs: [], rootMissing: true };
  }
  const now = Date.now();
  const out: RunRec[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name.startsWith(".")) continue;
    if (Buffer.byteLength(name) > 255) continue; // pi-subagents 自身の readStatus と同じ判定
    const dir = join(ASYNC_DIR, name);
    const snap = readStatusCached(dir);
    const s = snap.status;
    const state = typeof s?.state === "string" ? s.state : "unknown";
    const activeMarker = activeSet.has(name);
    const lastUpdate = Number(s?.lastUpdate ?? s?.lastActivityAt ?? s?.startedAt ?? snap.mtimeMs ?? 0);
    const terminal = TERMINAL_STATES.has(state) || state === "partial" || state === "paused";
    const staleMarker = activeMarker && terminal && now - lastUpdate > STALE_MARKER_MS;
    const isActive = !staleMarker && (activeMarker || state === "queued" || state === "running");
    if (!showAll && !isActive && now - lastUpdate > RECENT_WINDOW_MS) continue;
    if (!showAll && !s && !activeMarker) continue; // status も marker も無い → 対象外
    out.push({
      runId: name,
      dir,
      state,
      status: s,
      statusError: snap.error,
      active: isActive,
      staleMarker,
      isNested: s?.isNested === true || !!s?.parentWorkflowRunId,
      parentRunId: s?.parentWorkflowRunId,
      lastUpdate,
    });
  }
  out.sort((a, b) => Number(b.active) - Number(a.active) || b.lastUpdate - a.lastUpdate);
  const limit = showAll ? ALL_LIST_LIMIT : DEFAULT_LIST_LIMIT;
  return { runs: out.slice(0, limit), rootMissing: false };
}

// ============================================================
// C. events.jsonl パーサ / 尾行カーソル
// ============================================================

type Kind = "task" | "thinking" | "text" | "toolCall" | "toolResult";

interface Entry {
  kind: Kind;
  at: number;
  agent?: string;
  text?: string;
  tool?: string;
  callId?: string;
  argText?: string;
  isError?: boolean;
  origChars?: number;
}

interface TailCursor {
  offset: number;
  remainder: Buffer;
  skipFirst: boolean;
  seenTask: boolean;
  stepAgents: Map<number, string>;
  lastDedupKey: string;
}

function newCursor(offset: number, skipFirst: boolean): TailCursor {
  return { offset, remainder: Buffer.alloc(0), skipFirst, seenTask: false, stepAgents: new Map(), lastDedupKey: "" };
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * 重複除去キー。observedAt は pi-subagents 側で重複が観測されていなくても
 * 防御として必ず含める（レビュー指摘 4）。
 */
function dedupKey(rec: any): string {
  if (!rec || typeof rec !== "object") return "";
  const type = rec.type ?? "";
  const observedAt = rec.observedAt ?? rec.timestamp ?? "";
  const role = rec.message?.role ?? "";
  let body = "";
  if (rec.message?.content !== undefined) body = JSON.stringify(rec.message.content);
  else if (rec.result?.content !== undefined) body = JSON.stringify(rec.result.content);
  else if (rec.args !== undefined) body = JSON.stringify(rec.args);
  return `${type}|${observedAt}|${role}|${fnv1a(body)}`;
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function shortenResult(text: string): string {
  const oneLine = text.replace(/\r?\n/g, " ↵ ");
  if (oneLine.length <= TOOL_RESULT_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TOOL_RESULT_MAX_CHARS)} …[${text.length} chars]`;
}

function previewArgs(args: any): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (s === undefined || s === null) s = "";
  s = stripUnsafeAnsi(s); // 切断前に strip（NIT#4）
  if (s.length > TOOL_ARGS_MAX_CHARS) {
    s = s.slice(0, TOOL_ARGS_MAX_CHARS);
    // 切断点が SGR 途中だった場合、尻に残る未閉鎖シーケンス断片を捨てる（NIT#4）
    const open = s.lastIndexOf("\x1b");
    if (s.indexOf("\x1b", open + 1) < 0 && open >= 0 && !/^\x1b\[[0-9;:]*m$/.test(s.slice(open))) {
      // 末尾 ESC が完全 SGR で終わっていなければ、そのシーケンスの開始以降を削る
      const tail = s.slice(open);
      if (!/^\x1b\[[0-9;:<=>?]*m/.test(tail)) s = s.slice(0, open);
    }
    s += "…";
  }
  return s;
}

/**
 * SGR（\x1b[…m）以外の ANSI エスケープと C0 制御文字を除去する（T006）。
 * 下位 agent が書いた任意文字列に \x1b[2J 等が混じっても ansi-to-html を壊さないため。
 */
function stripUnsafeAnsi(s: string): string {
  return s.replace(
    /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g,
    (m) => (m.startsWith("\x1b[") && m.endsWith("m") ? m : ""), // CSI のうち SGR のみ残す
  );
}

/**
 * events.jsonl 1 レコード → Entry[]。
 * system は必ず無視（content にシステムプロンプト全文が入り得る）。
 * message_start / tool_execution_* / turn_* は内容を使わない（設計書 §5.2）。
 */
function parseRecord(rec: any, stepAgents: Map<number, string>): Entry[] {
  if (!rec || typeof rec !== "object") return [];
  const at = Number(rec.observedAt ?? rec.ts ?? rec.timestamp ?? Date.now());
  const agent: string | undefined =
    rec.subagentAgent ?? (rec.subagentStepIndex != null ? stepAgents.get(rec.subagentStepIndex) : undefined);
  switch (rec.type) {
    case "subagent.step.started":
      if (rec.stepIndex != null && rec.agent) stepAgents.set(Number(rec.stepIndex), String(rec.agent));
      return [];
    case "message_end": {
      const m = rec.message ?? {};
      const role = m.role;
      if (role === "system") return [];
      if (role === "user") {
        const text = contentText(m.content);
        return text.trim() ? [{ kind: "task", text, at, agent }] : [];
      }
      if (role === "assistant") {
        const out: Entry[] = [];
        for (const p of m.content ?? []) {
          if (!p || typeof p !== "object") continue;
          if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) {
            out.push({ kind: "thinking", text: p.thinking, at, agent });
          } else if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
            out.push({ kind: "text", text: p.text, at, agent });
          } else if (p.type === "toolCall") {
            out.push({ kind: "toolCall", tool: String(p.name ?? "?"), callId: String(p.id ?? ""), argText: previewArgs(p.arguments), at, agent });
          }
        }
        return out;
      }
      if (role === "toolResult") {
        const raw = contentText(m.content);
        return [
          {
            kind: "toolResult",
            tool: String(m.toolName ?? "?"),
            callId: String(m.toolCallId ?? ""),
            text: stripUnsafeAnsi(shortenResult(raw)),
            isError: m.isError === true,
            origChars: raw.length,
            at,
            agent,
          },
        ];
      }
      return [];
    }
    default:
      return []; // 不明 type / tool_execution_* / turn_* は前方互換のため黙って無視
  }
}

/** remainder が上限超過なら破棄する（T004）。壊れた巨大未完行で無制限に増えるのを防ぐ。 */
function capRemainder(cs: TailCursor): void {
  if (cs.remainder.length > MAX_REMAINDER_BYTES) cs.remainder = Buffer.alloc(0);
}

/**
 * 追記バイトをカーソルに流し込み、完成した行だけを Entry[] にする。
 * remainder を Buffer のまま持つので UTF-8 の途中で切れても壊れない（設計書 §3.3）。
 */
function drainCursor(cs: TailCursor, chunk: Buffer): Entry[] {
  const joined = cs.remainder.length ? Buffer.concat([cs.remainder, chunk]) : chunk;
  const idx = joined.lastIndexOf(0x0a);
  if (idx < 0) {
    cs.remainder = Buffer.from(joined);
    capRemainder(cs);
    return [];
  }
  const text = joined.subarray(0, idx).toString("utf8");
  cs.remainder = Buffer.from(joined.subarray(idx + 1));
  capRemainder(cs);
  const lines = text.split("\n");
  if (cs.skipFirst) {
    lines.shift(); // 末尾 2MiB から始めたときの途中行を捨てる
    cs.skipFirst = false;
  }
  const out: Entry[] = [];
  for (const line of lines) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 失敗行は捨てる（設計書 §3.3-9）
    }
    const key = dedupKey(rec);
    if (key && key === cs.lastDedupKey) continue; // 連続重複を除去
    cs.lastDedupKey = key;
    out.push(...parseRecord(rec, cs.stepAgents));
  }
  return out;
}

function approxBytes(e: Entry): number {
  let n = 64;
  if (e.text) n += e.text.length * 2;
  if (e.argText) n += e.argText.length * 2;
  return n;
}

// ============================================================
// D. 表示フォーマット
// ============================================================

function pad(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? truncateToWidth(s, n) : s + " ".repeat(n - w);
}

function fmtTokens(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function ts(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function stateColor(state: string, text: string): string {
  if (state === "running" || state === "queued") return green(text);
  if (state === "complete") return dim(text);
  if (state === "partial" || state === "paused") return yellow(text);
  if (state === "failed" || state === "rejected" || state === "stopped") return red(text);
  return dim(text);
}

function stepOf(status: any): any {
  const steps = status?.steps ?? [];
  return steps[status?.currentStep ?? 0] ?? steps[0] ?? {};
}

function runRow(r: RunRec, selected: boolean): string {
  const st = r.status ?? {};
  const step = stepOf(st);
  const agentPlain = (r.isNested ? "↳" : "") + String(step.agent ?? "-");
  const agent = pad(truncateToWidth(agentPlain, 12), 12);
  const turn = Number(st.turnCount ?? step.turnCount ?? 0);
  const tools = Number(st.toolCount ?? step.toolCount ?? 0);
  const tokens = st.totalTokens?.window ?? st.totalTokens?.total ?? step.tokens?.window ?? step.tokens?.total;
  const stepIdx = (st.currentStep ?? 0) + 1;
  const stepTot = st.chainStepCount ?? (st.steps?.length ?? 1);
  const durMs = Number(st.endedAt ?? st.lastUpdate ?? st.lastActivityAt ?? Date.now()) - Number(st.startedAt ?? Date.now());
  const marker = r.staleMarker
    ? yellow("▲")
    : r.active
      ? green("●")
      : r.state === "partial" || r.state === "paused"
        ? yellow("◌")
        : dim("○");
  const cur = selected ? cyan(">") : " ";
  const rid = r.runId.slice(0, 8);
  const stateWord = pad((r.state + (r.statusError ? "!" : "")).slice(0, 8), 8);
  const left = `${cur} ${marker} ${rid}  ${agent}  ${stateColor(r.state, stateWord)}`;
  const right = `t${turn}/t${tools}  step ${stepIdx}/${stepTot}  ↓${fmtTokens(tokens)}  ${fmtDur(durMs)}`;
  return truncateToWidth(`${left}  ${right}`, 92, "", false) + R;
}

function wrapToChunks(text: string, width: number, cap: number): string[] {
  const chunks: string[] = [];
  for (const para of String(text).split("\n")) {
    if (para.trim() === "") continue;
    for (const c of wrapTextWithAnsi(para, Math.max(8, width))) chunks.push(c);
    if (chunks.length > cap + 2) break;
  }
  if (chunks.length > cap) {
    chunks.length = cap;
    chunks[cap - 1] = dim("… (truncated for display)");
  }
  return chunks;
}

function prefixed(label: string, indent: string, text: string, width: number, cap: number): string[] {
  const wrapW = Math.max(8, width - Math.max(visibleWidth(label), visibleWidth(indent)));
  const chunks = wrapToChunks(text, wrapW, cap);
  if (!chunks.length) return [label.trimEnd() + R];
  return chunks.map((c, i) => (i === 0 ? label + c : indent + c) + R);
}

function entryLines(e: Entry, width: number): string[] {
  const indent = "  ";
  switch (e.kind) {
    case "task":
      return prefixed(`${magenta("▣ task")}    `, indent, e.text ?? "", width, MAX_ENTRY_LINES);
    case "thinking":
      return prefixed(`${magenta("▸ thinking")} `, indent, e.text ?? "", width, MAX_THINKING_LINES);
    case "text":
      return prefixed(`${cyan("✎ text")}    `, indent, e.text ?? "", width, MAX_ENTRY_LINES);
    case "toolCall":
      return prefixed(`${yellow(`┊ ${e.tool ?? "?"}`)}  `, indent, e.argText ?? "", width, MAX_ENTRY_LINES);
    case "toolResult":
      return prefixed(
        e.isError ? `${red("⎿ error")}  ` : `${dim("⎿ result")} `,
        indent,
        e.text ?? "",
        width,
        MAX_ENTRY_LINES,
      );
  }
}

const HELP_LINES: string[] = [
  bold("subagent-viewer — help"),
  "",
  "キー:",
  "  q / Esc / Ctrl+C   閉じる",
  "  j / ↓ ,  k / ↑     ラン選択",
  "  J / PgDn , K / PgUp  ストリームを 1 行スクロール",
  "  g / G              先頭 / 末尾（末尾 = follow ON）",
  "  space              follow ON/OFF",
  "  t                  thinking 行の表示切替",
  "  x                  toolCall / toolResult 行の表示切替",
  "  a                  active+直近24h ⇄ 全件",
  "  i                  info パネル（i で閉じる）",
  "  r                  全キャッシュ破棄して読み直す（末尾 follow に戻す）",
  "  ?                  このヘルプ（? で閉じる）",
  "",
  "表示について:",
  "  thinking は events.jsonl の message_end 単位で「全文」。トークン差分の live ストリームは",
  "  pi-subagents が message_update を永続化しないため原理的に不可（message_end 粒度が到達点）。",
  "  長い bash 等の処理中は、ヘッダの turn / tool カウンタが動いている間は「処理中」と見てよい。",
  "  tool_execution_update（部分結果）は永続ログに残らず、部分ストリームの代替にならないため本ビューアは無視する。",
  "  1 エントリの表示上限: thinking 500 行 / その他 200 行（超過は truncated 表示。全文はバッファに保持）。",
  "  toolResult は 400 文字 + `…[N chars]` に短縮。",
  "",
  "ホスト:",
  "  pi-web の custom() API（全画面オーバーレイ）で描画する。色は恒等 theme を避けて ANSI 直書き。",
  "  純 pi CLI（interactive TUI）でも同じ custom() API で動作する。",
].map((l) => `${l}${R}`);

// ============================================================
// E. オーバーレイ コンポーネント
// ============================================================

class SubagentViewerComponent {
  private runs: RunRec[] = [];
  private selectedRunId: string | null = null;
  private cursor = 0;
  private listTop = 0; // ラン一覧ビューポート先頭の行 index
  private showAll = false;
  private follow = true;
  private scroll = 0;
  private showThinking = true;
  private showTools = true;
  private view: "stream" | "info" | "help" = "stream";
  private width = 92;
  private linesWidth = -1;

  private buffer: Entry[] = [];
  private bufferBytes = 0;
  private evicted = 0;
  private cs: TailCursor | null = null;
  private artifactsDeleted = false;
  private rootMissing = false;

  private renderedLines: string[] = [];
  private linesDirty = true;

  private statusTimer: NodeJS.Timeout | undefined;
  private eventsTimer: NodeJS.Timeout | undefined;
  private pendingRender: NodeJS.Timeout | undefined;
  private lastEmitAt = 0;
  private lastCacheSweep = 0;
  private disposed = false;

  private readonly tui: TUI;
  private readonly done: (result: undefined) => void;
  private readonly prefix: string;

  constructor(tui: TUI, done: (result: undefined) => void, prefix: string) {
    this.tui = tui;
    this.done = done;
    this.prefix = prefix;
    // コマンドハンドラ（custom() 実行中）から呼ばれる。extensions.md の「factory でタイマーを
    // 起動しない」を守るため、生成はここ（= コマンド実行時）1 箇所に閉じる。
    this.refreshRuns();
    if (this.prefix) {
      const i = this.runs.findIndex((r) => r.runId === this.prefix || r.runId.startsWith(this.prefix));
      if (i >= 0) this.selectAt(i);
    }
    if (!this.selectedRunId && this.runs.length) this.selectAt(0);
    this.pollStatus();
    this.pollEvents(true);
    this.statusTimer = setInterval(() => this.pollStatus(), POLL_STATUS_MS);
    this.eventsTimer = setInterval(() => this.pollEvents(false), POLL_EVENTS_MS);
  }

  // ---- 選択 ----

  private refreshRuns(): void {
    const res = discoverRuns(this.showAll);
    this.runs = res.runs;
    this.rootMissing = res.rootMissing;
  }

  private selectAt(i: number): void {
    if (i < 0 || i >= this.runs.length) return;
    this.cursor = i;
    this.clampListTop();
    const id = this.runs[i].runId;
    if (id !== this.selectedRunId) {
      this.selectedRunId = id;
      this.buffer = [];
      this.bufferBytes = 0;
      this.evicted = 0;
      this.cs = null;
      this.artifactsDeleted = false;
      this.linesDirty = true;
    }
    this.follow = true;
  }

  private moveSel(delta: number): void {
    if (!this.runs.length) return;
    const base = this.selectedRunId ? this.runs.findIndex((r) => r.runId === this.selectedRunId) : this.cursor;
    const next = Math.min(Math.max(0, (base < 0 ? 0 : base) + delta), this.runs.length - 1);
    this.selectAt(next);
    this.scheduleRender(true);
  }

  /** 選択行が必ず LIST_ROWS 行のビューポート内に収まるよう listTop を clamp（scroll into view）。 */
  private clampListTop(): void {
    if (this.cursor < this.listTop) this.listTop = this.cursor;
    else if (this.cursor >= this.listTop + LIST_ROWS) this.listTop = this.cursor - LIST_ROWS + 1;
    const maxTop = Math.max(0, this.runs.length - LIST_ROWS);
    if (this.listTop > maxTop) this.listTop = maxTop;
    if (this.listTop < 0) this.listTop = 0;
  }

  // ---- ポーリング ----

  private pollStatus(): void {
    if (this.disposed) return;
    const before = this.statusSnapshot();
    const now = Date.now();
    if (now - this.lastCacheSweep >= STATUS_CACHE_SWEEP_MS) {
      this.lastCacheSweep = now;
      statusCache.clear(); // T005: 溜まった snapshot を定期全消去（大は小を兼ねる）
    }
    this.refreshRuns();
    if (this.selectedRunId) {
      const idx = this.runs.findIndex((r) => r.runId === this.selectedRunId);
      if (idx >= 0) {
        this.cursor = idx;
        this.clampListTop();
        this.artifactsDeleted = false;
      } else if (existsSync(join(ASYNC_DIR, this.selectedRunId))) {
        // showAll 切替などで単に一覧から外れた → 隣へ移る
        if (this.runs.length) this.selectAt(Math.min(this.cursor, this.runs.length - 1));
        else this.selectedRunId = null;
      } else {
        this.artifactsDeleted = true; // artifacts 消失。バッファは保持して読める状態を保つ
        this.cursor = this.runs.length ? Math.min(this.cursor, this.runs.length - 1) : 0;
        this.clampListTop();
      }
    } else if (this.runs.length) {
      this.selectAt(0);
    }
    if (this.statusSnapshot() !== before) {
      this.linesDirty = true;
      this.scheduleRender(false);
    }
  }

  /** pollStatus が実際に変化したか判定するための状態要約（T002）。 */
  private statusSnapshot(): string {
    return [
      this.selectedRunId ?? "",
      this.cursor,
      this.artifactsDeleted ? 1 : 0,
      this.runs.map((r) => `${r.runId}:${r.state}:${r.active ? 1 : 0}:${r.lastUpdate}`).join(","),
    ].join("|");
  }

  private pollEvents(initial: boolean): void {
    if (this.disposed || !this.selectedRunId) return;
    const eventsPath = join(ASYNC_DIR, this.selectedRunId, "events.jsonl");
    let fd: number;
    try {
      fd = openSync(eventsPath, "r");
    } catch {
      if (!this.artifactsDeleted) {
        this.artifactsDeleted = true;
        this.linesDirty = true;
        this.scheduleRender(false);
      }
      return;
    }
    try {
      const st = fstatSync(fd);
      let cs = this.cs;
      if (!cs) {
        const tail = initial && st.size > INITIAL_FULL_READ_BYTES;
        const offset = tail ? st.size - INITIAL_TAIL_BYTES : 0;
        cs = newCursor(offset, tail);
        this.cs = cs;
      }
      if (st.size < cs.offset) {
        // ローテート / 再生成の防御
        cs.offset = 0;
        cs.remainder = Buffer.alloc(0);
        cs.skipFirst = false;
      }
      let chunk = Buffer.alloc(0);
      const toRead = st.size - cs.offset;
      if (toRead > 0) {
        const buf = Buffer.allocUnsafe(toRead);
        const n = readSync(fd, buf, 0, toRead, cs.offset);
        cs.offset += n;
        chunk = buf.subarray(0, n);
      }
      const entries = drainCursor(cs, chunk);
      if (!entries.length) return;
      for (const e of entries) {
        if (e.kind === "task") {
          if (cs.seenTask) continue;
          cs.seenTask = true;
        }
        this.buffer.push(e);
        this.bufferBytes += approxBytes(e);
      }
      this.evict();
      this.linesDirty = true;
      this.scheduleRender(false);
    } catch {
      // 読めない瞬間があっても落とさない
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  private evict(): void {
    while (this.buffer.length > MAX_BUFFER_ENTRIES || (this.bufferBytes > MAX_BUFFER_BYTES && this.buffer.length > 1)) {
      const dropped = this.buffer.shift();
      if (!dropped) break;
      this.bufferBytes -= approxBytes(dropped);
      this.evicted += 1;
    }
    if (this.bufferBytes < 0) this.bufferBytes = 0;
  }

  private reload(): void {
    this.buffer = [];
    this.bufferBytes = 0;
    this.evicted = 0;
    this.cs = null;
    this.artifactsDeleted = false;
    this.follow = true; // T007: 読み直し後は末尾 follow に戻す（help の r 説明と一致）
    this.scroll = 0;
    this.linesDirty = true;
    this.pollStatus();
    this.pollEvents(true);
    this.scheduleRender(true);
  }

  // ---- 描画 ----

  private scheduleRender(immediate: boolean): void {
    if (this.disposed) return;
    const now = Date.now();
    const dt = now - this.lastEmitAt;
    if (immediate || dt >= RENDER_THROTTLE_MS) {
      this.lastEmitAt = now;
      this.tui.requestRender();
      return;
    }
    if (this.pendingRender) return;
    this.pendingRender = setTimeout(() => {
      this.pendingRender = undefined;
      if (this.disposed) return;
      this.lastEmitAt = Date.now();
      this.tui.requestRender();
    }, RENDER_THROTTLE_MS - dt);
  }

  invalidate(): void {
    this.linesDirty = true;
    this.scheduleRender(false);
  }

  render(width: number): string[] {
    this.width = Math.max(40, Math.floor(width) || 92);
    this.ensureLines();

    const out: string[] = [];
    const runWord = `${this.runs.length} run${this.runs.length === 1 ? "" : "s"}`;
    const hdr = `${cyan("subagent-viewer")}  ${runWord} ${this.showAll ? "(all)" : "(active+24h)"}  ${dim(`root:${TEMP_ROOT_DIR}`)}`;
    out.push(truncateToWidth(hdr, this.width, "", false) + R);
    out.push(truncateToWidth(LEGEND, this.width, "", false) + R);
    out.push("─".repeat(this.width + 8));

    const visible = this.runs.slice(this.listTop, this.listTop + LIST_ROWS);
    for (let i = 0; i < LIST_ROWS; i += 1) {
      const r = visible[i];
      out.push(r ? runRow(r, r.runId === this.selectedRunId) : "");
    }
    out.push("─".repeat(this.width + 8));
    out.push(truncateToWidth(this.headerLine(), this.width, "", false) + R);

    const body = this.view === "help" ? HELP_LINES : this.view === "info" ? this.infoLines() : this.streamWindow();
    for (let i = 0; i < STREAM_ROWS; i += 1) out.push(body[i] ?? "");
    // 下罫線（最終行を常に非空にする）。pi-web の custom UI は末尾の空行をトリミングして
    // ボックス高を決めるため、これが無いと内容が少ないとき一覧/ストリームが縮んで見える。
    out.push(dim("─".repeat(this.width + 8)));
    return out;
  }

  private ensureLines(): void {
    if (!this.linesDirty && this.linesWidth === this.width) return;
    this.renderedLines = this.buildStreamLines();
    this.linesDirty = false;
    this.linesWidth = this.width;
  }

  private buildStreamLines(): string[] {
    const out: string[] = [];
    if (this.rootMissing) {
      out.push(red("pi-subagents の async run ディレクトリが見つからない") + R);
      out.push(dim(`root: ${TEMP_ROOT_DIR}`) + R);
      out.push(dim("PI_SUBAGENTS_TEMP_ROOT を疑う。foreground 実行は run ディレクトリを残さない（background:true のみ対象）。") + R);
      return out;
    }
    if (!this.selectedRunId) {
      out.push(dim("no async subagent runs") + R);
      out.push(dim(`root: ${TEMP_ROOT_DIR}`) + R);
      out.push(dim("foreground 実行は親プロセス内で走るので run ディレクトリを残さない。background:true の実行だけが対象。") + R);
      return out;
    }
    if (this.artifactsDeleted && !this.buffer.length) {
      out.push(red("[run artifacts deleted]") + dim(`  ${this.selectedRunId}`) + R);
      return out;
    }
    if (this.evicted > 0) out.push(dim(`── buffer start (${this.evicted} entries evicted) ──`) + R);
    if (!this.buffer.length) out.push(dim("waiting for events…") + R);
    for (const e of this.buffer) {
      if (e.kind === "thinking" && !this.showThinking) continue;
      if ((e.kind === "toolCall" || e.kind === "toolResult") && !this.showTools) continue;
      out.push(...entryLines(e, this.width));
    }
    if (this.artifactsDeleted) out.push(red("[run artifacts deleted]") + dim("  (バッファ内容は保持)") + R);
    return out;
  }

  private streamWindow(): string[] {
    const lines = this.renderedLines;
    const total = lines.length;
    const maxScroll = Math.max(0, total - STREAM_ROWS);
    this.scroll = this.follow ? maxScroll : Math.min(Math.max(0, this.scroll), maxScroll);
    const out: string[] = [];
    for (let i = 0; i < STREAM_ROWS; i += 1) out.push(lines[this.scroll + i] ?? "");
    return out;
  }

  private headerLine(): string {
    if (!this.selectedRunId) return dim("STREAM  (no run selected)");
    const r = this.runs.find((x) => x.runId === this.selectedRunId);
    let line = `${bold("STREAM")}  ${cyan(this.selectedRunId.slice(0, 8))}`;
    if (r) {
      const st = r.status ?? {};
      const step = stepOf(st);
      const durMs = Number(st.endedAt ?? st.lastUpdate ?? st.lastActivityAt ?? Date.now()) - Number(st.startedAt ?? Date.now());
      line += ` · ${String(step.agent ?? "-")} · ${stateColor(r.state, r.state)}`;
      line += ` · turn ${st.turnCount ?? step.turnCount ?? 0} · tools ${st.toolCount ?? step.toolCount ?? 0} · ${fmtDur(durMs)}`;
    } else if (this.artifactsDeleted) {
      line += ` · ${dim("[artifacts deleted]")}`;
    }
    line += ` · follow:${this.follow ? green("ON") : dim("OFF")} · ${this.renderedLines.length} lines`;
    return line;
  }

  private infoLines(): string[] {
    const out: string[] = [];
    const kv = (k: string, v: unknown): void => {
      out.push("  " + dim(pad(k, 15)) + " " + (v === undefined || v === null || v === "" ? dim("-") : String(v)));
    };
    out.push(bold("INFO") + dim("  (i で閉じる)"));
    const r = this.runs.find((x) => x.runId === this.selectedRunId);
    if (!r) {
      out.push(dim("no selected run"));
      return out.map((l) => truncateToWidth(l, this.width, "", false) + R);
    }
    const s = r.status ?? {};
    const step = stepOf(s);
    const tok = s.totalTokens ?? step.tokens;
    kv("runId", r.runId);
    kv("state", stateColor(r.state, r.state) + (r.statusError ? "  " + red("!status unreadable") : ""));
    kv("mode", s.mode);
    kv("agent", step.agent);
    kv("model", step.model ?? s.model);
    kv("thinking", step.thinking ?? s.thinking);
    kv("turns", s.turnCount ?? step.turnCount);
    kv("tools", s.toolCount ?? step.toolCount);
    kv("currentTool", s.currentTool ?? step.currentTool);
    kv("tokens", tok ? `in ${fmtTokens(tok.input)} out ${fmtTokens(tok.output)} total ${fmtTokens(tok.total)} window ${fmtTokens(tok.window)}` : undefined);
    kv("cost", s.totalCost?.costUsd != null ? `$${Number(s.totalCost.costUsd).toFixed(4)}` : undefined);
    kv("startedAt", ts(s.startedAt));
    kv("deadline", s.deadlineAt ? `${fmtDur(s.deadlineAt - Date.now())} left (${ts(s.deadlineAt)})` : undefined);
    kv("step", `${(s.currentStep ?? 0) + 1}/${s.chainStepCount ?? (s.steps?.length ?? 1)}`);
    kv("nested", r.isNested ? `yes parent=${r.parentRunId ?? "-"}` : "no");
    kv("workflowChildren", s.workflowChildren?.length);
    kv("cwd", s.cwd);
    kv("sessionName", step.sessionName);
    kv("sessionFile", step.sessionFile ?? s.sessionFile);
    kv("transcript", step.transcriptPath);
    kv("processTerminal", s.processTerminal?.state);
    kv("lifecycle", `${s.lifecycleArtifactVersion ?? "-"}${s.lifecycleArtifactVersion !== 3 ? "  " + red("WARN: expected 3") : ""}`);
    kv("error", s.error ?? step.error);
    kv("buffer", `${this.buffer.length} entries${this.evicted ? ` (+${this.evicted} evicted)` : ""}`);
    return out.map((l) => truncateToWidth(l, this.width, "", false) + R);
  }

  // ---- 入力 ----

  handleInput(data: string): void {
    if (this.disposed) return;
    const m = (k: string): boolean => matchesKey(data, k as any);

    // 閉じる
    if (data === "q" || data === "\x03" || data === "\x1b" || m(Key.escape) || m(Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    // どのビューからでも効く
    if (data === "?") {
      this.view = this.view === "help" ? "stream" : "help";
      this.scheduleRender(true);
      return;
    }
    if (data === "r") {
      this.reload();
      return;
    }
    if (this.view !== "stream") {
      if (data === "i") {
        this.view = "stream";
        this.scheduleRender(true);
      }
      return;
    }
    if (data === "i") {
      this.view = "info";
      this.scheduleRender(true);
      return;
    }

    if (data === "j" || m(Key.down)) return void this.moveSel(1);
    if (data === "k" || m(Key.up)) return void this.moveSel(-1);
    if (data === "J" || m(Key.pageDown)) return void this.scrollBy(1);
    if (data === "K" || m(Key.pageUp)) return void this.scrollBy(-1);
    if (data === "g") {
      this.follow = false;
      this.scroll = 0;
      this.scheduleRender(true);
      return;
    }
    if (data === "G") {
      this.follow = true;
      this.scheduleRender(true);
      return;
    }
    if (data === " " || m(Key.space)) {
      this.follow = !this.follow;
      this.scheduleRender(true);
      return;
    }
    if (data === "t") {
      this.showThinking = !this.showThinking;
      this.linesDirty = true;
      this.scheduleRender(true);
      return;
    }
    if (data === "x") {
      this.showTools = !this.showTools;
      this.linesDirty = true;
      this.scheduleRender(true);
      return;
    }
    if (data === "a") {
      this.showAll = !this.showAll;
      this.pollStatus();
      return;
    }
    if (data === "\t" || m(Key.tab)) return void this.jump(1);
    if (data === "\x1b[Z" || m(Key.shift("tab"))) return void this.jump(-1);
  }

  private scrollBy(delta: number): void {
    this.follow = false;
    this.scroll = Math.max(0, this.scroll + delta);
    this.scheduleRender(true);
  }

  private jump(dir: number): void {
    if (!this.runs.length) return;
    const interesting = this.runs
      .map((r, i) => ({ i, interesting: r.active || r.state === "partial" || r.state === "paused" }))
      .filter((x) => x.interesting)
      .map((x) => x.i);
    if (!interesting.length) return;
    const cur = this.selectedRunId ? this.runs.findIndex((r) => r.runId === this.selectedRunId) : 0;
    const next = dir > 0 ? interesting.find((i) => i > cur) ?? interesting[0] : [...interesting].reverse().find((i) => i < cur) ?? interesting[interesting.length - 1];
    this.selectAt(next);
    this.scheduleRender(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.eventsTimer) clearInterval(this.eventsTimer);
    if (this.pendingRender) clearTimeout(this.pendingRender);
    this.statusTimer = this.eventsTimer = this.pendingRender = undefined;
  }

  /** 二重起動時に旧オーバーレイを閉じる（T003）。done 二重発火を dispose 済みなら抑止。 */
  dropExisting(): void {
    if (this.disposed) return; // すでに閉じている → done 済み、二重発火しない
    this.dispose();
    this.done(undefined);
  }
}

// ============================================================
// F. パーサ自己診断（/subview-selftest）
// ============================================================

interface SelfTestResult {
  ok: boolean;
  report: string[];
}

function findLatestRunDir(): string | undefined {
  if (!existsSync(ASYNC_DIR)) return undefined;
  let best: { dir: string; m: number } | undefined;
  try {
    for (const e of readdirSync(ASYNC_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = join(ASYNC_DIR, e.name);
      let m = 0;
      try {
        m = statSync(join(dir, "events.jsonl")).mtimeMs;
      } catch {
        continue;
      }
      if (!best || m > best.m) best = { dir, m };
    }
  } catch {
    return undefined;
  }
  return best?.dir;
}

/** events.jsonl を読み取り専用で全走査し、assert 結果を返す。副作用なし。 */
function runSelfTest(runDir: string): SelfTestResult {
  const report: string[] = [];
  const fail: string[] = [];
  const eventsPath = join(runDir, "events.jsonl");
  report.push(`runDir: ${runDir}`);

  let full: Buffer;
  try {
    full = readFileSync(eventsPath);
  } catch (err) {
    return { ok: false, report: [`events.jsonl を読めない: ${eventsPath}`, String(err)] };
  }
  report.push(`events.jsonl: ${full.length} bytes`);

  // --- 本体カーソルで全読み ---
  const whole = newCursor(0, false);
  const entries = drainCursor(whole, full);

  // 生データ側の集計
  let rawSystemEnds = 0;
  let rawAssistEnds = 0;
  let rawThinkingChars = 0;
  const rawCallIds = new Set<string>();
  const rawResultIds = new Set<string>();
  for (const line of full.toString("utf8").split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "message_end") continue;
    const role = rec.message?.role;
    if (role === "system") rawSystemEnds += 1;
    if (role === "assistant") {
      rawAssistEnds += 1;
      for (const p of rec.message?.content ?? []) {
        if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) rawThinkingChars += p.thinking.length;
        if (p?.type === "toolCall" && p.id) rawCallIds.add(String(p.id));
      }
    }
    if (role === "toolResult" && rec.message?.toolCallId) rawResultIds.add(String(rec.message.toolCallId));
  }

  // assert 1: system message_end がバッファに混入していない
  // 生レコードに対して parseRecord が空を返すこと（システムプロンプト全文の混入防止）を直接確認する。
  const syntheticSystem = parseRecord(
    { type: "message_end", observedAt: 1, message: { role: "system", content: "SYSTEM PROMPT ".repeat(1000) } },
    new Map(),
  );
  const systemOK = syntheticSystem.length === 0 && !entries.some((e) => e.kind === "task" && (e.text ?? "").length > 100000);
  report.push(`[1] system message_end: raw=${rawSystemEnds} parseRecord(system)=${syntheticSystem.length} ${systemOK ? "OK" : "NG"}`);
  if (!systemOK) fail.push("system message_end が Entry を生成した");

  // assert 2: thinking 全文性
  const thinkingEntries = entries.filter((e) => e.kind === "thinking");
  const bufThinkingChars = thinkingEntries.reduce((a, e) => a + (e.text?.length ?? 0), 0);
  const thinkingOK = bufThinkingChars === rawThinkingChars;
  report.push(`[2] thinking: entries=${thinkingEntries.length} chars(buffer)=${bufThinkingChars} chars(raw)=${rawThinkingChars} ${thinkingOK ? "OK" : "NG"}`);
  if (!thinkingOK) fail.push(`thinking 文字数不一致: buffer=${bufThinkingChars} raw=${rawThinkingChars}`);

  // assert 3: toolCall → toolResult 対応
  const callIds = new Set(entries.filter((e) => e.kind === "toolCall" && e.callId).map((e) => e.callId as string));
  const resultIds = new Set(entries.filter((e) => e.kind === "toolResult" && e.callId).map((e) => e.callId as string));
  let unmatched = 0;
  for (const id of callIds) if (!resultIds.has(id)) unmatched += 1;
  report.push(`[3] toolCall=${callIds.size} toolResult=${resultIds.size} 対応=${callIds.size - unmatched} 未対応=${unmatched} ${callIds.size > 0 && unmatched === 0 ? "OK" : unmatched === 0 ? "OK(none)" : "NG"}`);
  if (unmatched > 0) fail.push(`toolCall に toolResult が無い: ${unmatched} 件`);

  // assert 4: 切り詰め耐性（(a) 最終改行の直前 (b) 日本語の途中バイト）
  const lastNl = full.lastIndexOf(0x0a);
  const cutA = lastNl >= 0 ? full.subarray(0, lastNl) : full;
  let cutB = full;
  for (let i = 1; i < full.length; i += 1) {
    const b = full[i];
    if (b >= 0x80 && b <= 0xbf) {
      const prev = full[i - 1];
      if (prev !== undefined && (prev & 0xc0) !== 0x80) {
        cutB = full.subarray(0, i);
        break;
      }
    }
  }
  const countSplit = (cut: Buffer): number => {
    const cs = newCursor(0, false);
    const first = drainCursor(cs, cut);
    const rest = drainCursor(cs, full.subarray(cut.length));
    return first.length + rest.length;
  };
  const totalA = countSplit(cutA);
  const totalB = countSplit(cutB);
  const ref = entries.length;
  const truncOK = totalA === ref && totalB === ref;
  report.push(`[4] truncation: whole=${ref} cutBeforeNewline=${totalA} cutMidMultibyte=${totalB} ${truncOK ? "OK" : "NG"}`);
  if (!truncOK) fail.push(`切り詰め耐性 NG: whole=${ref} A=${totalA} B=${totalB}`);
  const mojibake = entries.some((e) => (e.text ?? "").includes("\ufffd") || (e.argText ?? "").includes("\ufffd"));
  report.push(`[4b] U+FFFD mojibake: ${mojibake ? "NG" : "OK"}`);
  if (mojibake) fail.push("U+FFFD 混入");

  // assert 5: 内訳
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const maxThinking = thinkingEntries.reduce((a, e) => Math.max(a, e.text?.length ?? 0), 0);
  report.push(`[5] 総エントリ=${entries.length} 内訳=${[...counts.entries()].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  report.push(`    最大 thinking=${maxThinking} 文字 / 表示上限=${MAX_THINKING_LINES} 行`);
  report.push(`    remainder 残バイト=${whole.remainder.length}（完成行のみ消費）`);

  report.push(fail.length ? `RESULT: FAIL (${fail.length}) ${fail.join("; ")}` : "RESULT: PASS");
  return { ok: fail.length === 0, report };
}

// ============================================================
// G. 登録
// ============================================================

let activeViewer: SubagentViewerComponent | null = null; // T003: 二重起動防止（生存中のオーバーレイ）

async function openViewer(ctx: ExtensionCommandContext, args: string): Promise<void> {
  if (typeof ctx.ui.custom !== "function") {
    ctx.ui.notify("このホストはカスタム UI (ctx.ui.custom) 非対応", "warning");
    return;
  }
  const prefix = args.trim();
  if (prefix === "help" || prefix === "-h" || prefix === "--help") {
    ctx.ui.notify(HELP_LINES.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"), "info");
    return;
  }
  if (activeViewer) activeViewer.dropExisting(); // T003: 二重起動時は旧オーバーレイを先に閉じる
  try {
    await ctx.ui.custom<undefined>(
      (tui, _theme, _keybindings, done) => {
        const inst = new SubagentViewerComponent(
          tui,
          (r) => {
            if (activeViewer === inst) activeViewer = null;
            done(r);
          },
          prefix,
        );
        activeViewer = inst;
        return inst;
      },
      { overlay: true, overlayOptions: { width: 92 } },
    );
  } catch (err) {
    try {
      ctx.ui.notify(`subagent-viewer: ${err instanceof Error ? err.message : String(err)}`, "error");
    } catch {
      /* ignore */
    }
  }
}

async function runSelfTestCommand(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const arg = args.trim();
  const runDir = arg ? (existsSync(arg) ? resolvePath(arg) : join(ASYNC_DIR, arg)) : findLatestRunDir();
  if (!runDir || !existsSync(runDir)) {
    ctx.ui.notify(`subview-selftest: run ディレクトリが見つからない (${arg || ASYNC_DIR})`, "warning");
    return;
  }
  let res: SelfTestResult;
  try {
    res = runSelfTest(runDir);
  } catch (err) {
    ctx.ui.notify(`subview-selftest: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const text = `subagent-viewer selftest\n${res.report.join("\n")}`;
  // 実機の人と、ヘッドレス検証の両方に届くよう console にも出す
  console.log(text);
  ctx.ui.notify(text, res.ok ? "info" : "error");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subview", {
    description:
      "background subagent の thinking / tool 実行を全画面オーバーレイでライブ表示する。" +
      "pi-web の custom() API で描画（純 pi CLI の interactive TUI でも同じ custom() API で動作）。" +
      "引数は runId 前方一致。`/subview help` でキー操作。",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim();
      const items = discoverRuns(true)
        .runs.map((r) => ({ value: r.runId, label: r.runId, description: `${r.state} ${stepOf(r.status).agent ?? ""}`.trim() }))
        .filter((it) => !p || it.value.startsWith(p));
      items.push({ value: "help", label: "help", description: "キー操作と表示仕様" });
      return items;
    },
    handler: async (args, ctx) => {
      await openViewer(ctx, args);
    },
  });

  pi.registerCommand("subview-selftest", {
    description: "subagent-viewer のパーサ自己診断（events.jsonl を読み取り専用で検証、オーバーレイは開かない）",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim();
      return discoverRuns(true)
        .runs.map((r) => ({ value: r.runId, label: r.runId, description: r.state }))
        .filter((it) => !p || it.value.startsWith(p));
    },
    handler: async (args, ctx) => {
      await runSelfTestCommand(ctx, args);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // 常駐 widget は置かない（ユーザー指定: 常駐表示不要・ペーン高変動の防止）。
    // viewer 本体の起動は /subview（コマンドハンドラ）だけ。タイマーもプロセスも起動しない（extensions.md:58）。
    try {
      ctx.ui.setWidget(WIDGET_KEY, []); // 既存セッションの残置 widget をクリア
    } catch {
      /* headless / no-op UI */
    }
  });
}

// ============================================================
// H. テスト用エクスポート（pi は default export のみを見る。副作用なし）
// ============================================================

export {
  ASYNC_DIR,
  TEMP_ROOT_DIR,
  discoverRuns,
  drainCursor,
  newCursor,
  parseRecord,
  runSelfTest,
  stripUnsafeAnsi,
  SubagentViewerComponent,
};
export type { Entry, RunRec, TailCursor };
