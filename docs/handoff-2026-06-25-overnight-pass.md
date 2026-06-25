# RPC overnight autonomous pass — 2026-06-25

**Mode: MONITOR-MODE (off-hours).** Scheduled 01:02 PDT; fired late at real **~06:55 PDT** (~55 min past the 00:00–06:00 window) — the app-launch trigger pattern (same as 06-23/06-24). **NO clock skew this run** (verified): DB `now()` 13:55:13Z matched the shell clock (13:54Z) and the app-stamped `sales.ingested_at` 13:52Z / `fmv.computed_at` 13:54Z (which cannot be future-dated), so real UTC ≈ 13:55Z = ~06:55 PDT. → MONITOR-MODE: full review + Section 2 health triage + post-ship watch, **queued everything, docs-only commit**. Push WAS available. `origin/main` `79cd8e7` unchanged start→end.

Shipped **0** to production (correct — MONITOR-MODE; and substantively: the one gate-met candidate is queued for off-hours, the owned BREACH fix is off-limits, the new offer-gap breach self-cleared mid-run). Reverted **0**, repaired **0**, **closed 1** (UFC-VIDEO-BACKFILL-AUDIT-TABLE-RLS). Drained **5** inbox files. The 14:05Z monitor first-tick fired ~10 min into this run and independently **corroborates every finding** (unmapped 2370 monotonic +603/6h/0-resolved, offer-gap $192 benign with offers-sweep fresh, all else GREEN) — no new candidate.

Git: sandbox-native clone at `$HOME/rpc` (the documented `/tmp/rpc` had a stale dir + dubious-ownership uid-squash, so re-cloned to `$HOME` per the CLAUDE.md `$HOME` precedent). Push available.

---

## Health-drift triage — GREEN (1 owned BREACH)

- **Security 0/0/0/0.** `rls_off_base` null/[] · anon/auth-write-on-RLS-off-base (relkind r/p) [] · `check_public_security_invariants()` 0 rows (clean) · `check_secdef_anon_execute_violations()` [].
- **`detect_stalled_pipelines()` []** · **`check_pgcron_recent_failures()` []** · `get_pipeline_alerts()` 1 INFO (`ufc_sales` resolving_editions, benign/long-standing).
- **Sentinel** TS-UUID-keyed-48h **0** · `ts_uuid_dupes_created_24h` **0/200** — no writer leak under the heavy backfill wave.
- **Trust-health 8/9 ok, 1 BREACH:** `unmapped_resolution_backlog_max` **2370/100** (the owned HISTORY-BACKFILL-UNMAPPED-SPIKE — NOT corruption; rows quarantined OUT of `sales`). Other 8 ok incl `edition_integrity` 4/50, `fmv_sanity` 0/1, `pinnacle_ask` 0.1h, `pinnacle_fmv` 3.8h.
  - **`offer_edition_gap_max_usd` breached $192 mid-run then SELF-CLEARED to $0/ok by 14:02Z** — see "Non-finding" below. Trust board is back to 8/9 with only the owned unmapped breach.
- **Editions FLAT** (TS 17435 / AllDay 6191 / Golazos 581 / UFC 518). ts_uuid_total 6430 (frozen, +2), 48h 0 = no leak.
- **FMV** TS HIGH+MED **4535** (improving 4399→4535 across the window) / AllDay **908** (flat). Both reconcile (TS sum 17433 vs 17435 editions, gap 2 = benign `::` parallels; AllDay 6191=6191 exact). `v_fmv_sanity_flags` 0, writers fresh 13:58Z. conflation 105 (owned, converges on the daily `refresh-conflated-editions` remap), thin_fmv 122.
- **DB 5434 MB** (+199 over ~24h vs 5235 — elevated from the heavy studio + on-chain backfill sales wave writing ~124k+ rows; benign, watch).
- **Sentry 3 unresolved**, all single-event smoke transients (NEXTJS-W pinnacle-overview 18h / NEXTJS-1C RLS-smoke 19h [stale true-positive, fixed by `0ae1b26e`] / NEXTJS-X golazos-analytics 22h), super_low, culprit `POST /api/smoke-test`. 0 new groups since the monitor's 03:16Z tick.
- **Vercel** prod **11c8a23** (Pinnacle studio drain) READY; HEAD `79cd8e7` is docs-only (CANCELED via ignoreCommand). **0 ERROR across 20 recent** (all READY code ships or CANCELED docs/monitor commits).
- **Pipeline fails 24h = 7**, all transient/recovered: the 06-24 19:01–19:33Z contention micro-cluster ×4 (wmc-fmv-populate lock ×2, alerts-dispatch + check-alerts + compute-topshot-pack-ev statement timeout) >18h ago; 06-25 03:23Z `refresh-pack-grail-metrics-mv` Cloudflare-520 (recovered 04:23Z onward); 06-25 03:42Z `topshot-moments-hydrator` TS-GQL GetMintedMoment flake (recovered next tick). No logic failures.

### Overnight deltas (vs 06-24 metrics-latest)
FMV TS HIGH+MED 4399→**4535** (improving) · AllDay 901→908 (flat) · TS NO_DATA 3318→3314 (improving) · editions FLAT · conflation 68→**105** (owned, backfill parallel-sales pre-`::`) · thin_fmv 104→122 · DB 5235→**5434** MB (heavy backfill wave) · unmapped 725→**2370** (owned, climbing) · security 0/0/0/0 unchanged.

---

## Post-ship regression watch — ALL PASS, 0 reverts

The heaviest single-window ship wave in weeks (prod walked `37993a1`→`00a0330`→`1e5300fe`→`0ae1b26e`→`7be31e3`→`77f0c65`→`11c8a23` over ~24h, all Trevor/CC). Each re-measured clean:

1. **Studio-platform deep-history program (`7be31e3` AllDay / `77f0c65` Golazos+shared `lib/studio-sales-history.ts` / `11c8a23` Pinnacle) — PASS.** The 3 crons each have **4 consecutive clean ticks** (03:5xZ / 06:5xZ / 09:5xZ / 12:5xZ, all ok=true). Studio sales ingested: **AllDay 30,708 / 261 ed** (oldest 2022-11-04), **Golazos 49,641 / 302 ed** (oldest 2022-11-28), **Pinnacle 44,066 / 688 renders** (oldest 2024-12-17) ≈ **124k total**. The KEY safety property verified live: external_id/render-keyed ⇒ **ZERO `unmapped_sales` writes** (no studio source appears in the unmapped breakdown), **editions FLAT** (zero edition creation), **perfect dedup** (distinct id == row count on all 3 sources), `fmv_sanity` 0, all 3 progress tables RLS-on. Working exactly as designed — the antithesis of the on-chain TS-Flowty unmapped spike.
2. **On-chain historical-sales-capture program (5 crons) — PASS.** allday/golazos/pinnacle/topshot-flowty/ufc-`sales-history-backfill` all **7/7 ok** over ~19h (plus topshot-sales-history-backfill 9/9). The TS-Flowty (#3) leg is the source of the owned UNMAPPED-SPIKE (separate finding below); the other legs are clean.
3. **UFC video recovery (`0ae1b26e`) — PASS + CLOSE.** `editions.video_url` 518/518; the backup table `audit_20260624_ufc_video_backfill` is RLS-on; `check_public_security_invariants()` clean. The 18:06Z monitor's **UFC-VIDEO-BACKFILL-AUDIT-TABLE-RLS** security finding is RESOLVED (Trevor's repo-sync of the anon-DML-revoke default + RLS-on). **Closed.**
4. **Video-form fixes (`00a0330` AllDay momentVideoUrl, `1e5300fe` hover-video Golazos) — PASS.** Route-only, 0 attributable Sentry, no AllDay/Golazos video runtime error.

---

## Non-finding (investigated, self-cleared) — offer_edition_gap transient

`offer_edition_gap_max_usd` read **$192 BREACH** when I first sampled `v_rpc_trust_health` (~13:55Z). Investigated: `offers-sweep` is **healthy** (every ~20 min, all ok, last 13:42Z), and the flagged rows are the `chain_exceeds_gql` edition-grain class (`has_sub_serial=false`): top = Larry Bird 117:4128 with a **live $525 open edition offer** vs `edition_offers` showing $333 (also Steph Curry $116, Ben Simmons $68, Giannis $50). By **14:02Z** `raise_edition_offers_from_chain` (the GREATEST-raise wired into offers-sweep) had ratcheted `edition_offers.highest_offer` up to match the chain on **all four** (Larry Bird $525==$525, gap $0), and the trust-health leg returned to **$0/ok**. This is exactly the EXPECTED transient documented in the ledger (OFFER-SANITY-VIEW-REFINEMENT, l.750): "a transient `offer_edition_gap_max_usd` breach that self-clears while `offers-sweep` is healthy is EXPECTED (a fresh edition offer can sit unsurfaced for up to ~20 min until the next sweep) and should NOT be treated as an incident." **Not queued** — benign, self-cleared, no corruption/no FMV impact.

---

## Queued (nothing shipped — MONITOR-MODE)

### HISTORY-BACKFILL-UNMAPPED-SPIKE — re-measured + sharpened (night-count 2; MED · CC/operator · off-limits sales-path + hot file)
The `topshot-flowty-sales-history-backfill` (#3) keeps enqueuing edition-unresolvable Flowty-era TS sales into `unmapped_sales` far faster than they drain. **Re-measured tonight: open 2370** (725 nightly → 996 → 1338 → **2370**, climbing each `*/3` tick), **+603 enqueued / 6h, ~0 drained (5 resolved / 24h)** → accumulating with effectively no drain. `unmapped_resolution_backlog_max` is a standing trust-health BREACH that will keep climbing as the backfill walks back through TS Flowty history. **NOT corruption** — rows quarantined OUT of `sales` (no board/FMV/user impact). **Sharpened fix (now proven & templated):** the studio-platform GQL `searchTopShotMarketplaceHistory` is external_id-keyed and writes ZERO unmapped — build **`topshot-studio-sales-history-backfill`** on the existing shared `lib/studio-sales-history.ts` (the exact AllDay/Golazos/Pinnacle pattern verified clean tonight) and **retire the Flowty #3 on-chain backfill** it supersedes. Interim stop-bleed options (Trevor/CC): pace/pause the #3 cron, or add a retire-mechanism for permanently-unresolvable Flowty-era rows (mirror the AllDay `flowty_no_edition_id` class). Do NOT just raise the threshold (masks signal). Off-limits to the pass (sales-ingest route logic + hot file) + MONITOR-MODE → queued, not actioned.

### HISTORY-BACKFILL-WATCHLIST — studio gate MET, on-chain nearly (night-count 2; LOW · future night-pass SHIP)
Two ready-to-ship `pipeline_cadence_watchlist` adds, both held tonight only because it's MONITOR-MODE (off-hours):
- **Studio 3 crons — gate MET (4 clean ticks each).** Ship next genuine overnight run:
  ```sql
  INSERT INTO pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes) VALUES
    ('allday-studio-sales-history-backfill',600,'medium',true,'*/3h studio deep-history'),
    ('golazos-studio-sales-history-backfill',600,'medium',true,'*/3h studio deep-history'),
    ('pinnacle-studio-sales-history-backfill',600,'medium',true,'*/3h studio deep-history')
  ON CONFLICT (pipeline) DO NOTHING;
  ```
  Then verify `detect_stalled_pipelines()` stays []. Revert: `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline LIKE '%-studio-sales-history-backfill';` (matches focus.md WATCHLIST FOLLOW-UP; 600m = ~3 missed 3h ticks + grace, the established `*/3h` backfill cadence).
- **On-chain 5 crons — ~19h / 7 clean ticks (gate ~24-48h, nearly met).** The ready INSERT (250m/low) is in the ledger (l.694); ship once a full 24-48h is banked.

### PINNACLE-EDITION-KEY-UUID-CAST (new this monitor cycle; LOW · CC route-side)
From the 15:14Z monitor: the `/[collection]/edition/[slug]` page's `parallels` + `high_offer` lookups throw `invalid input syntax for type uuid` when the slug is a Pinnacle **composite edition_key** (e.g. `STAR-OEV1-SWAL:Golden:1`, `WDAS-OEV1-WINN/ASTC`). 4-6 events since 06-09, 1 event each, NOT in Sentry. The Parallel-Printings + high-offer sub-sections silently fail (caught) for affected Pinnacle editions; the page otherwise renders. Fix (CC, route code): resolve a Pinnacle composite edition_key to its `render_id`/uuid before calling `get_edition_subedition_siblings` + `get_edition_high_offer`, or skip those uuid-typed lookups for Pinnacle composite-keyed editions (mirrors the 06-22 Pinnacle moment-page colon-id redirect).

### Carried (off-limits / operator / CC — unchanged)
THIN-FMV-GUARD-CONTENTION (watch), refresh-conflated-editions cron (operator; conflation 105 oscillating, remap converges `*/6`), BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, TS-WMC-UUID-FOSSILS (6430), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2. See `docs/overnight/ledger.md`.

---

## Closed this run
- **UFC-VIDEO-BACKFILL-AUDIT-TABLE-RLS** — the 06-24 18:06Z monitor security finding (`audit_20260624_ufc_video_backfill` RLS-off + authenticated DML). RESOLVED by Trevor's `0ae1b26e` (anon-DML-revoke repo-sync + RLS-on). Verified tonight: security 0/0/0/0, table RLS-on.

## Failed / blocked / reverted
None. No production shipping (MONITOR-MODE); no regression to auto-revert.

## Artifacts
16 enumerated (2 tombstones: pack-drops-ev-check, rpc-ts-data-mission; 14 active). No schema change tonight (prod 11c8a23 = studio drain + RLS-on progress tables + editions UPDATEs; no view/RPC change). Monitor validated all backing objects across 4 ticks today; I independently confirmed every backing relation queried returns data. **None broken, none repaired.**
