# The board-warm failures now have names, and the numbers say capacity — not a missing index

Claude Code, interactive, 2026-08-12 ~16:30 PT (2330Z). **Read-only measurement. The instrumentation that produced it shipped today (`d6a71b27`); this is its first harvest.**

## What changed

Until this afternoon `pipeline_runs` recorded board-warm failures as bare keys —
`"deals; first-mint; panini-squeeze"` — 68 times out of 68, with no cause. `warmBoard` only
carried an error when the live closure *threw*, and these fetchers never throw. With
`BoardLiveResult.error` shipped, the same rows now read:

| board | reason (verbatim from `pipeline_runs.error`) |
|---|---|
| `deals` | `cross_collection_deals_board: canceling statement due to statement timeout` |
| `first-mint` | `topshot_first_mint_trophy_stats: …timeout, topshot_first_mint_trophies: …timeout` (BOTH) |
| `rookies` | `topshot_2025_rookie_cohort_stats: …timeout, topshot_2025_rookie_index: …timeout` (occasional) |
| `panini-squeeze` | `panini_squeeze_board: query failed` |

Frequency over the last 5h: the `deals` + `first-mint` pair accounts for **49 of ~58** failing runs.

## The number that reframes it

`service_role` — the role `supabaseAdmin` runs as — carries **`statement_timeout=30s`**
(measured: `anon` 3s, `authenticated`/`authenticator` 8s, `service_role` 30s).

So these views are not merely slow. **They are exceeding THIRTY SECONDS.** And
`topshot_first_mint_trophy_stats` was measured at **2,047 ms** on a quiet instance on
2026-08-11, immediately after `idx_sales_2026_ts_otherserial_cover` took it from 17,308 ms.
That index is alive and in use (591 scans, 62 MB) — verified, not assumed.

**A ~2s query is crossing a 30s ceiling. That is a ~15× multiplier from disk-IO throttling,
not a query-plan defect** — which means the next covering index buys little, and the lever is
the one CLAUDE.md already names: the shared **materialize-latest-FMV** item, which would close
`cross_collection_deals_board` and `/api/market` together.

⚠ **Do not respond to this by adding another index to `sales_2026`.** The 08-11 index did its
job; the cost is elsewhere. Re-measure on a genuinely quiet instance before choosing a lever
(the 08-10 entry records a finding whose conclusion inverted under `EXPLAIN (ANALYZE)`).

## Already handled — do not re-file

- **The build-kill.** A slow board took down deploy `dpl_FwbnxURHqSbbYRqCQus44Cxxgyhc` entirely
  (`/insights/first-mint` > 60s × 3 attempts → `npm run build` exited 1). Fixed by
  `BOARD_LIVE_TIMEOUT_MS` (`673d2436`) — the live query is now raced against an 8s clock so a
  slow board falls to the stale snapshot instead of blocking a render. That is containment, not
  a cure: the boards still fail to warm.
- **User impact is currently NIL.** All five snapshots exist and are served; measured ages
  14–100 min. Users see stale-but-complete boards, which is the caching layer working as designed.

## What is NOT yet known

- Whether the timeouts are continuous or bursty across the day — the 6h sample was uniform, but
  `pipeline_runs` retains only ~73h, so use `pipeline_runs_daily` for anything longer.
- Whether `panini_squeeze_board: query failed` is also a timeout. It is reported distinctly on
  purpose (the fetcher separates "errored" from "partial ranking hit the page cap"), and its
  message is not a timeout string — so it may be a different fault and should be read separately,
  not folded into the timeout cohort.

---

## Swept the estate for the same blind-instrument class — it is NOT wider. (Negative result, worth recording.)

The board-warm gap was "a failure recorded with the reason discarded". Obvious next question:
how many other pipelines do that? Measured over 24h, every pipeline with at least one failure:

| pipeline | failures | failures with NO reason |
|---|---|---|
| `promote_unmapped_sales` | 5 | **5** |
| `wallet-backfill-allday` | 49 | 0 |
| `wallet-backfill-pinnacle` | 44 | 0 |
| `pinnacle-nft-resolver` | 29 | 0 |
| `compute-topshot-pack-ev` | 28 | 0 |
| …11 more | — | 0 |

**Exactly one candidate, and on inspection it is not the defect.** `promote_unmapped_sales` logs
`error IS NULL` because *nothing errored*. Its `ok:false` comes from a purpose-built branch whose
own comment reads:

```sql
-- ...true silent-failure signature reds the run:
-- there was work to do and absolutely nothing changed.
IF v_eligible > 0 AND v_promoted = 0 AND v_dedup = 0 AND v_merged = 0 AND v_blocked = 0 THEN
  v_ok := false;
```

All five runs match it exactly (`eligible 1, promoted 0`, every explanatory bucket 0). **The
condition IS the reason** — it is a deliberate silent-no-op detector, working. The only gap is
that an operator must read `extra` rather than `error` to see it.

⚠ **Deliberately NOT "fixed".** Setting `p_error` to a human string would be a one-line
readability win on a function that is (a) DB-invariant **pinned**, (b) whose pin CLAUDE.md records
as **STALE** — so a change needs a snapshot migration authored first — and (c) on the sales-ingest
path, which is off-limits for autonomous shipping. Low benefit, real blast radius. **Recorded so
nobody re-investigates these 5 rows/day as an anomaly: they are the detector doing its job.**
