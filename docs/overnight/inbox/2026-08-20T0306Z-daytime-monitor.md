# Daytime monitor — 2026-08-20T03:06Z (≈20:06 PT)

Written to the MOUNT, push unavailable (`remote.origin.pushurl` absent on desktop Cowork; only the public `remote.origin.url` is set, no creds — consistent with the 08-19 nightly and all four earlier 08-19 daytime ticks). Night pass picks this up locally. Lock RELEASED (08-19T08:22Z, stale), so no concurrency skip.

## The one non-duplicative signal: the spell is INTERMITTENT within the day, not a solid block — this closes part of the 2107Z re-measure

The 2107Z (≈14:07 PT) symptom filing deferred to "re-measure the IO-wait distribution across a quiet window." Today's intraday series now reads:

| tick (PT) | io_wait / active | state |
|---|---|---|
| 0006Z (~17:06 prev day) | spell | saturated |
| 1511Z (~08:11) | 31–33 / 31–33 | saturated (`rpc_ops_snapshot()` timed out) |
| 2107Z (~14:07) | 33 / 33 | saturated (peak) |
| 0012Z (~17:12) | **0 / 0** | **CLEAR** |
| **0306Z (~20:06, this tick)** | **16 / 16** (11 long >5s) | **saturated again** |

So the spell **cleared mid-evening (~17:12) and re-appeared by ~20:06** — it is recurring/intermittent across the day, not a continuous block, and this evening instance is milder than the afternoon peak (16 vs 33). Per focus §3 and the spell discipline this is **a SYMPTOM data point, NOT a cause claim**: no cost figure, no direction called from these points. The suggested action remains the 2107Z one — the night pass should re-measure the IO-wait distribution across ≥several days before characterizing, and the lever is cutting work (page size / precompute / fan-out), never raising a timeout or the tier. `rpc_ops_snapshot()` timed out again this tick on its `sentinel_fmv_confidence_rows` leg — itself a spell signal, not a broken sentinel.

## Already-logged, NOT re-raised (avoid inbox duplication)

- **ccm cross-collection MV staleness** → owned by `2026-08-19T1511Z` CANDIDATE 1 and re-confirmed by `2026-08-20T0012Z`. `check_pgcron_recent_failures()` this tick still shows `rpc-ccm-step1` (04:10Z) + `rpc-ccm-step2` (04:25Z) both failed **today** on statement timeout. Disposition unchanged: recovery is an overnight self-cleaning per-step one-shot (step1's TRUNCATE takes ACCESS EXCLUSIVE — not a mid-day run). Read-only freshness miss, no data loss. No re-file.
- **pg_cron: 5 jobs with recent fails, ALL timeout / job-startup-timeout class, ZERO logic errors** (`rpc-ccm-step1`, `rpc-ccm-step2`, `rpc-refresh-misattrib-candidates` 15:35Z, `rpc-candy-wmc-ghost-purge` 09:10Z, `rpc-thin-sale-ask-disclosure-refresh` 09:25Z). One saturation signature per §1c, not 5 bugs; none post-date a same-day fix. Known-class.
- **`detect_stalled_pipelines()` = 3, all known-class:** `candy-listings-indexer` (873/400 — documented cry-wolf oscillator: writes on ~1/3 of ticks without a terminal `pipeline_runs` row), `wallet-username-resolver` (181/75 — known stale threshold vs actual cadence, medium/visibility-only), `refresh-pack-grail-metrics-mv` (166/90 — hourly `REFRESH MATERIALIZED VIEW CONCURRENTLY`, plausible spell collateral, ~2.7 missed ticks). No new bug.

## Clean baseline for the night pass

- **Security clean:** `rls_off_public=0`, `anon_write_holes=0` (direct catalog checks; nothing has deployed since the last clean read — push is credential-less — so drift is structurally near-impossible).
- **Sentry:** 0 new unresolved issues in 24h.
- **Vercel healthy:** latest READY production deploy is the 08-18 21:08Z Top Shot series-filter fix (`fdf84ee4`); everything newer is CANCELED docs-only commits correctly skipped by `ignoreCommand`; 0 ERROR-state deploys. No new pushes since 08-18 (sandbox push is credential-less).
- **Demand (focus §1 priority, re-captured this tick): 21 users / 1 WAU (7d sign-ins). UNMOVED** vs the 08-19 nightly. Roadmap gate is 50+ WAU.
- **Artifact estate (11 active, none RETIRED): validated at the data-source level, not by re-running 11 heavy CTE payloads** — deliberately, to avoid stacking IO onto the active spell (§1b guidance). No deploys/migrations since this morning's GREEN validation, so no schema change could have newly broken a dashboard; backing views sampled by the 0012Z quiet-window tick all returned rows.

No new low-risk candidate tasks this run. The single new observation (spell intermittency) is a distribution data point on the already-open 2107Z saturation symptom, not a new investigation or fix.
