// lib/panini/pack-drops.ts — Panini pack RELEASE dates from Panini's own NFT store.
//
// The residential runner (scripts/ingest-panini-runner.mjs) loads two store pages in the real browser
// and forwards what the SPA's signed /onepanini queries returned, unmodified:
//   · `packs`          (nft-store/nft-pack.html)       — packs on sale now
//   · `packsTimeline`  (nft-store/pack-timeline.html)  — every pack Panini has released, by year
// as `pack_drops: { store: [...], timeline: [...] }` on POST /api/cron/panini-ingest. This file turns
// them into `panini_pack_drops` rows (migration 20261108221500). Pure: no I/O.
//
// start_date is UTC ("2026-11-06 16:00:00" = 8 AM PST; every 2026 pack starts at Panini's 8 AM PT).
// A pack read from BOTH lists merges: the store's live stock wins, the timeline's total qty fills in.

export interface PaniniPackDropRow {
  pack_id: string
  name: string
  sport: string | null
  price_usd: number | null
  cards_per_pack: number | null
  start_at: string | null
  end_at: string | null
  in_stock: boolean | null
  is_available: boolean | null
  status: number | null
  url_key: string | null
  total_qty: number | null
  remaining_qty: number | null
  seen_in: string[]
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const bool = (v: unknown): boolean | null =>
  v === true || v === 1 || v === "1" || v === "true" ? true : v === false || v === 0 || v === "0" || v === "false" ? false : null

/** "2026-11-06 16:00:00" (UTC, Panini's format) → ISO; null for anything that is not a real date. */
export function paniniUtcToIso(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  const d = new Date(t)
  return Number.isFinite(t) && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100 ? d.toISOString() : null
}

function one(raw: unknown, source: "store" | "timeline"): PaniniPackDropRow | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = r.pack_id == null ? null : String(r.pack_id)
  const name = str(r.pack_name)
  if (!id || !/^[0-9]+$/.test(id) || !name) return null
  return {
    pack_id: id,
    name,
    sport: str(r.sport),
    price_usd: num(r.subpack_price),
    cards_per_pack: num(r.cards_per_subpack),
    start_at: paniniUtcToIso(r.start_date),
    end_at: paniniUtcToIso(r.end_date),
    in_stock: bool(r.in_stock),
    is_available: bool(r.is_available),
    status: num(r.status),
    url_key: str(r.url_key),
    total_qty: num(r.total_subpack_qty),
    remaining_qty: num(r.subpack_qty),
    seen_in: [source],
  }
}

/** The runner's `pack_drops` payload → one row per pack id (store wins on stock; timeline fills totals). */
export function normalizePaniniPackDrops(payload: unknown): PaniniPackDropRow[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return []
  const p = payload as Record<string, unknown>
  const timeline = (Array.isArray(p.timeline) ? p.timeline : []).map((x) => one(x, "timeline"))
  const store = (Array.isArray(p.store) ? p.store : []).map((x) => one(x, "store"))
  const byId = new Map<string, PaniniPackDropRow>()
  for (const row of timeline) if (row) byId.set(row.pack_id, row)
  for (const row of store) {
    if (!row) continue
    const prev = byId.get(row.pack_id)
    if (!prev) {
      byId.set(row.pack_id, row)
      continue
    }
    byId.set(row.pack_id, {
      ...prev,
      ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)),
      total_qty: prev.total_qty ?? row.total_qty,
      seen_in: ["store", "timeline"],
    } as PaniniPackDropRow)
  }
  return [...byId.values()]
}
