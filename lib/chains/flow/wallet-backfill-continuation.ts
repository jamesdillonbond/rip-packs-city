// The wallet-backfill route re-dispatches itself to continue a long walk (MAX_CONTINUATIONS).
// Lives here, not in the route file: a Next.js route may only export its handlers.

export interface ContinuationDispatch {
  ok: boolean
  depth: number
  attempts: number
  /** HTTP status of the last attempt, or null when it threw / never ran */
  status: number | null
  error: string | null
}

/**
 * Re-dispatch this route for the same wallet. Bounded wait; never throws.
 *
 * ⛔ 2026-11-09 (#245): this was `fetch(...).catch(() => {})` — status discarded, error
 * swallowed. geds' chain stopped after the 7:45 AM PT walk (ended 7:50:07, `timeout`, 0
 * chunk errors) and NO request reached the route afterwards (Vercel logs), with nothing
 * recording why. Now: one retry (a duplicate is harmless — the route answers
 * `skipped_in_progress` for a wallet already walking), and the outcome is returned so the
 * caller logs it. Budget: walks end by ~273 s of the 300 s wall, so 2 × 8 s + 1 s fits.
 */
export async function dispatchContinuation(
  url: string,
  wallet: string,
  depth: number,
  fetchImpl: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ContinuationDispatch> {
  const out: ContinuationDispatch = { ok: false, depth, attempts: 0, status: null, error: null }
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) return { ...out, error: "INGEST_SECRET_TOKEN unset" }
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return { ...out, error: "bad request url" }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await pause(1_000)
    out.attempts = attempt
    try {
      const resp = await fetchImpl(`${origin}/api/wallet-backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wallet, skip_cached: true, continuation: depth }),
        signal: AbortSignal.timeout(8_000),
      })
      out.status = resp.status
      out.error = resp.ok ? null : `HTTP ${resp.status}`
      if (resp.ok) return { ...out, ok: true }
    } catch (err) {
      out.status = null
      out.error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 160)
    }
  }
  return out
}
