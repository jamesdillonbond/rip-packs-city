// lib/pack-dist/container-contents.ts
//
// A Top Shot BOX or CASE is a PackNFT that yields PackNFTs, not Moments, so it has no drop
// pool of its own. What it contains is `pack_container_recipes` (inner dist x count:
// observed from opened containers, or seeded from supply arithmetic / Dapper's description
// until one is opened). refresh_container_pack_ev (:28 hourly) already writes a container's
// EV as the SUM of its inner packs' EVs, only when every inner pack is priced.
//
// This module turns the recipe + each inner pack's latest EV + its lowest live ask into the
// pack page's "What's inside" panel (2026-11-12, Trevor: "Rip EV on Boxes and Cases").
// Two totals, each withheld (null) unless EVERY line can answer — never a partial sum:
//   ripEv     = sum(count x inner gross EV)   — what opening everything is worth
//   sealedValue = sum(count x inner lowest ask) — what selling the packs inside sealed fetches
// An inner EV below MIN_INNER_COVERAGE_PCT is not shown (the same 25 % gate pack_table_rows
// applies to every pack), so a container whose topper is mostly unpriced shows no rip EV.

export const MIN_INNER_COVERAGE_PCT = 25
/** An inner EV older than this is not current (the container writer's own 26 h window). */
export const INNER_EV_MAX_AGE_MS = 26 * 3600 * 1000

export type RecipeSource = "observed" | "supply" | "description"

export interface ContainerRecipeRow {
  inner_dist_id: string
  inner_count: number
  source: string
}

export interface InnerEvRow {
  dist_id: string
  gross_ev: number | string | null
  fmv_coverage_pct: number | string | null
  edition_count: number | string | null
  snapshotted_at: string | null
}

export interface InnerAskRow {
  dist_id: string
  lowest_ask: number | string | null
}

export interface InnerTitleRow {
  dist_id: string
  title: string | null
}

export interface ContainerLine {
  distId: string
  title: string
  count: number
  /** Latest gross EV per pack; null when unpriced, under the coverage gate, or stale. */
  evEach: number | null
  coveragePct: number | null
  /** Lowest live secondary ask per pack; null when none is listed. */
  askEach: number | null
}

export interface ContainerContents {
  source: RecipeSource
  lines: ContainerLine[]
  packCount: number
  ripEv: number | null
  sealedValue: number | null
  /** Lines whose EV is withheld (unpriced / under coverage / stale). */
  unpricedLines: number
  /** Lines with no live ask. */
  unlistedLines: number
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Strongest claim wins: one observed row makes the recipe observed. */
function recipeSource(rows: ContainerRecipeRow[]): RecipeSource {
  const s = new Set(rows.map((r) => r.source))
  if (s.has("observed")) return "observed"
  if (s.has("supply")) return "supply"
  return "description"
}

export function buildContainerContents(
  recipe: ContainerRecipeRow[],
  evs: InnerEvRow[],
  asks: InnerAskRow[],
  titles: InnerTitleRow[],
  now: number = Date.now(),
): ContainerContents | null {
  const rows = recipe.filter((r) => r.inner_dist_id && Number(r.inner_count) > 0)
  if (rows.length === 0) return null

  // newest EV row per dist
  const evBy = new Map<string, InnerEvRow>()
  for (const e of evs) {
    const prev = evBy.get(e.dist_id)
    if (!prev || String(e.snapshotted_at ?? "") > String(prev.snapshotted_at ?? "")) evBy.set(e.dist_id, e)
  }
  // lowest ask per dist
  const askBy = new Map<string, number>()
  for (const a of asks) {
    const v = num(a.lowest_ask)
    if (v == null || v <= 0) continue
    const prev = askBy.get(a.dist_id)
    if (prev == null || v < prev) askBy.set(a.dist_id, v)
  }
  const titleBy = new Map(titles.map((t) => [t.dist_id, t.title]))

  const lines: ContainerLine[] = rows.map((r) => {
    const e = evBy.get(r.inner_dist_id)
    const gross = num(e?.gross_ev)
    const cov = num(e?.fmv_coverage_pct)
    const editions = num(e?.edition_count)
    const ts = e?.snapshotted_at ? Date.parse(e.snapshotted_at) : NaN
    const fresh = Number.isFinite(ts) && now - ts <= INNER_EV_MAX_AGE_MS
    const priced =
      gross != null && gross > 0 && (editions ?? 0) > 0 && cov != null && cov >= MIN_INNER_COVERAGE_PCT && fresh
    return {
      distId: r.inner_dist_id,
      title: titleBy.get(r.inner_dist_id)?.trim() || `Pack #${r.inner_dist_id}`,
      count: Number(r.inner_count),
      evEach: priced ? gross : null,
      coveragePct: cov,
      askEach: askBy.get(r.inner_dist_id) ?? null,
    }
  })
  // biggest contributor first: the topper / premium before the filler packs
  lines.sort((a, b) => (b.evEach ?? b.askEach ?? 0) * b.count - (a.evEach ?? a.askEach ?? 0) * a.count || a.distId.localeCompare(b.distId))

  const unpricedLines = lines.filter((l) => l.evEach == null).length
  const unlistedLines = lines.filter((l) => l.askEach == null).length
  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    source: recipeSource(rows),
    lines,
    packCount: lines.reduce((s, l) => s + l.count, 0),
    ripEv: unpricedLines === 0 ? round2(lines.reduce((s, l) => s + l.count * (l.evEach as number), 0)) : null,
    sealedValue: unlistedLines === 0 ? round2(lines.reduce((s, l) => s + l.count * (l.askEach as number), 0)) : null,
    unpricedLines,
    unlistedLines,
  }
}
