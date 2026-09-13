// The sentinel's OWN wall budget, applied to every query it issues.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// `app/api/sentinel/route.ts` runs ~45 database reads in sequence under a
// 180 s `maxDuration`. Each arm degrades its own timeout to an INCONCLUSIVE
// warn — correct, and earned — but no arm can see the CLOCK. Under a saturation
// spell three arms each waiting out a two-minute statement budget is 360 s of
// waiting inside a 180 s wall, and a wall kill runs neither the success path
// nor any catch: NO terminal `pipeline_runs` row, NO Telegram, NO JSON for the
// GHA runner (which then reds the badge after three 190 s attempts). The
// instrument that exists to report saturation is the one thing saturation
// silences completely.
//
// Measured 2026-09-13 (pipeline_runs, 24 SURVIVING runs): p50 39.6 s, p90
// 153.6 s, max 162.4 s of 180 s, four runs over 150 s — and those are the
// survivors; the 16:48Z tick that day 504'd ("Task timed out after 180
// seconds") and wrote nothing. The route's own header had carried "Still open:
// per-check timeouts" since the 60 → 180 s raise.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
// ONE fetch wrapper on the route's supabase client, not forty-five per-arm
// edits — the guard-that-names-its-instances trap would have the forty-sixth
// arm ship unbounded. Every request gets an AbortSignal sized to
// `min(perQueryCap, remaining budget)`; once the budget is spent, further
// requests are REFUSED before they leave the process, with a message the
// arms' existing catch branches classify as inconclusive. So a sweep that
// would have died at the wall instead ends with every unevaluated arm NAMED,
// the Measurement Blackout arm counting them, a terminal row, and delivery.
//
// Two phases, because the terminal work must never be refused:
//   • "checks"   — budget = wall − reserve; refuse once it is spent.
//   • "terminal" — the previous-sweep read, delivery and log_pipeline_run get
//                  whatever wall remains, never refused.
// A null clock (no sweep in flight — module init, a caller outside
// runSentinel) gets the per-query cap only.
//
// ⚠ The numbers are DERIVED, not chosen (the unbounded-fetch ratchet's rule:
// a cap sized off a guess about the upstream converts working behaviour into
// failure). The cap is sized so the budget survives three consecutive
// worst-case arms (3 × 45 s = 135 s < 140 s); the reserve covers two 10 s
// delivery bounds plus the terminal write, which has measured up to 47 s
// under saturation. Re-derive both if `maxDuration` or the arm count moves.
//
// ⚠ Aborting the client side does NOT cancel the statement in Postgres — it
// runs on to its own statement_timeout. This wrapper stops the sentinel
// WAITING; it does not reduce the load the probe placed. Cheap probes are the
// other half (see the coverage / FMV-confidence rewrites of 2026-09-13).

export const WALL_BUDGET_EXHAUSTED = "aborted: sentinel wall budget spent";

export type WallBudgetPhase = "checks" | "terminal";

export interface WallBudgetClock {
  /** When the sweep started (ms since epoch). */
  startedAtMs: number;
  phase: WallBudgetPhase;
}

export interface WallBudgetOptions {
  /** The route's `maxDuration`, in ms. */
  wallMs: number;
  /** Held back from the checks phase for delivery + the terminal write. */
  reserveMs: number;
  /** No single request may hold the sweep longer than this. */
  perQueryCapMs: number;
  /** The sweep in flight, or null when none is. Read on EVERY request. */
  clock: () => WallBudgetClock | null;
  baseFetch?: typeof fetch;
  now?: () => number;
}

/** A request refused before it left the process, or the bound it gets. */
export type QueryDeadline =
  | { kind: "refuse"; message: string }
  | { kind: "bound"; timeoutMs: number };

// A request that cannot finish inside this is not worth starting.
const MIN_QUERY_MS = 1_000;
// The terminal phase keeps this much of the wall for the JSON response itself.
const TERMINAL_MARGIN_MS = 3_000;
// And never bounds a terminal request tighter than this, so a sweep that ended
// right at the budget still gets a real attempt at its terminal row.
const MIN_TERMINAL_MS = 5_000;

const secs = (ms: number) => (ms / 1000).toFixed(1);

/**
 * Pure: what deadline does the next request get, given the sweep clock?
 *
 * Exported so the arithmetic is testable without a fetch. The route's
 * behaviour is exactly this function plus an AbortSignal.
 */
export function queryDeadline(
  opts: Pick<WallBudgetOptions, "wallMs" | "reserveMs" | "perQueryCapMs">,
  clock: WallBudgetClock | null,
  nowMs: number,
): QueryDeadline {
  const cap = Math.max(MIN_QUERY_MS, opts.perQueryCapMs);
  if (!clock) return { kind: "bound", timeoutMs: cap };

  const elapsed = Math.max(0, nowMs - clock.startedAtMs);

  if (clock.phase === "terminal") {
    const left = opts.wallMs - elapsed - TERMINAL_MARGIN_MS;
    return { kind: "bound", timeoutMs: Math.max(MIN_TERMINAL_MS, left) };
  }

  const budget = opts.wallMs - opts.reserveMs;
  const remaining = budget - elapsed;
  if (remaining < MIN_QUERY_MS) {
    return {
      kind: "refuse",
      message:
        `${WALL_BUDGET_EXHAUSTED} (${secs(elapsed)}s elapsed of a ${secs(budget)}s query budget ` +
        `inside a ${secs(opts.wallMs)}s wall) — this arm did not evaluate`,
    };
  }
  return { kind: "bound", timeoutMs: Math.min(cap, remaining) };
}

/**
 * A `fetch` for supabase-js `global.fetch` that applies `queryDeadline` to
 * every request the client makes.
 */
export function createWallBudgetFetch(opts: WallBudgetOptions): typeof fetch {
  const base = opts.baseFetch ?? fetch;
  const now = opts.now ?? Date.now;
  return async (input, init) => {
    const d = queryDeadline(opts, opts.clock(), now());
    if (d.kind === "refuse") throw new Error(d.message);
    const timeout = AbortSignal.timeout(d.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}
