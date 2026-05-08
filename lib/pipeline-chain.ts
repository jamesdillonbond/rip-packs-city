// lib/pipeline-chain.ts
//
// Shared helper used by the ingest → sales-indexer → fmv-recalc → listing-cache
// chain. Uses next/server `after()` to schedule the outbound fetch after the
// response is sent — without this, un-awaited fetches get killed when Vercel
// tears down the serverless function before the outbound request completes.

import { after } from "next/server"

// Fire-and-forget invocation of a Supabase Edge Function. Used for the
// allday-unmapped-resolver historical-backlog drain, which lives outside
// the Vercel base URL and so can't piggyback on `fireNextPipelineStep`.
// Returns immediately; any failure is logged but never propagates.
export async function fireSupabaseEdgeFunction(
  functionName: string,
  body: Record<string, unknown> = {},
) {
  const token = process.env.INGEST_SECRET_TOKEN
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!token || !supabaseUrl) {
    console.log(`[PIPELINE-CHAIN] Skipping edge fn ${functionName} — token or supabase URL missing`)
    return
  }
  const url = `${supabaseUrl}/functions/v1/${functionName}`
  after(async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      console.log(`[PIPELINE-CHAIN] Fired edge fn ${functionName} — status=${res.status}`)
    } catch (err) {
      console.error(
        `[PIPELINE-CHAIN] Edge fn fetch error for ${functionName}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  })
}

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
  const base = process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "https://www.rippackscity.com"
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
