# RPC nightly autonomous pass — handoff 2026-06-26

**Mode:** GENUINE OVERNIGHT, in-window (fired 01:02 PDT / 08:02Z; shell PDT == DB now() == app-stamped rows, no clock skew). Push available. Sandbox-native clone at `$HOME/rpcwork` (the documented `/tmp/rpc` uid-squash hazard recurred — a stale `/tmp/rpc` owned by `nobody` blocked clone; fell back to `$HOME` per CLAUDE.md precedent). origin/main `d9e361e` (monitor docs commit) unchanged start→end of the review window.

**Outcome:** Shipped **1** (verified PASS), reverted 0, repaired 0, **closed 2** (both resolved-in-code by Trevor; monitor instructed CLOSE), reconciled 2 stale-doc items. Drained 7 inbox files. Health GREEN; the lone trust BREACH is the owned UNMAPPED-SPIKE, draining hard as designed. A quiet, honest night.

---

## SHIPPED (1, fresh-subagent verified PASS)

### `audit_20260626_watchlist_onchain_sales_history_backfills` — HISTORY-BACKFILL-WATCHLIST on-chain leg (the last open piece of that queue item)
Added 5 rows to `pipeline_cadence_watchlist` (600m / medium / active) for the on-chain secondary-sales deep-history backfills so `detect_stalled_pipelines()` can catch them if their Vercel crons die:
`allday-sales-history-backfill`, `golazos-sales-history-backfill`, `pinnacle-sales-history-backfill`, `topshot-flowty-sales-history-backfill`, `ufc-sales-history-backfill`.

- **Gate met:** all 5 banked ~50h (first runs 2026-06-24 06:0x–06:48Z) with **0 fails/48h**, regular ~3h cadence (8–9 runs/24h, ~40s/run). The 06-25 night metrics carried them as "~19h/7-ticks nearly at the 24-48h gate"; now well past.
- **Why 600m & no false-positive risk:** each fires every ~3h and logs a rich `extra` on EVERY tick **including the `below_floor` no-op path** at completion (verified in their run extras — `below_floor:false` while walking, will flip to a logged no-op at done). So a finite backfill that completes keeps firing+logging, and 600m (~3 missed 3h ticks) won't false-positive. Matches the value the 3 `-studio-` siblings already use.
- **Verification (direct + fresh no-context subagent, VERDICT PASS):** 5 rows present with exact intended values; `detect_stalled_pipelines()` returns `[]` (none of the 5 flagged, max headroom 96min vs 600m); all 5 firing healthy (runs_24h 8–9, fails_48h 0); `check_public_security_invariants()` `[]`.
- **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('allday-sales-history-backfill','golazos-sales-history-backfill','pinnacle-sales-history-backfill','topshot-flowty-sales-history-backfill','ufc-sales-history-backfill');`
- **Target metric (re-check tomorrow):** these 5 stay absent from `detect_stalled_pipelines()` while firing ~3h; if a cron genuinely dies, it surfaces within ~10h. No new false-positive on the next monitor tick.

This is a DB-only monitoring-config migration (Supabase connector) — no code deploy, so no Vercel/smoke step applies.

---

## CLOSED (2 — both fixed-in-code by Trevor; the 06-26T06-20Z monitor explicitly said CLOSE, not operator-re-fire)

- **PACK-EVENTS-CRONJOB-STALL** — resolved by `80a9238b` (pack-events worker per-chunk flush + cursor commit). NOT a cron-job.org trigger problem: the worker batched all cursor writes + the `pipeline_runs` log at the very end, so a CF-wall-clock-killed run committed nothing and only *looked* cron-silent. **Verified live this pass:** all 3 live forward cursors fresh (4 min): `topshot_pack_purchases` 156064047, `topshot_pack_opens` 156013422, `allday_pack_purchases` 156035922 — all well past the 03:16Z frozen tip (156004422). `get_pipeline_alerts()` has no cursor_stalled.
- **LISTCACHE-CRON-DROP / CRONJOB-ORG-TRIGGER-SURFACE-DEGRADED** — resolved by `35fb466f` (decoupled TS listing-cache into its own GHA workflow, immune to the monolith) + `d3e931d7` (fmv-backfill full-table pagination → indexed anti-join RPC, ~18min → ~2.5s; the hang that starved the listing-cache step). NOT a cron-job.org account problem. **Verified:** `detect_stalled_pipelines()` `[]` (no listing-cache stall); FMV fresh, sanity 0.

---

## RECONCILED (stale continuity docs corrected — no DB change needed)

- **`ufc-studio-sales-history-backfill` watchlist was ALREADY shipped** (CC 2026-06-25, `audit_20260625_watchlist_ufc_studio_sales_history_backfill`, 90m/medium). The 4 monitor inbox files (18:11Z/21:14Z/00:14Z) and the focus.md "PENDING" note were reading stale state and kept calling it ship-eligible. **Confirmed live in `pipeline_cadence_watchlist`.** Corrected the focus.md note so the monitor stops re-flagging it.
- **HISTORY-BACKFILL-WATCHLIST is now FULLY RESOLVED.** studio 3-cron leg (Trevor, `watchlist_studio_sales_history_backfills`) + ufc-studio (CC, above) + **on-chain 5-cron leg (shipped tonight)** = the whole queue item is done. Removed from carried-queued.

---

## Post-ship regression watch — ALL PASS, 0 reverts

Re-measured the dense 06-25/26 Trevor/CC daytime wave (the night pass shipped nothing 06-25; everything below is daytime work):

- **pack-events (`80a9238b` / `52b2647c`):** 3 live cursors fresh (4 min), advancing past the frozen tip — see CLOSE above. PASS.
- **DQ fills:** `7a978ac` TS parallel null-thumb = **8** (matches 149→8); `729bfe4` UFC null `set_name` = **0** (72/72); AllDay null `player_name` = 36 (proven correct-as-NULL Draft-Pick moments, not a regression). PASS.
- **Studio + UFC-studio drains:** perfect dedup in last 24h — `allday_studio_history_v1` 48,247/48,247, `golazos_studio_history_v1` 46,608/46,608, `ufc_studio_history_v1` 813,380/813,380 (near-done global walk), `source=onchain` 8,815/8,815. ZERO unmapped spill from studio sources; editions FLAT; fmv_sanity 0. PASS.
- **`topshot-flowty-unmapped-drain` (`98c35dc`/`22461b5`):** healthy, ~50/tick promoted, **retired 0** (the transient-null guard holding), net-draining. The owned BREACH `unmapped_resolution_backlog_max` fell 2370 (overnight) → 1968 → 1831 → 1405 → **1180 → 724** (during this run). Draining as designed, even faster than the monitor's projection. PASS — do NOT re-flag/skip/retire/raise-threshold (Declined).
- **`d3e931d7` fmv-backfill anti-join:** FMV fresh, sanity 0, no hang. PASS.
- **`59ddb6b` spork-proxy (creds-gated, no runtime effect):** `topshot-buyer-backfill` 6/6 ok (157–255s, < 800s cap), walking 2022-05. PASS.
- **`716566b`/`3e96f4` alerts typeahead, `35fb466f` concierge, `ec82db1` panini scaffolding (inert/repo-only):** no attributable Sentry, route-only. PASS.

---

## Health-drift triage (GREEN)

- **Security 0/0/0/0:** `pg_tables` RLS-off base = 0; anon/auth write-grant on RLS-off base (relkind r/p) = 0; `check_public_security_invariants()` `[]`; `check_secdef_anon_execute_violations()` `[]`.
- **Pipelines:** `detect_stalled_pipelines()` `[]`; `check_pgcron_recent_failures()` `[]`; `get_pipeline_alerts()` = 1 INFO (`ufc_sales resolving_editions`, benign/long-standing). Fails 24h = **7**, all transient/recovered (2× topshot-badge-catalog TS-GraphQL-429; the known 01:15–01:31Z statement-timeout micro-cluster — compute-topshot-pack-ev / pinnacle-nft-resolver×2 / wmc-fmv-populate / check-alerts — all recovered next tick). 0 backfill/drain fails over 48h.
- **Trust health 8/9 ok:** lone BREACH `unmapped_resolution_backlog_max` (1180→724, owned, draining). Others ok: edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap 0/50, pack_ev_stale 0.84d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30 (refreshes at the 10:07Z daily sync), ts_uuid_dupes_24h 34/200.
- **Sentinel:** TS-UUID-keyed 48h = 34 (inert, well under WARN 250); ts_uuid_total 6464 (frozen floor, +34); editions FLAT (TS 17469 incl. inert floor / AllDay 6191 / Golazos 581 / UFC 518).
- **FMV (latest-per-edition):** TS HIGH 1297 / MED 3263 / **H+M 4560** (improving from 4535 overnight) / NO_DATA 3309; AllDay H+M 909 / NO_DATA 1438 (improving). fmv_sanity 0, reconciles to editions (gap 2 = benign `::` parallels).
- **Sentry:** 1 unresolved — `JAVASCRIPT-NEXTJS-J` "smoke test failed: pack-listings responds", 1 user/1 event, 11h, culprit `POST /api/smoke-test`, low actionability (the known single-event smoke-flake class). 0 new.
- **Vercel:** prod `80a9238b` READY, **0 ERROR**/20 (newer commits 97c5b0a/d9e361e are docs/monitor → CANCELED, normal).
- **DB 6115 MB** (+~680/24h from the documented deep-history backfill wave; ~50 MB/hr, benign-attributable, ample headroom; watch the rate).
- **Artifacts:** 16 (2 tombstones / 14 active). Monitor validated all active healthy across every tick today; none broken, none repaired this pass.

### Overnight deltas vs 2026-06-25 night metrics
- FMV TS H+M 4535 → **4560** (up). AllDay 908 → 909.
- unmapped_resolution_backlog_max 2370 → **724** (draining hard, owned).
- DB 5434 → **6115 MB** (backfill wave).
- editions FLAT. conflation 105 → **162** (owned/backfill-elevated, converges on daily refresh-conflated-editions remap; `edition_integrity_flags` 4/50 canary clean). thin_fmv 122 → 120.
- Sentry 3 → **1** (cleaner).

---

## QUEUED (carried forward + new)

**NEW this pass:**
- **DRAIN-WATCHLIST (topshot-flowty-unmapped-drain)** — the load-bearing drain clearing the UNMAPPED BREACH is itself **un-watchlisted**. Gate not yet met (~15h alive since 2026-06-25 17:09Z vs the 24-48h rule). Ship next genuine overnight run once it banks ~24-48h: `INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes) VALUES ('topshot-flowty-unmapped-drain', 90, 'medium', true, 'TS Flowty unmapped_sales drain (20-min cadence 9,29,49); clears the unmapped_resolution_backlog_max BREACH. Keeps firing no-ops post-clear.') ON CONFLICT (pipeline) DO NOTHING;` (Revert: DELETE that row.)
- **WEEKLY-SURFACE-QA-PROSE (rpc-live-health)** — 2 stale static-prose strings (the inbox candidate `2026-06-25-weekly-surface-qa-live-health-prose.md`): (1) the Open-Issues "Item B" entry — live-DB confirmed it's stale (sentinel TS-UUID-48h = 34 inert, writer-leak CLOSED 2026-06-21 `6b9e89a`); reword to "Edition-writer leak CLOSED — sentinel TS-UUID-48h low/inert; writer-side fixed + historical UUID-dupes drained." (2) the moot Pinnacle "earlier days intentionally empty" caveat (trailing 14-day window is now entirely after 2026-06-08). **NOT done tonight:** a full-file reinstall of the monitor's own 550-line board for two cosmetic sentences is the wrong risk trade for an unattended pass (queries are all healthy; downside = blinding the monitor). Best applied interactively (Trevor can eyeball) or by the weekly `rpc-surface-qa` task itself, via the verified `update_artifact` install + fresh-subagent read-back.
- **topshot-sales-history-backfill watchlist (minor)** — the older GHA edition-queue TS history backfill is also un-watchlisted + gate-met, but a different class (GHA-driven, edition-queue, tolerates per-edition gql_errors). Deliberately excluded from tonight's ship to keep scope = the carried "on-chain 5". Evaluate separately on a future night.

**Carried (unchanged):**
- HISTORY-BACKFILL-UNMAPPED-SPIKE — owned, resolved-in-progress by the drain (do NOT re-flag/skip/retire/raise-threshold per Declined). Cadence is the only lever.
- PINNACLE-EDITION-KEY-UUID-CAST (LOW/CC route-side).
- THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator; conflation 162 oscillating, remap converges */6), BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, TS-WMC-UUID-FOSSILS (6464), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS x2.

## FAILED / BLOCKED / REVERTED
None.
