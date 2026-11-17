# Daytime-peak saturation spell — SYMPTOM filing (do not act causally)

**Source:** rpc-daytime-monitor, 2026-08-19 ~21:07Z (~2:07pm PT). **inbox written to mount, push unavailable** (pushurl absent on desktop Cowork; no git run against mounted `.git`).

⚠ Everything below is a **SYMPTOM observed under an active saturation spell** — the positive control read **io_wait 33 / active 33** (a strict majority; total saturation) and `rpc_ops_snapshot()` itself timed out mid-call. Per the spell discipline, **no causal claim, no cost figure, no "cheap/expensive" judgment** is made here. Every suggested action is a **quiet-window RE-MEASURE**, not a fix.

## What was observed

- **Spell is present and severe, and it is now in the DAYTIME peak, not the overnight cron band.** io_wait 33/33 at ~2pm PT. For contrast, last night's pass (08-19 08:22Z) recorded io_wait 9/10. This is the one arguably-new data point: the saturation is persisting/recurring into a workday afternoon window, not just the overnight heavy-cron band. Do **not** infer a cause from that — the heavy-cron band is a constant and cannot by itself be the cause of a swinging effect (per focus). Re-measure the distribution across a quiet window and across several days before characterizing direction.

- **`detect_stalled_pipelines()` returns 3, all consistent with spell collateral:**
  - `compute-golazos-pack-ev` — 871 min silent vs 800 threshold (just over). Suggested action: **quiet-window re-measure** whether it advances once IO frees; only treat as a genuine stall if it stays silent in an uncontended window.
  - `candy-listings-indexer` — 513/400. **Known cry-wolf oscillator** (writes on ~1/3 of ticks without a terminal `pipeline_runs` row; documented at length in its own watchlist note). Not a new finding.
  - `wallet-username-resolver` — 181/75 (medium, visibility-only, does not page). Plausible spell collateral.

- **`check_pgcron_recent_failures()` returns 7, ALL timeout-class, ZERO logic errors** → per 1c this is **one saturation signature, not 7 distinct bugs**: `rpc-backfill-pinnacle-mint-acquisitions`, `rpc-refresh-allday-pack-realized`, `rpc-refresh-misattrib-candidates`, `rpc-ccm-step1`+`rpc-ccm-step2` (today's 04:10/04:25Z daily cross-collection refresh — both timed out, so `cross_collection_*_mat` are likely stale until tomorrow's tick; recovery recipe if still stale then is the self-cleaning per-step one-shot in the SKILL, operator/night-pass only), `rpc-thin-sale-ask-disclosure-refresh` (job startup timeout), `rpc-candy-wmc-ghost-purge`. All `last_run` timestamps are old relative to now; they retry on their own cadence. No action beyond letting them re-tick in a quieter window.

## Clean / healthy (for the night pass's baseline)

- Security 3/3 core clean: `rls_off_base=0`, `anon_write_holes=0`, `check_secdef_anon_exec_drift()=0`.
- Sentry: 0 new unresolved issues in 24h.
- Vercel: latest deploy CANCELED = Trevor's docs(ledger+inbox) commit, an expected `ignoreCommand` docs-only skip; recent READY production deploys present; the lone ERROR in the 20-deploy window is old (nightly already reported 0 unresolved ERROR).

## Suggested disposition

No fix is proposed. The single new signal worth the night pass's attention is **saturation reaching daytime peak** — re-measure the IO-wait distribution in a genuinely quiet window (and across ≥several days) before drawing any conclusion, and remember the lever is cutting work (page size / precompute / fan-out), never raising a timeout or the tier. Heavy artifact payload validation was **deliberately skipped** this run to avoid stacking IO onto the spell.
