// app/api/cron/resolve-topshot-stubs/route.ts
//
// Thin Vercel-side trigger for the topshot-stub-resolver Supabase edge
// function. cron-job.org pings this endpoint every 30min; we forward to
// the edge function over its public URL with the shared INGEST_SECRET_TOKEN
// Bearer header, then write a pipeline_runs row capturing the result so
// /admin/pipeline-health (R8) can track drift.
//
// We could call the edge function directly from cron-job.org, but routing
// through Vercel keeps the auth + observability story consistent with the
// rest of the cron tree.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

export const dynamic = "force-dynamic"
export const maxDuration = 30

function isAuthed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && auth === `Bearer ${ingest}`) return true
  if (cron && auth === `Bearer ${cron}`) return true
  const qToken = req.nextUrl.searchParams.get("token") ?? ""
  if (ingest && qToken === ingest) return true
  if (cron && qToken === cron) return true
  return false
}

/**
 * Pull the edge fn's real counters out of its JSON response body.
 *
 * These were hardcoded `0`s until 2026-07-27, which made this pipeline's
 * rows_found/written/skipped a literal fiction — `rows_written = 0` across 140
 * runs meant nothing at all, so the standing "parts that don't sum" sweep could
 * never see this pipeline. Forward what the edge fn actually reports, or nothing.
 */
export function countersFrom(body: unknown): { found: number; written: number; skipped: number } | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  if (typeof b.targets_found !== "number") return null
  return {
    found: num(b.targets_found),
    written: num(b.rows_resolved),
    skipped:
      num(b.rows_skipped_no_onchain_ids) +
      num(b.rows_skipped_cadence_err) +
      num(b.rows_skipped_no_player_data) +
      num(b.rows_skipped_upsert_err) +
      num(b.rows_no_change),
  }
}

async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  errorMsg: string | null
  extra: Record<string, unknown>
  counters?: { found: number; written: number; skipped: number } | null
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "resolve-topshot-stubs",
      p_started_at: args.startedAtIso,
      p_rows_found: args.counters?.found ?? 0,
      p_rows_written: args.counters?.written ?? 0,
      p_rows_skipped: args.counters?.skipped ?? 0,
      p_ok: args.ok,
      p_error: args.errorMsg,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

export async function POST(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  after(async () => {
    // Invocation heartbeat, written BEFORE the work and awaited.
    //
    // ⚠ `try/catch` CANNOT catch a `maxDuration` kill, and this route has the
    // SMALLEST WALL in the fleet at **30 s**. Over the 73 h `pipeline_runs`
    // retains (read 2026-09-02) its 146 recorded ticks reach **29,313 ms —
    // 97.7% of the wall** — with three more in the 21.8–25.2 s band.
    //
    // ⭐ AND THE OBSERVED MAXIMUM IS CENSORED AT THE WALL BY CONSTRUCTION: a tick
    // that CROSSED 30 s wrote nothing, so it is absent from that distribution
    // rather than at the top of it. The recorded max can therefore never exceed
    // the ceiling no matter how often the ceiling is hit, which is exactly the
    // shape a marker exists to make visible.
    //
    // ⚠ This pipeline is NOT on `pipeline_cadence_watchlist`, so a kill here is
    // not merely misread — it is unobserved by anything at all.
    //
    // ⓘ Deliberately NOT claimed: a 90-minute gap on 2026-09-01 04:39Z looks like
    // two killed ticks and is not — it falls inside a correlated band where 28
    // scheduled pipelines each skipped a tick (see R77), so it is a scheduler
    // event, not this route dying.
    await writeInvocationHeartbeat({
      pipeline: "resolve-topshot-stubs",
      startedAtMs: Date.parse(startedAtIso),
    })
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const ingestToken = process.env.INGEST_SECRET_TOKEN
    if (!supabaseUrl || !ingestToken) {
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: "missing NEXT_PUBLIC_SUPABASE_URL or INGEST_SECRET_TOKEN",
        extra: {},
      })
      return
    }

    const fnUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/topshot-stub-resolver`
    try {
      const res = await fetch(fnUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ingestToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(120_000),
      })

      const bodyText = await res.text().catch(() => "")
      let bodyJson: unknown = null
      try {
        bodyJson = JSON.parse(bodyText)
      } catch { /* keep as text */ }

      await logPipelineRun({
        startedAtIso,
        ok: res.ok,
        errorMsg: res.ok ? null : `edge fn HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
        extra: { status: res.status, body: bodyJson ?? bodyText.slice(0, 500) },
        counters: countersFrom(bodyJson),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: `edge fn fetch threw: ${msg}`,
        extra: {},
      })
    }
  })

  return NextResponse.json({
    ok: true,
    triggered_at: startedAtIso,
    target: "topshot-stub-resolver",
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
