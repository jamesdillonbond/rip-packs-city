// A pull chance (0–1) as a percent for the pack pages. A real chance under 0.005% rounded to
// "0.00%" beside a 2.6% EV share (/nfl-all-day/pack/dist/1277, 2026-10-21 sweep), which reads
// as "cannot be pulled". A true zero still reads 0.00%.
export function fmtChancePct(p: number): string {
  const pct = p * 100
  if (pct > 0 && pct < 0.01) return "<0.01%"
  return `${pct.toFixed(2)}%`
}
