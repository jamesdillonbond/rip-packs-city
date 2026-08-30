// lib/upstream/host-circuit.ts
//
// An IN-PROCESS circuit breaker for a dead upstream HOST, for use on
// USER-FACING request paths.
//
// ── WHY THIS EXISTS SEPARATELY FROM lib/pipeline/upstream-breaker.ts ────────
// That one reads `pipeline_runs` to decide whether a CRON tick should run. It is
// right for a cron: one indexed read per tick is free, and the state must be
// shared across invocations. It is the WRONG shape here — a page render must not
// pay a database round-trip to discover that a third party is down, and there is
// no `pipeline_runs` row for a user request anyway. Same idea, different cost
// budget, so deliberately not the same module.
//
// ── WHAT IT IS FOR, measured 2026-08-30 ────────────────────────────────────
// `/api/collection-moments` falls back to Top Shot's GraphQL for moments whose
// `player_name` is null. That is **6.90 % of the 1,904,686 Top Shot rows in
// `wallet_moments_cache` (131,420)**, so the fallback fires on nearly every
// page. It runs batches of 10 in parallel, batches sequentially, each request on
// a 6 s timeout — and `public-api.nbatopshot.com` has been Cloudflare
// 530 / "error code: 1033" since 2026-08-28 ~17Z. On a 50-row page that is one
// ~6 s stall; on the 200-row max, two. Added to a route the same night's work
// had just brought from 40–60 s down to ~2 s.
//
// ⚠ **THIS CHANGES NO RENDERED VALUE.** A skipped fallback and a failed fallback
// both leave `player_name` null — the enrichment simply does not happen, exactly
// as it already does not happen. This removes the WAIT, not a result. If it ever
// starts skipping a fallback that could have SUCCEEDED, that is a bug in the
// cooldown, not a redefinition of the output.
//
// ── PER-PROCESS IS A DELIBERATE TRADE, NOT AN OVERSIGHT ─────────────────────
// State lives in module scope, so it is per lambda instance. Under Fluid Compute
// instances are reused across requests, so a warm instance learns once and then
// skips. A COLD instance pays one probe — which is the correct price for never
// being wrong for long, and is why this needs no shared store.
//
// ── HALF-OPEN BY CONSTRUCTION ──────────────────────────────────────────────
// There is no counter and no "open/closed" flag: the cooldown is measured from
// the last observed failure, so once it elapses the next request probes for real.
// A recovery is picked up within one cooldown with no deploy and nothing to
// remember to switch back on.

type CircuitState = { lastFailureAt: number }

const circuits = new Map<string, CircuitState>()

/** Record that `host` just failed in a way that suggests it is down (not a 404 for one id). */
export function noteUpstreamFailure(host: string, now: number = Date.now()): void {
  circuits.set(host, { lastFailureAt: now })
}

/**
 * Record that `host` answered. Clears the circuit immediately rather than
 * waiting out the cooldown — a recovery should not be penalised for the
 * remainder of a window.
 */
export function noteUpstreamSuccess(host: string): void {
  circuits.delete(host)
}

/**
 * True when `host` failed within `cooldownMs` and should not be called again yet.
 *
 * ⚠ Returns FALSE for an unknown host. The absence of a recorded failure is not
 * evidence of anything, and the safe direction here is to make the call: the
 * cost of one wasted request is bounded, while wrongly skipping means silently
 * dropping enrichment that would have worked.
 */
export function isUpstreamDown(host: string, cooldownMs: number, now: number = Date.now()): boolean {
  const c = circuits.get(host)
  if (!c) return false
  return now - c.lastFailureAt < cooldownMs
}

/** Test-only: clear all circuits so cases cannot leak into one another. */
export function __resetUpstreamCircuits(): void {
  circuits.clear()
}
