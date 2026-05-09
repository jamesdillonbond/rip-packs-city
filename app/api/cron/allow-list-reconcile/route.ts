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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

async function logRun(opts: {
  startedAt: string
  ok: boolean
  result?: ReconcileResult
  error?: string
}) {
  try {
    await supabaseAdmin.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      started_at: opts.startedAt,
      finished_at: new Date().toISOString(),
      ok: opts.ok,
      error: opts.error ?? null,
      rows_found: opts.result?.promoted_count ?? 0,
      rows_written: opts.result?.promoted_count ?? 0,
      rows_skipped: opts.result?.skipped_count ?? 0,
      extra: {
        promoted_count: opts.result?.promoted_count ?? 0,
        skipped_count: opts.result?.skipped_count ?? 0,
        promoted_emails: opts.result?.promoted_emails ?? [],
      },
    })
  } catch (err) {
    console.warn(
      `[${PIPELINE_NAME}] pipeline_runs insert failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function handle(request: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { ok: false, error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 },
    )
  }
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${ingestToken}`) {
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
