// lib/chains/panini/team-walk.ts — request validation for /api/cron/panini-team-walk.
//
// The Panini team walk runs on Trevor's machine (Panini's Cloudflare returns 403
// "1000s" to GitHub Actions runners — measured 2026-09-24), so it cannot hold a
// service-role key. It posts here with INGEST_SECRET_TOKEN and this route calls
// the service-role-only RPCs on its behalf. Pure so every rejection is testable.

export const TEAM_WALK_PIPELINE = "panini-team-walk"
export const MAX_ROWS_PER_POST = 1000
const SPORTS = new Set(["Basketball", "Baseball"])
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/

export const MAX_PLAN_TARGETS = 50

export type TeamWalkOp =
  | { op: "plan"; limit: number }
  | { op: "heartbeat"; sport: string; team: string; walkStartedAt: string }
  | { op: "ingest"; sport: string; team: string; walkStartedAt: string; rows: unknown[]; complete: boolean }
  | {
      op: "finish"
      sport: string
      team: string
      walkStartedAt: string
      pages: number
      listingsSeen: number
      written: number
      ok: boolean
      error: string | null
      extra: Record<string, unknown>
    }

const nonNegInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null

/** Parse a POST body into an op, or return the reason it is rejected (a 400). */
export function parseTeamWalkBody(body: unknown): { ok: true; value: TeamWalkOp } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "body must be a JSON object" }
  const b = body as Record<string, unknown>
  // `plan` names no target — it ASKS which targets to walk (rotation mode).
  if (b.op === "plan") {
    const limit = typeof b.limit === "number" && Number.isInteger(b.limit) ? b.limit : NaN
    if (!(limit >= 1 && limit <= MAX_PLAN_TARGETS)) return { ok: false, reason: `limit must be an integer from 1 to ${MAX_PLAN_TARGETS}` }
    return { ok: true, value: { op: "plan", limit } }
  }
  const sport = typeof b.sport === "string" ? b.sport : ""
  if (!SPORTS.has(sport)) return { ok: false, reason: "sport must be Basketball or Baseball" }
  const team = typeof b.team === "string" ? b.team.trim() : ""
  if (!team || team.length > 80) return { ok: false, reason: "team must be a non-empty string of at most 80 characters" }
  const walkStartedAt = typeof b.walk_started_at === "string" ? b.walk_started_at : ""
  if (!ISO_UTC.test(walkStartedAt)) return { ok: false, reason: "walk_started_at must be an ISO-8601 UTC timestamp" }

  if (b.op === "heartbeat") return { ok: true, value: { op: "heartbeat", sport, team, walkStartedAt } }

  if (b.op === "ingest") {
    if (!Array.isArray(b.rows)) return { ok: false, reason: "rows must be an array" }
    if (b.rows.length > MAX_ROWS_PER_POST) return { ok: false, reason: `at most ${MAX_ROWS_PER_POST} rows per post` }
    if (typeof b.complete !== "boolean") return { ok: false, reason: "complete must be a boolean" }
    return { ok: true, value: { op: "ingest", sport, team, walkStartedAt, rows: b.rows, complete: b.complete } }
  }

  if (b.op === "finish") {
    const pages = nonNegInt(b.pages)
    const listingsSeen = nonNegInt(b.listings_seen)
    const written = nonNegInt(b.written)
    if (pages == null || listingsSeen == null || written == null) {
      return { ok: false, reason: "pages, listings_seen and written must be non-negative integers" }
    }
    if (typeof b.ok !== "boolean") return { ok: false, reason: "ok must be a boolean" }
    const error = typeof b.error === "string" && b.error ? b.error.slice(0, 500) : null
    const extra = b.extra && typeof b.extra === "object" && !Array.isArray(b.extra) ? (b.extra as Record<string, unknown>) : {}
    return { ok: true, value: { op: "finish", sport, team, walkStartedAt, pages, listingsSeen, written, ok: b.ok, error, extra } }
  }

  return { ok: false, reason: "op must be plan, heartbeat, ingest or finish" }
}
