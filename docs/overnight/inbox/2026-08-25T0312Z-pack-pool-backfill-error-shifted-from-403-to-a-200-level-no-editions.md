# topshot-pack-pool-backfill: last error shifted from the ledger's documented 403 to a 200-level "no editions"

**Source:** rpc-daytime-monitor, 2026-08-25T03:12Z tick (late tick, not first-tick). Observed via `rpc_ops_snapshot()` `pipeline_alerts` + `pipeline_fails_24h`, cross-read against the ledger's jobid-16 history.

## What was observed (measurement, not conclusion)
- `topshot-pack-pool-backfill` (jobid 16 `rpc-backfill-pack-pool`, sync path `mode=pool&sync=1&limit=3&conc=1`): **224/225 runs failed (99.6%) over 2 days**, **259 fails in 24h** — the single largest failing pipeline on the board.
- Its **last error is now `0/3 dists converted; 3 returned no editions`** — a 200-level logic outcome, NOT the `{"error":"forbidden"}` / `pg_net_http_403` the ledger documents for this exact job (ledger ~13995 and ~15081, the 08-12/08-13 attribution work: "the historical backfill lane is dead" via a 403 on `backfill-topshot-pack-supply`).
- **Spell positive control at read time: `io_wait=0, active=0`** — NOT in a saturation spell, and the error is a logic message, not a timeout. So this is a genuine steady-state observation, not saturation collateral.

## Why this is worth a note (not an alarm)
The ledger's picture is that jobid 16's lane is "403-dead" and operator-gated on a key rotation. The live error is no longer a 403 — the sync path is reaching the endpoint (200) and simply finding no editions to convert. Two readings, and the monitor cannot discriminate between them read-only:
1. **Benign / expected:** the finite historical backfill has exhausted its convertible distributions (nothing left to pull), so every tick correctly returns "no editions." If so, the 99.6% "fail" is a mis-classified done-state and the row could be retired or its outcome re-mapped — the user-facing pack pool was already confirmed FRESH via the healthy `compute-topshot-pack-ev`/`compute-allday-pack-ev` lanes (ledger ~13997), and rpc-live-health `insights_counts` + freshness validated clean this tick.
2. **Regression:** the 403 got resolved but the conversion query now legitimately returns nothing it should be converting.

## Suggested action (night pass / Trevor — a decision, not a diagnosis)
In a quiet window, confirm whether jobid 16's "no editions" is **exhausted work** (-> retire the row or re-map its terminal outcome so it stops posting as a 99.6% failure and dominating the fail board) or a **real conversion regression**. Independently, the ledger's "403-dead historical lane" belief for this job is now stale and should be re-derived. **Risk read: low** — read-only observation; proposed changes are a watchlist/outcome-mapping tweak or a ledger correction, no user surface, no data mutation, no key handling here (that lane's 403 history is operator/secret-gated).

## Also swept this tick (all known / already-filed — continuity only, NOT candidates)
- **`public_board_slow_count = 4` (BREACH)** + the cluster of pg_cron `statement timeout` / `job startup timeout` fails (rpc-ccm-step2, rpc-refresh-new-collectors, rpc-refresh-challenge-costs, rpc-thin-sale-ask-disclosure-refresh, rpc-refresh-players-current-team, rpc-weekly-log-purges, rpc-thp-leg-pinnacle-fmv-share) = one root cause (SMALL-instance disk-IO budget). focus.md PRIORITY 3 bars new investigations into these. Positive control confirms not in a spell at read time.
- **`unmapped_resolution_backlog_max = 350` (BREACH, nfl_all_day)** — chronic; 47,149 actionable rows, draining net ~-25/day (out 103 / in 78 per 24h). Known.
- **`cross_collection_ts_set_overlap_mat` staleness / `rpc-ccm-step2` timeout** — ALREADY FILED today at `inbox/2026-08-25T0011Z-cross-collection-overlap-mat-is-51h-stale-and-no-standing-metric-watches-it.md`. Not re-filed.
- Security invariants all clean. Production deploy READY (`b3230e36`); newest deploy CANCELED is the expected docs-only ledger commit (vercel.json ignoreCommand). Sentry: 0 new, 0 escalating in 24h. rpc-live-health artifact validated OK (12/12 backing views return, FMV/pack-EV/offers freshness minutes-old).

---

## ✅ ANSWERED 2026-08-25 ~08:20 PT (Claude Code, interactive) — it is NEITHER of the two readings. It is a WEDGED HEAD, and both proposed dispositions were harmful.

This filing offered two readings and asked for a decision: **(1) benign/exhausted** — retire the row or re-map its terminal outcome — or **(2) a conversion regression**. **Measured: neither.** The walk is not exhausted and nothing regressed. **Three unconvertible distributions permanently occupy the head of an ordered candidate list and block everything behind them.**

### The mechanism, from `get_topshot_pool_backfill_targets`'s own body

```sql
WHERE d.collection_id = '…' AND d.metadata->>'uuid' IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pack_drop_pool p
                  WHERE p.collection_id = d.collection_id AND p.dist_id = d.dist_id)
ORDER BY (EXISTS (SELECT 1 FROM pack_rips r WHERE …)) DESC, d.first_seen_at DESC NULLS LAST
LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),400)
```

**A candidate leaves the set ONLY by acquiring a `pack_drop_pool` row.** A distribution whose GQL walk returns
no editions writes no pool rows — so **it can never leave**. The ORDER BY is deterministic and `limit=3`, so the
same three are re-selected every tick, **12 ticks/hour, 288/day, forever.**

**Verified stable, not inferred:** three consecutive calls to the RPC returned the identical head in the
identical order — **`6923, 6218, 6215`**.

### The number that makes the disposition matter

| | count |
|---|---:|
| TS distributions eligible (uuid present) | **2,082** |
| …already converted (have `pack_drop_pool` rows) | 1,372 |
| **…unconverted — blocked behind the head 3** | **710** |
| **…of those, distributions that HAVE real `pack_rips`** | **351** |
| `pack_drop_pool` rows for TS today | 61,326 |

⚠ **The ORDER BY sorts has-rips FIRST, so the blocked candidates are exactly the highest-value ones** — 351
distributions with actual pack-opening data are never even attempted. `pack_drop_pool` is read by **18
functions**, including `get_pack_detail_bundle`, `get_pack_contents`, `get_pack_for_simulator`,
`get_pack_ev_contributors`, `refresh_challenge_costs` and all three `compute_pack_ev_*`.

### ⛔ Why BOTH proposed dispositions were harmful

- **"Exhausted → retire the row / `DELETE FROM pipeline_cadence_watchlist`"** would have **hidden 710
  unconverted distributions (351 with rips) behind a green board.** The alarm is correct; it is the
  *interpretation* that was missing.
- **"Conversion regression"** implies something broke. Nothing did — those three apparently never had
  convertible editions. Chasing a regression would have found no change to blame.

### ➡ The actual fix shape (NOT shipped — `pack_drop_pool` feeds pack-EV, which is off-limits here)

The exit condition needs a second door: a distribution that has been **attempted and returned zero editions**
must stop being selected. Options, cheapest first — **Trevor's call**:

1. **Record the attempt.** A `pack_pool_backfill_attempts` row (or a `last_attempted_at` / `empty_attempts`
   column on `pack_distributions`), and add `AND (empty_attempts < N OR last_attempted_at < now() - interval
   '30 days')` to the targets query. Keeps retrying eventually, never wedges.
2. **Order by attempt recency** — `ORDER BY has_rips DESC, last_attempted_at ASC NULLS FIRST` — so the head
   rotates even without an exclusion. Least invasive; the 3 blockers still burn a slot occasionally.
3. **Park them explicitly** — a `pack_pool_unconvertible` marker for dists proven to have no editions.

⚠ **Do NOT simply raise `limit=3`.** That widens the window past the blockers but keeps re-fetching them every
tick and does nothing about the exit condition — the wedge returns the moment three more unconvertible
distributions reach the head.

### ⚠ A measurement trap inside this one, worth carrying

My first count of the candidate population came from `get_topshot_pool_backfill_targets(100000, false)` and
returned **400**. That is not the population — **the function's own `LIMIT LEAST(…, 400)` capped it.** Querying
the underlying predicate directly gives **710**. ⓘ *When the number you measure equals a limit in the thing you
measured with, you have measured the limit* — the same lesson recorded the previous night against Flowty's
`PAGE_LIMIT`, met again within twelve hours, in an unrelated subsystem.
