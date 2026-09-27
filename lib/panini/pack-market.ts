// lib/panini/pack-market.ts
//
// Pure parsers for /api/panini-pack-market (Panini Packs tab, 2026-09-27). Kept
// out of the route file so the route exports only handlers + segment config, and
// so the parsing is testable without a request.

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export interface PaniniPackLabel {
  label: string
  lines: string[]
}

/** The product's published name + guaranteed-contents/odds labels from the raw market stats. */
export function parsePackDetails(raw: unknown): { name: string | null; labels: PaniniPackLabel[]; topSaleUsd: number | null; listedCount: number | null } {
  if (!raw || typeof raw !== "object") return { name: null, labels: [], topSaleUsd: null, listedCount: null }
  const r = raw as Record<string, unknown>
  const labels: PaniniPackLabel[] = []
  if (Array.isArray(r.pack_label)) {
    for (const l of r.pack_label) {
      if (!l || typeof l !== "object") continue
      const label = str((l as Record<string, unknown>).label)
      const children = (l as Record<string, unknown>).children
      const lines = Array.isArray(children) ? children.map(str).filter((s): s is string => s !== null) : []
      if (label && lines.length) labels.push({ label, lines })
    }
  }
  const ms = r.market_stats && typeof r.market_stats === "object" ? (r.market_stats as Record<string, unknown>) : null
  return {
    name: str(r.pack_name),
    labels,
    topSaleUsd: ms ? num(ms.top_sale) : null,
    listedCount: ms ? num(ms.pack_auction_count) : null,
  }
}

export function packLabel(t: string): string {
  return t === "fotl" ? "FOTL" : t === "hobby" ? "Hobby" : t
}
