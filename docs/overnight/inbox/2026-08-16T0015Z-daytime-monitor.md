# Daytime monitor — 2026-08-16T00:15Z (2026-08-15 ~17:15 PT)

Read-only sweep. Bash/git sandbox DOWN (the recurring `/sessions` useradd/no-space failure — 9th straight occurrence per the last night-pass lock note), so this file is **written to the mount, push unavailable** — the night pass picks it up locally. Only ONE genuinely-new, non-saturation, previously-unlogged candidate this run.

## Candidate 1 — ✅ RESOLVED 2026-08-15 (live, `c8745113`), do not re-investigate

Fixed same session: `app/profile/[username]/ProfileClient.tsx` avatar `onError` set `parentElement.innerHTML` (detaching the `<img>`) and then read `parentElement.style` on the now-null parent. Captured the parent ref before mutating. `tsc` clean, deploy READY on www. Left below for the record.

### (original candidate — client null-deref on the PUBLIC profile page)

- **Title:** `TypeError: Cannot read properties of null (reading 'style')` on `/profile/:username`
- **Source:** Sentry `JAVASCRIPT-NEXTJS-2D` — first seen ~1h ago, 1 user / 1 event, culprit `/profile/:username`.
- **Risk read:** Low blast radius so far (1 user/1 event) but it is a client-side CRASH on the shareable public profile surface, and it is NOT saturation-class (every other fresh failure this run is `statement/lock timeout`). A `.style` read on a null element echoes the theme/ProBadge DOM-ref lessons in CLAUDE.md. Worth a look before it spreads by copy-paste or a shared link amplifies it.
- **Suggested action (night pass):** pull the stack frame via `get_sentry_resource JAVASCRIPT-NEXTJS-2D`, find the `.style` access on `/profile/[username]` (likely a ref/measure effect running before mount or against an element removed by a conditional render), null-guard it, add a component test. Verify against the light/dark theme toggle — the profile page has prior theme-conditional-render history.

## NOT logged — already filed, do not duplicate

The dominant signal this run is the **documented disk-IO saturation wave**, escalating through the day. Every constituent is already filed today, so re-logging is noise:
- `pipeline_runs`: last 6h is almost entirely `canceling statement due to statement/lock timeout` / `saturation-class` (fmv-recalc, refresh_wmc_fmv_changed, compute-topshot-pack-ev, pinnacle-nft-resolver, refresh-insights-cache, alerts-dispatch, wallet-username-resolver, classify-acquisitions, populate-pinnacle-wmc-fmv, …). Root cause filed: `2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13`, plus `1600Z-fmv-recalc…killed`, `1200Z-insights-cache…half its boards`, `2240Z-999-sentinel-unreachable`, `1700Z-reconcile-saved-wallet-stats`.
- `check_pgcron_recent_failures()`: 13 jobs failing, ALL statement-timeout (trust-precompute-refresh, ccm-step1, allday-pack MV refreshes, pinnacle-mint-acquisitions backfill, atlas-pack-ev, misattrib-candidates, challenge-costs, candy-wmc-ghost-purge, public-board-liveness-sweep, thin-sale-ask-disclosure, pinnacle-fmv-recalc-backstop, reconcile-saved-wallet-stats). Same root cause.
- `Sentry NEXTJS-2C` "smoke check could not run: public base tables: RLS on + no anon write" (2 users) — the documented **honest-degradation-under-saturation** artifact, NOT a security breach: verified live this run `check_public_security_invariants()` and `check_anon_write_surface()` both `[]`.

## Health snapshot
- **Security:** invariants `[]`, anon-write `[]`, secdef-drift `[]`, RLS-off 0 — clean.
- **Trust board:** 5 BREACH, all known-class, two saturation movers still CLIMBING vs the 08-15 15:20 PT baseline in CLAUDE.md: `fmv_sweep_wedge_hours` 7.40 → **9.35**, `trust_precompute_max_age_hours` 15.14 → **17.09** (the precompute refresh keeps timing out — confirmed in the pg_cron list). Others: `public_board_slow_count` 14, `panini_sale_price_capture_dry_days` 18, `unmapped_resolution_backlog_max` 258 (AllDay floor).
- **Cross-collection MV** (evening tick — 1a first-tick check normally skipped): `cross_collection_cohort_mat` last fresh **2026-08-14 04:10Z** (~44h) — 08-15 `rpc-ccm-step1` failed on statement timeout. Downstream of the same saturation; re-running would time out again, so NOT filed separately.
- **Vercel:** tip `513c514e` (dpl_Beuf1BhJ…) READY; recent CANCELED are superseded builds, **0 ERROR** deploys.
- **Artifacts:** 11-artifact estate intact; heavy payload validation deferred this run to avoid adding load to the saturated instance.
