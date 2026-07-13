// app/api/cron/ingest-topshot-challenges/route.ts
//
// Cron seam for the automated Top Shot challenge-definition ingest. The adapter is now
// WIRED to the real feed — the `searchChallenges` operation (VARIABLE challenges,
// variableSlots) through the topshot-proxy worker — and upserts each challenge + its slots,
// then resolves slot queries to eligible editions and refreshes cached costs
// (lib/challenges/topshot-ingest.ts; slot model + review in
// docs/audits/challenge-tracker-review-2026-07-13.md). It stays DISABLED by default
// (CHALLENGE_INGEST_ENABLED !== "true") — flip that Vercel env var to 'true' to enable the
// scheduled refresh (operator step; TS_PROXY_SECRET must be set). Auth mirrors the other
// ingest crons (Bearer INGEST_SECRET_TOKEN); the work + pipeline_runs log move into after()
// so a slow upstream can't trip the caller's client timeout. Writes nothing on a shape
// mismatch (the adapter throws → logged, ok=false).

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

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!challengeIngestEnabled()) {
    return NextResponse.json(
      { status: "disabled", note: "CHALLENGE_INGEST_ENABLED is not 'true'. The searchChallenges ingest is wired; set CHALLENGE_INGEST_ENABLED=true (with TS_PROXY_SECRET) in Vercel to enable the scheduled refresh. See docs/audits/challenge-tracker-review-2026-07-13.md." },
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
