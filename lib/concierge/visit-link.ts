// lib/concierge/visit-link.ts
//
// Joins a concierge conversation to the VISIT it happened in (2026-10-03).
//
// The chat widget keys its conversation on its own `rpc_chat_session` id (a
// capability token for reading the anon conversation back), while every other
// beacon — page-view telemetry, funnel_events, outbound_clicks — keys on the
// funnel `rpc_sess` id. Until now nothing linked the two, so "what did this
// visitor do before / after asking the concierge" was unanswerable. The widget
// now also sends the funnel session id + the session's landing attribution,
// and the route stores them on support_conversations.visit_session_id /
// visit_referrer.
//
// Both values are client-supplied on a PUBLIC route, so they are validated
// here and dropped (null) when malformed — never echoed into the DB as-is.

// rpc_sess is crypto.randomUUID() or the `s_<base36>_<base36>` fallback
// (lib/track-funnel.ts getSessionId). Anything else is not one of ours.
const VISIT_SID_RE = /^[A-Za-z0-9_-]{8,64}$/

export function sanitizeVisitSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const v = raw.trim()
  return VISIT_SID_RE.test(v) ? v : null
}

// The attribution string lib/track-funnel.ts builds is already token-charset
// utm values + an origin+path referrer, capped at 512. Re-cap and strip
// control characters so a hand-crafted body cannot store anything larger or
// stranger than the beacon itself would.
export function sanitizeVisitReferrer(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512)
  return v || null
}

// Internal checks (Cowork billing/health probes, QA scripts) call the public
// route without the X-RPC-Smoke-Test token and so landed as real traffic —
// row 10308 `cowork-billing-check-20261002` read as a real visitor's chat on
// 10-02. The in-product widget only ever sends `rpc_<uuid>` (or the route's
// own `anon-<uuid>` default) and the bot bridge `tg:` / `dc:`, so a session id
// carrying one of these prefixes is by construction not a collector. A
// client choosing one only hides its OWN row from the traction reads.
const INTERNAL_SESSION_RE = /^(cowork|smoke|qa|test|internal)[-_:]/i

export function isInternalCheckSessionId(sessionId: unknown): boolean {
  return typeof sessionId === "string" && INTERNAL_SESSION_RE.test(sessionId)
}
