# Three Top Shot pipelines died on **2026-08-29** with `public-api.nbatopshot.com`, not on 09-04 as the alarm reads — and one of them is SUPERSEDED, one was already zero-yield, and one is a real question

*Claude Code, Trevor's box · MEASUREMENT, nothing shipped or paused · 2026-09-05 03:10 PT*

## What the alarm says, and why the date in it is misleading

`pipeline-sentinel` has failed **3 consecutive runs** (most recent 3.7 h ago). Its CRITICAL check is:

```
Pipeline Success Coverage: critical
  ingest-topshot-challenges  0/1 ok, 0 rows — Top Shot GQL HTTP 530: error code: 1033
  topshot-catalog-backfill   0/1 ok, 0 rows — page 0: HTTP 530
  topshot-misattrib-drain    0/1 ok, 0 rows — HTTP 530 | HTTP 530 | HTTP 530
  (since 2026-09-04, rollup 360m old, 30 suppressed)
```

⚠ **"since 2026-09-04" is the ROLLUP WINDOW, not the onset.** `pipeline_runs_daily` is indefinite and gives the real answer — all three flipped on the **same day, 2026-08-29**:

| pipeline | last ok | rows/day while healthy | since 08-29 |
|---|---|---|---|
| `topshot-catalog-backfill` | 08-28 | **7,232–9,471** | 0 ok, 0 rows (8 days) |
| `topshot-misattrib-drain` | 08-27 | 64–888 | 0 ok, 0 rows |
| `ingest-topshot-challenges` | 08-28 | **0 — even when ok** | 0 ok, 0 rows |

⭐ **08-29 is the day `public-api.nbatopshot.com` was decommissioned** — the same event that paused pg_cron jobid 16 (`rpc-backfill-pack-pool`, known-issues #386) and drained `/insights/pack-reality` (#50). **These three were not paused with it.** They still run daily, still 530, still fail.

## 🚨 The real cost is not the three pipelines — it is the alarm

**`pipeline-sentinel` has been CRITICAL for 8 days on a known, Trevor-gated cause.** CLAUDE.md: *"a permanently-red instrument is indistinguishable from a broken one at a glance."* Its own Detector-Health check already says this about a sibling — *"A detector red for many days running is usually CORRECT and unread — read the LOG, not the badge"* — and `edge-fn-drift` was **acknowledged until 2026-10-03** for exactly this reason. **These three have no such acknowledgement**, so the fleet alarm currently cannot tell anyone about a NEW critical.

## The three are NOT the same problem, and the right action differs for each

**1. `topshot-catalog-backfill` — SUPERSEDED, not broken.** The catalog it filled is healthy and actively maintained without it: **699 Top Shot editions created in the last 7 days, 7,046 updated in the last 24 h**, newest edit minutes before this filing. The Atlas drain (`atlas_editions_drain`, 210 calls / 6 h) has taken the job over. ⭐ **Fixing it and retiring it are opposite actions, which is why this was measured rather than assumed.**

**2. `ingest-topshot-challenges` — was ALREADY zero-yield before it broke.** It wrote **0 rows on every one of its healthy days** back through 08-16. Its death cost nothing; it was already a no-op that reported `ok`. (Retire by measured yield, not by name — the same test that retired three UFC scanners on 08-27.)

**3. `topshot-misattrib-drain` — the only real question, and my first reading of it was WRONG.** It wrote 64–888 rows/day and now writes none, with **20,128 rows in `mv_topshot_misattrib_candidates`** and **130,716 in `unmapped_sales`**. That looks like a corrective process silently stopping under a growing backlog.

⛔ **It is not — a STOCK IS NOT A RATE.** The daily flow is healthy, and it is healthier *after* the death than before:

```
day        arrived  resolved      day        arrived  resolved
09-04         23      17          08-28          4       0
09-03          1       1          08-26         12       4
09-02         41      41          08-24         11       0
09-01          8       8          08-22         15       2
```

**Something other than this drain is resolving the daily arrivals, and doing it well.** What stopped is work on the HISTORICAL backlog. ⚠ **NOT ESTABLISHED: whether 20,128 candidates is above its own norm.** Without that trend this is not evidence of a growing hole, and I am not claiming one.

## Recommended, not done

⛔ **Nothing was paused or changed.** Retiring a pipeline is a state change, the area is actively owned by the Atlas work shipping today, and item 3 has an open sub-question. Suggested order:

1. **Ack or retire (1) and (2).** Both are measured zero-value — one superseded, one always zero-yield. That alone should clear the sentinel's CRITICAL and make the fleet alarm readable again, which is the highest-value part of this filing.
2. **Answer (3) with one query before deciding**: is `mv_topshot_misattrib_candidates` at 20,128 growing, flat, or below its pre-08-29 level? If flat, retire it with the others; if growing, it needs an Atlas-shaped replacement, and memory records that **pg_net reaches Atlas**.

ⓘ Also visible in the same sentinel payload, unrelated and NOT actioned: `Trust Health` warns `unmapped_resolution_backlog_max=148` (breach at 100), and Golazos sales ingest reads `0/24h (last 120.8 h ago)`.
