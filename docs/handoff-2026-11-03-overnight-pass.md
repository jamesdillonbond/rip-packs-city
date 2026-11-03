# RPC overnight pass — 2026-11-03 (Pacific)

**Run:** `rpc-nightly-overnight`, Cowork cloud (laptop-VM clone + `.rpc-git-cred`). RUNID `cowork-20261103T090348Z`.
**Mode:** genuine overnight. Fired 09:03Z = **1:03 AM PT**, inside 00:00–06:00 → normal shipping allowed. Clock verified no-skew (shell `date -u` 09:03:09Z == DB `now()` 09:03:19Z == newest `sales.ingested_at` 09:03:08Z). Push AVAILABLE (dry-run authenticated, "Everything up-to-date"). Not frozen. Lock taken over (prior entry RELEASED from the 11-02 pass, ~24 h old).
**Verdict:** 🟢 GREEN. **0 production shipped, 0 reverted.** Two docs commits: a stranded-output sweep (`79116199b`) and this handoff/ledger/metrics/session commit. Nothing was both low-risk AND completable this pass beyond rescuing stranded task output — a quiet honest night.

## What was reviewed
- **Targeted continuity review** (not a full CLAUDE.md verbatim read this pass): `focus.md` (all steers through 11-01), `ledger.md` top, `metrics-latest.json`, the three newest inbox filings, latest handoffs, `known-issues.md` status index (3 open · 6 partial · 216 closed) + its 10-17 re-derivation, roadmap pointers. All authoritative live state covered via the health sweep below.
- **Inbox drained (3 filings since the 11-02 pass):**
  - `2026-11-02T1908Z` GHA schedule-tick stall (MEDIUM) — **already dispositioned by Claude Code: SELF-HEALED.** `gha-schedule-watchdog` back to `delivering` from 11:38 AM PT 11-02; `detect_stalled_pipelines()` never turned non-empty. GitHub-side schedule delay. No action.
  - `2026-11-03T0705Z` net._http_response above sawtooth peak — **already dispositioned by Claude Code (`d38934933`): TOAST high-water mark (504 MB live of 2.6 GB), not a leak.** Confirmed this pass: `_http_response` 2,772 MB (down from 2,845 last night). No action.
  - `2026-11-02T1900Z` Panini ingest throughput down + old catalogue starving — **MOUNT-ONLY (stranded); carried into origin this pass; QUEUED** (laptop Task-Scheduler env + possible route-logic fix = Claude Code/Trevor, not sandbox-shippable). See QUEUED below.
- **Stranded-output sweep:** two files written to Trevor's laptop tree by daytime Cowork sessions on 11-02 that never reached origin, both committed as-is (`79116199b`):
  - the panini-throughput inbox filing above (+ INDEX.md 11-02 section 2→3, header 615→616, every file listed / counts reconciled by `fix-inbox-index-counts.mjs`);
  - `docs/handoff-2026-11-02-saved-wallets-username-address-path.md` — a route-fix handoff for Claude Code (`saved_wallets.username` null on address-entry signups). The 21 existing null rows were already backfilled live by that session; the code fix is NOT yet landed (origin's `app/api/profile/resolve-and-associate/route.ts` line 110 still hard-nulls `username`). QUEUED for Claude Code.
  - Ledger and `handoff-2026-11-02-email-product-launch.md` also DIFFER mount-vs-origin, but that is the mount being **behind** origin (Claude Code's 11-02-evening pushes un-pulled on Trevor's box), not stranded content — every mount entry already in origin. Nothing carried.
- **Git:** `origin/main` = `d38934933` at run start; advanced only by my own stranded-sweep push mid-run. Last ~48 h had heavy Claude Code / Cowork activity (#226 chain reconcile, #227 digest, mint-probe exact-bracket, bio-editor gate, trade-block collection labels, #223 xcoll quarantine, #114 roster, #225 UFC). Every touched file treated as HOT; nothing edited.

## Health-drift findings + deltas (baseline = 11-02 metrics-latest)
- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Trust health:** 0 breaches, all 40 legs ok. candy_sales_stale_hours 533.8 (< 1,114.9 re-verify clock ~11-27), edition_integrity_flags 22 (<250), panini_coverage_pct_drop 5.4 (<15), panini_fmv_stale_hours 0 (<36), trust_precompute_max_age 5.33 (<13), fmv_sanity_flags 0.
- **Structural:** stalled_pipelines []. backward_cursor_rewinds / wmc_null_edition_key / function_search_path_drift / procedure pins / cross_collection_mat_staleness / suppression drifts all []. sentinel_ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0. **pg_cron:** `check_pgcron_recent_failures()` = [].
- **pipeline_alerts:** 2 rows, both `info`/designed (flow-rest-moment-moved-400; atlas-pack-supply-upstream-404) — last ok/200 09:07Z, neither at its escalation condition.
- **pipeline_fails_24h:** all low, upstream 0 — atlas-pack-market 10, topshot-pack-supply-atlas 7 (designed 404/403), gha-schedule-watchdog 7 (the self-healed 16:08→11:38 window), pack-nft-identity 4, others ≤3. **pack-mint-probes verified recovered:** 360/360 ok over 30 h (last night's 12 were an 11-01 DNS blip).
- **Post-ship regression watch — GREEN:**
  - **#219 league backfill:** null_league_classified 0 → holds.
  - **#222 lock-check:** last 5 `lock-check-batch` all ok, `extra.absent_from_chain` 0–2 (small), skipped_locked 0 (is_locked preserved) → holds.
  - **#217 reprice-drifted-rips:** last daily run 11-02 11:26Z ok; next ~4:26 AM PT (after this pass). No regression.
  - **pack-mint-probes exact-bracket fix (`c692e6b18`):** 360/360 ok → holds.
  - **#227 digest / send-digest:** correctly idle (Vercel cron Mondays 8:23 AM PT; Stage B enabled ~12:00 PM PT 11-02, after Monday's slot — first scheduled send next Monday 11-09). `WEEKLY_DIGEST_ENABLED` stays OFF (#227). Nothing to re-measure until 11-09.
  - **net._http_response:** 2,772 MB, within the documented sawtooth; came down vs 2,845 last night.
- **Vercel:** last prod **READY** = `dpl_Ct1yCXeKpPTpHGfHnH7GD4YR55rj` on `899c6c6fa`. The 4 newer commits (a48c9f5f2, 1b27a40aa, 341be6443, d38934933) all CANCELED = rapid-succession **docs-only** build supersession; no runtime difference (production serves current code). Runtime errors 24 h: all chronic/graceful groups (set-activity statement-timeout→empty since 09-26; wallet-search Flow computation-limit on one oversized collection since 09-14; pack-detail / market-pulse / pack-sniper read-exceeded since 08-23/08-16) **plus a single-minute 01:03 AM player-hub "bound exceeded" burst** (~10 distinct player hubs, count=1 each, soft non-crashing degrade log — crawler/cold-start shape). **No new crash group; nothing attributable to the recent code ships.**
- **db size:** 44,715 MB (+366 vs 44,349 last night) — within the ±1.3 GB band; no public table grew > 200 MB. Top tables: panini_card_serials 9,295 (steady Panini growth), wmc 2,857, _http_response 2,772, pack_rips 2,355, sales_2026 2,077.
- **FMV churn (HIGH+MED, compute 05:35Z):** nba 6,604 (+26), panini 18,001 (−21), nfl 1,645 (+17), **pinnacle 904 (−5 — the 996→955→909 slide has stabilised)**, candy 68 (flat), golazos 1, ufc 0. Editions ~flat (panini 40,156 / nba 14,600 / nfl 6,190 / golazos 575 / ufc 617 / candy 125). 0 stale/sanity flags — normal churn.

## QUEUED (needs Trevor / Claude Code / a non-sandbox lever)
- **Panini ingest throughput down + old catalogue starving (inbox `2026-11-02T1900Z`, now in origin) — NEW, QUEUED.** Runner fires and authenticates (7 walks/24 h, fmv_yield 1.00, stalest-first) but writes far too little per walk: 1,832 editions 11-01 (36 % of trailing-7); 14,576 editions un-repriced 7+ days (oldest 251.5 h), 0 walked in 24 h. Per-card time rose after 10-28 (serial paging explains ~1.5× of a 2–3× slowdown; per-page latency unexplained). **Why not auto-shipped:** the proposed fixes are (B) lower `PANINI_SERIAL_PAGES` and (C) widen the walk budget — both **Task-Scheduler environment** changes on Trevor's laptop, not repo; and (D) an optional **aged-priority walk-order code change** in `scripts/ingest-panini-runner.mjs` + `app/api/cron/panini-ingest/route.ts` — that is **route-logic on the ingest pipeline (OFF-LIMITS, always QUEUE)**. Evidence needed (`%USERPROFILE%\panini-run.log`) is outside the Cowork-connected folders. Full diagnosis: `claude/panini-throughput-diagnosis-2026-11-02.md` + addendum (project) and the inbox file.
- **saved_wallets username root-cause code fix (handoff `docs/handoff-2026-11-02-saved-wallets-username-address-path.md`, now in origin) — QUEUED for Claude Code.** `app/api/profile/resolve-and-associate/route.ts` address branch hard-nulls `username` (line ~110) instead of reverse-resolving from `wallet_usernames`; so future address-entry signups recreate the null gap. `.tsx`/route change Cowork can't push. The 21 existing null rows were already backfilled live (null_username now 0 of 185).
- **panini-ingest-enum 738-min cadence threshold (carried, OPTIONAL, low value):** relax/annotate so a weekend-quiet enum (laptop runner closed) stops surfacing near-threshold `info`. Trevor/Claude Code call.
- **#58 OPENSEA_API_KEY (carried, P2, Trevor-only):** secret, no sandbox lever. candy_sales_stale is a re-verify clock (~11-27), low pressure.
- **topshot-active-listings-ingest egress_blocked (carried, WATCH):** backstop-attribution fix shipped 11-01 (`25bdf5a1e`); pooled alert ages out on its own. Monitor only.

## Shipped / Failed / Reverted
None. No production change this pass (two docs commits only).

## Metric to re-check next pass
- net._http_response size stays within sawtooth; any public table > 200 MB between passes = escalate.
- Post-ship watches #219 (0), #222 (absent_from_chain small/0, is_locked preserved), #217 (daily small rows_written, no 57014), pack-mint-probes ok rate.
- player-hub "bound exceeded" — was a one-minute 01:03 burst; only a SUSTAINED pattern (not a single crawl burst) would warrant a look at `get_player_hub` perf (route logic = Claude Code).
- send-digest first real run is Monday 11-09 8:23 AM PT.
- Pinnacle HIGH+MED (slide stabilised at 904; continuity note only).
