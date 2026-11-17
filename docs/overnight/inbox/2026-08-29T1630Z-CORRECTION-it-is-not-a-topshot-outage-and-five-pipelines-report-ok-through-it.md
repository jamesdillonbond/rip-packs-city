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


---

# ⛔ SECOND CORRECTION, to the table above — 2026-08-29 ~17:10Z

**I classified the sweep's output too fast. Four of the six rows are NOT offenders,
and the two that are have now been fixed.** The caveat *"the sweep DISCOVERS, it does
not diagnose"* is in this very filing, and I then published the raw output as if it
were a defect list. Checked one at a time:

| row | verdict | evidence |
|---|---|---|
| `wallet-username-resolver` | ⛔ **real** | 6 runs, `errored` = `found`, 0 written, all green |
| `topshot-deal-floor-serials` | ⛔ **real** | 21 runs, `gql_errors` 10 of 10, `listings_found: 0`, 0 written, all green |
| `topshot-moments-hydrator` | ✅ **honest** | split on `ok`: the 135 **failing** runs carry `hard_chunk_failures: 810` / `graphql_failures: 0`; the 37 green runs carry `graphql_failures: 10,885` / `hard_chunk_failures: 0` **and wrote 215 rows**. The 530s ARE classified as transport faults and DO flip `ok=false`. `graphql_failures` is a per-moment *null data* condition, not a transport error. Working exactly as its `computeOk` comment documents. |
| `topshot-buyer-backfill-historical` | ✅ **honest** | 58 green runs, **6,960 found / 1,276 written**. `decode_failed` is a permanent property of 2023-era transactions, not a live failure. |
| `ufc-enrichment-drain` | ✅ **honest** | 59 green runs, **2,313 found / 2,203 written** — 95%. `cadence_errors` is 110 Flow `1101` script faults on the tail. |
| `topshot-onchain-art-backfill` | ✅ **honest** | `resolver_misses` = "this edition genuinely has no on-chain art"; the route's own comment says it re-scans those harmlessly. |

⭐ **The correction is worth more than the original claim, because it names the
discriminator: `rows_written`.** Every honest row above is WRITING. The two real ones
resolved **nothing at all**. "Green with a nonzero error tally" is not the defect;
**"green, faulted, and resolved nothing"** is — which is precisely the predicate both
fixes now use.

## ⚠ And the obvious predicate was wrong on the second route — the test caught it

For `wallet-username-resolver`, `errored === found` is correct: one lookup per address.
I reached for the same form on `topshot-deal-floor-serials` and it is **wrong there**:
that route fetches **one price-sorted page per `(set_uuid, play_uuid)`**, serving the
base edition and all its `::` parallel siblings from it. So `gqlErrors` counts *fetch
groups* while `editionsTargeted` counts *editions* — different denominators, and a
single failed fetch can wipe out several editions while `gqlErrors` never reaches
`editionsTargeted`. The two-edition test produced `gql_errors: 1` against
`editionsTargeted: 2` and failed, which is how it was caught.

Shipped predicate there is outcome-based and needs no denominator:
`editionsTargeted > 0 && listingsFound === 0 && gqlErrors > 0`. The `gqlErrors > 0`
conjunct is load-bearing — a deal board whose editions genuinely have no live listing
resolves nothing **without faulting**, and must stay green.

⚠ **A second test-fixture trap, same root cause.** The existing test *"a 429 GQL fault
… but the run stays ok"* used **one** edition, so "one of several failed" and "every one
failed" were the same input — it pinned the correct intent and the wrong behaviour
together. It was **rewritten, not deleted** (per the standing rule), into two editions in
**different** `set:play` groups plus a total-wipeout case and an empty-board control. And
failing by call index does not work: `fetchFloorWithRetry` retries a 429 with backoff and
`CONCURRENCY = 2` interleaves the workers, so "fail the first call" is absorbed — that is
the backoff working correctly. The fixture now fails by `set_uuid`, which fails every
attempt for one group and none for the others.

Both fixes are mutation-checked in **both** directions: the old predicate fails the
total-wipeout test, the naive `gqlErrors === 0` over-correction fails the partial test.
