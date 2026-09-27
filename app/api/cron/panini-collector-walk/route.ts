// app/api/cron/panini-collector-walk/route.ts
//
// Receiver for scripts/panini-collector-walk.mjs — reads a username's PUBLIC Panini profile
// (nft.paniniamerica.net/public-profile/collections.html?nickname=<u>&tab=collected) in the
// runner's real browser on Trevor's box, and lands the cards it lists in panini_user_holdings,
// which the Panini Collection tab reads (panini_profile_holdings). Migration 20260927194743.
//
// ⚠ WHY A ROUTE. Panini's Cloudflare answers datacenter IPs with a 403 (team walk, measured
// 2026-09-24), so the walk runs on Trevor's box, which holds INGEST_SECRET_TOKEN and no
// service-role key.
//
// ⚠ WHO IS WALKED. `plan` answers the usernames users LINKED to their RPC profile
// (panini_collector_walk_targets) — opt-in. The box may add an explicit list; nothing here walks
// a name a stranger typed into the Collection tab.
//
// Three ops (body.op), all bearer-guarded:
//   plan      — linked usernames, stalest complete walk first
//   heartbeat — a `panini-collector-walk-heartbeat` marker BEFORE a username's walk
//   ingest    — the whole walk in ONE call (the RPC retires by set), then its pipeline_runs row.
//               Returns what the RPC says it WROTE and whether the DB judged the walk complete.
//
// ⚠ A FAILED WRITE IS A NON-2xx — including the run row: a walk whose record did not land is
// reported to the walker as failed, so the box's log says so.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { apiErrorResponse } from "@/lib/api-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { COLLECTOR_WALK_PIPELINE, parseCollectorWalkBody } from "@/lib/chains/panini/collector-walk"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const DB_BUDGET_MS = 45_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function boundedRpc(db: any, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  try {
    return await withBoardBudget<{ data: unknown; error: unknown }>(Promise.resolve(db.rpc(fn, args)), fn, DB_BUDGET_MS, "cron/panini-collector-walk/")
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
  const parsed = parseCollectorWalkBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 })
  const v = parsed.value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  if (v.op === "plan") {
    const { data, error } = await boundedRpc(db, "panini_collector_walk_targets", {})
    if (error) return apiErrorResponse(error, "api/cron/panini-collector-walk")
    if (!Array.isArray(data)) return NextResponse.json({ error: "plan returned no list" }, { status: 502 })
    const targets = (data as Array<Record<string, unknown>>)
      .filter((r) => typeof r.username === "string" && typeof r.nickname === "string")
      .slice(0, v.limit)
      .map((r) => ({ username: r.username as string, nickname: r.nickname as string, last_complete_at: (r.last_complete_at as string | null) ?? null }))
    return NextResponse.json({ targets })
  }

  if (v.op === "heartbeat") {
    const landed = await writeInvocationHeartbeat({
      pipeline: COLLECTOR_WALK_PIPELINE,
      startedAtMs: Date.parse(v.walkStartedAt),
      collectionSlug: "panini_blockchain",
      extra: { username: v.username },
    })
    return NextResponse.json({ landed }, { status: landed ? 200 : 503 })
  }

  const { data, error } = await boundedRpc(db, "panini_collector_walk_ingest", {
    p: {
      username: v.username,
      walk_started_at: v.walkStartedAt,
      complete: v.complete,
      profile_state: v.profileState,
      reported_total: v.reportedTotal,
      unopened_packs: v.unopenedPacks,
      error: v.error,
      holdings: v.holdings,
    },
  })
  if (error) return apiErrorResponse(error, "api/cron/panini-collector-walk")
  const d = (data as Record<string, unknown> | null) ?? {}
  const n = (k: string) => {
    const x = Number(d[k])
    return typeof d[k] === "number" && Number.isFinite(x) ? x : null
  }
  const written = n("written")
  // An RPC that answered without a count has not told us what landed.
  if (written == null) return NextResponse.json({ error: "ingest returned no write count" }, { status: 502 })
  const dbComplete = d.complete === true

  // The run is ok only when the walker read the whole profile, the DB agreed, and nothing errored.
  const ok = v.complete && dbComplete && v.error == null
  const runError = v.error ?? (v.complete && !dbComplete ? "walker claimed complete; DB disagreed (fewer distinct cards than the profile reported, or profile not public)" : v.complete ? null : "incomplete walk")
  const log = await boundedRpc(db, "log_pipeline_run", {
    p_pipeline: COLLECTOR_WALK_PIPELINE,
    p_started_at: v.walkStartedAt,
    p_rows_found: v.holdings.length,
    p_rows_written: written,
    p_rows_skipped: 0,
    p_ok: ok,
    p_error: runError,
    p_collection_slug: "panini_blockchain",
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: {
      ...v.extra,
      username: v.username,
      profile_state: v.profileState,
      reported_total: v.reportedTotal,
      unopened_packs: v.unopenedPacks,
      retired: n("retired"),
      collected: n("collected"),
      complete: dbComplete,
    },
  })
  const result = { written, retired: n("retired"), collected: n("collected"), complete: dbComplete, logged: !log.error }
  if (log.error) {
    console.error(`[api/cron/panini-collector-walk] run row not recorded for ${v.username}`)
    return NextResponse.json({ ...result, error: "holdings written; run row not recorded" }, { status: 503 })
  }
  return NextResponse.json(result)
}
