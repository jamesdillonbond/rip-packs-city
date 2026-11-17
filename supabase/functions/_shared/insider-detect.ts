// _shared/insider-detect.ts
//
// Pure pattern-detection core for topshot-insider-detect-patterns. Extracted
// 2026-07-26 so the scoring/grouping/dedup math is unit-testable under vitest
// (the edge function itself runs on Deno and is outside the CI coverage measure).
// A regression here silently emits FALSE insider alerts or, worse, silently
// SUPPRESSES real ones — both invisible from every external signal, which is
// exactly the class this repo keeps getting bitten by.
//
// The three patterns (verbatim from the edge fn):
//   1. cluster_buyback   — a single player with 5+ buybacks in 24h.
//   2. set_concentration — a single set with 10+ buybacks in 24h.
//   3. low_serial_buyback — any buyback whose serial is in the bottom 5% of the
//      edition's mint count (floor of 5, i.e. Math.max(5, ceil(circ * 0.05))).
//
// Dedup: an alert is skipped when any of its evidence buyback-ids already
// appears in an active (last-24h) alert of the same type — so a cluster that
// grows 5 → 6 → 7 over a few hours does not spam a new alert each time.

export interface InsiderBuyback {
  id: string
  serial_number: number | null
  sold_at: string
  player_name: string | null
  set_name: string | null
  edition_circulation: number | null
}

export type InsiderAlertType = "cluster_buyback" | "set_concentration" | "low_serial_buyback"

export interface InsiderAlert {
  alert_type: InsiderAlertType
  title: string
  summary: string
  evidence: string[]
  severity: number
}

// bottom-5%-of-mint threshold, with a floor of 5 serials so tiny editions still
// flag their lowest handful. A regression that drops the floor or the ceil()
// either misses low-serial buybacks on small editions or flags too many.
export function lowSerialThreshold(circulation: number): number {
  return Math.max(5, Math.ceil(circulation * 0.05))
}

// Conservative dedup predicate: does any existing active-alert evidence set for
// this type overlap the candidate's evidence? (Overlap, not equality, so a
// growing cluster's superset is treated as already-covered.)
export function evidenceOverlaps(existingEvidence: string[][], candidate: string[]): boolean {
  for (const existing of existingEvidence) {
    if (existing.some((id) => candidate.includes(id))) return true
  }
  return false
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    if (!k) continue
    const list = m.get(k) ?? []
    list.push(r)
    m.set(k, list)
  }
  return m
}

export interface InsiderComputeResult {
  alerts: InsiderAlert[]
  playersWithBuybacks: number
  setsWithBuybacks: number
}

// Pure detector. `existingByType` maps an alert type to the evidence arrays of
// its currently-active alerts (the DB read the edge fn does before emitting).
// Returns the alerts to emit, in the same order (cluster → set → low-serial) the
// edge fn produced them.
export function computeInsiderAlerts(
  buybacks: InsiderBuyback[],
  existingByType: Partial<Record<InsiderAlertType, string[][]>> = {},
): InsiderComputeResult {
  const alerts: InsiderAlert[] = []
  const existing = (t: InsiderAlertType) => existingByType[t] ?? []

  // ── 1. cluster_buyback (player) ──────────────────────────────────────
  const byPlayer = groupBy(buybacks, (b) => b.player_name)
  for (const [player, rows] of byPlayer.entries()) {
    if (rows.length < 5) continue
    const evidence = rows.map((r) => r.id).sort()
    if (evidenceOverlaps(existing("cluster_buyback"), evidence)) continue
    const summaryLines = rows.slice(0, 8).map(
      (r) => `• ${r.set_name ?? "?"} #${r.serial_number ?? "?"} (${new Date(r.sold_at).toUTCString()})`,
    )
    alerts.push({
      alert_type: "cluster_buyback",
      title: `Top Shot bought ${rows.length} ${player} moments in 24h`,
      summary: summaryLines.join("\n") + (rows.length > 8 ? `\n…and ${rows.length - 8} more` : ""),
      evidence,
      severity: rows.length >= 10 ? 5 : rows.length >= 7 ? 4 : 3,
    })
  }

  // ── 2. set_concentration ──────────────────────────────────────────────
  const bySet = groupBy(buybacks, (b) => b.set_name)
  for (const [setName, rows] of bySet.entries()) {
    if (rows.length < 10) continue
    const evidence = rows.map((r) => r.id).sort()
    if (evidenceOverlaps(existing("set_concentration"), evidence)) continue
    const playerSet = new Set(rows.map((r) => r.player_name).filter(Boolean))
    alerts.push({
      alert_type: "set_concentration",
      title: `Top Shot bought ${rows.length} moments from ${setName} in 24h`,
      summary: `${rows.length} buybacks from "${setName}" across ${playerSet.size} player(s) in the last 24 hours.`,
      evidence,
      severity: rows.length >= 25 ? 5 : rows.length >= 15 ? 4 : 3,
    })
  }

  // ── 3. low_serial_buyback ─────────────────────────────────────────────
  for (const b of buybacks) {
    if (!b.serial_number || !b.edition_circulation || b.edition_circulation <= 0) continue
    const threshold = lowSerialThreshold(b.edition_circulation)
    if (b.serial_number > threshold) continue
    const evidence = [b.id]
    if (evidenceOverlaps(existing("low_serial_buyback"), evidence)) continue
    alerts.push({
      alert_type: "low_serial_buyback",
      title: `Top Shot bought ${b.player_name ?? "a"} ${b.set_name ?? "moment"} #${b.serial_number} of ${b.edition_circulation}`,
      summary: `Low-serial buyback in the bottom ${Math.round((b.serial_number / b.edition_circulation) * 100)}% of the edition. Bought ${new Date(b.sold_at).toUTCString()}.`,
      evidence,
      severity: b.serial_number === 1 ? 5 : b.serial_number <= 10 ? 4 : 3,
    })
  }

  return { alerts, playersWithBuybacks: byPlayer.size, setsWithBuybacks: bySet.size }
}
