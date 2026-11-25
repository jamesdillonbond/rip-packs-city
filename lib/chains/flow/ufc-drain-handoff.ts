// lib/chains/flow/ufc-drain-handoff.ts
//
// 2026-11-25: when `wallet-backfill-ufc`'s enrichment chain stops at its deadline with NULL-key rows
// left (`done=false`), it logged "the rest stays NULL for the next run" — but nothing runs next.
// `/api/cron/ufc-enrichment-drain` (reads ONLY the NULL-edition_key UFC rows, 250 per run, its own
// pipeline_runs row) has had no caller since cron-job.org disabled it on 10-18. Measured 11-25:
// wallet 0x9a26549ac659995d walked 1:44 AM PT, chain enriched 350 over 7 pages and hit the deadline,
// and 114 rows were still unkeyed five hours later (trust arm `ufc_wmc_null_edition_key_aged_rows`).
//
// So the backfill hands the remainder to the drain itself, once, the moment it knows there is one.
// Not a loop: the drain does not re-fire, and a row it cannot key stays visible to the trust arm.
// Kept out of the route file (a route may only export handlers) and out of wallet-backfill-helpers
// (the drain must not import the Flow SDK — see __tests__/ufc-enrichment-drain-does-not-import-the-flow-sdk).

export const UFC_DRAIN_PATH = "/api/cron/ufc-enrichment-drain"

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface DrainHandoff {
  fired: boolean
  status: number | null
  error: string | null
}

/** POST the drain with the ingest bearer. Never throws; the result says what happened. */
export async function fireUfcEnrichmentDrain(
  origin: string,
  token: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<DrainHandoff> {
  if (!token) return { fired: false, status: null, error: "INGEST_SECRET_TOKEN not set" }
  try {
    const res = await fetchFn(`${origin}${UFC_DRAIN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    })
    // the drain answers 202 and works in after(); anything else is a failed hand-off
    return { fired: res.status === 202, status: res.status, error: res.status === 202 ? null : `drain answered ${res.status}` }
  } catch (e) {
    return { fired: false, status: null, error: e instanceof Error ? e.message : String(e) }
  }
}
