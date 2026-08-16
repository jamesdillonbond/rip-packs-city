# Daytime monitor — 2026-08-16T14:46Z (2026-08-16 07:46 PT · first tick of day)

Read-only sweep. Bash/git sandbox DOWN (recurring `/sessions` useradd/no-space failure — 10th+ straight), so this file is **written to the mount, push unavailable** — the night pass picks it up locally. **ZERO genuinely-new candidates this run.** State has IMPROVED overnight vs the 00:15Z tick; the one candy item below is a known-class recurrence pointed at its existing handoff, not a new investigation.

## No new candidates — everything is filed or known-class

- **Disk-IO saturation wave (still dominant, but easing).** `check_pgcron_recent_failures()` = **10 jobs**, ALL `statement timeout` (trust-precompute-refresh, allday-pack-realized MV, public-board-liveness-sweep, misattrib-candidates, pinnacle-fmv-recalc-backstop, serial-fmv-multipliers-weekly, serial-fmv-jersey-weekly, thin-sale-ask-disclosure, candy-wmc-ghost-purge, allday-ev-corrected). Down from 13 last night. Root cause filed: `2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13` + `1600Z-fmv-recalc…killed` + `1200Z-insights-cache…half its boards`. Do NOT re-log constituents.
  - ⚠ Note for the night pass: the two **weekly** serial-fmv jobs (`serial-fmv-multipliers-weekly`, `serial-fmv-jersey-weekly`) fired today (Sunday 11:00/11:35 UTC) and both timed out, so the serial-FMV multiplier/jersey refresh **missed its whole week** — not just a delayed tick. That is a distinct cost of the saturation (one shot/week), already implied by the root-cause filings; noting the calendar effect, not filing anew.
- **Sentry `NEXTJS-2D`** (`TypeError: null.style` on `/profile/:username`, 1 user/1 event) — **already RESOLVED** in code `c8745113` per the 00:15Z monitor; no new events (last seen ~16h ago, pre-fix). Sentry issue just not marked resolved. Do NOT re-file.
- **Sentry `NEXTJS-2C`** ("smoke check could not run: public base tables…", 4 users) — the documented **honest-degradation-under-saturation** path, NOT a breach: verified live this run `check_public_security_invariants()` and `check_anon_write_surface()` both `[]`.
- **panini-ingest stall** (silent 768 min) — Trevor already diagnosed + committed docs (`85293c07`, `73107069`): the residential box doze-hibernated overnight, WakeToRun inert on battery, ~3 of 6 walks lost = a live zero-day. Owner actively on it. Do NOT re-flag.

## Known-class recurrence (noted, not newly filed) — candy-editions daily refresh timing out

- `candy-editions-ingest` stalled **1806 min** (last completion 2026-08-15 08:40Z; today's `40 8 * * *` Vercel tick left no `pipeline_runs` row = timed out again, the documented "killed at maxDuration=300s, logs only on completion so reads as silence" class). Candy MLB is LIVE/public, so this is user-facing coverage staleness on `/insights/candy-mlb` inputs.
- Existing fix path: `docs/handoff-2026-08-04-candy-editions-timeout.md` (route `maxDuration` 300 → up to 800 on Pro). It keeps recurring under the current saturation, so the night pass / Trevor may want to weigh that bump now. Low-risk, single-route, no DB change. Not filed as a new candidate — the handoff already exists and the underlying cause is the saturation already filed.

## Health snapshot
- **Security:** invariants `[]`, anon-write `[]`, secdef-drift 0, RLS-off base 0 — clean.
- **Trust board:** 5 BREACH, all known-class, and the saturation movers came DOWN vs the 00:15Z baseline: `fmv_sweep_wedge_hours` 9.35 → **7.98**, `trust_precompute_max_age_hours` 17.09 → **13.80**, `public_board_slow_count` 14 → **12**. Others: `panini_sale_price_capture_dry_days` **19** (was 18 — one more dry day, the real-defect arm, mechanism still unestablished), `unmapped_resolution_backlog_max` **258** (AllDay permanent floor). No NEW arms.
- **Cross-collection MV (1a first-tick check):** RECOVERED — `cross_collection_cohort_mat` fresh **2026-08-16 04:10Z** (179 rows), `..._ts_set_overlap_mat` fresh **04:25Z**, both `rpc-ccm-step1/step2` active + succeeded today. (Was 44h stale last night on the 08-15 step1 timeout.)
- **Stalled pipelines:** candy-editions (above), panini-ingest (owner-diagnosed, above), `backfill-pack-rip-metadata` 173 min (info, minor saturation skip).
- **Vercel:** latest production READY (`dpl_9JCCdKC…`, commit `1073691d`); recent CANCELED are superseded rapid pushes, **0 ERROR** deploys.
- **DB size:** 13,074 MB (was 12,718 on 08-13 — normal growth). Editions 27,181.
- **Artifacts:** 11-artifact estate intact; heavy payload validation deferred to avoid adding load to the saturated instance (health-sweep found NO schema-break errors — every failure is a statement timeout, not a missing view/column, so a broken artifact is unlikely).
