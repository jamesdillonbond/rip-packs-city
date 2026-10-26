// lib/sniper/serial-estimate.ts
//
// Re-price a #1 / perfect-serial sniper deal by the fitted serial model instead of the flat
// display multiplier (2026-10-25).
//
// WHY. `sniperSerialMultiplier` prices serial #1 at 8x base FMV for every edition size, and that
// figure drove the deal's adjustedFmv, discount, net margin and ranking. The card also showed the
// fitted model's estimate (SerialFmvBadge, `serial_fmv_estimate`) — on /nba-top-shot/sniper a
// #1/29 read "Adj. FMV $704 · -68.5%" beside "#1 est ≈ $189", so the headline deal contradicted
// the badge under it. Measured on 450 realised Top Shot #1 sales (365 d, HIGH/MEDIUM base FMV in
// force ≥ 1 d before): realised #1 premiums run ~3x base under 100 minted, ~5x at 100–999 and
// ~22x at 1k–10k, so a flat 8x overstates small editions (fake deals) and understates large ones.
// Within ±25 %: model 21.7 / 23.1 / 22.7 vs 8x 11.4 / 18.7 / 10.7 by band; WAPE 65 / 62 / 67 vs
// 215 / 64 / 72; both time halves favour the model (n 22 / 428).
//
// WHAT. Where the model returned an estimate on a HIGH/MEDIUM base, it becomes adjustedFmv; the
// discount, dealRating and serialMult follow from it, and a deal that is no longer below its
// adjusted FMV (or below the caller's minDiscount) drops out. Deals without an estimate are
// returned unchanged. Pure; the caller re-sorts.

export interface SerialEstimateDeal {
  askPrice: number
  baseFmv: number
  adjustedFmv: number
  discount: number
  dealRating: number
  serialMult: number
  confidence: string
  serialFmvEstimate?: { estimate_usd: number } | null
}

const MODELLED_BASE = new Set(["high", "medium"])

export function applySerialFmvEstimates<T extends SerialEstimateDeal>(deals: T[], minDiscount: number): T[] {
  const out: T[] = []
  for (const d of deals) {
    const est = d.serialFmvEstimate?.estimate_usd
    if (est == null || !Number.isFinite(est) || est <= 0 || !MODELLED_BASE.has(String(d.confidence).toLowerCase())) {
      out.push(d)
      continue
    }
    if (d.askPrice >= est) continue
    const discount = Math.round(((est - d.askPrice) / est) * 1000) / 10
    if (discount < minDiscount) continue
    out.push({
      ...d,
      adjustedFmv: est,
      discount,
      dealRating: Math.max(0, Number((1 - d.askPrice / est).toFixed(4))),
      serialMult: d.baseFmv > 0 ? Number((est / d.baseFmv).toFixed(4)) : d.serialMult,
    })
  }
  return out
}
