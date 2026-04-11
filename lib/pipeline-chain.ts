// lib/pipeline-chain.ts
//
// Shared helper used by the ingest → sales-indexer → fmv-recalc → listing-cache
// chain. Uses next/server `after()` to schedule the outbound fetch after the
// response is sent — without this, un-awaited fetches get killed when Vercel
// tears down the serverless function before the outbound request completes.

import { after } from "next/server"

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
    : "https://rip-packs-city.vercel.app"
  const url = base + nextPath + "?chain=true"
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
