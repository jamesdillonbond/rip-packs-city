// lib/pipeline-chain.ts
//
// Shared helper used by the ingest → sales-indexer → fmv-recalc → listing-cache
// chain. Uses next/server `after()` to schedule the outbound fetch after the
// response is sent — without this, un-awaited fetches get killed when Vercel
// tears down the serverless function before the outbound request completes.

import { after } from "next/server"

// Production chains to the production DOMAIN, never VERCEL_URL. VERCEL_URL is the
// deployment's generated *.vercel.app URL, which Vercel Deployment Protection
// gates behind a Vercel login — so a chain fired at it 401s before the route runs
// and writes no pipeline_runs row (security audit 2026-10-25, finding 1). Preview
// and local runs keep chaining to their own deployment.
export function chainBaseUrl(): string {
  if (process.env.VERCEL_ENV === "production") return "https://www.rippackscity.com"
  return process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "https://www.rippackscity.com"
}

// (Removed 2026-06-16) `fireSupabaseEdgeFunction` — the only thing it ever fired
// was the `allday-unmapped-resolver` edge fn, whose consumer-GQL leg is now
// Cloudflare-blocked for edge egress. That drain moved to the Vercel route
// /api/cron/allday-resolve-unmapped (fired via fireNextPipelineStep), leaving the
// helper with zero callers. See docs handoff 2026-06-16-allday-consumer-gql-403.

export async function fireNextPipelineStep(nextPath: string, chain: boolean) {
  if (!chain) {
    console.log(`[PIPELINE-CHAIN] Skipping ${nextPath} — chain flag not set`)
    return
  }
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) {
    console.log(`[PIPELINE-CHAIN] Skipping ${nextPath} — INGEST_SECRET_TOKEN not set`)
    return
  }
  const base = chainBaseUrl()
  const separator = nextPath.includes("?") ? "&" : "?"
  const url = base + nextPath + separator + "chain=true"
  console.log(`[PIPELINE-CHAIN] Scheduling chain to ${nextPath} at ${url}`)

  after(async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })
      console.log(`[PIPELINE-CHAIN] Chained to ${nextPath} — status=${res.status}`)
    } catch (err) {
      console.error(
        `[PIPELINE-CHAIN] Chain fetch error for ${nextPath}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  })
}
