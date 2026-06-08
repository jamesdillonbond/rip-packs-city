# RPC overnight autonomous pass — 2026-06-08

**Mode: GENUINE OVERNIGHT (fired ~01:02 PDT, inside 00:00–06:00) + NO-PUSH (no GitHub credentials in this sandbox).**
Shipped **0**, reverted **0**, repaired **0**. Platform GREEN; every recent ship verified; 16/16 artifacts healthy. A quiet, honest night.

Lead line for the digest: **GIT PUSH UNAVAILABLE this run — DB migrations + artifact repairs were available but none were needed; this is a DB-read + local-doc-only pass.** All doc outputs below are written to disk **uncommitted** (they persist on Trevor's machine via the mount and will be picked up by a future pushing session).

---

## 0. Setup / gates

- **`.git/config` NUL corruption repaired (same class as 2026-06-01).** Every git op failed at start with `fatal: bad config line 18` — the on-disk config carried 16 trailing NUL bytes after `name = Trevor` (the documented Windows↔sandbox bridge corruption). Backed up to `.git/config.bak-nullfix-20260608` and stripped the NULs (`tr -d '\000'`); git restored (on `main`, identity Trevor). Local git-internal only, not tracked, no commit. Reconfirms Q7 (the mount intermittently NUL-corrupts the sandbox's read of `.git` internals).
- **Lock:** the prior `.lock` was a RELEASED marker from runid=310200120 (mtime 14:13Z 06-07, ~18h old; unlink isn't permitted on this mount so it's left as a released marker). Took it over; wrote a fresh HELD marker for this run; will mark RELEASED on exit.
- **FREEZE:** absent. **Quiet-hours:** inside window → normal overnight mode. **Push:** `git push --dry-run origin main` → `fatal: could not read Username for 'https://github.com'` → **NO-PUSH MODE** for the session (DB + artifacts + local docs only; code/deploys queued).
- Local `HEAD == origin/main == 29715ed` (0 ahead / 0 behind; clean tree).

---

## 1. Post-ship regression watch (last ~24–48h) — ALL GREEN, nothing reverted

The heavy churn since the last night pass = the **2026-06-07-evening Claude Code wave** (labeled "June 8 daytime" in CLAUDE.md; commits `3364d4e`→`29715ed`, 6 commits, all authored Trevor, deployed READY) draining `docs/handoff-2026-06-08-audit-followups.md` Items 1–7, plus the day-before pack-ev v21 / DUPE1-MIT / cron-stagger / sentinel ships. Re-measured every target metric:

| Shipped change | Target metric | Result | Verdict |
|---|---|---|---|
| `3364d4e` smoke Pinnacle FMV drift re-key (Item 1) | Sentry NEXTJS-14 stops firing every tick | **NEXTJS-14 GONE from unresolved** | ✅ resolved |
| `eb39370` /legal + /blog anon (Item 2/3) | anon/Googlebot reach them | deploy READY; monitor-verified routing | ✅ |
| `9912094` /analytics Flowty historical (Item 4) | cosmetic framing | deploy READY | ✅ |
| `ccfce64` mobile responsive (Item 5) | 390px overflow | deploy READY | ✅ |
| `de01542` brand-token sweep + CI guard (Item 6) | no literal regrowth on 6 surfaces | CI guard live; deploy READY | ✅ |
| `29715ed` polish batch (Item 7) | dashboard `$0`→`—`, "exhausted" | deploy READY (prod tip) | ✅ |
| pack-ev **v21** (`f39761a`) | stale-24h trending down | **665→91; stale-48h 330→0; oldest advancing** | ✅ unwedged & drained |
| DUPE1-MIT (`drain_cold_tail` skip-inert) | NO_DATA stops inflating; sentinel falls | TS NO_DATA 5444→**5196**; sentinel 612→**542**; editions flat | ✅ holding |
| cron stagger (full 21-job + GHA) | rush fails collapse | fails only in :00 windows; 0 in 8/12 hours; ~0.76%/24h | ✅ working |

**No metric regressed; nothing attributable to a recent ship is failing.** Nothing to auto-revert. Only NEW Sentry issue is a single cold-start transient (NEXTJS-1H, §2).

---

## 2. Health-drift triage + overnight deltas

Baseline = `docs/overnight/metrics-latest.json` (06-07T14:10Z).

- **Security: 0/0 (all four checks clean).** `pg_tables` RLS-off base tables `[]`; the anon/auth-write-on-RLS-off check returns `[]` **once the mandated `relkind IN ('r','p')` filter is applied** (the task's stock query omits it and false-positives on 49 views — the documented footgun; re-ran correctly). `check_secdef_anon_execute_violations()` `[]`; `check_public_security_invariants()` `[]`.
- **`detect_stalled_pipelines()` = 1; `get_pipeline_alerts()` = 1** — both flag only **`topshot-listing-cache-v2`** (medium, silent 558m vs 360m, last 22:48:52Z 06-07, 0 fails = clean external-cron dropout). Known inbox candidate → see LISTCACHE-CRON-DROP below (escalated).
- **Pipeline fails 24h: ~44, all the I1 rush-saturation class.** Concentrated in the two :00 dispatch storms (00:00Z 8/1268, 06:00Z 13/1297, where run-volume spikes ~6× on the wallet-backfill family) — every error is `lock timeout` / `statement timeout` / `Timed out acquiring connection from connection pool` / `time_budget_exceeded_after_fetch`, all self-recovering. **0 fails in the other 8 of 12 hours and 0 in the current 08:00Z hour.** `compute-topshot-pack-ev`'s 8 fails are rush-window `targets` timeouts, NOT a v21 wedge (it's draining fine). No new pipeline logic broke.
- **Sentinel TS-UUID-48h = 542** (612 @06:16Z → 542), 0/hr new — pure roll-off, on pace to clear WARN <250 today. The DUPE1 inert-dupe population is 6,406 total (flat; re-mint stopped). **CC-owned merge gate — NOT pre-empted (focus.md #3).**
- **Sentry: 1 unresolved** — `JAVASCRIPT-NEXTJS-1H` "smoke test failed: edition page has Recent Sales", **1 event** 05:03:20Z (cold-start), release `de01542`, no recurrence in ~3h. The 5 earlier smoke transients + NEXTJS-14 + NEXTJS-4 stayed resolved (0 re-opens across the whole wave).
- **Vercel: 19/20 READY.** Prod tip `dpl_EuPu4t…` = `29715ed` (= local HEAD) READY. The 1 ERROR (`dpl_5JjJJA…`, `76b6c2e` CRON-30S) is the known superseded build-infra blip (descendants `9d77c95`/`87f5f83`/`5ad46fc` READY, code live). Not a finding.
- **Artifacts 16/16 healthy (independently spot-checked).** AF1 `v_tracked_wallet_fmv_confidence` returns 20 rows with no 57014; insights boards resolve (squeeze 500+, scarcity 500+ on the post-rekey `pinnacle_catalog` backing, deals 306, rookies 61, cross-collection-deals 334, pinnacle priced 1,794). None broken; none touched.

### Overnight metric deltas (baseline → tonight)
- **FMV TS:** HIGH 564→558, MED 2444→2413, **HIGH+MED 3008→2971** (churn-flat), NO_DATA 5444→**5196** (improving), ASK_ONLY 1028→1001, STALE 234→242, SALES_ONLY 19 (flat).
- **FMV AllDay:** HIGH 88→91, MED 405 (flat), **HIGH+MED 493→496** (flat), NO_DATA 527 (flat), STALE 444→443, ASK_ONLY 84→67.
- **Editions:** TS 15,541→15,542, AllDay 6,191, Golazos 581, UFC 446 (all flat — DUPE1 re-mint stopped).
- **pack-ev targets:** total 800, **stale-24h 665→91, stale-48h 330→0**, oldest 06-06 14:08Z (advancing).
- **DB 6,398→6,482 MB** (slow creep +84/18h; watch-only — dupe roll-off + index). **unmapped_sales 183** (flat). **Sentinel 2,644→542.**

---

## 3. Shipped

**Nothing.** Genuine overnight, but NO-PUSH (code/deploys unavailable), the platform is fully green, every recent ship verified, 16/16 artifacts healthy, the DUPE1 merge is CC-gated, and there was no broken artifact and no genuinely-needed verified-safe additive DB migration on the candidate list. Manufacturing a migration just to "ship something" would violate the don't-look-busy rule. SHIP NOTHING is the correct outcome.

---

## 4. Queued

### NEW this run

- **LISTCACHE-CRON-DROP · [LOW-MED · operator, then a keep-or-retire call] — escalation of the inbox's LISTCACHE-V2-STALL: the WHOLE listing-cache cron family is dropping ticks tonight, not just `-v2`.**
  - `topshot-listing-cache-v2`: silent since 22:48:52Z 06-07 (~9.5h; 0 fails) — the only entry `detect_stalled_pipelines()` flags (crossed its 360m watchlist threshold).
  - The PRIMARY `topshot-listing-cache` (which the 06:16Z monitor called "healthy") is **also dropping ticks**: normal cadence ~85 min, but it had a 4h49m gap (00:22→05:11Z) and is now ~3h silent — under its 360m watchlist threshold, so `detect_stalled` rightly doesn't flag it yet, but it's the same cron-job.org dropout pattern as `-v2`.
  - **Impact bounded:** both feed `cached_listings → badge_editions.low_ask → fmv-recalc ASK_ONLY`. Core sales-based FMV is **fresh** (last TS `fmv_snapshots` write 2 min old; fmv-recalc 90 runs/24h), so only the ASK_ONLY minority (1,001 TS editions) risks ~3h price staleness. No user-facing outage. If the primary crosses 360m, ASK honesty degrades further.
  - **Action (operator):** re-fire / investigate the cron-job.org entries for the listing-cache family (same class as Q3/N1/P3-BUYERS). SECONDARY product call (carried from the inbox): since the primary alone keeps `cached_listings` fresh and `-v2` only trails it ~2s with the same rationale, decide whether `-v2` is a redundant duplicate worth **retiring** (drop its cron entry + watchlist row) instead of re-firing. Not auto-shippable (external cron + needed-or-not call); NO-PUSH can't touch route code regardless.

- **SMOKE-EDITION-TIMEOUT (Sentry NEXTJS-1H) · [LOW · CC/operator watch — single transient]** the edition-page "Recent Sales" smoke assertion timed out once on a cold lambda (1 event 05:03:20Z, release `de01542`, `/nba-top-shot/edition/124:4493`, detail "operation was aborted due to timeout"). The Recent Sales board is what `81f686f` just added; this is a fetch-timeout, not a missing section. Assertion-class → bypasses SMOKE-RETRY (same family as SMOKE-MARKET-EMPTY). **No recurrence in ~3h.** If it recurs: bump the smoke check's per-fetch timeout for the (now heavier) edition endpoint, or route the timeout-abort through SMOKE-RETRY. Mark NEXTJS-1H resolved if quiet 24h. (Touches `app/api/smoke-test/route.ts` — hot file + NO-PUSH, so queued.)

### Carried (open)

- **PIN-SYNC-CRON · [operator → night-pass-eligible].** `pinnacle-sync` logs `pipeline_runs` and is running daily (last 10:07Z 06-07, ok). The 2nd daily tick (~10Z 06-08) had not fired at 08:08Z, so the watchlist INSERT stays queued (wiring it before a 2nd logged tick would false-positive). Ready migration in the prior ledger entry; revisit after ~10Z today.
- **CRON-30S items 3/4 + token hygiene · [operator/CC].** AllDay + Golazos pack-distributions cron 30s timeouts (cosmetic — seeds static historical data; decide retire-vs-`waitUntil`). Plus migrate 4 cron entries off `?token=` URL params to the `Authorization: Bearer` field.
- **PIN-FMV-REKEY-WAVES 2/3 · [Trevor].** Entity/team/cross-collection fns, then stats/health/routes; retire legacy `pinnacle_fmv_snapshots` at zero readers. Each swap changes displayed prices → eyeball live.
- **PACKVIZ-GRID · [CC review].** Deferred pack-dist What's-Inside grid restructure (pullable vs exhausted split + top-5-FMV hero strip).
- **P3-BUYERS · [operator watch].** `pinnacle-resolve-buyers` flaky external trigger (watch for a 3rd dropout).
- **DUPE1 · [CC-owned, gated].** Inert TS-UUID re-mint; sentinel 542 and falling toward <250 today, then the merge (`docs/migrations/dupe1-merge-plan-2026-06-07.md`) + Tier-B sales re-map are CC-owned (focus.md #3). The night pass must NOT pre-empt. Durable fix = worker int-pair preference (Item B2).
- **N1 · [operator].** `snapshot-institutional-wallets` recurring cron-rush dropout (per metrics-latest it recovered 02:14Z + ran 07:25Z off the rush — close if the next 2 daily slots hold; otherwise move its slot).
- **I1 · [RESOLVED root-cause; histogram-verify due this evening].** Rush-window saturation now milder + concentrated only at :00 (this run: 8/1268 @00:00Z, 13/1297 @06:00Z). The stagger-histogram verification (identify the residual :00 anchor — wallet-backfill dispatch storm per the 05:05Z audit) is a separate evening task, not overnight work.
- **Q2** (compute-laliga-pack-ev cadence, operator watch), **Q5** (smoke sales-lag threshold, operator/CC), **Q6** (evm-transfers-ingest Base-429, low), **Q7** (the NO-PUSH root cause — scheduled sandbox has no GitHub creds + the flaky Windows-mounted `.git`; confirmed again this run via the config-NUL repair + push-username failure).

### Doc reconciles folded into the ledger this run
- SMOKE-MARKET-EMPTY, PACKVIZ-GRID(shipped), PACKEV-THROUGHPUT, TFP-WATCH, I1, CROSS1, PIN-SER were already CLOSED inline in the ledger (06-07 CC reconcile). GIT-IDENT resolved (prod tip authored Trevor). Nothing further to reconcile.

---

## 5. Failed / blocked / auto-reverted

None. Nothing errored; nothing was rolled back; production shipping was never hard-stopped (nothing was shipped).

---

## 6. Verification standard met

This was a read-only-against-production verification pass: independent Supabase catalog/health SQL (security ×4, stalls, alerts, fails, FMV, sentinel, editions, DB, pack-ev, watchlist), independent Vercel deploy enumeration, independent Sentry unresolved scan, and independent re-runs of the highest-risk artifact backing queries. No subagent verification was required because nothing was shipped.
