# Panini — FMV & pack-EV methodology (v0, 2026-07-16)

Transparent record of how the Panini WC Prizm numbers are computed. All are **models over live
marketplace data**, not oracle prices; each is reversible and refreshes as FMV updates.

## Edition FMV
Per edition, from `getCardMarketStats`: if the edition has marketplace sales, FMV = its average sale
(confidence HIGH/MED/LOW by sale count); otherwise FMV = floor ask × 0.90 (confidence ASK_ONLY). Stored
in `panini_fmv_snapshots` (history intentional).

**Validation (2026-07-16):** against the 1,294 real per-serial secondary sales now captured, for the 169
editions with ≥3 real sales the FMV sits a median **~30%** from the real-sale median, with only **13/169
(8%)** more than 2× off — i.e. the avg-sale FMV is well-calibrated for a thin market. No rewrite
warranted. The squeeze board now exposes `real_sales` (how many genuine per-serial sales back each price)
as a transparency signal.

**Known limitation (v2 candidate, gated):** FMV is edition-level; it does not yet apply a serial premium
(a #1/1 trades far above a mid serial). The per-serial data to fit that premium now exists
(`panini_card_serials.last_sale_usd`), but it's a pricing-logic change — do it deliberately, not inline.

## Pack EV (`panini_pack_ev_model` → `panini_pack_ev_board`) — v0.2 (Hobby vs FOTL differentiated, 2026-07-18)

**Two pack products, correctly differentiated:** Hobby (`1038`, $212) and FOTL / First-Off-The-Line
(`1039`, $368). FOTL = the Hobby configuration **plus one guaranteed FOTL-exclusive parallel** in an
extra slot (the Aguila / Maple Leaf / Old Glory / Nebula families, which come *only* from FOTL). Every
slot is valued by the **supply-weighted** FMV of its family (Σ fmv×mint_cap / Σ mint_cap) — common cards
weighted heavily, grails lightly — to avoid family-mean grail skew.

Shared Hobby slots: 2 base silver (/259) + 1 base non-silver parallel (/124→1/1) + insert (7-in-20) + a
bonus base/insert slot. Supply-weighted family values (live): silver **$10**, base parallel **$59**,
insert **$236** (FOTL-exclusives are now *excluded* from this bucket — the v0.1 model wrongly lumped them
in, inflating Hobby and hiding FOTL's real edge), FOTL-exclusive **$399**.

| Pack | Cost | Typical pull (median) | Actual EV (supply-weighted) | Net rip edge |
|---|---|---|---|---|
| Hobby 1038 | $212 | ~$65 | ~$297 | **+$85** |
| FOTL 1039 | $368 | ~$137 | ~$696 | **+$328** |

- **Actual EV** = 3·silver + 1.15·base + 0.85·insert (+ FOTL-exclusive for FOTL) on supply-weighted values.
- **Typical Pull** = same structure on family medians (what a normal pack returns).

**Why FOTL is the stronger rip:** its guaranteed exclusive (~$399 supply-weighted) far exceeds the $156
price premium over Hobby, so FOTL flips from apparently −EV (the old blended model) to strongly +EV. Both
packs are +EV to rip at current secondary prices, FOTL more so.

**Validation:** Hobby Typical ($65) sits under the observed average sealed-pack sale (~$106) — honest, since
the observed avg blends both products; Actual EVs capture chase upside over each pack's floor.

**KEY ASSUMPTION (flag for confirmation):** FOTL is modeled as *Hobby contents + exactly one guaranteed
FOTL-exclusive parallel*. Panini does not publish FOTL pack odds; if FOTL actually carries a different
count of exclusives, or the exclusive is odds-based rather than guaranteed, the FOTL EV shifts. The
per-family multiplier lives in the model and is a one-line tune. **Other assumptions to revisit:** the
bonus base/insert split (50/50); within-family weighting uses circulation as the drop-odds proxy.

## Serial-premium FMV (2026-07-16)
Per-serial FMV = edition FMV × a premium multiplier for the special flags. Multipliers are the **median
real-sale ÷ edition-FMV** measured on multi-serial editions: **jersey 1.40× (n=40), perfect 1.21× (n=37),
#1 1.11× (n=45)**; highest applicable flag wins; everything else 1.00. Finding: Panini has **no
serial-POSITION premium** (non-special low serials trade ~0.93×, same as ordinary) — unlike Top Shot — so
only the flags carry a premium. Asks were excluded (median 2–6.5× FMV = aspirational noise). Multipliers
live in `panini_serial_premium` (tunable) and drive `serial_fmv_usd` on the special-serials + deal boards.
Re-fit as sales accumulate.

## Refresh cadence
Data is a point-in-time snapshot per runner pass. Staleness is monitored via `pipeline_cadence_watchlist`
row `panini-ingest` (STAGED INACTIVE, 360 min / info) — flip `is_active=true` once the Task Scheduler job
(`scripts/panini-run.bat`) is live. Everything recomputes on the next `panini-replay`/run.
