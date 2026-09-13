/**
 * The pg_net dispatcher and its response store — as a sentinel arm.
 *
 * ── WHY (2026-09-13) ────────────────────────────────────────────────────────
 * Every edge-function lane, every Atlas walk and every DB-dispatched probe on
 * this platform goes out through pg_net: a request row is queued, a background
 * worker sends it after the enqueuing transaction commits, and the response
 * lands in `net._http_response`. Nothing watched any of that:
 *
 *   • a STALLED WORKER (queue growing, no responses landing) reads, from every
 *     other arm, as "the lanes went silent" — and the register records a
 *     head-of-line block on this very worker taking a lane down (#102/#103);
 *   • the RESPONSE STORE is the largest relation on the instance: 13 GB total
 *     for ~5,400 live rows, because its TOAST (pg_toast_51873) has never been
 *     autovacuumed — register #75, database.md "A HEAP'S STATS DEFECT DOES NOT
 *     IMPLY ITS TOAST WAS FIXED WITH IT" — and it was growing ~2 GB/day with
 *     no instrument reporting the size.
 *
 * ── WHAT THE SQL SIDE READS, and what it costs ─────────────────────────────
 * `check_pg_net_dispatch()`: the queue count (an unlogged table that is usually
 * empty), the last 10 minutes of responses via `_http_response_created_idx`
 * (measured 20 buffers), `max(created)` off the same index, and the store's
 * size from the catalog. No body is read. ~30 buffers per sweep.
 *
 * ── WHY IT WARNS AND NEVER PAGES ────────────────────────────────────────────
 * A backed-up queue during a saturation spell is the spell, not a new incident;
 * the store size is a slow-moving maintenance fact. Both need a human to decide,
 * neither needs a 3am page. Candidates, like the sibling arms.
 */

export type PgNetPayload = {
  queued?: number | string | null
  responses_10m?: number | string | null
  errored_10m?: number | string | null
  http5xx_10m?: number | string | null
  last_response_at?: string | null
  store_bytes?: number | string | null
  store_rows?: number | string | null
  ttl?: string | null
  batch_size?: number | string | null
}

export type PgNetVerdict = { status: "ok" | "warn" | "critical"; detail: string; value?: number }

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

const gb = (bytes: number | null): string => (bytes === null ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GB`)

/**
 * @param warnStoreBytes the response store (heap + toast + indexes) at or above this warns.
 *   Default 8 GiB: the store holds six hours of bodies, measured at ~1.5 GB live; anything
 *   several times that is dead TOAST nothing reclaims (register #75).
 * @param queueWarn queued requests at or above this warn — default 200, one pg_net batch.
 */
export function summarisePgNet(
  payload: PgNetPayload | null | undefined,
  warnStoreBytes = 8 * 1024 ** 3,
  queueWarn = 200,
): PgNetVerdict {
  if (!payload || typeof payload !== "object") {
    return { status: "warn", detail: "check_pg_net_dispatch returned no readable payload — UNMEASURED, not clean" }
  }
  const queued = num(payload.queued)
  const responses = num(payload.responses_10m)
  const errored = num(payload.errored_10m) ?? 0
  const http5xx = num(payload.http5xx_10m) ?? 0
  const store = num(payload.store_bytes)
  // ⚠ A missing count is not a zero. The queue and the response window are the
  // two facts this arm exists to read; without both it has measured nothing.
  if (queued === null || responses === null) {
    return { status: "warn", detail: "check_pg_net_dispatch returned no queue or response count — UNMEASURED, not clean" }
  }

  const problems: string[] = []
  if (queued >= queueWarn) problems.push(`${queued} requests QUEUED (≥${queueWarn}, one pg_net batch) — dispatch is backed up`)
  if (queued > 0 && responses === 0) problems.push(`${queued} queued and NO response landed in 10 min — the pg_net worker looks STALLED`)
  if (responses >= 20 && errored / responses >= 0.25) {
    problems.push(`${errored} of ${responses} responses in 10 min timed out or errored (${Math.round((100 * errored) / responses)}%)`)
  }
  if (store !== null && store >= warnStoreBytes) {
    problems.push(
      `response store is ${gb(store)} for ~${num(payload.store_rows) ?? "?"} rows (≥${gb(warnStoreBytes)}) — dead TOAST nothing reclaims; register #75, VACUUM FULL is the lever and Trevor's call`,
    )
  }

  const scope =
    `queue ${queued}, ${responses} responses/10m (${errored} errored, ${http5xx} 5xx), ` +
    `store ${gb(store)}, ttl ${payload.ttl ?? "?"}, batch ${payload.batch_size ?? "?"}` +
    (payload.last_response_at ? `, last response ${String(payload.last_response_at).slice(11, 19)}Z` : "")

  if (problems.length === 0) return { status: "ok", detail: `pg_net dispatching normally — ${scope}`, value: queued }
  return { status: "warn", detail: `${problems.join("; ")} — ${scope}`, value: queued }
}
