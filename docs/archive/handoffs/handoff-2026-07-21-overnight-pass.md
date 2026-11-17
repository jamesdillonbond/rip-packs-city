# Handoff — 2026-07-21 overnight autonomous pass

**GENUINE OVERNIGHT (~01:03 PDT), no clock skew.** Shell `08:02:41Z` ≈ DB `now()` `08:03:21Z`
≈ newest sale `08:03:06Z` ≈ newest FMV `07:49Z` — all four agree, the 07-06/07-18-class
stale-sandbox trap did NOT fire. Real local time inside 00:00–06:00 ⇒ normal shipping mode.

- Push **AVAILABLE** (`git push --dry-run` → "Everything up-to-date").
- No `docs/FREEZE.md`.
- Lock taken 08:03Z (`night-20260721-5693`); prior lock was RELEASED by the 07-20 pass.
- `origin/main` **`24d0171d` UNCHANGED start → end** — no concurrent session, no queue-only degrade.
- Prod deploy `dpl_ALwUJGF1jfGuszHhdRNyeR4vogv4` (`c983335a`) **READY**, 0 ERROR-state.

**Shipped 1** (DB-only, additive, subagent-verified) · reverted 0 · repaired 0 · **closed 2**
· drained 6 inbox files.

---

## Top finding — an ongoing multi-pipeline scheduler dropout produced ZERO pages, and the reason is structural

At ~07:20Z, **nine** HTTP-triggered pipelines stopped together. Measured across the run:

| pipeline | last run | silent @08:16Z | watchlist row |
|---|---|---|---|
| `refresh-pack-grail-metrics-mv` | 06:23Z | 113 min | 90 min / **info** |
| `offers-sweep` | 07:02Z | 74 min | 120 min / medium |
| `golazos-listings-indexer` | 07:07Z | 69 min | 30 min / **info** |
| `pack-events-ingest` | 07:09Z | 67 min | 1440 min / **info** |
| `pack-events-ingest-backfill` | 07:16Z | 60 min | 60 min / **info** |
| `allday-listings-indexer` | 07:17Z | 59 min | **NONE** |
| `pinnacle-events-ingest` | 07:19Z | 57 min | 60 min / medium |
| `golazos-sales-indexer` | 07:11Z | *recovered* | 90 min / medium |
| `pinnacle-nft-resolver` | 07:20Z | *recovered* | 180 min / info |

**This is a degradation, not an outage, and it is partially self-healing** — two of the nine
came back during the run, and 60 other pipelines ran normally throughout (`topshot-sales-indexer`
08:03Z, `wmc-fmv-populate` 08:03Z, 302 runs / 73 distinct pipelines in hour 07). Sales ingest
never stopped. This matches the documented recurring cron-job.org-dropout class.

**The structural finding is what it revealed: not one page fired, and none could have.**
`app/api/check-alerts/route.ts:186` is

```js
const hot = allAlerts.filter((a) => a.severity === "critical" || a.severity === "high");
```

…and returns early with 0 emails / 0 telegrams when `hot` is empty. So `info` and `medium`
alerts are computed by `get_pipeline_alerts()`, surfaced in `rpc_ops_snapshot()`, and then
**silently dropped by the dispatcher**. Measured live:

- `pipeline_cadence_watchlist`: **10 active `high`, 0 `critical`, 47 active `medium`, 14 active `info`.**
- Of **86 pipelines that run ≥12×/24h**: **34 have no watchlist row at all**, and only **9 can
  ever page.** 77 of 86 are structurally mute.
- Every alert `get_pipeline_alerts()` emitted tonight was `info`. The pager was correctly quiet
  — because nothing it watches was breached.

I am deliberately **not** calling this a bug in the dispatcher. Severity tiers exist precisely so
a backfill going quiet doesn't wake anyone at 1am, and bumping 61 rows to `high` would trade
silence for alarm fatigue, which is worse. The real gap is that a **correlated** dropout — nine
pipelines at once — is a different failure mode from any single pipeline going quiet, and nothing
in the system models it. Fix queued below; deliberately not shipped tonight (see why).

---

## Shipped

### `audit_20260721_watchlist_allday_listings_indexer` (DB-only, additive)

`allday-listings-indexer` runs **every 15 minutes at :02/:17/:32/:47** — 21 runs per 6h, 286 runs
since 2026-07-18, **0 failures** — and had **no `pipeline_cadence_watchlist` row**, so
`detect_stalled_pipelines()` was structurally blind to it. Tonight it was the only one of the nine
affected pipelines that produced no stall entry of any kind.

```sql
INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('allday-listings-indexer', 90, 'medium', '<cadence note>', true)
ON CONFLICT (pipeline) DO NOTHING;
```

**`severity='medium'` is deliberate.** It matches the listings/offers family convention
(`allday-listings-retry`, `allday-offers-indexer`, `pinnacle-listings-indexer`,
`golazos-sales-indexer` are all medium) and, per the filter above, **does not page**. This ship
buys *visibility* in `detect_stalled_pipelines()` / `rpc_ops_snapshot()` for every future monitor
tick and night pass. It does not unilaterally arm a new pager at 1am — that calibration is the
queued item's job.

**Independent subagent verification: PASS 7/8.** Exactly one row, no duplicate (PK on `pipeline`);
no collateral modification (`high=12, info=23, medium=54` across all rows, exactly the expected
post-state); `detect_stalled_pipelines()`, `get_pipeline_alerts()` and `rpc_ops_snapshot()` all
still execute clean (the live pager path is intact); security invariants all four `[]`;
trust breaches 0; cadence claim confirmed at 14.9–15.1 min spacing.

The one FAIL was **my arithmetic in the verification brief**, not the change — I told the subagent
to expect a post-insert total of 90 based on an eyeballed pre-count of 89; the true pre-count was
88 and the total is now 89. The subagent caught the contradiction against its own check-3 figures
and said so plainly. Worth recording as a method note: the check-3 distribution was the reliable
signal, the round-number total was not.

**Threshold judgment — I kept 90 min against the subagent's flag, and here is why.** It observed
that 90 sits only 15 minutes above the largest gap ever recorded for this pipeline (75 min over
~3 days) and warned it will fire. That is correct arithmetic, but a `*/15` cron does not drift to
75 minutes through normal jitter — **that 75-minute gap was almost certainly a smaller instance of
exactly the dropout class this row exists to detect.** Widening to 120 to accommodate it would
calibrate the detector against its own target and blind it. 90 min = 6 consecutive missed ticks,
which is not a healthy state under any reading. Expect it to show as stalled while the current
dropout persists; that is the row working, not a false positive.

- **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-listings-indexer';`
- **Metric to re-check tomorrow:** whether `allday-listings-indexer` appears in
  `detect_stalled_pipelines()`, and whether its 15-min cadence resumed.

---

## Post-ship regression watch — the ~25-commit 07-20/21 wave: ALL PASS, 0 reverts

The largest surface change in a week (security remediation, onboarding P0–P3, concierge to 29
tools, weekly-digest route, funnel instrumentation, front-door open).

- **Anon PII revokes hold.** `has_table_privilege('anon', …, 'SELECT')` = **false** on
  `pro_users`, `user_profiles`, and `pack_table_rows`.
- **SECDEF anon-exec drift** `check_secdef_anon_exec_drift()` = **`[]`**.
- **`get_pipeline_alerts()` still works after the 07-21 drift-arm rewrite** — returns 3 alerts,
  executes clean. The live pager path survived being recreated.
- **Weekly digest is correctly inert**: `alert_deliveries` rows with `alert_kind='weekly_digest'`
  = **0**. Gated route, no scheduler, env flag off.
- **Security invariants 0/0/0/0** after the entire DDL wave.
- **Sentry: 0 new issues in 24h.** Six unresolved over 7d, none new and none attributable to the
  wave: 3 are the queued ACTIVATION-PATH-RPC-TIMEOUTS class (pack/team/player detail, 1–6 events),
  3 are smoke-test issues last seen 2–4 days ago and already stale.
- **Vercel**: prod `c983335a` READY; the newest deploy (`24d0171d`, the monitor's docs commit) is
  CANCELED — expected `ignoreCommand` behavior on a docs-only tip, not a failure.

**No auto-revert warranted.**

---

## Closed

### 1. Monitor 0606Z Item 2 — the durable concierge IP limiter **is** writing (was "unverifiable at n=1")

The 0606Z tick found `concierge_ip_rate` empty with only 1 post-deploy chat and correctly refused
to call it either way. Now resolved with direct evidence:

- `concierge_ip_rate` holds **1 row**: `window_start 06:15:25.240301Z`, `count 1`.
- Newest `support_conversations` row: **06:15:25.411625Z** — **171 ms later**.

The limiter fired for that chat and wrote its row. The security control shipped on 07-20 (and
invisibly skipped by four consecutive CANCELED builds until `c983335a`) is live and functioning.
Incidental note, not a defect: the IP is `52.90.x`, AWS — likely a crawler rather than a human.

### 2. Monitor 0606Z Item 1 — `topshot-badge-catalog` watchlist row: **investigated and declined, with proof**

The monitor flagged this pipeline (zero successful runs in the whole retention window, both runs
killed by an upstream Top Shot GraphQL 429, absent from the watchlist) and suggested adding a
watchlist row, but explicitly deferred the threshold: *"Pick `max_silent_minutes` after the cadence
is confirmed, not before"* — cadence being undeterminable from `pipeline_runs` alone.

**I resolved the cadence from the repo, which the DB-only monitor could not — and the answer
inverts the suggestion.** `.github/workflows/badge-sync.yml` schedules the catalog sweep at
`45 2,8,14,20 * * *` = **4×/day**, and `app/api/badge-sync/route.ts:158` confirms
`CATALOG_PIPELINE = "topshot-badge-catalog"`. There is no `vercel.json` cron for it.

Expected ≈13 runs in the 3.3-day window. **Actual logged runs: 2** — 2026-07-19 05:37Z and
2026-07-21 05:36Z, i.e. **48 hours apart, and at a wall-clock time matching none of the four
scheduled slots.**

So the interval between *logged* runs is 48h, not 6h. **Any threshold tight enough to be useful
(720 min) would page continuously during current, known-broken operation; any threshold loose
enough not to page (≥2880 min) detects almost nothing.** A watchlist row here would monitor a
pipeline that is already failing rather than detect a new failure. Declining is the correct call
and the monitor's caution was well-placed.

The residual question — whether GHA is firing and the route dies before logging, or the schedule
isn't firing at all and something else runs at ~05:37 — needs GitHub Actions run history, which is
operator-visible, not DB- or repo-visible. Queued below. The monitor's other judgment stands and I
re-verified it: `deleted_stale_rows = upserted = 512` is a per-batch delete-then-insert, not a
global prune; TS `badge_editions` is **9,283 rows** and grew. No data loss.

---

## Queued — needs your decision

### CORRELATED-PIPELINE-DROPOUT-DETECTOR (MED, new, nc1)

Nine pipelines stopped simultaneously tonight and nothing paged. Individual severity tuning is the
wrong lever (alarm fatigue); the right one is a check that treats *N simultaneous cadence breaches*
as a scheduler-level incident and emits `high` regardless of the individual rows' severities —
routing through the existing `check-alerts` → Telegram/email path with no new cron.

Shape (a third `UNION ALL` arm on `get_pipeline_alerts()`, mirroring the 07-21 `secdef_anon_exec_drift`
arm precedent):

```sql
-- emit ONE 'high' alert when >= N distinct pipelines are simultaneously past cadence
SELECT 'scheduler-dropout' AS pipeline, 'correlated_cron_silence' AS type, 'high' AS severity,
       format('%s pipelines simultaneously past cadence: %s', count(*), string_agg(pipeline, ', '))
FROM (SELECT ... existing cron_silent logic ...) s
HAVING count(*) >= 5;
```

**Deliberately NOT auto-shipped, three reasons:** (1) `get_pipeline_alerts()` was recreated
**hours ago** by a concurrent session (`audit_20260721_get_pipeline_alerts_secdef_drift_arm`) — a
hot object under the 24–48h collision rule; (2) it is the **single live pager path**, so a mistake
blinds all alerting rather than degrading one check; (3) the threshold N is a genuine calibration
judgment — too low and every stagger-cluster pages, too high and it never fires. That is your call,
not mine at 1am.

### PIPELINE-WATCHLIST-COVERAGE-AUDIT (MED, new, nc1)

**34 of 86** regularly-running pipelines (≥12 runs/24h) have no watchlist row. Tonight's ship
closed the one that was demonstrably affected; the other 33 remain invisible to
`detect_stalled_pipelines()`. Not auto-shipped as a batch: each needs its own cadence measured from
a clean window and a severity judgment, and inserting 33 rows blind — several of which are
currently mid-dropout — would produce a wall of stall entries that buries the signal. Recommend
working it in small batches, cadence-measured, as tonight's single row was.

### TOPSHOT-BADGE-CATALOG-429 (LOW/MED, carried, reframed)

Route-level pacing/backoff on the Top Shot GraphQL 429 (13 pages in 16.5s is plausibly faster than
the proxy tolerates). Route code ⇒ Claude Code, not autonomous. **Do NOT propose a proconfig
`statement_timeout` change** — this is an upstream HTTP 429, not a DB timeout; that pattern has
now been disproven three times. Prerequisite for any watchlist row (see Closed #2). Needs the GHA
run history to determine whether the schedule is firing at all.

### CLAUDE.md doc correction — Golazos badge `low_ask` (LOW, docs)

The Deferred-hardening section says Golazos is *"104/218, frozen since 2026-07-08"* and asks for a
`golazos-badge-low-ask-refresh` cron to be built. Measured now: **111/218**, `max(updated_at)` =
**2026-07-21 04:26:27Z** — today. So "frozen since 07-08" is factually stale.

**But the monitor's own closure criterion is NOT met.** It asked for one more measurement and said
close the item only *if both move again*. Between the 0606Z tick and 08:07Z, `with_low_ask` stayed
**111** and `max(updated_at)` stayed **04:26:27Z** — neither moved. There is still no
`golazos-badge-low-ask-refresh` pipeline, and what touched those rows is still unidentified.
`highest_offer` remains **0/218**. Correct the stale date claim; do **not** close the underlying
ask. Left for the doc pass rather than shipped as a half-answer.

### Carried (unchanged, not re-investigated)

`DUNE-DATAPOINT-CAP-402` (nc3 — both walkers still 100% failing on HTTP 402, cursors parked, fails
safely) · `WMC-PRUNE-120S-CEILING` (nc2) · `LIVE-HEALTH-ARTIFACT-DEAD-TABLE-CREDIT` (nc2) ·
`ACTIVATION-PATH-RPC-TIMEOUTS` · `COMPUTE-LALIGA-PACK-EV-ALGO-VERSION-SCHEMA-MISMATCH` ·
`NON-WAVE-WALLET-BACKFILL-DRIVER` · `WMC-LOCK-FRESHNESS` · `MARKET-EDITION-LINK` ·
`TOPSHOT-WMC-FOSSIL-DRAIN` · Panini go-live (one `proxy.ts` line, your editorial call) ·
chain-two/Candy (gated) · standing operator queue.

---

## Health — GREEN on every standard axis

- **security 0/0/0/0** — `invariants`, `anon_write_holes`, `rls_off_base_tables`,
  `secdef_anon_violations` all `[]`; `check_secdef_anon_exec_drift()` `[]`.
- **trust: 15 metrics, 0 breaches.** `topshot_impossible_parallel_serials` 0 ·
  `offer_edition_gap_max_usd` **0** (the 07-20 baseline's mid-run breach self-cleared exactly as
  that pass predicted) · `fmv_sanity_flags` 0 · `edition_integrity_flags` 5 ·
  `unmapped_resolution_backlog_max` 26.
- **FMV staleness all inside threshold**: TS 0.2h / AllDay 0.3h / Golazos 0.3h / Pinnacle 9.5h /
  UFC 10.6h.
- **pipeline_alerts**: 3, all `info` (2 cron_silent from the dropout, 1 standing `ufc_sales`
  resolving_editions at 158/24h).
- **Sentinel** `ts_uuid_dupes_created_24h` **24** (threshold 200) — known inert `::`-cataloging class.
- **DB 10,393 MB** (+119 vs the 07-20 baseline's 10,274 over ~24h — *slower* than the +220/24h that
  baseline flagged). Standing LOW watch; the instance is IOPS-constrained.
- **editions**: TS 19,488 (+24) · AllDay 6,190 · Golazos 575 · UFC 518 · candy_mlb 125 — all
  unchanged except TS.
- **FMV TS H+M 3,293** (978+2406=3,384 → 950+2343=3,293). Oscillating in the documented
  3,28x–3,38x band; sales-cooldown redistribution, confirm-only.
- **`pipeline_fails_24h`**: `sales-counterparty-backfill` 35 (contention-class, ~100% recovery by
  construction, continuing its documented monotonic improvement), `sales-seller-recovery-dune` 24 +
  `sales-ingest-dune` 12 (the carried 402 cap), rest ≤9 with `last_ok` newer than `last_fail`.
- **Traction**: 20 users, still **0 signups**; 37 funnel events/24h. The front door has been open
  since 07-20 and no one has walked through it yet.

## Artifacts

17 listed / 15 active (`rpc-growth-funnel` + `rtr-pack-finder` are retired tombstones). The 0315Z
and 0606Z monitor ticks between them validated all 21 backing objects across the full estate
(21/21 resolve, 6 probed directly return data) within the last 5 hours. Re-validating tonight
would duplicate that work against unchanged objects, so I did not. **None broken, none repaired.**

The one known cosmetic defect stays queued: `rpc-live-health/index.html:240` credits
`pinnacle_fmv_snapshots`, dropped 2026-06-08. `update_artifact` requires a full-document rewrite,
which is a poor trade against transcription risk on a working dashboard for a credits line.
