// app/api/cron/panini-team-walk/route.ts
//
// Receiver for scripts/panini-team-walk.mjs — the Panini NBA/MLB team-filtered grid
// walk that feeds franchise-hub STAGING (panini_team_listings; nothing on the site
// reads it yet — docs/features/franchise-hubs.md).
//
// ⚠ WHY A ROUTE. Panini's Cloudflare answers GitHub Actions runners with a 403
// (1000-series error box, measured 2026-09-24), so the walk runs on Trevor's box
// beside the soccer runner, which holds INGEST_SECRET_TOKEN and no service-role key.
//
// Three ops (body.op), all bearer-guarded:
//   heartbeat — a `panini-team-walk-heartbeat` marker BEFORE a target's walk
//   ingest    — one flush of listings -> panini_team_listings_ingest; returns what
//               the RPC says it WROTE, never what was offered
//   finish    — the target's panini-team-walk pipeline_runs row
//
// ⚠ A FAILED WRITE IS A NON-2xx. The walker treats any non-2xx as a failed flush,
// withholds `complete` (so nothing is retired) and reports the run ok=false.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { apiErrorResponse } from "@/lib/api-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { parseTeamWalkBody, TEAM_WALK_PIPELINE } from "@/lib/chains/panini/team-walk"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Each DB call is bounded under the 60 s wall, so a stalled write answers the walker
// with a non-2xx it can act on instead of a platform 504.
const DB_BUDGET_MS = 45_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function boundedRpc(db: any, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  try {
    return await withBoardBudget<{ data: unknown; error: unknown }>(Promise.resolve(db.rpc(fn, args)), fn, DB_BUDGET_MS, "cron/panini-team-walk/")
  } catch (e) {
    return { data: null, error: e }
  }
}

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  return Boolean((ingest && auth === `Bearer ${ingest}`) || (cron && auth === `Bearer ${cron}`))
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 })
  }
  const parsed = parseTeamWalkBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 })
  const v = parsed.value
  const target = `${v.sport}:${v.team}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  if (v.op === "heartbeat") {
    const landed = await writeInvocationHeartbeat({
      pipeline: TEAM_WALK_PIPELINE,
      startedAtMs: Date.parse(v.walkStartedAt),
      collectionSlug: "panini_blockchain",
      extra: { target },
    })
    return NextResponse.json({ landed }, { status: landed ? 200 : 503 })
  }

  if (v.op === "ingest") {
    const { data, error } = await boundedRpc(db, "panini_team_listings_ingest", {
      p_sport: v.sport,
      p_team_raw: v.team,
      p_walk_started_at: v.walkStartedAt,
      p_rows: v.rows,
      p_complete: v.complete,
    })
    if (error) return apiErrorResponse(error, "api/cron/panini-team-walk")
    const n = (k: string) => {
      const x = Number((data as Record<string, unknown> | null)?.[k])
      return Number.isFinite(x) ? x : null
    }
    const written = n("written")
    // An RPC that answered without a count has not told us what landed.
    if (written == null) return NextResponse.json({ error: "ingest returned no write count" }, { status: 502 })
    return NextResponse.json({ written, mapped: n("mapped"), unmapped: n("unmapped"), retired: n("retired") })
  }

  const { error } = await boundedRpc(db, "log_pipeline_run", {
    p_pipeline: TEAM_WALK_PIPELINE,
    p_started_at: v.walkStartedAt,
    p_rows_found: v.listingsSeen,
    p_rows_written: v.written,
    p_rows_skipped: 0,
    p_ok: v.ok,
    p_error: v.error,
    p_collection_slug: "panini_blockchain",
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: { ...v.extra, target, pages: v.pages },
  })
  if (error) return apiErrorResponse(error, "api/cron/panini-team-walk")
  return NextResponse.json({ logged: true })
}
