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
