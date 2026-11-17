// app/api/cron/allow-list-reconcile/route.ts
//
// Hourly reconciliation sweep that promotes allow_list rows from
// complete_partial → complete once every opted-in collection has a
// wallet_backfill_state row recording a recent scan. Both GET and POST
// supported so cron-job.org / GitHub Actions can hit it via either verb.
//
// Calls the SECDEF reconcile_allow_list_prewarm() RPC which returns
// { ran_at, promoted_count, skipped_count, promoted_emails, skipped_detail }.
// We surface the RPC result verbatim under { ok: true, ...result } and
// also write a pipeline_runs row so the regular ops dashboard catches
// any future failures alongside the rest of the platform pipelines.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { bearerMatches } from "@/lib/auth/bearer-secret"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
) as any

export const dynamic = "force-dynamic"
export const maxDuration = 30

const PIPELINE_NAME = "allow-list-reconcile"

interface ReconcileResult {
  ran_at?: string
  promoted_count?: number
  skipped_count?: number
  promoted_emails?: string[]
  skipped_detail?: unknown
}

// The terminal row goes through the shared helper (lib/pipeline/terminal-run.ts):
// counts are NULL, not 0, when the RPC failed and nothing was counted, and the
// write's own error is read. ⚠ `promoted_emails` is deliberately NOT copied into
// `extra` (it was until 2026-10-18): run telemetry carries counts, never a
// user's email address. The emails stay in the bearer-gated HTTP response.
async function logRun(opts: {
  startedAt: string
  ok: boolean
  result?: ReconcileResult
  error?: string
}) {
  const promoted = opts.result?.promoted_count ?? null
  const skipped = opts.result?.skipped_count ?? null
  await logTerminalRun(
    {
      pipeline: PIPELINE_NAME,
      startedAt: opts.startedAt,
      ok: opts.ok,
      error: opts.error ?? null,
      rowsFound: promoted,
      rowsWritten: promoted,
      rowsSkipped: skipped,
      extra: { promoted_count: promoted, skipped_count: skipped },
    },
    supabaseAdmin,
  )
}

async function handle(request: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { ok: false, error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 },
    )
  }
  // Vercel Cron sends ONLY `Authorization: Bearer $CRON_SECRET` (via GET) and
  // cannot send INGEST_SECRET_TOKEN, so both are accepted — this route moved from
  // a GitHub Actions schedule to a Vercel cron on 2026-08-01 (GHA was delivering
  // ~9 of 24 daily ticks). Same shape as app/api/candy-listings-indexer.
  const cronToken = process.env.CRON_SECRET
  const auth = request.headers.get("authorization")
  const okIngest = bearerMatches(auth, "INGEST_SECRET_TOKEN")
  const okCron = Boolean(cronToken) && bearerMatches(auth, "CRON_SECRET")
  if (!okIngest && !okCron) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()

  try {
    const { data, error } = await supabaseAdmin.rpc("reconcile_allow_list_prewarm")
    if (error) {
      console.error(`[${PIPELINE_NAME}] RPC failed:`, error.message)
      await logRun({ startedAt, ok: false, error: error.message })
      return NextResponse.json(
        { ok: false, error: error.message, ran_at: startedAt },
        { status: 500 },
      )
    }

    const result: ReconcileResult = (data ?? {}) as ReconcileResult
    await logRun({ startedAt, ok: true, result })

    if ((result.skipped_count ?? 0) > 0) {
      console.warn(
        `[${PIPELINE_NAME}] skipped_count=${result.skipped_count} ` +
          `promoted_count=${result.promoted_count ?? 0}`,
      )
    } else {
      console.log(
        `[${PIPELINE_NAME}] ok promoted_count=${result.promoted_count ?? 0}`,
      )
    }

    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${PIPELINE_NAME}] unexpected:`, msg)
    await logRun({ startedAt, ok: false, error: msg })
    return NextResponse.json({ ok: false, error: msg, ran_at: startedAt }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
