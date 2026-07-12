// app/api/cron/ingest-topshot-challenges/route.ts
//
// Cron seam for the automated Top Shot challenge-definition ingest. DISABLED by default
// (CHALLENGE_INGEST_ENABLED !== "true") — it no-ops until the challenge GraphQL shape is
// confirmed (scripts/probe-topshot-challenges.mjs → lib/challenges/topshot-ingest.ts) and
// the flag is flipped on. Auth mirrors the other ingest crons (Bearer INGEST_SECRET_TOKEN);
// the work + pipeline_runs log move into after() so a slow upstream can't trip the caller's
// client timeout. Writes nothing on a shape mismatch (the adapter throws → logged, ok=false).

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
      { status: "disabled", note: "CHALLENGE_INGEST_ENABLED is not 'true' — confirm the challenge GraphQL shape (scripts/probe-topshot-challenges.mjs), fill lib/challenges/topshot-ingest.ts, then enable." },
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
