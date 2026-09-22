# All Day FMV is capped by month-old floor listings that the market keeps clearing ABOVE — 55 % of HIGH editions sit below every one of their last 7 sales

**Filed 2026-09-22 ~1:45 PM PT (Cowork cloud, daytime autonomous pass). READ-ONLY. Nothing shipped:** pricing logic (`app/api/fmv-recalc`) is off-limits to autonomous passes. This bears directly on the headline KPI, because the rows it affects are **counted as HIGH/MEDIUM**.

## The measurement (DB 1:35–1:45 PM PT, 30-day sales, editions with ≥ 7 sales)

`edition_fmv_current.fmv_usd` ÷ the median of the edition's **last 7 sales**:

| collection | tier | editions | median ratio | FMV below ALL last-7 sales | FMV above ALL last-7 |
|---|---|---|---|---|---|
| nba_top_shot | HIGH | 1,366 | **1.000** | 18 (1 %) | 67 |
| nba_top_shot | MEDIUM | 1,479 | **1.000** | 58 (4 %) | 79 |
| **nfl_all_day** | **HIGH** | 74 | **0.740** | **41 (55 %)** | **0** |
| **nfl_all_day** | **MEDIUM** | 326 | **0.682** | **142 (44 %)** | **0** |
| nfl_all_day | LOW | 121 | 0.500 | — | — |

⭐ **The tell is the one-sidedness.** Top Shot errors are symmetric around 1.00. All Day errors point one way, with **zero** editions above the whole recent range. That's a clamp, not noise.

## The mechanism (read, then confirmed in data)

`app/api/fmv-recalc/route.ts` Step 2a-ter(b) builds the **ask-CEILING** map from `allday_edition_floor_ask.floor_ask`, and Step 1 applies `fmv = capFmvAtCheapestAsk(fmv, ceiling)`. **That read has no age or verification gate.** `allday_edition_floor_ask` is a view over `cached_listings_v2` (`completed_at IS NULL`, not expired), and it has no verification column (ledger note: *"`floor_ask_listed_at` is when the listing was CREATED"*).

Confirmed: of the **184** All Day HIGH/MEDIUM editions whose FMV is below every one of their last 7 sales, **180 have FMV exactly equal to the floor ask**. Those floor listings are a median **36 days old**; 144 are older than 30 days, and the oldest is from 2026-04-21.

Example: Josh Allen Base COMMON (HIGH). FMV $0.10, pinned there since at least 09-17, while every recent sale was $0.16–0.39 (last-7 median $0.22). A live $0.10 listing that seven buyers in a row pay 2× to avoid is very unlikely to be purchasable. The likely explanation is a ghost listing whose NFT moved or whose listing is otherwise dead, with no completion event reaching the indexer.

## Why nothing was shipped

- It changes a published price, which is FMV logic and off-limits to autonomous passes.
- The right discriminator is a design decision:
  1. **Age-gate the ceiling.** Only cap when `floor_ask_listed_at` is recent, or when the floor listing has been seen in a recent `cached_listings_v2` walk. ⚠ There is no "last seen" column today.
  2. **Market-contradiction gate.** Skip the cap when N of the last M sales cleared above the floor after it was listed. The data above suggests this is the direct test.
  3. **Fix the source.** Retire ghost listings in `cached_listings_v2`, e.g. owner ≠ lister, the NFT sold elsewhere after `listed_at`, or a listing-verification walk. That also fixes the All Day deal board and alerts, which read the same floor.
- ⚠ Magnitude: the dollars are small, because these are cheap commons (typical last-7 median $0.19–0.20 and a total gap of about $52 across the 184 editions). The **percent** error is 25–50 % on editions the KPI counts as confident, and that is what the accuracy gate measures.

## Falsifier / controls for whoever picks this up

- **Positive control, run on the same instrument:** the Top Shot rows above use the same query and come out symmetric at 1.00.
- **Falsify "ghost":** for a sample of the 180 floor listings, check on-chain or through Dapper that the listing is still purchasable. If most are live, the finding becomes "buyers pay 2× the floor", which would be very surprising for commons, and the ceiling is right.
- Re-run the ratio after any change: All Day HIGH/MEDIUM should move toward 1.00 and keep a symmetric spread.
