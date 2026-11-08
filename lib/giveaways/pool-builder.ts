// lib/giveaways/pool-builder.ts
//
// Pure helpers for the admin pool builder (/admin/giveaways, Trevor 2026-11-08:
// "how I can assign moments into the pack content pool"). Filtering, the tier
// mix of a selection, and a random fill from the filtered list. Kept in lib/ so
// the coverage gate measures them; the component only wires them up.

export interface BuilderCandidate {
  moment_id: string
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
}

export type BuilderSort = "fmv_desc" | "fmv_asc" | "player" | "serial"

export interface BuilderFilter {
  /** Matched case-insensitively against player, set and team. */
  q: string
  /** A tier name as the candidates carry it, or "" for every tier. */
  tier: string
  /** Hide moments with no FMV (sealing refuses them). */
  pricedOnly: boolean
  sort: BuilderSort
}

export const DEFAULT_FILTER: BuilderFilter = { q: "", tier: "", pricedOnly: false, sort: "fmv_desc" }

/** "COMMON" / "common" / " Common " → "Common"; null/blank → "Unknown". */
export function tierLabel(tier: string | null | undefined): string {
  const t = (tier ?? "").trim()
  if (!t) return "Unknown"
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

/** The distinct tiers present, in a fixed collector order, unknown last. */
export function tiersOf(rows: readonly BuilderCandidate[]): string[] {
  const order = ["Common", "Fandom", "Rare", "Legendary", "Ultimate"]
  const seen = new Set(rows.map((r) => tierLabel(r.tier)))
  return [...seen].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (a === "Unknown" || b === "Unknown") return a === "Unknown" ? 1 : -1
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
}

export function filterCandidates<T extends BuilderCandidate>(rows: readonly T[], f: BuilderFilter): T[] {
  const q = f.q.trim().toLowerCase()
  const out = rows.filter((r) => {
    if (f.pricedOnly && (r.fmv_usd == null || !Number.isFinite(r.fmv_usd))) return false
    if (f.tier && tierLabel(r.tier) !== f.tier) return false
    if (q) {
      const hay = `${r.player_name ?? ""} ${r.set_name ?? ""} ${r.team_name ?? ""}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  const byId = (a: T, b: T) => (a.moment_id < b.moment_id ? -1 : a.moment_id > b.moment_id ? 1 : 0)
  switch (f.sort) {
    case "fmv_asc":
      return out.sort((a, b) => (a.fmv_usd ?? Infinity) - (b.fmv_usd ?? Infinity) || byId(a, b))
    case "player":
      return out.sort((a, b) => (a.player_name ?? "￿").localeCompare(b.player_name ?? "￿") || byId(a, b))
    case "serial":
      return out.sort((a, b) => (a.serial_number ?? Infinity) - (b.serial_number ?? Infinity) || byId(a, b))
    default:
      return out.sort((a, b) => (b.fmv_usd ?? -Infinity) - (a.fmv_usd ?? -Infinity) || byId(a, b))
  }
}

/** Count of the picked moments per tier, in collector order. */
export function tierMix(rows: readonly BuilderCandidate[], picked: ReadonlySet<string>): { tier: string; count: number }[] {
  const chosen = rows.filter((r) => picked.has(r.moment_id))
  const counts = new Map<string, number>()
  for (const r of chosen) counts.set(tierLabel(r.tier), (counts.get(tierLabel(r.tier)) ?? 0) + 1)
  return tiersOf(chosen).map((tier) => ({ tier, count: counts.get(tier) ?? 0 }))
}

/**
 * Top the selection up to `need` with moments drawn at random from `shown`
 * (never re-adding one already picked). A convenience for building the pool,
 * not the fairness mechanism — the deal at sealing is what decides who gets
 * what. Returns a new set; never removes a pick.
 */
export function randomFill(
  shown: readonly BuilderCandidate[],
  picked: ReadonlySet<string>,
  need: number,
  rand: (maxExclusive: number) => number = (n) => Math.floor(Math.random() * n),
): Set<string> {
  const next = new Set(picked)
  const pool = shown.filter((c) => !next.has(c.moment_id)).map((c) => c.moment_id)
  while (next.size < need && pool.length > 0) {
    const i = rand(pool.length)
    next.add(pool[i])
    pool.splice(i, 1)
  }
  return next
}

/** Pack shapes (packs × per pack, within the drop limits) that use exactly `n` moments. */
export function shapesFor(n: number): { packs: number; perPack: number }[] {
  const out: { packs: number; perPack: number }[] = []
  for (let perPack = 1; perPack <= 10; perPack++) {
    if (n % perPack === 0 && n / perPack >= 1 && n / perPack <= 100) out.push({ packs: n / perPack, perPack })
  }
  return out
}
