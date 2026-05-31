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

export function trackFunnelEvent(payload: FunnelEventPayload): void {
  try {
    if (typeof window === "undefined") return
    const body = JSON.stringify({ sessionId: getSessionId(), ...payload })

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
