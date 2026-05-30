// lib/track-click.ts
//
// Client-side helper to log an outbound marketplace / "View Listing" click to
// outbound_clicks (via POST /api/track-click). Fire-and-forget: it must never
// block or interfere with the navigation the user just triggered.
//
// Uses navigator.sendBeacon when available — beacons are queued by the browser
// and survive the page unload that an outbound `target="_blank"` (or same-tab)
// navigation can cause, which a plain fetch() may not. Falls back to fetch with
// keepalive. All failures are swallowed — instrumentation must never throw into
// a click handler.

export type OutboundClickPayload = {
  surface?: string | null
  destination?: string | null
  editionKey?: string | null
  momentId?: string | number | null
  playerName?: string | null
  setName?: string | null
  tier?: string | null
  serial?: number | null
  askPrice?: number | null
  fmv?: number | null
  discount?: number | null
  walletAddress?: string | null
  sessionId?: string | null
  buyUrl?: string | null
}

const ENDPOINT = "/api/track-click"

// Lazily-derived, stable-per-tab session id so we can group a visitor's clicks
// without any auth. Stored in sessionStorage (cleared when the tab closes).
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

export function trackOutboundClick(payload: OutboundClickPayload): void {
  try {
    if (typeof window === "undefined") return
    const body = JSON.stringify({ sessionId: getSessionId(), ...payload })

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" })
      const ok = navigator.sendBeacon(ENDPOINT, blob)
      if (ok) return
    }

    // Fallback — keepalive lets the request outlive the navigation.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Never let instrumentation break a click.
  }
}
