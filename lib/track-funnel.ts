// lib/track-funnel.ts
//
// Client-side helper to log a top-of-funnel event (anon arrivals: home /
// share / insights views + wallet-pastes) to funnel_events via
// POST /api/track-funnel. Fire-and-forget: it must never block render or a
// user interaction, and every failure is swallowed.
//
// Mirrors lib/track-click.ts (outbound_clicks) and DELIBERATELY reuses the
// same "rpc_sess" sessionStorage key so a visitor's funnel events and their
// outbound clicks reconcile to one session_id.

// Must match the funnel_events CHECK constraint event_type allowlist exactly.
export type FunnelEventType =
  | "home_view"
  | "wallet_paste"
  | "share_view"
  | "share_cta_click"
  | "insights_view"
  | "insights_card_click"
  | "collection_view"
  // signup funnel (2026-07-20): CTA intent, auth-confirm success, email capture
  | "signin_click"
  | "account_created"
  | "email_capture_submitted"

export type FunnelEventPayload = {
  eventType: FunnelEventType
  walletAddress?: string | null
  surface?: string | null
  referrer?: string | null
  sessionId?: string | null
}

const ENDPOINT = "/api/track-funnel"

// Same key as lib/track-click.getSessionId so sessions reconcile across the
// two instrumentation sinks. Stored in sessionStorage (cleared on tab close).
function getSessionId(): string | null {
  try {
    if (typeof window === "undefined") return null
    const KEY = "rpc_sess"
    let id = window.sessionStorage.getItem(KEY)
    if (!id) {
      const cryptoObj = window.crypto
      id =
        cryptoObj && "randomUUID" in cryptoObj
          ? cryptoObj.randomUUID()
          : `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
      window.sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return null
  }
}

// ── Campaign attribution ────────────────────────────────────────
// Traffic has measured ~100% referrer-less at every check (990 of 1,086
// funnel_events rows had a null/empty referrer on 2026-07-25, and zero carried
// a utm_*), so if anything is ever promoted the arrival is unattributable. We
// resolve attribution ONCE per session — the first event of a session is the
// landing hit — and reuse it for every later event, because document.referrer
// degrades to our own origin the moment the visitor navigates internally.
//
// PRIVACY: our own campaign params and the referring page only. utm values are
// stripped to a conservative token charset and capped; the referrer is reduced
// to origin+pathname so a referring URL's query string (which we do not control
// and which can carry personal data) is never stored. Same-origin referrers are
// dropped — this column answers "where did they come from", which is only
// meaningful for external arrivals. Nothing user-identifying is captured, and
// no user data is ever placed in a URL.
const ATTR_KEY = "rpc_attr"
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const

function utmToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._~-]/g, "").slice(0, 64)
}

function refOriginAndPath(href: string, selfOrigin: string): string {
  try {
    if (!href) return ""
    const u = new URL(href)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    if (u.origin === selfOrigin) return ""
    return `${u.origin}${u.pathname}`.slice(0, 300)
  } catch {
    return ""
  }
}

// Returns e.g. "utm_source=twitter&utm_campaign=squeeze&ref=https://t.co/abc".
// "" is a valid resolved answer (no campaign, no external referrer) and is
// cached as such, so we never re-read a now-internal document.referrer.
function getAttribution(): string | null {
  try {
    if (typeof window === "undefined") return null
    const cached = window.sessionStorage.getItem(ATTR_KEY)
    if (cached !== null) return cached || null

    const parts: string[] = []
    const params = new URLSearchParams(window.location.search)
    for (const k of UTM_KEYS) {
      const v = utmToken(params.get(k) ?? "")
      if (v) parts.push(`${k}=${v}`)
    }
    const ref =
      typeof document !== "undefined"
        ? refOriginAndPath(document.referrer || "", window.location.origin)
        : ""
    if (ref) parts.push(`ref=${ref}`)

    const value = parts.join("&").slice(0, 512)
    window.sessionStorage.setItem(ATTR_KEY, value)
    return value || null
  } catch {
    return null
  }
}

export function trackFunnelEvent(payload: FunnelEventPayload): void {
  try {
    if (typeof window === "undefined") return
    const event: FunnelEventPayload & { sessionId?: string | null } = {
      sessionId: getSessionId(),
      ...payload,
    }
    // An explicit referrer from the caller wins; otherwise stamp the session's
    // resolved campaign attribution onto every event.
    if (event.referrer == null) {
      const attr = getAttribution()
      if (attr) event.referrer = attr
    }
    const body = JSON.stringify(event)

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" })
      const ok = navigator.sendBeacon(ENDPOINT, blob)
      if (ok) return
    }

    // Fallback — keepalive lets the request outlive a navigation.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Never let instrumentation break render or a click.
  }
}
