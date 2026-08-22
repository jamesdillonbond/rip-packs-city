# The disk-IO budget, ranked: 7,809 GB / 242h, and the two priciest boards are LIVE (I nearly filed the opposite)

**Filed 2026-08-21 ~20:40 PT (2026-08-22 03:40Z), Claude Code interactive. MEASURED, read-only.
Nothing shipped — this is the ranking the "fix expensive queries" instruction has been missing.**

CLAUDE.md's standing guidance on the saturation is *"the intermittent saturation is disk-IO-bound, NOT
compute-bound — **fix expensive queries**, don't upgrade."* That names a remedy without naming the
queries. Several open filings now converge on the same 20-hour degraded band (the deals board at ~80%
refresh failure, the cross-collection mats 5 days stale, `fmv-recalc` "losing 19 hours a day"). This is
the shared denominator, ranked.

---

## The budget

`pg_stat_statements`, window **242.0 h** since `stats_reset` 2026-08-12 01:34Z:

**1,023,506,374 blocks = 7,809 GB read from disk = 9.4 MB/s sustained average.**

⚠ Read as a rate, not a stock. The documented throttled floor is **22 MB/s** once burst credits are
depleted, so a 9.4 MB/s *average* is ~43% of the floor — which is exactly why the band is intermittent
rather than constant: the average is survivable and the peaks are not.

## Top consumers by disk read

| % of all IO | disk read | calls | mean ms | MB/call | statement |
|---:|---:|---:|---:|---:|---|
| **8.1%** | 636 GB | 1,177 | **295,970** | 552.9 | `refresh_wmc_fmv_changed($1,$2)` |
| 5.3% | 411 GB | 1,734 | 15,140 | 242.7 | PostgREST RPC — `p_window_start, p_pinn…` |
| **4.5%** | 354 GB | 5,171 | 4,393 | 70.1 | `panini_squeeze_board` |
| 3.1% | 244 GB | 13,893 | 2,534 | 18.0 | PostgREST scalar RPC |
| 3.0% | 232 GB | 1,624 | 8,948 | 146.0 | `topshot_pack_sales_history` (LIMIT/OFFSET) |
| 3.0% | 231 GB | 1,827 | 8,906 | 129.6 | `allday_pack_sales_history` (LIMIT/OFFSET) |
| 2.9% | 224 GB | 1,475 | 18,887 | 155.7 | PostgREST RPC — `p_collection_id, p_dry…` |
| **2.3%** | 180 GB | **149** | 51,445 | **1,235.9** | `raise_impossible_parallel_circ()` |
| 2.2% | 168 GB | 2,591 | 25,473 | 66.4 | PostgREST RPC — `p_collection_id, p_dry…` |
| 2.1% | 165 GB | 1,598 | 20,367 | 105.6 | PostgREST RPC — `p_deviation_pct…` |
| 1.9% | 148 GB | 2,462 | 24,067 | 61.6 | `backfill_wmc_fmv_confidence(...)` |
| 1.8% | 142 GB | 59,257 | 493 | 2.5 | PostgREST scalar RPC — `p_edition_id…` |

**#1 is already filed** — the 2026-08-22T0010Z filing found `refresh_wmc_fmv_changed`'s temp build is
120× its necessary cost. Nothing here duplicates it; note only that it is **8.1% of the whole estate's
disk IO at 4.9 minutes and 553 MB per call**, which corroborates that filing from a second instrument.

**Worth a look, not yet filed anywhere:** `raise_impossible_parallel_circ()` reads **1.24 GB per call**
across only 149 calls — by far the worst per-call cost in the top twelve. It is a trust-board check, so
it is paying 180 GB to answer a yes/no question.

## The board pair: 605 GB / 7.75% combined — and ⚠ they are LIVE

| board | disk read | % of all IO | calls | refresh failure rate (48h) |
|---|---:|---:|---:|---:|
| `panini_squeeze_board` | 354 GB | 4.53% | 5,177 | **79.0%** |
| `candy_*` boards | 251 GB | 3.22% | 11,686 | 17.7% |

Combined **7.75%** — effectively tied with the single largest consumer. And `panini-squeeze` spends
4.53% of the estate's scarcest resource while **79% of its refreshes are discarded**: near-full cost for
mostly-thrown-away work, the deals-board pattern but worse.

## ⚠ THE NEAR-MISS, AND IT HAD TEETH

`collections.is_active` is **false** for both `candy_mlb` (solana) and `panini_blockchain` (ethereum).
Combined with CLAUDE.md's *"no tweets / Reddit / TC DMs about multi-chain pre-launch"*, the obvious
reading is: **RPC is burning 7.75% of its scarcest resource on boards nobody can see.** I was one step
from filing exactly that and recommending they be dropped from `WARM_BOARDS`.

**It is wrong. Both boards are LIVE**: `CANDY_MLB_PUBLIC = true` and `PANINI_PUBLIC = true` in
`lib/launch-flags.ts`, so the pages are reachable, indexed, and in the sitemap. Acting on the wrong
reading would have taken two live public surfaces dark.

**There are THREE independent switches that all mean "live", and they are DESIGNED to disagree** —
`lib/launch-flags.ts` documents it:

| switch | governs |
|---|---|
| `collections.is_active` (Postgres) | RLS-gated anon PostgREST reads, ~11 cross-collection rollups, the smoke freshness grader |
| `published` in `lib/collections.ts` | nav, collection switcher, footer links, `/<collection>/*` tab routes |
| `*_PUBLIC` in `lib/launch-flags.ts` | the insights board page + its public JSON + its OG card, enforced in `proxy.ts` |

A partial launch — insights board shipped, collection surfaces not — is a legitimate and deliberate
state, and it is what these two are in. ⚠ **`collections.is_active` is NOT the public-visibility
switch. `lib/launch-flags.ts` is.** Anyone auditing cost, dead code or "unused" collections will hit
this exact trap; the DB flag is the one you find first and the one that answers a different question.

## What this does and does not support

- It **does** give the "fix expensive queries" instruction its missing list, ranked, with per-call cost.
- It **does** show two live boards are jointly the estate's largest IO line item, one of them mostly
  failing — a cadence/cost question worth asking about a shipped surface, not a cleanup.
- It does **not** show that trimming any single item ends the band. 7.75% is real but the average is
  9.4 MB/s against a 22 MB/s floor; the band is a peak phenomenon and I have not modelled the peaks.
  ⚠ Do not credit a fix here with ending the band without measuring the band itself before and after.
