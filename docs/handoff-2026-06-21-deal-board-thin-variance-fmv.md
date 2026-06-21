# RPC Claude Code — flag the thin-data fake-deal residual on the TS deal board (2026-06-21)

The parallel-conflation fix cleaned the deal board (the original Traoré "FMV $45.83 vs $23 ask" fake deal is gone). A read-only Cowork pass then found the **last residual of the same user-facing symptom — inflated FMV → fake deal — but from a different cause: thin, high-variance sales**, not conflation. Small but real, and it erodes trust in the headline product surface.

## The finding (measured)
`topshot_deals_vs_fmv` has **520 deals; 98% are clean** (max discount 52%, only 2 ≥50%, 0 ≥70%, the discount curve tapers sanely). But **10 deals (~2%)** are editions with **<15 sales/90d AND latest FMV > 1.5× the 90-day median sale** — the WAP/mean FMV gets pulled well above the median by a wide range on very few sales, so a near-median ask shows as a big "discount." Worst offenders:

| external_id | name | FMV | median (n sales) | shows as |
|---|---|---|---|---|
| 5:61 | Aaron Gordon — Metallic Gold LE | $55 | $24 (7) | 51% "deal" (ask $27 ≈ median) |
| 5:50 | Carmelo Anthony — Metallic Gold LE | $63 | $31 (3) | 36% |
| 172:6375 | Cam Whitmore — Throwdowns | $10.15 | $5 (14) | 41% |
| 95:3107 | Bradley Beal — For the Win | $10 | $5 (7) | 40% |
| 14:181 | Kawhi Leonard — Hometown Showdown | $11.20 | $7 (7) | 38% (ask $7 = median) |
| 25:356 | Dirk Nowitzki — Run It Back | $250 | $160 (3) | 17% (the high-$ one) |

Pattern: **low-circulation premium parallels dominate** (Metallic Gold LE = 4 of 10) — thin + high-variance. ~5–6 create genuinely misleading discounts; the rest have inflated FMV but a small discount (less harmful). All are MEDIUM confidence (none HIGH).

## The fix — recommended: FLAG, not suppress (Trevor's product call)
Mirror the existing `is_conflated` caveat pattern (on `topshot_serial_premiums_board` / `topshot_perfect_mint_premiums_board`): add a `low_confidence_fmv` (thin-data) signal to the TS deal surface so these render with a "thin data — FMV uncertain on N sales" caveat instead of a confident discount %. Recommend **flag over suppress** — honest (it's only ~2% and some are partly-real), and it doesn't hide inventory. Optionally also exclude flagged deals from **alert dispatch** (so the omni-channel alerts don't fire a fake "51% off" — this is the part most worth suppressing; your call).

## Implementation notes (read before coding)
- **Do NOT add a per-row `LATERAL percentile_cont` median to `topshot_deals_vs_fmv`.** It feeds page loads + `dispatch_due_deal_alerts` (statement_timeout); a per-edition median subquery would risk a hot-path perf regression. Compute the signal from cheap, already-stored fields.
- `fmv_snapshots` already carries **`sales_count_30d`** + **`days_since_sale`** (v1.5.0+) — the *thinness* half is free (`sales_count_30d < ~15`).
- The *inflation* half ("FMV >1.5× median") needs a median. Two options:
  1. **Precise:** have the FMV pipeline also store a robust median (or a WAP-vs-median divergence ratio) on the snapshot when it computes the sale set — then the deal view flags on a stored column (cheap). This is a reviewed FMV-pipeline change but the cleanest.
  2. **Cheap proxy (no median):** flag deals that are `confidence='MEDIUM' AND sales_count_30d < 15 AND discount_pct >= 35` — catches the same class using only existing columns, no new computation. Good enough for a v1 caveat.
- Keep it additive (new column / flag) so existing consumers are unaffected; verify the deal-view query time is unchanged.

## The deeper lever (note only — deliberate separately)
The root is that FMV uses WAP/mean, which overshoots on thin/high-variance editions. Anchoring FMV to the **median** (or a variance-haircut) for low-sales-count editions would fix this everywhere FMV is shown (portfolio, alerts, every board) — but that's a platform-wide pricing-philosophy change affecting all surfaces, so it's a separate, deliberate decision, not part of this targeted board fix. (Cross-ref the `dense-low-fmv-is-honest` principle: thin LOW is honest; this is the inverse — thin MEDIUM over-claiming.)

## Verify
- The ~10 editions above render with the thin-data caveat (and, if chosen, don't fire alerts).
- The deal board's ≥40%-discount tail is then dominated by genuine deals (HIGH-conf or many-sales), not thin-variance artifacts.
- Re-run the sizing: `WHERE sales_count_30d < 15 AND fmv > 1.5×median` count is flagged, not silently shown as confident deals.

Guardrails: reviewed pricing/board logic + it feeds alerts → confirm the deal view + `dispatch_due_deal_alerts` stay within budget; direct-to-main, PowerShell git, rev-list 0, tsc clean. Update CLAUDE.md + the ledger.
