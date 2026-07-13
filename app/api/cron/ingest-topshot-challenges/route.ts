// app/api/cron/ingest-topshot-challenges/route.ts
//
// Cron for the automated Top Shot challenge-definition ingest. WIRED to the real feed — the
// `searchChallenges` operation (VARIABLE challenges, variableSlots) through the topshot-proxy
// worker — upserting each challenge + its slots, then resolving slot queries to eligible
// editions and refreshing cached costs (lib/challenges/topshot-ingest.ts; slot model + review
// in docs/audits/challenge-tracker-review-2026-07-13.md).
//
// Gated by CHALLENGE_INGEST_ENABLED === "true" (no-ops otherwise). Scheduled via vercel.json
// (daily); Vercel cron issues a GET with `Authorization: Bearer $CRON_SECRET`, and a manual
// run may POST with $INGEST_SECRET_TOKEN — both accepted. The work + pipeline_runs log move
// into after() so a slow upstream can't trip the caller's client timeout. Writes nothing on a
// shape mismatch (the adapter throws → logged, ok=false).

import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { challengeIngestEnabled, ingestTopshotChallenges } from "@/lib/challenges/topshot-ingest"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE_NAME = "ingest-topshot-challenges"

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cronSecret && auth === `Bearer ${cronSecret}`) || (!!ingest && auth === `Bearer ${ingest}`)
}

async function run(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!challengeIngestEnabled()) {
    return NextResponse.json(
      { status: "disabled", note: "CHALLENGE_INGEST_ENABLED is not 'true'. Set it (with TS_PROXY_SECRET) in Vercel to enable the scheduled searchChallenges ingest. See docs/audits/challenge-tracker-review-2026-07-13.md." },
      { status: 200 }
    )
  }

  after(async () => {
    let ok = true
    let errMsg: string | null = null
    let result: { fetched: number; upserted: number; skipped: number } | null = null
    try {
      result = await ingestTopshotChallenges(supabaseAdmin)
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_ok: ok,
        p_extra: { ...(result ?? {}), error: errMsg },
      })
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
