// lib/telemetry/track.ts
//
// Client-side beacon helper. Posts {feature, metadata} to /api/telemetry,
// which resolves the user's wallet address server-side from the auth
// cookie. Calls are debounced + coalesced so a flurry of rapid clicks
// (e.g. cart +/- buttons) doesn't hammer the API — same feature name
// fired multiple times within the debounce window collapses into one
// beacon, with metadata from the most recent call.
//
// Failures are silent. Telemetry never blocks UI.

const DEBOUNCE_MS = 350
const FLUSH_INTERVAL_MS = 5000

type Beacon = { feature: string; metadata?: Record<string, unknown> }

const pending = new Map<string, Beacon>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush() {
  if (typeof window === "undefined") return
  if (pending.size === 0) {
    flushTimer = null
    return
  }
  const beacons = Array.from(pending.values())
  pending.clear()
  flushTimer = null

  for (const b of beacons) {
    try {
      const blob = new Blob([JSON.stringify(b)], { type: "application/json" })
      const ok = (typeof navigator !== "undefined" && navigator.sendBeacon)
        ? navigator.sendBeacon("/api/telemetry", blob)
        : false
      if (!ok) {
        // Fallback to fetch with keepalive so the request survives navigation.
        void fetch("/api/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(b),
          keepalive: true,
          credentials: "include",
        }).catch(() => undefined)
      }
    } catch {
      // Swallow.
    }
  }
}

function schedule() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, DEBOUNCE_MS)
}

export function track(feature: string, metadata?: Record<string, unknown>): void {
  if (typeof window === "undefined") return
  if (!feature) return
  // Coalesce repeated firings of the same feature in the debounce window.
  pending.set(feature, { feature, metadata })
  schedule()
}

// Best-effort flush before the page unloads so we don't lose the last
// beacon. Setting a hard interval as a safety net.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flush())
  window.addEventListener("beforeunload", () => flush())
  setInterval(() => flush(), FLUSH_INTERVAL_MS)
}
