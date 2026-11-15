# Candy secondary trading is reviving past the 11-10 "silent_since" disposition — 9 sales since the baseline (7 in the last 48 h), revival counter 9/10

Filed 2026-11-15 ~04:10Z (≈11-14 8:10 PM PT) by the daytime health monitor. Read-only sense-and-log; nothing changed. Not observed in a saturation spell (`rpc_ops_snapshot()` and all probes returned fast; no IO-wait majority).

## What was read

- `rpc_ops_snapshot()` trust_health: `candy_sales_stale_hours` = **9.7 (BREACH, breach_at 0)** and `candy_revival_sales_since_recorded_silence` = **9 (ok, breach_at 10)** — one more Candy sale trips the revival arm to BREACH.
- Direct count (`sales` ⋈ `editions`, candy_mlb): **17 sales in 14 d, 7 in the last 48 h**, last sale **2026-11-14 18:22Z**. The revival counter (9) is since the recorded-silence baseline of **2026-11-10** (`v_collection_marketplace_status.candy_mlb` = `silent_since_2026_11_10`, set in `20261110225146`).

## Why this is a state change, not noise

The prior daytime finding (`inbox/2026-11-10T0645Z-candy-revival-detector-fired-first-sale-since-10-11.md`) was dispositioned on 11-10 ~2:55 PM PT as **"a trickle, not a revival"** (1 Magic Eden sale + 4 dust sales), and the silence baseline was re-dated to 11-10, which reset the revival counter to 0. Five days later that baseline has accrued **9 sales, 7 of them in the last 48 h** — an accelerating trickle, not the dust rate the 11-10 call was made on. #58 ("Candy secondary trading STOPPED on 10-11", closed by measurement) and the `silent_since_2026_11_10` relabel are both being overtaken.

## Risk read

LOW. No pipeline is broken — `candy-sales-indexer` is ingesting (last sale 18:22Z, `detect_stalled_pipelines()` = []). The only consequence of leaving it is that `candy_sales_stale_hours` keeps reading BREACH (its known #58 false-breach shape) and the revival arm flips to BREACH on the next sale, which is the arm doing its job. The product-facing question — is the candy_mlb market "open" again, and are these Base-set or legacy-collection prints — is unanswered and gates the frozen-book caveats in `docs/strategy/collections/candy-mlb.md`.

## Suggested action (night pass / Trevor — value UPDATE, operator-held)

Re-score Candy trading over the 11-10→now window: count the 9 revival sales by `sold_at` day and by set (Base 2026 set vs legacy ICONs), and decide whether the `v_collection_marketplace_status.candy_mlb` row should move off `silent_since_2026_11_10` to an "open/reviving" status (the same md5-guarded, `security_invoker`-preserving UPDATE pattern as `20261110225146`). If it is still legacy-dust, re-date the silence baseline again to reset the revival counter. Either way the 10-11 relabel can finally be scored if Base-set sales are among the 9. Re-measure, don't assume the 11-10 "trickle" call still holds.
