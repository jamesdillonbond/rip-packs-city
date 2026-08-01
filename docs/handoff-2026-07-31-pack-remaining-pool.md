# Handoff — Pack "remaining pull pool" accuracy

Author: Cowork, 2026-07-31 (PT). Trigger: Trevor — *"We want an accurate view of what's left to be pulled from every single pack, so we can accurately provide Pack EV to our users."*

Two DB-only items already SHIPPED (see `docs/overnight/ledger.md`, 2026-07-31). Everything below needs repo/worker/edge access Cowork does not have, or is a product decision.

## The one-paragraph summary

The remaining-pull pool comes from the **publisher** (`packEditionsV3 { count remaining }` + `packListingContentRemaining`), **not** from our on-chain pack-open history. Only Top Shot models remaining at all; AllDay, Golazos and Pinnacle all weight by original minted supply, which systematically overstates EV on picked-over packs. Of **1,398** distributions currently serving a live Pack EV, only **390 (27.9%)** have a remaining pool we can defend.

Query the state any time:

```sql
SELECT collection, remaining_basis, remaining_trustworthy, count(*) AS dists,
       sum(total_sealed) AS packs_still_sealed, min(basis_note) AS note
  FROM public.v_pack_remaining_basis
 GROUP BY 1,2,3 ORDER BY 1, 4 DESC;
```

## Item 1 — AllDay Pack EV is original-supply weighted (HIGHEST user-facing impact)

`supabase/functions/compute-allday-pack-ev/index.ts` (v9) weights each edition by `circulation_count` via `supplyWeightPool()` and **never queries `remaining`**. Because `drop_weight == orig_drop_weight` and the collection isn't Top Shot, `compute_pack_ev_per_edition_weighted` resolves `ev_basis='original'` for all 2,950 AllDay dists.

Meanwhile `app/api/allday-pack-ev/route.ts:454` already does the right thing at request time:

```ts
const prob = totalUnopened > 0 ? node.remaining / totalUnopened : 0
```

**So there are two different EV models on the same collection**, and the warehouse one feeds the boards. That much is a verified code fact (`ev_basis='original'` on all 2,950 AllDay dists).

> ⚠ **CORRECTION 2026-07-31 (Claude Code) — the bias table that used to sit here was INVALID. Do not ship the port on it.**
>
> It compared a **whole-pack** modeled `gross_ev` against a **partial-pack** realized value. `mv_allday_pack_realized` sums `pack_rips.pull_value_usd`, which only counts the pulls we actually attributed — and AllDay pull capture is both low and wildly uneven:
>
> | dist | slots | pulls captured/pack | capture | realized_mean | old headline |
> |---|---|---|---|---|---|
> | 7073 | 7 | 4.12 | 59% | $107.18 | "$523 vs $65.63" |
> | 7103 | 7 | 0.56 | **8%** | $231.44 | "$386 vs $73.62" |
>
> Both dists are also **99–100% opened** (1 and 0 packs still sealed) — the least user-relevant possible examples, chosen because they were the most dramatic.
>
> Across all AllDay dists with realized data, capture varies ~8× by depletion bucket — the *same axis* the bias was being measured along — so the ratio is dominated by missing pull data, not by EV-model error:
>
> | bucket | sealed packs | pulls/rip | priced | warehouse ÷ realized (median) |
> |---|---|---|---|---|
> | ≥99% opened | 356 | 0.91 | 55.7% | 1.46 |
> | 90–99% | 34,519 | 0.31 | 37.7% | 1.21 |
> | 50–90% | 98,409 | 0.48 | 41.9% | 1.98 |
> | <50% fresh | **346,563** | 0.33 | 19.2% | **0.67** |
>
> Note the sign: on the freshest packs — where **74% of all sealed AllDay inventory sits** — the warehouse model **understates**, and because realized is a floor there (6% effective value capture) the true understatement is larger than 0.67 suggests. That is the opposite of the "original-supply weighting overstates EV" thesis this item was built on.
>
> **`v_allday_pack_realized_ev` cannot adjudicate EV-model accuracy in its current state**, in either direction. Fixing AllDay pull attribution is therefore a **precondition** for this item, not a parallel nice-to-have.

**Fix:** port the `packEditionsV3 { count remaining }` pagination from the API route into `compute-allday-pack-ev`, write `drop_weight = remaining / totalUnopened` and keep `orig_drop_weight = count`. That single change flips AllDay to `ev_basis='remaining'` automatically — the RPC already picks basis off `orig_drop_weight` presence, so **check that interaction**: today AllDay writes `orig_drop_weight = w` (the same normalized weight), which is what forces `'original'`.

Remaining-weighting is more truthful than original-supply weighting on principle, so the port is probably still right. But **it is currently unvalidatable**: per the correction above we cannot measure its effect before shipping, and we cannot detect a regression after. Sequence it behind AllDay pull attribution. Also note `packEditionsV3` lives on the **consumer** endpoint (`nflallday.com/consumer/graphql`), which is CF-1009 blocked from both the worker and residential egress (re-confirmed 403 on 2026-07-31) — only Vercel egress reaches it, so the port has a real transport constraint the edge function does not satisfy today.

**Revert:** `git revert <sha>` + redeploy the previous edge function version.

## Item 2 — Internal Dapper reserve packs are being published with absurd EV

`pack_ev_latest` includes non-purchasable internal distributions:

| dist | title | pack_price | gross_ev |
|---|---|---|---|
| 5730 | NFL Pack Hold - Genesis | **$999,999** | **$900,000** |
| 7186 | Super Bowl LX: Holding Pack | $9,999 | $3,767 |
| 7135 | Playoff Icons: Premium Serial | $9,999 | $2,450 |
| 6373 | Legends of The Turf: Premium S | $9,999 | $2,025 |
| 6722 | Ultimate Holding Pack (Rookie) | $9,999 | $900 |

These alone pull AllDay's average `gross_ev` to **$1,880** against a `typical_ev` of **$14.18**. They are reserve/holding rows, never sold to users.

**Fix:** exclude them from the publish path. A price sentinel (`pack_price >= 9999`) plus a title filter (`title ILIKE '%holding%'` / `'%pack hold%'`) covers all observed cases, but confirm against the full list before hardcoding — this is a publish-guard change, and per the "an MV is NOT the view it mirrors" rule the guard must live in every surface that publishes EV, not just one.

**Revert:** `git revert <sha>`.

## Item 3 — The moments-hydrator backlog is unreachable by construction

This is the fix for the 174,018-pull Top Shot attribution gap. **It is not a throughput problem.**

`v_moments_needing_hydration` (live definition):

```sql
SELECT nft_id, collection_id, wallet AS owner_address, acquired_date, source_pack_rip_id
  FROM moment_acquisitions ma
 WHERE acquisition_method = 'pack_pull'
   AND acquisition_confidence = 'verified'
   AND NOT (EXISTS (SELECT 1 FROM moments m
                     WHERE m.nft_id::text = ma.nft_id AND m.collection_id = ma.collection_id));
```

There is **no attempt counter, no failure flag, no last-tried timestamp** — anywhere. `workers/topshot-moments-hydrator/index.ts:118` reads it `ORDER BY acquired_date DESC LIMIT 300`. A moment leaves the view only by acquiring a `moments` row, so every nft_id GraphQL cannot resolve sits at its ordinal position **forever** and is re-fetched every 10 minutes. Observed: the top-300 window spans ~3.5 days, ~30–90 dead rows accumulate per day, and **~173,500 rows older than that (Apr–May 2026) are never fetched at all.**

⚠ **This is now the critical path, and LOCAL SOURCES ARE EXHAUSTED (measured 2026-07-31).** After the AllDay backfill, `allday_pack_pull.edition_id` is still NULL on **301,823 rows**, and of those: **0** are derivable from `moments`, and only **95** from `wallet_moments_cache`. There is no local data left to mine — every remaining row needs an external per-moment lookup, which is exactly what the hydrator supplies. So the chain is: **hydrator (needs a Cloudflare worker deploy) → AllDay pull attribution → realized-EV calibration → the ability to validate ANY Pack EV model change** (Item 1 included). One inaccessible deploy currently gates the whole Pack EV accuracy program.

**Fix:** add `hydration_attempts int` + `last_hydration_attempt_at timestamptz` to `moment_acquisitions` (or a side table keyed on nft_id), have the worker increment on every attempt, and order candidates by `last_hydration_attempt_at NULLS FIRST` so the queue rotates. Optionally retire a moment after N failed attempts. Needs the worker change **and** a wrangler deploy (Cowork has no `CLOUDFLARE_API_TOKEN`).

**Note on priority — REVISED 2026-07-31.** This gap does **not** affect Top Shot's remaining pool (which comes from the publisher), and I originally down-rated it for that reason. That was too narrow. It affects **realized-EV calibration**, and per the Item 1 correction, realized EV is the *only* instrument we have for validating any Pack EV model change — currently too sparse and too unevenly sparse to adjudicate anything. Attribution/hydration is the gate on making Pack EV accuracy **measurable at all**, which puts it upstream of the pricing work rather than beside it.

**Revert:** `git revert <sha>` + redeploy prior worker version.

## Item 4 — mostly a FALSE ALARM; the real residual is stale pools, not incomplete ones

> ⚠ **CORRECTED 2026-07-31 (Claude Code).** The original claim — "324 dists flagged incomplete, yet 312 still carry a live `pack_ev_latest` row (avg `gross_ev` $47.79)" — conflated two groups that `remaining_trustworthy = false` lumps together. Split by `basis_note`:
>
> | basis_note | dists | with **non-null** gross_ev | avg EV | sealed packs |
> |---|---|---|---|---|
> | `pool incomplete (sum drop_weight < 0.5)` | 193 | **1** | $1.99 | 208,398 |
> | `pool stale > 7d` | 131 | **122** | $47.26 | 76,598 |
>
> The incomplete-pool case is **already handled correctly**: 192 of 193 publish a row whose `gross_ev` is NULL, which is the honest "no EV" rendering — exactly like `depleted` / `placeholder_uniform`. The "312 rows" figure counted row *existence*, not a published number. **No product decision is needed here.**
>
> The genuine residual is **`pool stale > 7d`: 131 dists / 122 published EVs / 76,598 sealed packs**, computing EV off a drop pool not refreshed in over a week. That is the Atlas-staleness item below, not an incompleteness problem — so Item 4 collapses into Item 5's first bullet.

Also worth recording, since it explains why the incomplete group looks alarming but isn't: `sum_drop_weight` for the untrustworthy set ranges 0.001 → 6.623. Values **above 1** are not incompleteness at all (they are the stale/duplicated-pool rows); values below ~0.2 already resolve to a NULL EV. A future guard should key on `basis_note`, never on `remaining_trustworthy` alone.

## Item 5 — Operator / smaller

- **Atlas pool stale since 2026-07-17** — 57 TS dists, EV still recomputes off it hourly. Needs the Atlas env var + a fresh Bearer (already tracked in memory as the "Atlas key" item, 229 targets waiting).
- **`gql_historical` mislabel (544 dists)** — `backfill-topshot-pack-supply` `mode=pool` writes `drop_weight = count / totalCount` (original mint share) but the RPC reports `ev_basis='remaining'`. Currently latent (0 live EV rows, `pack_ev_latest` filters `pack_price > 0`) — fix before any of those dists gets a price.
- **`topshot-pack-opens-history-backfill` is walking the WRONG DIRECTION** (re-measured 2026-07-31). 193 runs / 48h, **all `ok=true`, `rows_found` 31,781, `rows_written` 0**. Cursor sits at block **99,990,659** — but **528,425 TS rips already exist above it** (TS rips span blocks 61,930,346 → 159,920,620, 821,138 rows). It is re-walking covered ground forward. The genuine gap is **below block 61,930,346**: our earliest TS rip is `2023-09-29`, and Top Shot packs date to 2020. So it needs to walk *backward* from the floor, not forward from the middle. ⚠ Correction to the earlier draft: `rows_written` is **not** missing — `pipeline_runs.rows_written` is populated and honestly reads 0; the pipeline is not hiding its uselessness, it is `ok=true` *while* reporting 0, which is the "green pipeline blind to its own work" class rather than a missing-telemetry one. Implementation is the Deno edge fn `supabase/functions/ingest-topshot-pack-opens-history` (pg_cron jobid 56, `11,26,41,56 * * * *`, invoked with a byte-exact `?key=` gate) — so the fix is an edge deploy, deliberately not attempted from a sandbox with no Deno toolchain.
- **Pinnacle has no pack-open ingest at all** (0 rips vs 433,575 publisher-opened) and no drop-pool rows; its EV is inline supply-weighted off `pinnacle_catalog.total_minted`.

## What is NOT worth doing

- **Do not build an opens-derived remaining pool for Top Shot.** Our TS rip history covers 4.5% of publisher-reported opens (762,082 / 16,837,027) because it starts 2023-09-29 and TS packs start 2020. Publisher remaining is the only honest TS source.
- **Do not re-run the sales-vs-wmc attribution audit without collection-scoping.** Joining `sales` on `nft_id` alone matches across collections and manufactures a fake ~13% error rate. Scoped, all sources agree 100%.
- **Do not compare modeled `gross_ev` against `realized_median` / `realized_mean` as if they measure the same thing.** Modeled EV is whole-pack; realized is the sum of *attributed* pulls only, and AllDay capture ranges 0.31–0.91 pulls per 7-slot pack depending on the bucket. Any such ratio is mostly an attribution-coverage measurement wearing a pricing-accuracy costume — it produced a confident, wrong-signed conclusion in the first draft of this document. Before quoting a ratio, report `pulls_per_pack` and `pct_pulls_priced` alongside it; if capture is not both high and *uniform across the comparison axis*, the ratio does not support a conclusion.
