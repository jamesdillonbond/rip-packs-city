// lib/pinnacle/pin-insight-chips.ts
//
// Disney Pinnacle pin → insights links (2026-11-23, parity pass 4 — the last "partial" cell of the Pinnacle parity
// matrix: Top Shot edition pages carry "Featured in Insights" chips, All Day and Candy got theirs 10-26, Pinnacle
// pages had only a footer link). Each chip is shown ONLY when its fact is true of THIS pin, and states the fact:
//   · scarcity     — scarcer than its variant family (pinnacle_scarcity_board, already on the page) → scarcity board
//   · squeeze      — ≤ 2 % of ≥ 25 collector-held copies listed (live-listings census ÷ market-cap supply split)
//                    → squeeze board
//   · hot floors   — swept (one collector, 3+ copies, no gap > 60 min) in the last 7 days → hot floors
//   · serial       — a #1 or perfect serial of this pin has sold → serial premiums board
//   · pack reality — pulled from a drop opened since Sept 2026 (the board's window) → pack reality board
// A read that failed or was not supplied (null) earns no chip — a chip is a claim, never a guess.

export interface PinChip {
  key: "scarcity" | "squeeze" | "hot" | "serial" | "pack"
  href: string
  label: string
}

export interface PinChipInput {
  scarcityPct: number | null
  /** Listings in the last complete sweep; null = the listings read failed. */
  listed: number | null
  /** Collector-held copies (market_cap_current); null = unknown. */
  collectorHeld: number | null
  /** Distinct sweepers in the last 7 days; null = read failed or not swept. */
  sweepers: number | null
  /** The latest #1 / perfect-serial sale of this pin; null = none or read failed. */
  specialSerial: { serial: number; perfect: boolean; priceUsd: number } | null
  /** Pack pulls the page already read (mv_pinnacle_render_pack_pulls); null = read failed. */
  packPulls: { dist_id: string; title: string | null; first_opened_at: string | null }[] | null
}

/** Pack Reality's window start — get_pinnacle_pack_reality's default p_since (2026-09-01 PT). */
export const PACK_REALITY_SINCE_MS = Date.parse("2026-09-01T07:00:00Z")
export const SQUEEZE_MIN_HELD = 25
export const SQUEEZE_MAX_PCT = 2

function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`
}

/** Pure: which chips this pin earns, in a fixed order. */
export function pinInsightChips(i: PinChipInput): PinChip[] {
  const out: PinChip[] = []
  if (i.scarcityPct != null && Number.isFinite(i.scarcityPct) && i.scarcityPct > 0) {
    out.push({ key: "scarcity", href: "/insights/pinnacle-scarcity", label: `${Math.round(i.scarcityPct)}% scarcer than its variant family →` })
  }
  if (i.listed != null && i.collectorHeld != null && i.collectorHeld >= SQUEEZE_MIN_HELD) {
    const pct = (100 * i.listed) / i.collectorHeld
    if (pct <= SQUEEZE_MAX_PCT) {
      out.push({
        key: "squeeze",
        href: "/insights/pinnacle-squeeze",
        label: i.listed === 0
          ? `None of ${i.collectorHeld.toLocaleString("en-US")} collector-held copies listed →`
          : `Only ${i.listed} of ${i.collectorHeld.toLocaleString("en-US")} collector-held copies listed →`,
      })
    }
  }
  if (i.sweepers != null && i.sweepers > 0) {
    out.push({ key: "hot", href: "/disney-pinnacle/hot-floors", label: `Bought in bulk by ${i.sweepers} ${i.sweepers === 1 ? "collector" : "collectors"} this week →` })
  }
  if (i.specialSerial && Number.isFinite(i.specialSerial.priceUsd) && i.specialSerial.priceUsd > 0) {
    const s = i.specialSerial
    out.push({ key: "serial", href: "/insights/pinnacle-serial-premiums", label: `${s.perfect ? `Perfect serial #${s.serial}` : "#1"} sold for ${usd(s.priceUsd)} →` })
  }
  const recent = (i.packPulls ?? []).find((p) => p.first_opened_at != null && Date.parse(p.first_opened_at) >= PACK_REALITY_SINCE_MS)
  if (recent) {
    out.push({ key: "pack", href: "/insights/pinnacle-pack-reality", label: `Pulled from ${recent.title ?? "a recent drop"} — did the pack pay? →` })
  }
  return out
}
