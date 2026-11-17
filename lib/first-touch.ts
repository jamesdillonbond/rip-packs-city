// lib/first-touch.ts
//
// First-touch attribution that survives the magic-link tab (2026-11-09,
// signup-wave remediation P2: the referrer/UTM attribution gap).
//
// ── WHY ──────────────────────────────────────────────────────────────────
// Campaign attribution (lib/track-funnel.ts) lives in sessionStorage, so it
// dies with the tab. Signing up is a magic link, which opens a NEW tab: the
// visit that brought a collector in is gone by the time they are an account.
// Measured 11-09: of 15 accounts created in the prior 7 days, 5 had any
// funnel_events row tied to their user_id and 1 had a referrer.
//
// So the FIRST landing on a browser is written to localStorage (`rpc_ft`), and
// once that browser is signed in it is sent to /api/profile/attribution, which
// stores it on user_profiles once (first write wins).
//
// ── PRIVACY ──────────────────────────────────────────────────────────────
// Same posture as `rpc_vid` (disclosed on /privacy): first-party only, no
// fingerprinting, nothing personal — the attribution string is already reduced
// to utm tokens, our share id and an external origin+path. GPC / DNT set:
// nothing is written, and a record written before the signal is dropped.
//
// Pure helpers here; the effectful wiring is components/FirstTouchCapture.tsx.

export const FIRST_TOUCH_KEY = "rpc_ft"
export const FIRST_TOUCH_CLAIMED_KEY = "rpc_ft_claimed"

export interface FirstTouch {
  /** Campaign attribution, same format as funnel_events.referrer. "" = captured, none (direct). */
  a: string
  /** Landing path, no query string (the query's useful part is already in `a`). */
  l: string
  /** ISO time of the first landing. */
  t: string
  /** rpc_vid at the time, or null. */
  v: string | null
}

export function buildFirstTouch(
  attribution: string | null,
  pathname: string,
  visitorId: string | null,
  // Defaulted HERE, not at the call site: the caller is a component, and the
  // hydration guard bans a wall-clock read in component source. It runs only
  // inside that component's mount effect, never during render.
  now: Date = new Date(),
): FirstTouch {
  return {
    a: (attribution ?? "").slice(0, 512),
    l: (pathname.startsWith("/") ? pathname : "/").slice(0, 200),
    t: now.toISOString(),
    v: visitorId,
  }
}

/** Parse a stored record; anything malformed reads as absent. */
export function parseFirstTouch(raw: string | null): FirstTouch | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<FirstTouch>
    if (typeof o?.a !== "string" || typeof o?.l !== "string" || typeof o?.t !== "string") return null
    if (!Number.isFinite(Date.parse(o.t))) return null
    return { a: o.a, l: o.l, t: o.t, v: typeof o.v === "string" ? o.v : null }
  } catch {
    return null
  }
}

// ── server-side validation (the route) ───────────────────────────────────

// Printable ASCII, no whitespace: the client already reduced both to URL
// pieces (a URL path may legally carry @ ! ( ) , ; and the like, and refusing
// those would drop a real record). Stored as text; every reader escapes.
const ATTR_RE = /^[\x21-\x7E]*$/
const PATH_RE = /^\/[\x21-\x7E]*$/
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/
/** A pre-signup touch may trail account creation only by clock skew. */
export const FIRST_TOUCH_MAX_AFTER_SIGNUP_MS = 10 * 60_000

export type FirstTouchVerdict =
  | { ok: true; row: { first_touch_attribution: string; first_touch_landing: string; first_touch_at: string; first_touch_visitor_id: string | null } }
  | { ok: false; reason: "malformed" | "after_signup" | "future" }

/**
 * Validate a claimed first touch against the account. A touch AFTER the
 * account was created is not how the collector found us (it is a later visit
 * on a new browser, or an old account seeing this code for the first time), so
 * it is refused rather than stored under a name that would mislabel it.
 */
export function validateFirstTouch(body: unknown, accountCreatedAt: string | null, now: Date): FirstTouchVerdict {
  const o = (body ?? {}) as Record<string, unknown>
  const a = typeof o.a === "string" ? o.a : null
  const l = typeof o.l === "string" ? o.l : null
  const t = typeof o.t === "string" ? o.t : null
  const v = typeof o.v === "string" && VISITOR_RE.test(o.v) ? o.v : null
  if (a === null || l === null || t === null) return { ok: false, reason: "malformed" }
  if (a.length > 512 || !ATTR_RE.test(a)) return { ok: false, reason: "malformed" }
  if (l.length > 200 || !PATH_RE.test(l)) return { ok: false, reason: "malformed" }
  const tMs = Date.parse(t)
  if (!Number.isFinite(tMs)) return { ok: false, reason: "malformed" }
  if (tMs > now.getTime() + 60_000) return { ok: false, reason: "future" }
  const created = accountCreatedAt ? Date.parse(accountCreatedAt) : NaN
  if (!Number.isFinite(created) || tMs > created + FIRST_TOUCH_MAX_AFTER_SIGNUP_MS) {
    return { ok: false, reason: "after_signup" }
  }
  return {
    ok: true,
    row: {
      first_touch_attribution: a,
      first_touch_landing: l,
      first_touch_at: new Date(tMs).toISOString(),
      first_touch_visitor_id: v,
    },
  }
}
