// lib/allday/edition-insight-chips.ts
//
// NFL All Day edition → insights links (All Day ↔ Top Shot parity, 2026-10-26). Top Shot edition pages carry
// "Featured in Insights" chips from get_edition_insight_links (Top Shot boards only); All Day pages had none.
//
// Two chips, each shown only when its fact is true for THIS edition:
//   · scarcity — the edition's row on /insights/allday-scarcity, when it is scarcer than its set + tier family
//     of at least 3 editions (the board's own inclusion rule);
//   · bid vs floor — the edition's best open bid as a share of its verified floor, from the two values the
//     page already has (no extra read), linking the All Day leg of /insights/offer-spread.
// A failed scarcity read drops that chip — it never renders a guessed figure.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

export interface AllDayScarcityRow {
  mint_count: number | null
  family_avg_mint: number | null
  family_size: number | null
  scarcity_vs_family_pct: number | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchAllDayScarcityRow(
  externalId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<{ row: AllDayScarcityRow | null; ok: boolean }> {
  try {
    const { data, error } = await boundedRead(
      db.from("allday_scarcity_board").select("mint_count, family_avg_mint, family_size, scarcity_vs_family_pct").eq("external_id", externalId).limit(1),
      "allday_scarcity_board/edition-chip",
      3_000,
    )
    if (error) return { row: null, ok: false }
    const r = Array.isArray(data) ? data[0] : null
    if (!r) return { row: null, ok: true }
    return {
      row: {
        mint_count: num(r.mint_count),
        family_avg_mint: num(r.family_avg_mint),
        family_size: num(r.family_size),
        scarcity_vs_family_pct: num(r.scarcity_vs_family_pct),
      },
      ok: true,
    }
  } catch {
    return { row: null, ok: false }
  }
}

export interface AllDayInsightChip {
  key: "scarcity" | "bid"
  href: string
  label: string
}

/** Pure: which chips this edition earns. */
export function allDayInsightChips(input: {
  scarcity: AllDayScarcityRow | null
  bid: number | null | undefined
  floor: number | null | undefined
  playerName: string | null | undefined
}): AllDayInsightChip[] {
  const out: AllDayInsightChip[] = []
  const s = input.scarcity
  if (s && s.scarcity_vs_family_pct != null && s.scarcity_vs_family_pct > 0 && (s.family_size ?? 0) >= 3) {
    out.push({ key: "scarcity", href: "/insights/allday-scarcity", label: `${Math.round(s.scarcity_vs_family_pct)}% scarcer than its set + tier →` })
  }
  const bid = num(input.bid)
  const floor = num(input.floor)
  if (bid != null && bid > 0 && floor != null && floor > 0) {
    const pct = Math.round((bid / floor) * 100)
    const q = new URLSearchParams({ collection: "nfl-all-day" })
    if (input.playerName) q.set("player", input.playerName)
    out.push({ key: "bid", href: `/insights/offer-spread?${q.toString()}`, label: `Top bid ${pct}% of floor →` })
  }
  return out
}
