// lib/pipeline-chain.ts
//
// Shared helper used by the ingest → sales-indexer → fmv-recalc → listing-cache
// chain. Each step fires the next step as a fire-and-forget POST so no single
// Vercel function has to wait for the whole pipeline to complete.

export async function fireNextPipelineStep(nextPath: string, chain: boolean) {
  if (!chain) return
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) return
  const base = process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "https://rip-packs-city.vercel.app"
  const url = base + nextPath + "?chain=true"
  try {
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }).catch(() => {})
  } catch {
    /* swallow — fire-and-forget */
  }
}
