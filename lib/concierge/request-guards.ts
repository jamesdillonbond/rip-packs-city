// Request-boundary guards for /api/support-chat (2026-10-03 concierge audit).
//
// Every value here arrives from the CLIENT body or headers and either lands in
// the system prompt, keys a database row, or is forwarded to the model as
// prior conversation. None of them was bounded before. Pure functions so the
// properties can be pinned with planted defects in
// __tests__/concierge-request-guards.test.ts — a source-text grep cannot tell
// a regex that matches from one that does not.

import { timingSafeEqual } from "node:crypto";

// ── Session ids ──────────────────────────────────────────────────────────────
// The Telegram / Discord bridge keys a user's DM history as `tg:<id>` /
// `dc:<snowflake>` and REBUILDS prior turns from support_conversations by that
// key (loadBotDmHistory). A web caller that chose the same session id would
// write turns into another user's DM context — so those prefixes are refused
// on the web path and accepted only behind the bot secret.
export const BOT_SESSION_PREFIX = /^(tg|dc):/i;

export function isBotSessionId(sessionId: unknown): boolean {
  return typeof sessionId === "string" && BOT_SESSION_PREFIX.test(sessionId);
}

// A session id is an opaque key: ASCII, no whitespace, bounded. Anything else
// gets a fresh anonymous id rather than a 400 — the widget never sends a bad
// one, and a hand-built caller should not be able to choose the row key shape.
const SESSION_ID_SHAPE = /^[A-Za-z0-9:._-]{1,128}$/;

export function isWellFormedSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_SHAPE.test(sessionId);
}

// ── Prompt fields ────────────────────────────────────────────────────────────
// Strings the client supplies that are interpolated into the system prompt
// (pageContext, marketPulse, dailyDeal.*). A line break lets a caller open a
// new "## section" of their own; backticks close the template's code spans in
// the rendered prompt. Collapse both, bound the length.
export function sanitizePromptField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\r\n\u2028\u2029`]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || null;
}

const COLLECTION_ID_SHAPE = /^[a-z0-9_-]{1,64}$/;

export function sanitizeCollectionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return COLLECTION_ID_SHAPE.test(v) ? v : null;
}

export type SanitizedDailyDeal = {
  player_name: string | null;
  set_name: string | null;
  low_ask: number | null;
  fmv: number | null;
  discount_pct: number | null;
  badges: string[];
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Keeps only the fields the prompt renders, each bounded. Both the snake_case
// and camelCase spellings the widget has sent over time are accepted.
export function sanitizeDailyDeal(raw: unknown): SanitizedDailyDeal | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const badges = Array.isArray(d.badges)
    ? d.badges.map((b) => sanitizePromptField(b, 40)).filter((b): b is string => !!b).slice(0, 8)
    : [];
  const out: SanitizedDailyDeal = {
    player_name: sanitizePromptField(d.player_name ?? d.playerName, 80),
    set_name: sanitizePromptField(d.set_name ?? d.setName, 80),
    low_ask: num(d.low_ask ?? d.askPrice),
    fmv: num(d.fmv ?? d.adjustedFmv),
    discount_pct: num(d.discount_pct ?? d.discount),
    badges,
  };
  return out.player_name ? out : null;
}

// ── Message + history ────────────────────────────────────────────────────────
// The widget caps the textarea at 2,000 characters; the Telegram bridge can
// relay up to 4,096. The server bound is the larger of the two — anything past
// it is not a conversation, it is a payload.
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_HISTORY_TURNS = 20;
export const MAX_HISTORY_TURN_CHARS = 8000;

export type HistoryTurn = { role: "user" | "assistant"; content: string };

// conversationHistory is forwarded to the model as prior turns. Only plain
// user/assistant text turns are accepted: a client-supplied tool_use /
// tool_result block, a `system` role, or an object content is dropped, each
// turn is bounded, and only the most recent MAX_HISTORY_TURNS survive. The
// first surviving turn must be a user turn (the API rejects an assistant lead).
export function sanitizeConversationHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const text = content.slice(0, MAX_HISTORY_TURN_CHARS);
    if (!text.trim()) continue;
    turns.push({ role, content: text });
  }
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent;
}

// ── Origin ───────────────────────────────────────────────────────────────────
// A browser sets `Origin` on every cross-site POST; a server-to-server caller
// (the bot bridge, the smoke runner, curl) sends none. An absent header is
// allowed; a present one must be the request's own host (covers Vercel
// previews) or one of the canonical site origins.
export function isAllowedBrowserOrigin(
  origin: string | null,
  requestHost: string | null,
  allowed: readonly string[],
): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  if (!requestHost) return false;
  try {
    return new URL(origin).host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

// ── Secrets ──────────────────────────────────────────────────────────────────
export function secretEquals(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
