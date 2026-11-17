# Five lanes still fire into the dead Top Shot GraphQL host — ten days after its sibling was paused for exactly this, and every one is a permanently-red instrument

*Claude Code on Trevor's box, 2026-09-07 22:2x PT / 2026-09-08T05:30Z. READ-ONLY sweep; **nothing paused, and the reason is stated below rather than implied.** Found while closing register **#38**, which turned out to be about a pipeline that no longer runs.*

> ✅ **DISPOSITION 2026-09-08 14:2xZ (Cowork).** Three of the five were NOT cron-job.org items — `ingest-topshot-challenges` (`10 8`), `backfill-topshot-subedition-circulation` (`10 21`) and `drain-topshot-misattribution` (`0 11`) are **`vercel.json` crons**, and they are now REMOVED (schedule-only; routes + tests untouched, `UNSCHEDULED 2026-09-08` note in each route header, pinned by `__tests__/topshot-gql-dead-host-crons-are-retired.test.ts`). `ingest` was retired from `rpc-pipeline.yml` on 09-07 (#67 (3)). **jobid 15 is deliberately still active:** the live path keeping `pack_distributions` fresh is STILL unnamed — it was updated in one 1,995-row shot at 12:13:09Z 09-08 with no coinciding `pipeline_runs` row, and `apply_topshot_supply` / `seed_topshot_pack_distributions` / `merge_pack_dist_meta` have no pg_cron, `vercel.json` or GHA caller in the repo. The remaining candidates are a Task-Scheduler-class job on Trevor's box or a manual/MCP call; pause jobid 15 once one of them is named.

---

## The finding

`public-api.nbatopshot.com` has been dead since ~2026-08-28 (530 / CF 1033). On **2026-08-29** the night pass paused pg_cron **jobid 16 `rpc-backfill-pack-pool`** for exactly that reason — the ledger records *"277 runs/day, 0 rows, ~44 DB-minutes and ~430k disk reads a day for nothing."*

⭐ **That mitigation was applied to one job and never swept.** The ledger itself flagged the asymmetry at the time (*"the night pass paused jobid 16, but `offers-sweep` and `topshot-moments-hydrator` kept firing"*). Those two have since been re-pointed or retired. **A different set of five was never revisited, and is still firing ten days later.**

## Measured live 2026-09-08T05:2xZ — over the FULL `pipeline_runs` retention window, not a 24 h slice

| pipeline | runs | ok | rows written | newest | error |
|---|---|---|---|---|---|
| `ingest` | 22 | **0** | **0** | 09-07 23:46Z | `Top Shot GraphQL failed with 530` |
| `topshot-subedition-circulation-backfill` | 3 | **0** | **0** | 09-07 21:10Z | `530 … error code: 1033` |
| `ingest-topshot-challenges` | 3 | **0** | **0** | 09-07 08:10Z | `Top Shot GQL HTTP 530: error code: 1033` |
| `topshot-pack-supply-backfill` | 3 | **0** | **0** | 09-07 08:15Z | `HTTP 530` |
| `topshot-misattrib-drain` | 3 | **0** | **0** | 09-07 11:00Z | `HTTP 530 \| HTTP 530 \| HTTP 530` |

**`last_success` is NULL for all five across the entire window.** These are not flaky — they cannot succeed.

⚠ Also 100 % failed but a *different* root and already Trevor's: `sync-nba-projections` (8/8, `all_upstreams_failed`) — that is **#8**, not this.

## Why it matters, and why it is not urgent

The direct cost is small — these are low-frequency (1–5 runs/day each), unlike jobid 16's 277/day. **The real cost is the one #38 was opened for and this file just closed it over: a permanently-red instrument is indistinguishable from a broken one at a glance, and five of them train a reader to skim the failure list.** That is the estate's own standing rule (`#25`, `series_detail_rollup`).

⭐ **The pack-supply lane is measurably NOT causing staleness, which bounds the urgency:** `pack_distributions` (Top Shot) holds **2,099** rows, **1,995 updated in the last 24 h**, freshest **04:13Z today**, and `total_sealed` populated on **2,099 of 2,099**. So the supply data is arriving by some path despite jobid 15 failing every run.

⛔ **I could not identify that path and am NOT guessing at it.** Only jobids 15/16 call `backfill-topshot-pack-supply`; **no pg_cron job calls `seed-topshot-pack-distributions` or `compute-topshot-pack-ev`**; the DB writers (`apply_topshot_supply`, `merge_pack_dist_meta`) have **no in-database caller**; and this box's Task Scheduler runs only four tasks, none of them pack-related (AllDay Badge Ingest, Deal Board Ingest, Panini Ingest, Pinnacle Render Cache Fill). That leaves cron-job.org, a GHA workflow, or a Vercel route — **the seventh and eighth caller sources**. Whoever picks this up should enumerate those before touching jobid 15.

## Suggested disposition — per lane, because they are not one decision

1. **`topshot-pack-supply-backfill` (pg_cron jobid 15, `15 8 * * *`, ACTIVE).** The only one of the five reachable from the DB, and its sibling jobid 16 is already paused with the same evidence. **Pausing it is defensible today** (0 ok, 0 rows, upstream dead, supply data provably fresh from elsewhere) — but do it *after* naming the live path above, so the pause cannot silently remove a retry arm nobody mapped.
2. **`ingest`** — already registered as **#67 item (3)**: the GHA step is dead and retiring it needs `workflow` scope. Not new; listed so it is not swept twice.
3. **`ingest-topshot-challenges`, `topshot-subedition-circulation-backfill`, `topshot-misattrib-drain`** — all Vercel routes (`app/api/cron/ingest-topshot-challenges`, `app/api/admin/backfill-topshot-subedition-circulation`, `app/api/admin/drain-topshot-misattribution`) whose callers are cron-job.org or GHA. ⚠ **Editing cron-job.org from a session is a recorded secret-leak hazard** (its bearer token is on the console page), so these are operator items, not code ones. For each, the question is the #65 one: **re-point to Atlas, or retire as superseded** — not "un-pause".

⭐ **The transferable point: a mitigation applied to ONE job is a claim about every sibling sharing its upstream.** The 08-29 pause fixed the loudest instance and the rest were never enumerated. When a shared upstream dies, sweep by **upstream**, not by whichever pipeline is noisiest — `pipeline_runs` `error ILIKE '%530%'` over the full retention window finds them all in one query.

## Not findings (checked in the same sweep, recorded so they are not re-raised)

- **`flow-rest-moment-moved-400`** — the pg_net 400 rate looks alarming (**1,633 in 6 h**) and is **expected**: they are Flow REST `Error Code: 1101` script failures from the moments hydrator (jobid 469), i.e. the documented moved-Moment case, ~23 % against a documented ~30 %. Already attributed as benign `info`.
- ⚠ **METHOD TRAP that nearly made the above a false finding:** grouping `net._http_response` by `status_code` and sampling with `max(content)` returns the **lexicographically largest** body, not a representative one — it surfaced a rare `{"code":"invalid_argument","message":"product is required"}` (**2 of 1,635**) and buried the real 1,633. **Group by `left(content, N)` and count.** Same family as the repo's `max()`-on-a-text-cursor rule.
- The 2 residual `product is required` 400s came from neither the hydrator nor `atlas_edition_requests` nor `topshot_atlas_market_requests`, both at exactly `03:52:13.718486Z`. Negligible rate; recorded with the timestamp so it is findable if it ever grows.
- `atlas-editions-refresh` (4.9 %), `atlas-market-feed` (2.8 %), `refresh_wmc_fmv_drift_active` (3.1 %, lock timeouts), `allday-price-recover` (2.8 %), `wallet-backfill` (1.4 %) — ordinary churn, not swept.

## Falsifier

If any of the five records an `ok = true` run with `rows_written > 0` while `public-api.nbatopshot.com` still answers 530, the "cannot succeed" claim is wrong and the lane has a working fallback path this filing missed.
