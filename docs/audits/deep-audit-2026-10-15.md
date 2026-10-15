# RPC monthly deep audit — 2026-10-15 (run 6, overnight, Cowork cloud)

Six read-only sweeps (A security, B pipelines, C data, D rendered DOM, E backlog, F growth). **No P0, no P1 that is a live security or wrong-data exposure.** Nothing was shipped to the DB: the one migration attempted (R126 trigger + zz_probe drops) was **denied by the auto-mode classifier** and is filed as `docs/pending-sql/audit_20261015_fmv_snapshots_touch_updated_at_and_drop_zz_probes.sql`. Every claim below is VERIFIED (measured live today, Pacific) unless marked INFERRED with its refuting condition. Mechanisms inherited from the register; severities re-derived.

## Overturned / corrected prior claims
- **R73 premise stale:** "last concierge conversation 2026-08-16, ~55 total" is wrong. `support_conversations WHERE NOT is_smoke_test`: 109 all-time, 93 since 08-16, 77 in 30d across 12 sessions, last 10-11 5:56 PM PT; ~6 genuinely outside users in 30d (INFERRED from message content).
- **R107 "residual CLOSED" falsified** (see R126): `check_edition_fmv_current_source_drift()` returned 8 rows at 1:06 AM PT.
- **10-14 handoff "candy migration not pushed" is stale:** `20261014235448` is on origin/main and applied. The mount is 27 commits behind origin.
- Security register wording: "0 anon-readable panini/candy" is now 1 object (`panini_pack_state_history`, RLS on, 0 policies, 0 reachable rows).

## Security (A) — clean
All VERIFIED-CLEAN probes hold 10-15: `check_public_security_invariants()` 0, `check_anon_write_surface()` 0, `jsonb_array_length(check_secdef_anon_exec_drift())` 0, RLS-off public tables 0, anon-readable views w/o security_invoker 0, anon/auth matviews 0 of 39, foreign tables 0, extensions in public 0. Better: anon write-grant objects 5 → 4 (portfolios grant gone); **gate keys in `cron.job.command` 13/149 → 0/238** (pg_cron now 238 jobs / 234 active). Anon-executable functions 83 of 993 (all search_path-pinned); anon SECDEF 3, pinned. IDOR heuristic over 536 route files: 8 surfaced, all benign (read-only POSTs / session-keyed). Advisors: no ERROR; 3 search_path WARN (one is the `zz_probe` scratch fn). **P2 (INFERRED upper bound P1):** scratch edge functions still deployed with verify_jwt=true (`zz-gate-diag`, `zz-gate-rotate`, `tmp-pack-pool-probe`, `shared-deploy-probe`, `pinnacle-render-smoke`, `allday-consumer-gql-smoke`, `allday-unmapped-bridge`, `admin-badge-backfill-bridge`, `pinnacle-render-cache-put`, `badge-icon-cache-put`); sources NOT read (get_edge_function returns live keys) — needs a redacted-subagent inspection, refuted if each does an in-code gate.

## Pipelines (B)
- **P1 (INFERRED liveness): the 3 `candy-opensea-*` indexers** — 21/21, 21/21, 11/11 failed in the 7d to 10-13, all `OPENSEA_API_KEY not set`; no rows or heartbeats since 10-13 ~6:05 AM PT (~43 h). Routes added 10-10, never succeeded, so no change point. INFERRED the cron-job.org entries were disabled (not readable); refuted if enabled and failing before `log_pipeline_run`. Magic Eden lanes healthy (candy-sales-indexer ok, 1/58 failed 7d; sales_found 0 = quiet market). Tied to #58 (Trevor-only key).
- P2: `topshot-pack-supply-atlas` ~21% of ticks fail (279/1344, 24 h) on Cloudflare "Just a moment" 403 pages, not gate keys; rows still written (partial loss).
- P2: `panini-collector-walk` hits its 10-min cap: 1/8 → 3/10 failed (10-09 → 10-14), covering 31–55 of 128 collections/run; INFERRED progressing (cursor not checked).
- NOT-A-FINDING: `sync-nba-projections` 19/19 failing (ESPN 403, offseason; register line known); `wmc-reindex-verify` "silent" (weekly, retention; ok on 10-11).
- Gate-key rotation (10-13): 0 failed pg_cron runs in 24 h; the 403s in `net._http_response` are all Cloudflare HTML. No cron regression seen. `check_pgcron_recent_failures()` null, `detect_stalled_pipelines()` [].
- Tip 99b60a0e5: Vercel production READY; 37 CI check-runs, 0 failures.

## Data (C)
FMV row coverage 100% on all five active collections; priced TS 97.5%, AD 88.6%, Golazos 86.8%, UFC ~100%, Candy 100%; HIGH+MEDIUM TS 55.6%, AD 26.2%, Golazos 1.0%, UFC 0%, Candy 56%. 0 non-positive FMVs. Pack EV arithmetic 0 mismatches; stale pack EV never published as live (0 of 390 TS / 247 AD primary_available).
- **R126 (P2):** haircut UPDATE does not bump `updated_at` → 7 of 1,263 haircut rows in 3 d (0.55%) publish pre-haircut ask-derived FMV (cache = source/0.55) for up to 24 h until the 09:36Z reconcile. Fix = pending-SQL file above.
- P3 latent: AD `badge_editions.lock_rate_pct` = locked/owned (1,030 of 5,607 > 100%) — not rendered anywhere found (DB-side search; app grep timed out). P3: ~7 rows with misleading ASK_ONLY/SALES_ONLY labels and NULL price; 24 of 75,963 TS 30 d sales with serial > circulation (WNBA live mints; `258:9304` unhealed 15 d). Honest gaps: AD pack EV NULL by design, Golazos no retail price, Pinnacle packs no image.

## Rendered DOM (D) — profile NOT a clean anonymous visitor
Browser profile was signed out of RPC but held a prior wallet context in localStorage (`rpc_owner_key`), so wallet-overlay UI and the 401 console noise are not representative; anon gating only partially assessed. ~30 pages rendered; no "0 moments"/NaN false conclusions.
- **R127 (P1, VERIFIED):** `/nfl-all-day/sniper` concludes "0 deals · avg 0.0% off" for >60 s because the default sort is Cheapest First (137 listings, none ≥10% off, junk asks), while the discount sort returns 143 and the overview advertises −57% deals.
- P2: Top Shot sniper shows "0 deals" ~30 s before the feed resolves (4 deals); `/panini-blockchain/overview` repeats one edition at −85%/−88% (INFERRED outlier FMV); `/insights/pack-sniper` "JUST LISTED (2H) 0" beside rows "22m ago"; "Quiet on the court" copy on NFL/UFC; about/methodology/early-access list five collections while home says seven; Candy overview prose says "trades daily" beside "NONE INDEXED"; unknown URLs redirect to /login not 404; `/insights/panini-squeeze` 3.0 MB HTML.

## Backlog (E)
- P1 process: 3 handoff/health docs and 4 inbox filings (10-13 → 10-15) exist only on the mount; INDEX.md stops at 10-12 so the nightly drain cannot see them. Mount main is 27 commits behind origin.
- Open: Trevor to run `docs/pending-sql/audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent.sql` (suppression lapsed 10-15 → `cursor_stalled` paging); delete `topshot-misattrib-drain` suppression (its predicate failed: 729 > 705); #58 key; #181 on 10-24.
- P2 R128: `app/api/edition-floor/route.ts persistFloorToSnapshot` — raw `fmv_snapshots` DESC + JS dedup + unchunked `.in()` (operator-only, fails closed). P2: 17+ local address normalizers vs `lib/address.ts`. `ci:guards` 6/6; TODO/FIXME: 0 real.

## Growth (F) — the numbers
Accounts 35 (auth.users 38 − 3 internal) · **WAU 6** (10-11: 5) · MAU 17 · signups 7d 1 / 30d 10 · D7 0% (n=1) · D30 0% (0 of 6) · email_subscribers 1. **wallet_paste 30d: 65 events / 53 distinct inputs / 46 visitors** (prior 30 d: 58 / 43 / 41); 7 d 15 events / 9 visitors. Upper bound on humans: fires pre-validation, no user_id, internal pastes not excludable, only 10 of 53 inputs look like a Flow address. 11% of 149 non-bot visitors ever do an engaged action. No SEO defect (11 pages by curl, not browser-confirmed). ~6 bare `#E03A2F` literals in chart/UI components (P2). Product signal: a beta collector reported the same alert firing daily (10-11).
