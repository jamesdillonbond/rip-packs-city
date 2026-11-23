/**
 * Physical cards — sealed box expected value from a published odds sheet
 * (prototype, NOT wired).
 *
 * Topps publishes pack odds as "1:N" per pack (some per box). EV of one box =
 * Σ over insert/parallel lines of (expected hits per box × value per hit),
 * where expected hits = packsPerBox / N, unless the box GUARANTEES a count
 * (e.g. "1 autograph per hobby box"), in which case the guarantee wins when it
 * is higher. Values come from the licensed feed's value range for that line
 * (a median across the line's cards), never from asks.
 *
 * Mirrors the Top Shot pack-EV discipline: an EV is shown only when every
 * line that carries value is priced; unpriced lines are reported, not zeroed.
 */

export type OddsLine = {
  name: string // "Base Refractor", "Rookie Autograph" …
  oddsPerPack: number | null // N in 1:N per pack; null when only a box guarantee exists
  guaranteedPerBox?: number
  valuePerHit: number | null // USD; null = not priced yet
}

export type BoxSpec = { packsPerBox: number; boxPriceUsd: number | null; lines: OddsLine[] }

/** Parses "1:24", "1:1,200", "1 : 3" → 24 / 1200 / 3. */
export function parseOdds(s: string): number | null {
  const m = s.replace(/,/g, "").match(/^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/)
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n : null
}

export type BoxEv = {
  status: "ok" | "incomplete"
  evUsd: number | null
  evToPrice: number | null // EV ÷ box price
  perLine: { name: string; expectedHits: number; evUsd: number | null }[]
  unpricedLines: string[]
}

export function boxEv(spec: BoxSpec): BoxEv {
  const perLine = spec.lines.map((l) => {
    const fromOdds = l.oddsPerPack ? spec.packsPerBox / l.oddsPerPack : 0
    const expectedHits = Math.max(fromOdds, l.guaranteedPerBox ?? 0)
    return {
      name: l.name,
      expectedHits,
      evUsd: l.valuePerHit == null ? null : expectedHits * l.valuePerHit,
    }
  })
  const unpricedLines = perLine.filter((p) => p.evUsd == null && p.expectedHits > 0).map((p) => p.name)
  if (unpricedLines.length) {
    return { status: "incomplete", evUsd: null, evToPrice: null, perLine, unpricedLines }
  }
  const evUsd = Math.round(perLine.reduce((s, p) => s + (p.evUsd ?? 0), 0) * 100) / 100
  return {
    status: "ok",
    evUsd,
    evToPrice: spec.boxPriceUsd ? Math.round((evUsd / spec.boxPriceUsd) * 1000) / 1000 : null,
    perLine,
    unpricedLines,
  }
}
