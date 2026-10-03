# Panini — FMV & pack-EV methodology (v0, 2026-07-16)

Transparent record of how the Panini WC Prizm numbers are computed. All are **models over live
marketplace data**, not oracle prices; each is reversible and refreshes as FMV updates.

## Edition FMV — current engine `panini-1.1.0` (shipped 2026-09-24 ~9 PM PT, Trevor-approved)

⚠ **The v0 description below is HISTORY (`panini-1.0.0`).** Current rule (`toFmvRowV11`, `lib/chains/panini/ingest-normalize.ts`; route `app/api/cron/panini-ingest/route.ts` via rpc `panini_recent_sales_fmv`):

| Confidence | Evidence | FMV |
|---|---|---|
| HIGH | 3 non-special serial sales in the last 30 days | median of the last ≤3 |
| MEDIUM | 1–2 such sales | median of them |
| LOW | no sale in 30 days, but lifetime sales | lifetime `avg_sale` |
| ASK_ONLY | no sale ever | floor ask × `PANINI_ASK_ONLY_MULT` **0.50** (was 0.90) |

- **Why:** the out-of-sample backtest (`panini_fmv_backtest`: each sale vs the FMV published >1 day before it) put 1.0.0 at MdAPE **57.6%**, median ratio **1.53** (FMV above the sale); the recent-median candidate at **33.3% / 1.06**. The 07-16 "~30% median" validation below was in-sample and against TOP sales.
- **Kill switch:** Vercel env `PANINI_FMV_ENGINE=1.0` (then redeploy). If the rpc errors, that batch falls back to 1.0.0 and the run is `ok=false` with `extra.fmv_recent_error`. Telemetry: `extra.fmv_engine`, `fmv_recent_hits`.
- **Backfill** `20260925040146`: 777 HIGH / 926 MEDIUM / 2,680 LOW / 710 ASK_ONLY. `panini_squeeze_totals.sale_backed` = HIGH+MEDIUM+LOW; `recent_sale_backed` = HIGH+MEDIUM (both shown on `/insights/panini-squeeze`).

### Three sampling traps fixed in the runner first (2026-09-23/24)
1. **30-row serial page:** `getPskuTotalCardsList` pages at `l:30`; only window scroll loads the rest. A max serials-per-edition pinned at 30 is a page size. `loadAllSerialPages()` (`PANINI_SERIAL_PAGES`, default 12). Sentinel warns if it reappears.
2. **TOP SALES default:** `nftSalesData` returns `sale_type:"top"` (all-time highest) unless the dropdown is switched to RECENT SALES → `openRecentSales()` (kill switch `PANINI_SALES_RECENT=0`; counters `recentPages`/`recentMissed`).
3. **A pointer click failed silently:** Playwright's click opened RECENT on 3 of ~300 cards with no error; `locator.evaluate(el => el.click())` works. Count opened-vs-missed; never trust "no exception".

### Monitoring
Sentinel "Panini Ingest" arm over `sentinel_panini_health()`: walk age warn 14 h / critical 26 h; oldest edition warn 168 h / critical 336 h; max serials per edition ≤30 → warn; newest sale warn 72 h / critical 168 h.

## Edition FMV — v0 (`panini-1.0.0`, history)
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

⚠ **Re-read 2026-09-24 on FMV 1.1.0 (board UNPUBLISHED; never publish a positive "rip edge"):** Hobby EV $158 vs $146 cost, typical pull $32; FOTL $272 vs $264, typical $47. The mean sits above cost only because of the tail; the typical pack loses most of its cost.

**Two things ground this model:** the published pack contents/odds, and the fact that EV is computed on the
pool that is **still in packs** (unopened), not on total mint.

> ⛔ **CORRECTED 2026-09-29 (model v0.5, migration `20260929224922`): Hobby is 4 cards and FOTL 5, not 5 and 6.**
> Panini's own pack data says so twice: `panini_pack_state.raw.cards_per_subpack` = 4 (1038) / 5 (1039), and the
> description reads "contain 4 cards per pack … 2 Base Silver (#/259), 1 Base Non-Silver Parallel, 1 additional Base
> Non-Silver Parallel - OR - a 35% chance at an Insert". The label's "1 Other Card" IS that either/or slot, not a
> separate common — so the model carried one phantom Silver-tier card per pack (weight 3 → 2). Effect at the switch:
> Hobby actual 148 → 144 / typical 27 → 25; FOTL 261 → 257 / 43 → 41. The 07-18 reading below is kept as written.

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

## Serial-premium FMV (2026-07-16; refit 2026-09-24)
⚠ **Refit 2026-09-24 (`20260925000244`) on the larger sale set: jersey 1.43×, perfect 1.25×, #1 1.50×.** The 07-16 figures below are history. Deal board (`20260924223606`) now also requires a recent-sales basis (`recent_sales_median_usd`, `recent_sales_n`, `deal_basis`).

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

## Pack EV — 2026 Prizm WNBA (`panini_pack_ev_model_wnba_2026`, v0.1, 2026-09-30)

Product setId **2420** (packs: FOTL 1055 $150 drop, Hobby 1056 $30 drop). Same remaining-pool basis as the
WC model. Contents per Panini's pack_label/description (read 2026-09-29): **Hobby 4 cards** = 2 Base Silver #/296
+ 1 non-Silver base parallel (#/169→1/1) + 1 more base parallel **or** an insert (1 in 4 packs) → 2 silver + 1.75
base + 0.25 insert. **FOTL 5 cards** = Hobby + 1 exclusive (Cherry Blossom #/17, Plum Blossom #/8, Lotus Flower #/3).
Families from `set_name` (migration `20260930222440`).

**Accuracy gate (new for this model):** a pack is `ev_modeled` only when every family in it has ≥3 editions priced
from SALES (HIGH/MEDIUM/LOW). At build (~3:30 PM PT 09-30, first walk of 2420 still running) Hobby passed
(silver 61 / base 55 / insert 9 sale-backed) and FOTL did not: its exclusive family had 2 sale-backed of 15 priced,
the rest ask-derived (top: a $600 ask-derived Cherry Blossom). So the board shows **Hobby: mean $32, typical $19 vs
$30**, and FOTL "not modeled yet".

FOTL off-board reading at build, for the record (not published): mean $181 / typical $69 using ask-derived exclusive
prices; with the exclusive leg valued on its 2 sale-backed editions only (~$28) the mean is ~$58. Every basis sits
far below the $150 drop price.

> ⛔ **CORRECTED 2026-09-30 ~7:15 PM PT (v0.2, migration `20261001020609`): the count gate was not enough.** By 7 PM
> (387 editions) FOTL passed "≥3 sale-backed" and the board published **+$20** (FOTL) and **+$6** (Hobby) edges, but
> sale-backed editions carried only **15%** of the exclusive family's remaining-weighted value, **33%** of base and
> **20%** of insert (silver 90%). Valued on sale-backed editions alone: Hobby ~$21 vs $30, FOTL ~$114 vs $150 — the
> edges were ask artefacts. Gate is now: every family in the pack needs ≥3 sale-backed editions **and** sale-backed
> editions carrying **≥50% of its value** (`*_sale_share` columns). WC families sit at 81–100%, so the WC board is
> unaffected. Both WNBA packs read "not modeled yet" until their markets trade.

### Independent check — player × parallel sales model (2026-10-02 ~7:45 AM PT, not on the board)

Bypasses the FMV layer entirely. Inputs: all **1,310** recorded WNBA 2420 sales (`panini_sales`, 09-26 → 10-01) and
1,398 catalogued editions with `still_in_packs`. Model: log(sale) = player effect + parallel effect, fit by
alternating least squares (40 iterations). The liquid parallels (Silver 172/196 editions sold, Purple 155/187) pin
each player; the rare-parallel sales pin each parallel's multiplier. That predicts a price for every edition in the
pool, including the ~85% of rare-parallel editions that never sold. Fitting per-edition averages instead would price
a random pull like the stars who sold first (Plum Blossom: 8 of 83 sold, two of them $1,000 Miles / Clark).
In-sample log RMSE 0.2–0.7 per parallel. Average-player prices: Silver $1.29 · Purple $2.40 · Pink Velocity $3.88 ·
Cherry Blossom $8.53 · Mojo $9.71 · Gold $21.63 · Plum Blossom $34.12 · Black Gold $51.98 · Gold Vinyl $245.
Imputed: unsold insert Golds = mean of sold insert Golds; Dual Color Blast = Abstract/Color Blast mean; **Lotus Flower
(1 sale, $15) set to Black Gold's level** (deliberately generous).

Monte-Carlo, 20,000 packs: slot draws ∝ `still_in_packs`, Panini odds (2 Silver + base + 0.75 base / 0.25 insert
[+ 1 exclusive]), residuals bootstrapped from the fit:

| Pack | Price | Mean | Median | P(pack ≥ price) |
|---|---|---|---|---|
| FOTL 1055 | $150 | **$45** (analytic, per-family smearing: $56) | **$26** | **3.6%** (p90 $81, p99 $374) |
| Hobby 1056 | $30 | **$16** (analytic: $22) | **$10** | **9.8%** |

Daily sale medians are flat to falling since the Hobby drop opened 09-30 (Silver mean $3.14 on 09-28 → $1.88 on
10-01). Prices are gross of any marketplace fee. A candidate for the board's model (it removes the ask-share problem
the v0.2 gate guards against), not shipped — build it deliberately.

### ✅ SHIPPED 2026-10-02 ~6:10 PM PT — the sales model now drives the WNBA board (`panini-pack-ev-wnba-sales-1.0`)

`refresh_panini_pack_ev_sales_model(2420)` (pg_cron `rpc-panini-pack-ev-sales-model`, :46 hourly) runs the player ×
parallel fit above in-database and writes `panini_pack_ev_sales_parallels` / `_families`;
`panini_pack_ev_model_wnba_2026_sales` turns those into pack EVs and `panini_pack_ev_board` reads it for 2420.
Imputation is generic, with no parallel named: no sale → same family + print run; < 3 sales → floored at the best
larger-print-run parallel of its family. Gate: ≥ 10 sales in every family of the pack and a fit < 6 h old.
First fit: 1,315 sales → **Hobby 22 / typical 9 vs 30 (edge −8); FOTL 55 / typical 18 vs 150 (edge −95).**
The FMV-based `panini_pack_ev_model_wnba_2026` (v0.2) stays as a diagnostic and is no longer read by the board.
"Typical" is the sum of family medians (same convention as WC); the Monte-Carlo pack median is higher
(FOTL ~$26), so treat the board's typical as conservative.
