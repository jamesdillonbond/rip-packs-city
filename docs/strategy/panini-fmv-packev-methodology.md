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

## Pack EV (`panini_pack_ev_model` → `panini_pack_ev_board`) — v0.3 (odds CONFIRMED from live pack pages, 2026-07-18)

**Pack contents + odds are confirmed** from the live product pages (nft.paniniamerica.net — Hobby subpack
1038 / FOTL subpack 1039, read 2026-07-18):

- **Hobby ($212), 5 cards:** 2 base silver (#/259) · 1 base non-silver parallel (#/124→1/1, guaranteed) ·
  1 "other" card · 1 bonus that is **either** another base non-silver parallel **or** an insert
  (#/25–#/49→1/1). Published odds: an insert falls in **7 of every 20 packs** (0.35), otherwise the bonus
  is a base parallel (0.65).
- **FOTL ($368), 6 cards:** the Hobby structure **plus one guaranteed FOTL-exclusive base parallel**
  (#/11, #/9, #/7 or 1/1) — the Aguila / Maple Leaf / Old Glory / Nebula families, which come only from FOTL.

Each family is valued by its **supply-weighted** FMV (Σ fmv×mint_cap / Σ mint_cap). Expected per-pack family
counts (from the published odds) give the slot weights:

| Family | Expected count / Hobby pack | Supply-wtd value |
|---|---|---|
| silver (+ the "other" card, valued as a common) | 3 | ~$10 |
| base non-silver parallel | 1.65 (1 guaranteed + 0.65 bonus) | ~$56 |
| insert | 0.35 (7/20 bonus) | ~$224 |
| FOTL-exclusive (FOTL only) | +1 guaranteed | ~$387 |

- **Actual EV** = 3·silver + 1.65·base + 0.35·insert (+ FOTL-exclusive for FOTL), supply-weighted.
- **Typical Pull** = same weights on family medians.

| Pack | Cost | Typical pull | Actual EV | Net rip edge |
|---|---|---|---|---|
| Hobby 1038 | $212 | ~$53 | ~$200 | **−$12 (≈ fair)** |
| FOTL 1039 | $368 | ~$122 | ~$587 | **+$219** |

**Result:** Hobby is priced right at its expected value (net ≈ $0); FOTL is the clear +EV rip — its
guaranteed low-cap exclusive (~$387 supply-weighted) far exceeds the $156 price premium over Hobby.

**Model history:** v0.1 blended both packs and lumped the FOTL-exclusives into the Hobby insert bucket;
v0.2 (2026-07-18) separated them; **v0.3 (2026-07-18) corrected the shared-slot odds to the published
values** — the earlier model carried insert at 0.85/pack (vs the real 0.35) and base at 1.15 (vs 1.65),
over-stating both packs by ~$88.

**Remaining soft assumptions:** the unspecified "other" card is valued as a common (silver-tier) — if it is
actually a base-parallel-eligible card, Hobby EV rises; the model's "insert" family is the catch-all of every
non-silver/non-base/non-FOTL edition (a slight over-set vs the true insert slot). Within-family weighting uses
circulation as the drop-odds proxy.

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
