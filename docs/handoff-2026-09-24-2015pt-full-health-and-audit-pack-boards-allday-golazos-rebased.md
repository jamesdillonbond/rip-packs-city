# Handoff — 2026-09-24 evening (7:45–8:20 PM PT): full health check + audit/QA. GREEN. Shipped: All Day + Golazos packs boards rebased off retail price (#50, second and third collections)

**Author:** Cowork (cloud). Trevor: "Do a full health check. Then … a full audit and QA across the entire project and our tools. Test and fix all you can."

> ⚠ **This session had NO push path.** Cloud git proxy refused the repo ("not in this session's authorized repository set"); the laptop bridge was offline the whole session (retried). This blocker is specific to **this cloud session** — Trevor's machine and Claude Code push normally. **Commit the two migration files below as usual.** They ride alongside this handoff (and in the chat).

## Capability triage (measured, not assumed)
bash ✅ · fresh clone of `origin/main` at `1539f09` ✅ · push ❌ (proxy 403) · device bridge ❌ (`device_bash` and `device_list_dir` both "not connected", retried) · Supabase MCP ✅ · Vercel MCP ✅ (dropped once mid-session, reconnected) · Sentry MCP ✅ · Chrome extension not used.
**Mode: DB + handoff.** Migrations applied via MCP; repo files written to the outputs folder for Claude Code / Trevor to commit.

## 1. Health check — GREEN, no regression (all readings 7:44–7:50 PM PT)

| Instrument | Reading |
|---|---|
| `check_public_security_invariants`, `check_anon_write_surface`, `check_secdef_anon_execute_violations`, `check_secdef_anon_exec_drift` | all `[]` |
| `detect_stalled_pipelines`, `detect_pipelines_without_success`, `check_pipelines_running_but_not_succeeding` | all `[]` |
| `check_when_others_timeout_blind` (R118) | length 0 |
| Structural drift arms (backward cursor, fn/proc search_path, txn-control pin, suppression-parked, cron_heavy exec, cursor-stall threshold) | all `[]` / 0 offenders (159 inspected) |
| `check_edge_lane_observability` | 15 inspected, 13 fresh, 0 stale, 0 unregistered, 2 unchecked-by-decision (documented) |
| `v_rpc_trust_health` | **38/38 arms ok**; precompute fresh (oldest leg 6 h, all within budget) |
| `get_pipeline_alerts` | 1 `high`: `panini-team-walk` 3/6 failed over 3 days — **already fixed** (ledger 09-24: 429 backoff + CDP disconnect; the 4:04 PM re-run completed both teams). 4 `info` rows all previously characterized benign (AllDay unmapped drain 4.3 d, Atlas 8–9% Cloudflare challenges with retry keeping up, Flow 400 "no nft" by design). |
| pg_cron 24 h | **0 failed, 0 `job startup timeout`** across every job |
| `pipeline_runs` 24 h | Only chronic/decided failures: `sync-nba-projections` 0/8 (dead feeds since 08-04, #8 decided), `topshot-pack-supply-backfill` 0/1 HTTP 530 (dead host, #81 decided). Everything else ≥98.7% ok. Two one-off failures noted in §3. |
| Smoke suite (`smoke_test_results`) 24 h | ~2,000 checks, **1 fail** — `/api/support-chat` concierge printed an uncorroborated "5%" once at 10:03 AM PT; passed the other 41 runs. |
| Sentry (7 d) | 13 unresolved issues, **every one last seen 6 days ago**; 0 new in 24 h |
| Vercel runtime errors (24 h) | 14 groups, **0 first-seen in 24 h** (oldest first-seen June 16; the bulk is the `url.parse` DeprecationWarning). **Production 5xx in 24 h: 0** (grouped by route → empty). Sentry-zero is therefore PAIRED and counts as health. |
| Live pages (curl from cloud) | **41 URLs, all 200** (or the expected 307 → login / overview): home, every `/insights/*` board (30), collection overviews, edition `124:4493`, pack dists 4184/901, `/teams/nba/lakers`, blog, pricing, methodology, sitemap, `/api/health`. 404s correct for a bad board slug and a bad edition. 0 error markers in any served HTML. |
| Security advisors | 0 ERROR. 2 `function_search_path_mutable` = the permanent pair (`rpc_trust_health_precompute_refresh_p`, `reconcile_all_saved_wallet_stats`; ledger says do NOT "fix"). anon/authenticated SECDEF-executable rows are the allow-listed readers. |
| Performance advisors | nothing new (unused-index / no-PK info rows on audit tables). |
| Migration parity (name-based, 14 d) | every prod migration has a repo file by name; `migration-autorecover` pushed the last fileless one at 6:50 PM PT. |
| DB size | 25,620 MB (24,237 on the 09-24 01:10 AM metrics). `net._http_response` is 6.4 GB for 6,636 live rows — the weekly `VACUUM FULL` (jobid 542, Sundays 2:16 AM PT) last ran 09-20; the sawtooth is instrumented. Not a finding. |

**Watch items from the 09-24 handoffs, re-read:** `golazos_pack_sales_history` = **31,846**, exactly the API total at reset — exit met (sweep still `done=false`, walking). #83 falsifier: **0** new All Day sales with the custodian as buyer since 7 AM PT. `snapshot-institutional-wallets` v44: last heartbeat 5:46 AM PT; first post-deploy run is ~3 AM PT 09-25 — not yet due.

## 2. Shipped — the packs boards for All Day and Golazos stop ranking unbuyable packs on retail (#50, second and third collections)

The 4:05 PM PT fix (`20260924230603`) rebased **Top Shot's** retail-basis rows on the live ask and scoped itself to Top Shot. I measured the other two collections and found the same defect:

- **All Day** (7:55 PM PT): every `mv_pack_ev_latest` row has `price_source NULL`; no primary is live; 375 of 489 EV rows had a live secondary ask the verdict ignored. `/nfl-all-day/packs` headlined **"2025 Regal Rookie Trade In Reward – Nick Emmanwori" at 15.75× on a $1.00 placeholder** — a reward pack with `primary_available=false` **and** `secondary_available=false`. Kansas City Game Day read 2.82× on $4 retail against a $16 live ask (really 0.70×); Houston Texans Feast 2.32× against $28.50 (0.33×). 10 published +EV rows were negative on the ask; 9 published negative rows were positive on the ask; 3 +EV rows had no price path at all.
- **Golazos** (8:08 PM PT): all 12 +EV rows (≤ 2.07×) had `primary_available=false` by the view's own measured rule (state `Complete`, windows that ended in 2022/23, or placeholder year-2122 windows) and `secondary_available=false` under a fresh ask snapshot (`total_listed = 1` for the whole collection). Nothing on that board could be bought.

**Migrations applied (8:06 / 8:09 PM PT), same shape as the Top Shot fix:**
- `20260925030613_audit_20260924_pack_table_rows_rebases_allday_retail_basis_rows_on_the_live_ask` — `retail_basis` extends to All Day rows with no `price_source`, except while the dist's primary window (`metadata.endTime`) is open. Dry run: 488 rebased / 479 changing / 114 verdicts NULLed. Post-apply: AD +EV **37 → 33**, max ratio **15.75 → 4.46**.
- `20260925030943_audit_20260924_pack_table_rows_rebases_golazos_retail_basis_rows_on_the_live_ask` — same for Golazos, except while the view's Golazos primary-live rule holds. Post-apply: Golazos +EV **12 → 0**; `gross_ev` still published on all 33.
- Verified from outside after each: 6,006 rows before and after; +EV total **76 → 60** (TS 27 unchanged); reloptions NULL and ACL unchanged (allow-listed definer view); security invariants `[]`; AD and Golazos packs pages and three pack-detail pages 200 with no error markers.
- **Revert:** re-apply the `pack_table_rows` body from `20260925030613` (drops Golazos only) or `20260924230603` (drops both).
- **Re-open:** a Golazos primary drop going live returns its primary price automatically. **Falsifier:** any AD/Golazos row +EV with `primary_available IS NOT TRUE AND secondary_ask IS NULL`.

**For Claude Code (all repo-side, none blocks prod):**
1. Drop the two `.sql` files into `supabase/migrations/` (they carry the `definer-view: intentional` marker the view-security guard asks for) and commit. `check-migration-parity` will otherwise name them in ~14 days.
2. Prepend the ledger entry (`ledger-entry-2026-09-24-pack-table-rows-allday-golazos.md`, alongside this handoff) at the top of `docs/overnight/ledger.md`.
3. `docs/reference/known-issues.md` #50 (closed 4:05 PM PT): add a one-line addendum that All Day and Golazos were rebased at 8:06/8:09 PM PT. No pin/test touches `pack_table_rows`' definition (`supabase/tests/*` only reads it in fixtures), so no re-pin.

## 3. Findings not shipped (report only, in priority order)

1. **All Day FMV lags a collapsing new-set market (FMV route — Trevor's call).** Independent accuracy check, FMV vs 30-day median sale on editions with ≥5 sales and HIGH/MEDIUM confidence: Top Shot median ratio **1.000** (p10–p90 0.84–1.14, n=3,804), All Day **1.027** (0.84–1.33, n=681) — tight. The outliers are one class: 2025 rookie commons where sales fell to the $0.15 floor while FMV still blends the earlier $1–2 prints — `4306` TreVeyon Henderson FMV $1.32 vs median $0.15 (12 sales, **8.8×**), `4283` Tyler Warren $0.86 vs $0.15 (5.7×), `4292` Jack Bech $0.39 vs $0.15 (2.6×). The Top Shot "outliers" are the opposite and benign: set 189 commons where the 30-day median is exactly $2.00 (fixed-price primary prints) while the live ask is $0.40–0.50 and FMV sits at $0.28–0.36 just under the ask. Nothing to fix on Top Shot; the All Day lag is an engine-window question, not a data bug.
2. **`ts-listings-atlas-sync` loses a whole 5-minute tick when one open listing's edition is a fresh stub** (`null value in column "circulation_count" of relation "ts_listings"` — 1 of 864 runs in 24 h; 2 on 09-12, 1 on 09-24). `_tsl_want` takes `e.circulation_count` straight from `editions`, and the 09-23 hydrate-drain stubbing creates editions before enrichment. A one-line splice (`WHERE e.circulation_count IS NOT NULL` in `_tsl_want`, or `COALESCE` with a NOT NULL-safe default) would drop just that listing for one tick instead of rolling back the tick's deletes and upserts. Self-heals in minutes today, so it did not clear the bar for a drift window from a no-push session. Queue for the next push-capable pass.
   - ✅ **DONE 2026-09-24 ~8:45 PM PT** (`20260925034501`, `ff51910c3`).
   - It took the `WHERE` form plus a `no_circulation` count. It did not take `COALESCE`: any default fabricates the mint-count denominator.
   - The first tick after the apply was ok. See the ledger.
3. **`topshot-moments-hydrate-wmc`** failed 1/216 in 24 h on `duplicate key … moments_nft_id_key` (also 3/68 on 09-20). Not investigated tonight; 99.5% ok and not stalled.
4. `panini-team-walk` `high` alert is stale by construction — the failure-rate arm counts 3 calendar days and the fix landed at 4:04 PM PT; it clears as the window rolls.

## 4. Needs Trevor (unchanged from 09-24 morning)
`enrich-ufc-wallet` CLI deploy · `wrangler deploy` of `workers/pack-events-ingest` (#123) · off-GitHub trigger / Vault Telegram token for the site-down alarm (#76) · GitHub Support for the credential purge (#22) · Q0 `fmv_from_cached_listings` (partly addressed 09-23 by `20260923205831`; the AD FMV lag above is the same route).

## 5. Digest
**Health: GREEN**, Sentry-zero paired with Vercel-zero, 41/41 pages 200, 38/38 trust arms ok, 0 pg_cron failures. **Shipped:** two `pack_table_rows` migrations — All Day and Golazos boards no longer publish +EV on packs nobody can buy at the quoted price (+EV rows 76 → 60, the 15.75× headline gone). **Not committed** (no push path) — files attached. **Failed:** nothing. **Nothing else was clearly-safe to ship unattended.**
