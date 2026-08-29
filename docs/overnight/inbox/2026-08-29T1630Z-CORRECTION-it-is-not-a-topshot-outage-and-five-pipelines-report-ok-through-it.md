# ⛔ CORRECTION — it is **not** a "Top Shot outage", and at least five pipelines report `ok: true` straight through it

**Filed 2026-08-29 ~16:30Z (09:30 PT). Supersedes the framing in
`2026-08-28T2320Z-topshot-upstream-5xx-outage-from-1800Z…` and in my own
`2026-08-29T1605Z-…` filing. The measurements in those stand; the LABEL does not.**

## What I claimed, and why it was wrong

I reported *"a ~22-hour Top Shot upstream outage; nothing in this repo can shorten it."*
The second half is what made it un-actionable, and it is false.

**Dapper's GraphQL is UP and serving live NBA Top Shot marketplace data right now.**
`snapshot-pack-asks` — **282 runs, 282 ok** in 24 h — fetched **1,996 live Top Shot pack
listings at 15:58:21Z**, and its `new` / `changed` / `dropped` counters move between runs,
so it is live data and not a warm cache. It reaches
`api.production.studio-platform.dapperlabs.com/graphql`.

What is dead is **one legacy endpoint**: `public-api.nbatopshot.com`, returning
Cloudflare **530 / error 1033** and **503 (nginx)**. Error 1033 is *Argo Tunnel not
connected* — the hostname is not routed to a live origin. 22 hours with zero recovery and
no partial success is a shape more consistent with **decommissioning than with an outage.**

⚠ **The failure is NOT an egress or IP block, and I checked rather than assumed.** Several
routes carry the comment *"Cloudflare blocks Vercel egress to public-api.nbatopshot.com,
so the GQL MUST go through TS_PROXY_URL"*, which makes an IP block the tempting story.
It is refuted: `wallet-username-resolver` goes **through the proxy** (its own header block
sets `x-proxy-secret`) and every one of its lookups fails, and `topshot-fmv-populate` also
resolves `TS_PROXY_URL || direct` and records `http 530: error code: 1033`. **Proxy and
direct fail identically, so the fault is at the origin, not on the path.**

⛔ **Nor is it rate limiting.** `topshot-deal-floor-serials` retries 429/5xx with bounded
backoff and records `throttled_giveups: 10` of `deal_editions_total: 10` — retry
exhaustion against a 5xx that never clears, not a throttle that backoff can ride out.

## 🚨 The reason my first read was wrong: `ok: true` through a total failure

I trusted `pipeline_runs.ok` and the per-pipeline aggregates. Both lie here, and this is
the finding that matters more than the endpoint.

A **self-discovering** sweep — every numeric `extra` key whose NAME looks like a failure
tally, no curated list — over 48 h of runs where `ok = true`:

| pipeline | key | total inside GREEN runs | green runs, zero rows written |
|---|---|---:|---:|
| `topshot-moments-hydrator` | `graphql_failures` | **43,832** | 67 |
| `topshot-buyer-backfill-historical` | `decode_failed` | 5,398 | 44 |
| `topshot-onchain-art-backfill` | `resolver_misses` | 4,750 | 12 |
| `topshot-deal-floor-serials` | `gql_errors` | 210 | **21 of 21** |
| `ufc-enrichment-drain` | `cadence_errors` | 178 | 81 |
| `wallet-username-resolver` | `errored` | 304 | 6 |

⭐ **`topshot-deal-floor-serials` is the one that caught me out.** I cited it earlier as
evidence that direct calls still work — *"23 runs, 22 ok, 4.3% failure."* Its actual rows
read `gql_errors: 10`, `throttled_giveups: 10`, `listings_found: 0`, `rows_written: 0`,
`ok: true` — **every hour, for 21 straight runs.** The aggregate said healthy; the run said
nothing worked. Same for `topshot-sales-history-backfill`, whose four "successes" are
`note: "queue_empty"` no-ops, and `topshot-pack-supply-backfill` (`processed: 0`).

⚠ **THE CURATED VERSION OF THIS SWEEP FOUND 2 OF THESE.** I first wrote it against a hand-
listed set of key names (`errored`, `chunk_errors`, `fail_count`, `dists_fail`,
`upsert_errors`) and it returned two pipelines. Widening it to *any numeric key matching
`(error|fail|lost|denied|blocked|timeout|miss|reject|abort|kill)`* returned seventeen.
**That is CLAUDE.md's "prefer a tree walk over a curated list" reproduced exactly**, and
the curated result would have closed this as a two-pipeline nit.

⛔ **The sweep is a DISCOVERY instrument and every hit needs classifying — it is not a
defect list.** Proven by its own output: `pinnacle-trades-indexer.first_failed_chunk`
totals **422,165,253**, because that key holds a BLOCK HEIGHT, not a count. `resolver_misses`
is legitimately "this edition has no on-chain art" and that route's comment says so. Read
each one before acting.

## Shipped this pass

`wallet-username-resolver` — `ok` started `true` and could only be lowered by the Supabase
RPC that fetches the queue, so per-address upstream failures never touched it. Six
consecutive runs logged `errored` = `found` (19/19 → 63/63), all green, all `rows_written: 0`.
⭐ **It is on `pipeline_cadence_watchlist` and ACTIVE**, so the sentinel's Success Coverage
arm (zero successes AND zero rows written) was aimed straight at it and could never fire.
Now `ok = ok && !(found > 0 && errored === found)`, the lookup carries its HTTP status out
instead of a bare `{status:"error"}`, and the reason lands in `error` + `extra.first_error_reason`.
Pinned with three controls (partial failure, empty queue, all-misses stay green) and
mutation-checked in **both** directions — the old predicate and the naive `errored === 0`
over-correction each fail a different test.

## 👉 The resilience opportunity, and it is concrete

**We already have working code against the healthy endpoint.** `lib/packs/live-pack-listings.ts`,
`lib/chains/flow/allday-studio-holdings.ts` and `lib/studio-sales-history.ts` all use
`api.production.studio-platform.dapperlabs.com`, and every pipeline behind them is green
(`snapshot-pack-asks` 282/282, `allday-studio-sales-history-backfill` 8/8,
`golazos-studio-sales-history-backfill` 8/8). The dead-endpoint clients are
`lib/chains/flow/topshot.ts`, `lib/chains/flow/topshot-graphql.ts` and `lib/topshot-badges.ts`.

⚠ **Not a find-and-replace, and the reason is specific: the two endpoints do not share a
schema.** The healthy one answers `searchPackNftAggregation`; the dead one answers
`searchMarketplaceEditions` / `getUserProfile` / `getMintedMoment`. **Whether the Studio
endpoint exposes equivalents is NOT established and is the first thing to check** — it is a
schema question, not a URL swap.

⚠ Also worth copying regardless of endpoint: the healthy client sends
`Origin: https://nbatopshot.com`, `Referer`, and a real product User-Agent. The dead-endpoint
client sends `User-Agent: sports-collectible-tool/0.1` and nothing else. ⛔ **That did not
cause this** (the proxy path fails identically) — but it is gratuitous fingerprinting on a
Cloudflare-fronted host and costs nothing to align.

## Sentinel item: `snapshot-institutional-wallets` is a DIFFERENT root cause

`errors: NBATopShotCommunity: load: wmc load page 178: canceling statement due to statement
timeout` — **nothing to do with Top Shot's API.** It is
`supabase/functions/snapshot-institutional-wallets/index.ts`, walking
`wallet_moments_cache` with **`PAGE_SIZE = 250` and `.range(from, to)`**, i.e. OFFSET paging.
Page 178 is `LIMIT 250 OFFSET 44500`: Postgres sorts and discards 44,500 rows to return 250,
and the cost across a full walk is quadratic — roughly 4M row-visits for that one wallet.
Under the daytime IO band it tips over the statement timeout at depth, which is exactly why
it fails at a HIGH page number and not at page 3.

⭐ **The fix is already named in the file's own comment** — *"Keyset paging would additionally
survive concurrent inserts/deletes mid-walk; offset+ORDER BY is sufficient here because
these wallets change by single digits a day."* That comment argues CORRECTNESS and never
costs it. `(collection_id, moment_id)` is already a total order per wallet and already the
`ORDER BY`, so keyset is a drop-in that is O(1) per page **and** strictly safer.
⛔ **Not shipped here: it is an edge function** (deploy-only, R21 territory), so it needs a
deliberate deploy rather than a push, and that is Trevor's call to sequence.
