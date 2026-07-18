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

## Pack EV (`panini_pack_ev_model` → `panini_pack_ev_board`) — v0.4 (remaining-pool basis + confirmed odds, 2026-07-18)

**Two things ground this model:** the published pack contents/odds, and the fact that EV is computed on the
pool that is **still in packs** (unopened), not on total mint.

**Contents + odds — confirmed** from the live product pages (nft.paniniamerica.net — Hobby subpack 1038 /
FOTL subpack 1039, read 2026-07-18):
- **Hobby ($212), 5 cards:** 2 base silver (#/259) · 1 base non-silver parallel (#/124→1/1, guaranteed) ·
  1 "other" card · 1 bonus = **either** another base non-silver parallel **or** an insert (#/25–#/49→1/1).
  Published: an insert falls in **7 of every 20 packs** (0.35), otherwise the bonus is a base parallel (0.65).
- **FOTL ($368), 6 cards:** the Hobby structure **plus one guaranteed FOTL-exclusive base parallel**
  (#/11, #/9, #/7 or 1/1) — the Aguila / Maple Leaf / Old Glory / Nebula families, FOTL-only.

**Basis — the remaining pool.** Ripping a pack now draws from the copies still sealed, so each edition's
pull-probability within its slot is proportional to its **still-in-packs** count, not its original mint. Each
family value is the still-in-packs–weighted FMV (Σ fmv×still_in_packs / Σ still_in_packs); Typical Pull takes
the median over editions that still have copies to pull. (Data: 100% of priced editions carry a
still-in-packs count, 99.8% walked <48h.) This matters because the best chases deplete first — the
FOTL-exclusive family prices ~$388 on total mint but only ~$299 on what's left.

Expected per-pack family counts (published odds) × remaining-pool family value:

| Family | Expected count / Hobby pack | Remaining-pool value |
|---|---|---|
| silver (+ the "other" card, valued as a common) | 3 | ~$11 |
| base non-silver parallel | 1.65 (1 guaranteed + 0.65 bonus) | ~$46 |
| insert | 0.35 (7/20 bonus) | ~$243 |
| FOTL-exclusive (FOTL only) | +1 guaranteed | ~$299 |

| Pack | Cost | Typical pull | Actual EV | Net rip edge |
|---|---|---|---|---|
| Hobby 1038 | $212 | ~$45 | ~$193 | **−$19 (≈ fair / slightly negative)** |
| FOTL 1039 | $368 | ~$95 | ~$492 | **+$124** |

**Result:** at current secondary prices, **Hobby is not a +EV rip** (price ≈ its remaining-pool EV); **FOTL is
the +EV play** — its guaranteed low-cap exclusive (~$299 on the remaining pool) covers the $156 premium over
Hobby with room to spare. All figures move as cards deplete and FMV updates.

**Model history:** v0.1 blended both packs + lumped FOTL-exclusives into Hobby; v0.2 separated them; v0.3
corrected the shared-slot odds to the published values (insert 7/20, base 1.65); **v0.4 switched the family
weighting from total mint to the remaining (still-in-packs) pool** — the correct basis for "what will I pull
if I rip now," which trimmed the FOTL edge as the best exclusives had already been pulled.

**Remaining soft assumptions:** the unspecified "other" card is valued as a common (silver-tier); the "insert"
family is the catch-all of every non-silver/non-base/non-FOTL edition; within-family draw is taken as
proportional to remaining copies (packs are pre-allocated at mint).

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
