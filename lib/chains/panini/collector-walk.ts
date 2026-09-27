// lib/chains/panini/collector-walk.ts — request validation for /api/cron/panini-collector-walk.
//
// The Panini collector walk reads a username's PUBLIC Panini profile in the runner's real
// browser on Trevor's box (Panini's Cloudflare 403s datacenter IPs — measured 2026-09-24 for
// the team walk), so like the team walk it holds INGEST_SECRET_TOKEN and no service-role key,
// and posts here. Pure so every rejection is testable.
//
// ⚠ ONE INGEST PER USERNAME. panini_collector_walk_ingest retires by SET (url_keys absent from
// the payload), so a walk's holdings must arrive in a single call — a split payload would retire
// the first half. MAX_HOLDINGS bounds that call.

export const COLLECTOR_WALK_PIPELINE = "panini-collector-walk"
export const MAX_HOLDINGS = 5000
export const MAX_PLAN_TARGETS = 50
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/
// Same shape the DB enforces (lib/address.ts isPaniniUsername, folded).
const USERNAME = /^[A-Za-z0-9_.-]{2,16}$/
export const PROFILE_STATES = ["public", "private", "not_found", "unknown"] as const
export type ProfileState = (typeof PROFILE_STATES)[number]

export interface CollectorHolding {
  url_key: string
  psku: string | null
  serial_number: number | null
  mint_cap: number | null
  athlete: string | null
  cardset: string | null
  sport: string | null
  image_url: string | null
}

export type CollectorWalkOp =
  | { op: "plan"; limit: number }
  | { op: "heartbeat"; username: string; walkStartedAt: string }
  | {
      op: "ingest"
      username: string
      walkStartedAt: string
      complete: boolean
      profileState: ProfileState
      reportedTotal: number | null
      unopenedPacks: number | null
      error: string | null
      holdings: CollectorHolding[]
      extra: Record<string, unknown>
    }

const nonNegInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null
const optStr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null

function toHolding(v: unknown): CollectorHolding | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const h = v as Record<string, unknown>
  const urlKey = typeof h.url_key === "string" ? h.url_key.trim() : ""
  if (!urlKey || urlKey.length > 200) return null
  return {
    url_key: urlKey,
    psku: optStr(h.psku, 200),
    serial_number: nonNegInt(h.serial_number),
    mint_cap: nonNegInt(h.mint_cap),
    athlete: optStr(h.athlete, 200),
    cardset: optStr(h.cardset, 200),
    sport: optStr(h.sport, 40),
    image_url: optStr(h.image_url, 500),
  }
}

/** Parse a POST body into an op, or return the reason it is rejected (a 400). */
export function parseCollectorWalkBody(body: unknown): { ok: true; value: CollectorWalkOp } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "body must be a JSON object" }
  const b = body as Record<string, unknown>
  if (b.op === "plan") {
    const limit = typeof b.limit === "number" && Number.isInteger(b.limit) ? b.limit : NaN
    if (!(limit >= 1 && limit <= MAX_PLAN_TARGETS)) return { ok: false, reason: `limit must be an integer from 1 to ${MAX_PLAN_TARGETS}` }
    return { ok: true, value: { op: "plan", limit } }
  }
  const username = typeof b.username === "string" ? b.username.trim().replace(/^@/, "") : ""
  if (!USERNAME.test(username)) return { ok: false, reason: "username must be 2–16 letters, numbers, . _ -" }
  const walkStartedAt = typeof b.walk_started_at === "string" ? b.walk_started_at : ""
  if (!ISO_UTC.test(walkStartedAt)) return { ok: false, reason: "walk_started_at must be an ISO-8601 UTC timestamp" }

  if (b.op === "heartbeat") return { ok: true, value: { op: "heartbeat", username: username.toLowerCase(), walkStartedAt } }

  if (b.op === "ingest") {
    if (!Array.isArray(b.holdings)) return { ok: false, reason: "holdings must be an array" }
    if (b.holdings.length > MAX_HOLDINGS) return { ok: false, reason: `at most ${MAX_HOLDINGS} holdings per walk` }
    const holdings: CollectorHolding[] = []
    for (const raw of b.holdings) {
      const h = toHolding(raw)
      if (!h) return { ok: false, reason: "every holding needs a url_key" }
      holdings.push(h)
    }
    if (typeof b.complete !== "boolean") return { ok: false, reason: "complete must be a boolean" }
    const profileState = PROFILE_STATES.find((s) => s === b.profile_state)
    if (!profileState) return { ok: false, reason: `profile_state must be one of ${PROFILE_STATES.join(", ")}` }
    // A count that was not read is null — never 0 (a 0 here would publish "no unopened packs").
    const reportedTotal = b.reported_total == null ? null : nonNegInt(b.reported_total)
    const unopenedPacks = b.unopened_packs == null ? null : nonNegInt(b.unopened_packs)
    if (b.reported_total != null && reportedTotal == null) return { ok: false, reason: "reported_total must be a non-negative integer or null" }
    if (b.unopened_packs != null && unopenedPacks == null) return { ok: false, reason: "unopened_packs must be a non-negative integer or null" }
    const error = typeof b.error === "string" && b.error ? b.error.slice(0, 500) : null
    const extra = b.extra && typeof b.extra === "object" && !Array.isArray(b.extra) ? (b.extra as Record<string, unknown>) : {}
    return {
      ok: true,
      value: { op: "ingest", username: username.toLowerCase(), walkStartedAt, complete: b.complete, profileState, reportedTotal, unopenedPacks, error, holdings, extra },
    }
  }

  return { ok: false, reason: "op must be plan, heartbeat or ingest" }
}
