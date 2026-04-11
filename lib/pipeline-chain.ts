// lib/pipeline-chain.ts
//
// Shared helper used by the ingest → sales-indexer → fmv-recalc → listing-cache
// chain. Each step fires the next step as a fire-and-forget POST so no single
// Vercel function has to wait for the whole pipeline to complete.

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
  console.log(`[PIPELINE-CHAIN] Chaining to ${nextPath} at ${url}`)
  try {
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
      .then((res) => {
        console.log(`[PIPELINE-CHAIN] ${nextPath} kicked off — status=${res.status}`)
      })
      .catch((err) => {
        console.log(`[PIPELINE-CHAIN] ${nextPath} fetch error:`, err instanceof Error ? err.message : String(err))
      })
  } catch (err) {
    console.log(`[PIPELINE-CHAIN] ${nextPath} sync throw:`, err instanceof Error ? err.message : String(err))
  }
}
