// Shared pure logic for the historical Flow backfill cursor walk.
//
// The event-ingest edge functions (ingest-allday-pack-opens,
// ingest-topshot-pack-opens-history, sales-serial-backfill, …) all walk a block
// cursor DOWN toward a genesis floor, one spork at a time, and must decide two
// things on every tick with zero Deno/network dependencies:
//
//   1. reachableFloor  — the lowest block any path can serve right now, so the
//      backfill TERMINATES at the floor instead of 404-looping below it. This is
//      the exact bug fixed 2026-07-11: a window straddling the spork floor 404'd
//      forever and never advanced the cursor.
//   2. sporkFloorOf    — the lowest block of the spork that contains a height, so
//      a scan window never crosses a spork boundary (the proxy rejects those).
//   3. isTransient     — whether a failed fetch should be RETRIED next tick
//      (network/rate-limit/5xx) or SKIPPED as permanent (404 pruned block, 4xx).
//
// This module is a Deno-and-vitest-importable extraction so the walk math is
// pinned by unit tests. Constants are passed in (the edge functions own the live
// spork table + the SPORK_AVAILABLE env gate) so this file has no globals.
//
// NOTE: the deployed edge functions still carry inline copies of this logic;
// wiring them to import from here is a deploy-gated follow-up (Deno deploy +
// one known-height verification), tracked so the two don't silently diverge.

export interface SporkConfig {
  /** mainnet current-spork root. Blocks >= this are served by rest-mainnet. */
  currentSporkMin: number
  /** Lowest block recoverable by ANY listed spork (below this = gone forever). */
  sporkFloor: number
  /** Per-spork upper block (next spork root − 1), ascending. */
  sporkMaxHeights: number[]
  /** True when the spork proxy is wired (SPORK_PROXY_URL + SECRET present). */
  sporkAvailable: boolean
}

/**
 * Lowest block reachable at all right now. Anything requested below this is
 * clamped up to it, so the backfill stops at the floor instead of 404ing.
 */
export function reachableFloor(requested: number, cfg: SporkConfig): number {
  return cfg.sporkAvailable
    ? Math.max(requested, cfg.sporkFloor)
    : Math.max(requested, cfg.currentSporkMin)
}

/**
 * Lowest block of the spork that contains height `h`, so a scan window stays
 * inside one spork (the events endpoint rejects cross-boundary ranges).
 */
export function sporkFloorOf(h: number, cfg: SporkConfig): number {
  if (h >= cfg.currentSporkMin) return cfg.currentSporkMin
  let lo = cfg.sporkFloor
  for (const maxH of cfg.sporkMaxHeights) {
    if (h <= maxH) return lo
    lo = maxH + 1
  }
  return lo
}

/**
 * A transient error is worth retrying the same window next tick (network blip /
 * rate-limit / node 5xx). A permanent error (404 pruned block, 400/401) means
 * the window will never succeed and the backfill must SKIP past it rather than
 * wedge forever. status 0 = fetch threw (treated as transient).
 */
export function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}

// ── JSON-CDC primitive unwrap (shared by every event parser) ──────────────────
// The event ingest functions read Cadence event fields the same way; a wrong
// Optional/typed unwrap silently drops ids and starves the backfill.

/** Find a named field's value node inside a decoded Cadence event. */
export function cdcField(ev: any, name: string): any {
  return ev?.value?.fields?.find((x: any) => x.name === name)?.value
}

/** Unwrap a typed / Optional JSON-CDC node down to its primitive (or null). */
export function cdcPrim(v: any): any {
  if (v == null) return null
  if (v.type === "Optional") return cdcPrim(v.value)
  if (v.value !== undefined && (typeof v.value !== "object" || v.value === null)) return v.value
  if (v.value && v.value.value !== undefined) return cdcPrim(v.value)
  return null
}
