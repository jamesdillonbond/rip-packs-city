// app/api/admin/resend-welcome-batch/route.ts
//
// Batched companion to /api/admin/resend-welcome. Two input modes:
//
//   1. Explicit email list: POST { emails: string[] }
//   2. Dormant cohort:      POST ?dormant_since_days=N    (body optional)
//      Selects allow_list rows where:
//        - status = 'active'
//        - welcome_email_sent_at IS NOT NULL AND < NOW() - interval 'N days'
//        - wallet_addr NOT IN (SELECT DISTINCT wallet_address FROM usage_events)
//      i.e. signed-in users who got the welcome but never produced a beacon.
//
// Caps at 50 per call. has_more=true forces the caller to page. Admin-trigger
// only — NOT wired to cron.
//
// Bearer auth via verifyAdminRequest (RPC_ADMIN_TOKEN). Logs each run as
// pipeline 'resend-welcome-batch'.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { processSinglePrewarmRow, type AllowListRow } from "@/lib/allow-list/prewarm"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const MAX_BATCH = 50

interface PostBody {
  emails?: string[]
}

interface BatchFailure {
  email: string
  reason: string
}

type CandidateRow = AllowListRow & {
  status?: string
  prewarm_attempts?: number | null
  welcome_email_sent_at?: string | null
}

async function fetchByEmails(emails: string[]): Promise<CandidateRow[]> {
  const cleaned = [...new Set(
    emails
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"))
  )]
  if (cleaned.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("allow_list")
    .select("id, email, wallet_addr, username, collections, status, prewarm_attempts, welcome_email_sent_at")
    .in("email", cleaned)
  if (error) throw new Error(`allow_list fetch: ${error.message}`)
  return ((data ?? []) as CandidateRow[]).filter((r) => r.status === "active")
}

async function fetchDormant(daysAgo: number): Promise<CandidateRow[]> {
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) {
    throw new Error("dormant_since_days must be a positive number")
  }
  const cutoffIso = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

  // Active signed-in users that got a welcome before the cutoff.
  const { data: candidates, error: candErr } = await supabaseAdmin
    .from("allow_list")
    .select("id, email, wallet_addr, username, collections, status, prewarm_attempts, welcome_email_sent_at")
    .eq("status", "active")
    .not("welcome_email_sent_at", "is", null)
    .lt("welcome_email_sent_at", cutoffIso)
    .order("welcome_email_sent_at", { ascending: true })
    .limit(MAX_BATCH * 4) // over-fetch to absorb the usage_events filter
  if (candErr) throw new Error(`allow_list candidate fetch: ${candErr.message}`)

  const rows = (candidates ?? []) as CandidateRow[]
  if (rows.length === 0) return []

  // Filter out wallets that have any usage_events row. Done client-side
  // because Supabase doesn't support a NOT IN subquery via PostgREST.
  const wallets = rows
    .map((r) => r.wallet_addr)
    .filter((w): w is string => typeof w === "string" && w.length > 0)
  if (wallets.length === 0) return rows

  const { data: telemetry, error: telErr } = await supabaseAdmin
    .from("usage_events")
    .select("wallet_address")
    .in("wallet_address", wallets)
  if (telErr) throw new Error(`usage_events fetch: ${telErr.message}`)

  const active = new Set<string>(
    ((telemetry ?? []) as { wallet_address: string }[])
      .map((r) => r.wallet_address)
      .filter(Boolean)
  )
  return rows.filter((r) => !r.wallet_addr || !active.has(r.wallet_addr))
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()

  const url = new URL(req.url)
  const dormantParam = url.searchParams.get("dormant_since_days")

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const failures: BatchFailure[] = []
  let candidates: CandidateRow[] = []
  let mode: "emails" | "dormant" = "emails"
  let totalMatched = 0

  try {
    if (Array.isArray(body.emails) && body.emails.length > 0) {
      candidates = await fetchByEmails(body.emails)
      totalMatched = candidates.length
    } else if (dormantParam !== null) {
      mode = "dormant"
      const allMatched = await fetchDormant(Number(dormantParam))
      totalMatched = allMatched.length
      candidates = allMatched
    } else {
      return NextResponse.json(
        { error: "Provide either body.emails (string[]) or ?dormant_since_days=N" },
        { status: 400 }
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const hasMore = candidates.length > MAX_BATCH
  if (hasMore) candidates = candidates.slice(0, MAX_BATCH)

  let processed = 0
  let succeeded = 0
  const origin = url.origin

  for (const row of candidates) {
    processed++
    try {
      // Reset welcome + prewarm stamps so processSinglePrewarmRow has a clean
      // slate, matching the single-user route's flow.
      await supabaseAdmin
        .from("allow_list")
        .update({
          welcome_email_sent_at: null,
          welcome_email_error: null,
          prewarm_status: "in_progress",
          prewarm_started_at: new Date().toISOString(),
          prewarm_completed_at: null,
          prewarm_error: null,
          prewarm_attempts: (row.prewarm_attempts ?? 0) + 1,
        })
        .eq("id", row.id as unknown as string)

      const outcome = await processSinglePrewarmRow(row as AllowListRow, origin)
      const ok = (outcome as { ok?: boolean } | null)?.ok ?? true
      if (ok) {
        succeeded++
      } else {
        const reason = (outcome as { error?: string } | null)?.error ?? "processSinglePrewarmRow returned !ok"
        failures.push({ email: String(row.email), reason })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failures.push({ email: String(row.email), reason })
      try {
        await supabaseAdmin.rpc("allow_list_finish_prewarm", {
          p_id: row.id as unknown as string,
          p_status: "failed",
          p_summary: null,
          p_error: `resend-welcome-batch: ${reason}`,
        })
      } catch {
        // ignore — already logged via failures array
      }
    }
  }

  const extra: Record<string, unknown> = {
    mode,
    matched: totalMatched,
    processed,
    succeeded,
    failed_count: failures.length,
    has_more: hasMore,
    elapsed_ms: Date.now() - startMs,
  }
  if (mode === "dormant") extra.dormant_since_days = Number(dormantParam)
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "resend-welcome-batch",
      p_started_at: startedAt,
      p_rows_found: totalMatched,
      p_rows_written: succeeded,
      p_rows_skipped: failures.length,
      p_ok: failures.length === 0,
      p_error: failures.length > 0 ? `${failures.length} failures` : null,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
  } catch (e) {
    console.log(
      "[resend-welcome-batch] log_pipeline_run err:",
      e instanceof Error ? e.message : String(e)
    )
  }

  return NextResponse.json({
    ok: true,
    mode,
    matched: totalMatched,
    processed,
    succeeded,
    failed: failures,
    has_more: hasMore,
  })
}
