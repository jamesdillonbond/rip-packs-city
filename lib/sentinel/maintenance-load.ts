/**
 * Maintenance in progress — vacuums, CLUSTER / VACUUM FULL, index builds — as
 * a sentinel arm, so the CAUSE of a saturation spell sits in the same digest
 * as its symptoms.
 *
 * ── WHY (2026-09-13) ────────────────────────────────────────────────────────
 * The instance ran a multi-hour IO spell: 268 cron failures in 6 h, Trust
 * Health and Pipeline Success INCONCLUSIVE, the Atlas verify tick failing 24
 * of 27 runs, /api/market serving 503s. Every arm reported a symptom. The
 * cause — the FIRST-EVER autovacuum of `pg_toast_51873`, net._http_response's
 * 12.4 GB TOAST (register #75), grinding through 1.6 M blocks in
 * IO/DataFileRead — was visible only in `pg_stat_progress_vacuum`, which
 * nothing read. A session found it by hand; the lane was minutes from being
 * blamed for the spell. Its failures matched the vacuum's start to the minute.
 *
 * ── WHAT THE SQL SIDE READS ─────────────────────────────────────────────────
 * `check_maintenance_load()`: the three `pg_stat_progress_*` views joined to
 * `pg_stat_activity` for running time and wait state, autovacuum worker
 * occupancy, and the client IO-waiter count. Catalog-backed, no relation is
 * touched, so it is free to run while the instance is saturated — which is
 * exactly when it is read.
 *
 * ── WHY IT WARNS AND NEVER PAGES ────────────────────────────────────────────
 * A long autovacuum is a fact to know and to wait out (cancelling it wastes
 * the work and it restarts). `warn_at` is minutes a single operation may have
 * run; below it the arm is `ok` and STILL names every operation in progress.
 * An arm that only speaks when it fires can never be re-derived.
 */

export type MaintenanceVacuum = {
  relation?: string | null
  parent?: string | null
  phase?: string | null
  heap_blks_total?: number | string | null
  heap_blks_scanned?: number | string | null
  heap_blks_vacuumed?: number | string | null
  index_vacuum_count?: number | string | null
  is_autovacuum?: boolean | null
  wait_event_type?: string | null
  running_seconds?: number | string | null
}

export type MaintenanceCluster = {
  relation?: string | null
  command?: string | null
  phase?: string | null
  heap_blks_total?: number | string | null
  heap_blks_scanned?: number | string | null
  running_seconds?: number | string | null
}

export type MaintenanceIndexBuild = {
  relation?: string | null
  phase?: string | null
  blocks_total?: number | string | null
  blocks_done?: number | string | null
  running_seconds?: number | string | null
}

export type MaintenanceLoadPayload = {
  vacuums?: MaintenanceVacuum[] | null
  clusters?: MaintenanceCluster[] | null
  index_builds?: MaintenanceIndexBuild[] | null
  autovacuum_workers?: number | string | null
  autovacuum_max_workers?: number | string | null
  io_waiters?: number | string | null
  measured_at?: string | null
}

export type MaintenanceLoadVerdict = {
  status: "ok" | "warn" | "critical"
  detail: string
  /** Operations in progress. */
  value: number
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

const mins = (secs: number | null): string => (secs === null ? "?" : `${Math.round(secs / 60)} min`)
const pct = (done: number | null, total: number | null): string =>
  done === null || total === null || total <= 0 ? "" : ` ${Math.round((100 * done) / total)}%`
const fmt = (n: number | null): string => (n === null ? "?" : n.toLocaleString("en-US"))

function vacuumLine(v: MaintenanceVacuum): string {
  const total = num(v.heap_blks_total)
  const scanned = num(v.heap_blks_scanned)
  const vacuumed = num(v.heap_blks_vacuumed)
  const phase = v.phase ?? "?"
  // Progress is phase-dependent: the scan phases count scanned blocks, the heap
  // pass counts vacuumed blocks. Anything else (index phases, truncate) has no
  // block counter worth quoting.
  const progress =
    phase === "vacuuming heap"
      ? `${pct(vacuumed, total)} (${fmt(vacuumed)}/${fmt(total)} blks)`
      : phase === "scanning heap"
        ? `${pct(scanned, total)} (${fmt(scanned)}/${fmt(total)} blks)`
        : ""
  const who = v.is_autovacuum === false ? "VACUUM (manual)" : "autovacuum"
  const rel = v.parent ? `${v.relation} (${v.parent})` : String(v.relation ?? "?")
  const wait = v.wait_event_type ? `, ${v.wait_event_type}` : ""
  return `${who} ${rel}: ${phase}${progress}, ${mins(num(v.running_seconds))}${wait}`
}

function clusterLine(c: MaintenanceCluster): string {
  const total = num(c.heap_blks_total)
  const scanned = num(c.heap_blks_scanned)
  return `${c.command ?? "CLUSTER"} ${c.relation ?? "?"}: ${c.phase ?? "?"}${pct(scanned, total)}, ${mins(num(c.running_seconds))} — holds ACCESS EXCLUSIVE`
}

function indexLine(i: MaintenanceIndexBuild): string {
  const total = num(i.blocks_total)
  const done = num(i.blocks_done)
  return `CREATE INDEX ${i.relation ?? "?"}: ${i.phase ?? "?"}${pct(done, total)}, ${mins(num(i.running_seconds))}`
}

/**
 * @param warnRunningMinutes a single operation running at least this long warns.
 *   Default 30: the 2026-09-13 spell's autovacuum was 57 min in when it was found
 *   by hand, and the tier's 22 MB/s IO budget makes anything past half an hour
 *   a whole-instance event rather than housekeeping.
 */
export function summariseMaintenanceLoad(
  payload: MaintenanceLoadPayload | null | undefined,
  warnRunningMinutes: number = 30,
): MaintenanceLoadVerdict {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.vacuums)) {
    return {
      status: "warn",
      detail: "UNMEASURED: check_maintenance_load() returned no readable payload — whether maintenance is running is unknown, not clean",
      value: 0,
    }
  }
  const vacuums = payload.vacuums
  const clusters = Array.isArray(payload.clusters) ? payload.clusters : []
  const builds = Array.isArray(payload.index_builds) ? payload.index_builds : []
  const ops = vacuums.length + clusters.length + builds.length
  const workers = num(payload.autovacuum_workers)
  const maxWorkers = num(payload.autovacuum_max_workers)
  const io = num(payload.io_waiters)
  const tail = ` · autovacuum workers ${workers ?? "?"}/${maxWorkers ?? "?"} · client IO waiters ${io ?? "?"}`

  if (ops === 0) {
    return { status: "ok", detail: `No vacuum, cluster or index build in progress${tail}`, value: 0 }
  }

  const runningSecs = [
    ...vacuums.map((v) => num(v.running_seconds)),
    ...clusters.map((c) => num(c.running_seconds)),
    ...builds.map((i) => num(i.running_seconds)),
  ].filter((s): s is number => s !== null)
  const longest = runningSecs.length ? Math.max(...runningSecs) : null
  const threshold = Math.max(1, warnRunningMinutes) * 60
  const long = longest !== null && longest >= threshold

  const lines = [...vacuums.map(vacuumLine), ...clusters.map(clusterLine), ...builds.map(indexLine)]
  const head = long
    ? `${ops} maintenance operation(s) in progress, the longest ${mins(longest)} (warn at ${warnRunningMinutes} min) — read the symptoms below in this light: `
    : `${ops} maintenance operation(s) in progress: `
  return {
    // ⛔ Never critical: a long autovacuum is waited out, not paged for.
    status: long ? "warn" : "ok",
    detail: `${head}${lines.join("; ")}${tail}`,
    value: ops,
  }
}
