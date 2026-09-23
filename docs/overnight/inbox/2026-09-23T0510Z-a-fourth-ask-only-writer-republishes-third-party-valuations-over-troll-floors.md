# A fourth ASK_ONLY writer, `fmv_from_cached_listings`, republishes Flowty's valuation as RPC's FMV, over $1,000,000 troll floors. It re-created a retired price within four hours.

**Filed 2026-09-22 ~10:10 PM PT (Cowork cloud). READ-ONLY. Nothing shipped:** this is pricing logic.

## What I verified in Claude Code's 09-22 evening report

- ✅ 0 active pg_cron jobs carry a literal `key=`. 12 active jobs plus 1 inactive (job 16) call `cron_gate_key()`, which is 13 as claimed. `cron_gate_key` RAISEs on a missing secret, and anon cannot EXECUTE it.
- ✅ Cron 0 failures out of 1,195 in 3 h.
- ✅ `refresh_allday_ask_fmv_from_listings` anti-joins `allday_listings_sold_after_listing`.
- ⚠ **"All Day ASK_ONLY with no live ask: now 0" was true when written and is 1 again.** The edition is Mark Andrews *Dynamic* (`810e0175-…`): `NO_DATA` / `allday-ask-retired-v1` at 6:10 PM PT, then re-published at **9:54 PM PT** as `ASK_ONLY` $11.77 by `algo_version = ask_only_v2`, with `floor_price_usd = 1,000,000`.

## The writer

`public.fmv_from_cached_listings(p_collection_id, p_algo_version DEFAULT 'ask_only_v2')`.
- ⚠ The `ask_only_v2` literal lives in **`proargdefaults`, not `prosrc`**, which is why a `prosrc` grep for it returns nothing.
- It is called by `app/api/allday-listing-cache`, `golazos-listing-cache` and `ufc-listing-cache`, each every 20 min (72 runs in 24 h).
- Mean call time is 9.9 s; `pg_stat_statements` counts 4,955 calls.

What it does:
1. **Reads legacy `cached_listings`,** the Flowty-fed table, not `cached_listings_v2`. So neither the ghost set nor the ghost-filtered view touches it.
2. **Prices FMV as `AVG(cached_listings.fmv)`,** i.e. Flowty's `valuations.blended.usdValue`, and falls back to the min ask ≤ $5,000. It labels the result `ASK_ONLY`. That is a third-party valuation published as RPC's own price. It is the Flowty blend that `fmv-recalc` removed on 2026-05-24, and it survives here.
3. **Writes `floor_price_usd = MIN(ask_price)` with no troll ceiling.** 8 of the 10 All Day rows carry a floor of **$1,000,000**.
4. **Its DELETE is not date-bounded:** it deletes *every* `ASK_ONLY` **and `LOW`** snapshot for matched editions that never held HIGH or MEDIUM. So a sales-derived LOW can be replaced by a Flowty valuation. Of the current ask_only_v2 rows, 17 of 67 Golazos editions and 6 of 10 All Day editions have ≥1 sale in 90 d.

## Examples: All Day, current published row = ask_only_v2 (9:54 PM PT)

| edition | published FMV | its floor field | live floor (ghost-filtered) |
|---|---|---|---|
| Jer'Zhan Newton, Regal Rookies | $60.39 | $1,000,000 | **$3** |
| Isaac Bruce, Career Chronicles '94 | $50.14 | $1,000,000 | **$4** |
| Xavier Worthy, SB LIX Icon | $202.76 | $1,000,000 | **$46** |
| Jordan Addison, Dynamic | $433.23 | $1,000,000 | **$325** |
| Mark Andrews, Dynamic | $11.77 | $1,000,000 | none (0 open listings) |

These are FMVs **above** a live buy-it-now. That is the confident-wrong shape the ask-ceiling exists to stop, and this writer bypasses it.

## Scale

- **Golazos:** 67 editions, Σ FMV ≈ $14.3k.
- **All Day:** 10 editions, Σ ≈ $1.4k.
- **UFC:** not measured.

## Decision for Trevor

Retire the RPC call from the three listing-cache routes, or scope it to editions with no other pricing and apply the ask ceiling and troll cap to it. Either one needs:
- the DELETE bounded to its own rows (`algo_version = p_algo_version`);
- `refresh_edition_fmv_current` run afterwards, because the snapshot is not the surface.

**Falsifier:** after the change, `fmv_snapshots` gets no new `ask_only_v2` rows in 24 h, and no current All Day row has FMV above `allday_edition_floor_ask.floor_ask`.
