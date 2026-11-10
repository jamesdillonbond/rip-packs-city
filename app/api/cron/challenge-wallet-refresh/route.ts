// app/api/cron/challenge-wallet-refresh/route.ts
//
// Hourly (vercel.json): while a trophy challenge is OPEN, bring every entrant's
// recent Top Shot purchases into their wallet cache, verified on-chain
// (lib/trophy/recent-buys.ts). 2026-11-10: spitehouse stopped Dame Time at 5 of
// 6 holding a sixth Lillard bought after his wallet's last walk — the picker,
// the ownership gate and both fill paths read only the cache, and nothing
// refreshed it for hours. This keeps the cache within ~1 h of the chain for the
// people a challenge depends on, without a full five-collection walk.
//
// Population: saved wallets of users with a challenge case that is NOT complete,
// on a challenge that is active and not past ends_at. Zero such wallets is a
// clean run (ok, wallets 0), not a failure.
//
// ⚠ `ok` is derived from the per-wallet results: any wallet whose sync could not
// run makes the run not-ok and is named in `extra.errors`. `added` counts rows
// the writer RETURNED.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { syncRecentTopShotBuysForWallets } from "@/lib/trophy/recent-buys"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "challenge-wallet-refresh"
const MAX_WALLETS = 150

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cronSecret && bearerMatches(auth, "CRON_SECRET")) || (!!ingest && bearerMatches(auth, "INGEST_SECRET_TOKEN"))
}

/** Saved wallets of entrants with an unfinished case on an open challenge. */
async function openChallengeWallets(): Promise<{ wallets: string[]; error: string | null }> {
  const nowIso = new Date().toISOString()
  const ch = await supabaseAdmin
    .from("trophy_challenges")
    .select("id, ends_at")
    .eq("is_active", true)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
  if (ch.error) return { wallets: [], error: `challenges: ${ch.error.message}` }
  const ids = ((ch.data ?? []) as { id: string }[]).map((c) => c.id)
  if (ids.length === 0) return { wallets: [], error: null }

  const cases = await supabaseAdmin
    .from("trophy_cases")
    .select("user_id")
    .in("challenge_id", ids)
    .is("completed_at", null)
    .limit(1000)
  if (cases.error) return { wallets: [], error: `cases: ${cases.error.message}` }
  const users = [...new Set(((cases.data ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((u): u is string => !!u))]
  if (users.length === 0) return { wallets: [], error: null }

  const sw = await supabaseAdmin.from("saved_wallets").select("wallet_addr").in("user_id", users).limit(1000)
  if (sw.error) return { wallets: [], error: `wallets: ${sw.error.message}` }
  const wallets = [
    ...new Set(
      ((sw.data ?? []) as { wallet_addr: unknown }[])
        .map((r) => (typeof r.wallet_addr === "string" ? r.wallet_addr : null))
        .filter((w): w is string => !!w)
    ),
  ]
  return { wallets: wallets.slice(0, MAX_WALLETS), error: null }
}

async function run(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const invokedAt = Date.now()
  after(async () => {
    // Heartbeat BEFORE the work: a maxDuration kill is otherwise invisible.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: invokedAt }, supabaseAdmin)
    const started = Date.now()
    let ok = true
    const extra: Record<string, unknown> = {}
    try {
      const pop = await openChallengeWallets()
      if (pop.error) {
        ok = false
        extra.error = pop.error
      } else {
        const results = await syncRecentTopShotBuysForWallets(supabaseAdmin, pop.wallets)
        const errors = results.filter((r) => r.error).map((r) => ({ wallet: r.wallet, error: r.error }))
        ok = errors.length === 0
        extra.wallets = pop.wallets.length
        extra.candidates = results.reduce((n, r) => n + r.candidates, 0)
        extra.held = results.reduce((n, r) => n + r.held, 0)
        extra.added = results.reduce((n, r) => n + r.added, 0)
        if (errors.length) extra.errors = errors.slice(0, 10)
      }
    } catch (e) {
      ok = false
      extra.error = e instanceof Error ? e.message : String(e)
    }
    extra.elapsed_ms = Date.now() - started
    try {
      await supabaseAdmin.rpc("log_pipeline_run", { p_pipeline: PIPELINE_NAME, p_ok: ok, p_extra: extra })
    } catch {
      /* logging is best-effort */
    }
  })

  return NextResponse.json({ status: "accepted" }, { status: 202 })
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
