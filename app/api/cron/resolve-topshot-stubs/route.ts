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

async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  errorMsg: string | null
  extra: Record<string, unknown>
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "resolve-topshot-stubs",
      p_started_at: args.startedAtIso,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
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
