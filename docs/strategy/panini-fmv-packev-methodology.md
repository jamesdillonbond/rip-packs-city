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

## Pack EV (`panini_pack_ev_model`)
WC Prizm Hobby pack contents (from the live pack detail): 2 base silver (/259) + 1 base non-silver
parallel (/124→1/1) + 1 "other" + 1 bonus; an insert replaces the base-non-silver slot 7 of 20 packs
(35%); the bonus is base-non-silver OR insert (assumed 50/50).

Each slot is valued by the **supply-weighted** FMV of its family (Σ fmv×mint_cap / Σ mint_cap) — common
cards weighted heavily, grails lightly. This avoids the family-mean grail skew (base non-silver: mean
$224 vs supply-weighted $58 vs median $23). Two figures, matching the Top Shot Actual-vs-Typical frame:
- **Actual EV** = 3·silver + 1.15·base + 0.85·insert on supply-weighted values → **~$334** (chase-inclusive).
- **Typical Pull** = same weights on family medians → **~$91**.

**Validation:** Typical Pull ($91) ≈ the observed **average sealed-pack sale ($106)** — strong sign the
model is right; Actual ($334) captures the chase upside over the ~$249 pack floor.

**Assumptions to revisit:** the "other" slot valued as a common; the bonus base/insert split at 50/50;
per-parallel drop odds are not published, so within-family weighting uses circulation as the proxy.
