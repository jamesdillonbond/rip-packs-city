/**
 * What the sentinel's OWN probes cost the database — as a sentinel arm.
 *
 * ── WHY (2026-09-13) ────────────────────────────────────────────────────────
 * The `Edition Coverage` arm had been reporting "INCONCLUSIVE (db saturated)"
 * on and off for weeks. Read the other way round, it was a CAUSE: its RPC
 * LEFT JOINed every edition to a DISTINCT ON over ~1.2M `fmv_snapshots` rows
 * to learn nothing but existence — pg_stat_statements read 320 calls, 6.5 s
 * mean, ~71,800 buffers (~560 MB) per sweep. `FMV Confidence` was worse:
 * 14k random LATERAL probes into the same table, ~467,000 buffers (~3.6 GB)
 * per sweep. Every sweep added ~4 GB of reads to the saturation it was
 * measuring, on the table CLAUDE.md books as the instance's #1 read hotspot.
 * Both were rewritten to read a 13 MB materialised table (5k buffers each).
 *
 * ⭐ Nothing would have caught the next one. An arm that reads INCONCLUSIVE
 * under saturation is a SUSPECT, not only a victim, and the only way to know is
 * to read its row in pg_stat_statements — which nobody does on a schedule. So
 * this arm does: `sentinel_probe_cost()` returns, for every ops RPC invoked
 * through PostgREST as `service_role` whose name starts `sentinel_`, `check_`,
 * `detect_`, `dune_spend_report` or `get_pipeline_alerts`, its calls, mean and
 * max time, and buffers per call since the last stats reset.
 *
 * ── THRESHOLD, AND WHAT IT IS ANCHORED ON ───────────────────────────────────
 * Buffers per call is the primary measure (a duration under IO throttle is
 * mostly waiting; buffers are the WORK). Measured 2026-09-13 across the ops
 * RPCs: the two offenders read 71,800 and 467,000; the next was
 * `check_public_security_invariants` at 26,000 (called every ~18 min by the
 * data-integrity cron, not the sentinel); `check_wall_kills` costs ~33,000 by
 * construction (a 24 h heap-fetching walk of pipeline_runs markers); everything
 * else is under 10,000. The default warn is 50,000 buffers (~400 MB) per call —
 * above everything that is known and sized, below the class that was found.
 * The secondary mean-time warn (5 s) catches a cheap-in-buffers probe that
 * waits on locks.
 *
 * ⚠ pg_stat_statements POOLS since its last reset. A rewritten probe keeps its
 * old mean until the stats for that queryid are reset — the migration that
 * rewrites one must reset its row (`pg_stat_statements_reset(0, 0, queryid)`)
 * or this arm reports the corpse. `since` is in the detail so a reader can
 * tell a stale pooled mean from a fresh one.
 */

export type ProbeCostRow = {
  fn?: string
  calls?: number | string | null
  mean_ms?: number | string | null
  max_ms?: number | string | null
  blks_per_call?: number | string | null
  total_s?: number | string | null
}

export type ProbeCostPayload = { since?: string | null; rows?: unknown }

export type ProbeCostVerdict = { status: "ok" | "warn" | "critical"; detail: string; value?: number }

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

const fmt = (n: number | null): string => (n === null ? "?" : n.toLocaleString("en-US"))

export function summariseProbeCost(
  payload: ProbeCostPayload | null | undefined,
  warnBlocksPerCall = 50_000,
  warnMeanMs = 5_000,
): ProbeCostVerdict {
  if (!payload || typeof payload !== "object") {
    return { status: "warn", detail: "sentinel_probe_cost returned no readable payload — UNMEASURED, not clean" }
  }
  const rows = Array.isArray(payload.rows) ? (payload.rows as ProbeCostRow[]) : []
  // ⚠ The sentinel itself invokes eight or more of these RPCs every sweep, so an
  // EMPTY list means the reader is broken (wrong schema, wrong role filter, a
  // reset seconds ago) — never that every probe is free.
  if (rows.length === 0) {
    return { status: "warn", detail: "sentinel_probe_cost saw ZERO ops RPCs in pg_stat_statements — the reader is broken or the stats were just reset; UNMEASURED, not clean" }
  }

  const since = payload.since ? String(payload.since).slice(0, 10) : "?"
  const scored = rows.map((r) => ({
    fn: r.fn ?? "unnamed",
    calls: num(r.calls),
    mean: num(r.mean_ms),
    blks: num(r.blks_per_call),
    total: num(r.total_s),
  }))
  const offenders = scored.filter((r) => (r.blks ?? 0) >= warnBlocksPerCall || (r.mean ?? 0) >= warnMeanMs)
  const heaviest = [...scored].sort((a, b) => (b.blks ?? 0) - (a.blks ?? 0))[0]
  const totalS = scored.reduce((s, r) => s + (r.total ?? 0), 0)
  const scope = `${scored.length} ops RPCs since ${since}, ${fmt(Math.round(totalS))} s of DB time in total; heaviest ${heaviest.fn} at ${fmt(heaviest.blks)} buffers/call`

  if (offenders.length === 0) {
    return { status: "ok", detail: `no ops probe exceeds ${fmt(warnBlocksPerCall)} buffers/call or ${fmt(warnMeanMs)} ms mean — ${scope}`, value: heaviest.blks ?? undefined }
  }

  const named = offenders
    .sort((a, b) => (b.blks ?? 0) - (a.blks ?? 0))
    .slice(0, 5)
    .map((r) => `${r.fn} ${fmt(r.blks)} buffers/call, mean ${fmt(r.mean)} ms over ${fmt(r.calls)} calls`)
    .join("; ")
  const more = offenders.length > 5 ? ` +${offenders.length - 5} more` : ""
  return {
    status: "warn",
    detail:
      `${offenders.length} ops probe(s) ARE THEMSELVES LOAD (≥${fmt(warnBlocksPerCall)} buffers/call or ≥${fmt(warnMeanMs)} ms mean): ` +
      `${named}${more} — ${scope}. An arm that reads INCONCLUSIVE under saturation may be a cause of it; rewrite the probe, do not raise this threshold.`,
    value: heaviest.blks ?? undefined,
  }
}
