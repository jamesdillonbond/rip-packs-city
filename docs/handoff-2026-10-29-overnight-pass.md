# RPC overnight pass — 2026-10-29 (~1:15 AM PT, Cowork cloud)

**Verdict: GREEN. 0 production shipped, 0 reverted, queue-only.** One docs-only commit (stranded-output carry, below). The HIGH user-facing item the daytime monitor filed at 06:13Z resolved by design before the pass acted. Push route: laptop-VM clone + `.rpc-git-cred` (push available, dry-run exit 0).

## Gates
- Lock: prior was RELEASED (10-28 08:19Z, ~24 h old). Took over; fresh lock `cowork-20261029T080358Z-1542`. Released at end.
- FREEZE: none. Push: available. Clock: NOT skewed (shell 08:03:19Z ≈ DB now 08:03:34Z ≈ app rows) → real local time ~01:03 AM PT = genuine overnight, normal shipping allowed.
- Collision gate: `origin/main` was `1b2fb7f56` at start and through the pass (no concurrent human/CC push). Nothing hot was edited.

## Reviewed
- Inbox drained (clone is a superset of the mount — daytime monitor pushed through 10-29T0613Z; no mount-only filings). Newest 4 read in full.
- Ledger (head + Declined), focus.md, metrics-latest.json, last handoff (10-28), CLAUDE.md in full.
- Health baseline `rpc_ops_snapshot()` + direct-catalog security re-check + Vercel deploys/runtime errors.

## Inbox dispositions (this pass)
1. **2026-10-29T0613Z — Dapper "degraded" notice stuck on Top Shot while trading live (HIGH).** RESOLVED BY DESIGN, no action. `restore_dapper_maintenance_notice(boolean)` lifts a collection only when `sales_2h >= need AND distinct_buyers_2h >= 5` (need = TS 48 / All Day 8 / Pinnacle 6 — 25 % of pre-outage 2 h volume), or at the 2026-11-04 15:00Z backstop. At 06:13Z the monitor saw "10 sales in 70 min" — well below TS's 48/2h bar — so the notice correctly held. Between 06:13Z and ~07:17Z, TS (and Pinnacle) genuinely crossed the bar and were lifted. **Live now: nba_top_shot, disney_pinnacle = healthy; only nfl_all_day still degraded** (last restore tick 08:07Z: sales_2h 5, buyers_2h 4, need 8 → correctly not lifted; self-lifts on volume or the 11-04 backstop). Restore cron still scheduled; only nfl_all_day retains `marketplace_saved`. The notice state matches reality on every collection. Not a defect.
2. **2026-10-29T0314Z + 0015Z — topshot/allday/golazos listing-cache dark; cached_listings_v2 freeze.** No action (held by Trevor). These are the three **Flowty** API lanes (flowty-retirement-runbook §0), DARK, teardown pre-staged, retire-not-repair, held until Dapper fully back + 24 h. Nothing priced depends on them (TS asks read `ts_listings`, fresh; All Day/Golazos read on-chain `cached_listings_v2`). Golazos already dispositioned as a quiet market (book re-verified, matches live site). All Day/Pinnacle `cached_listings_v2` freeze = Dapper markets still closed (expected).
3. **2026-10-28T1810Z — pg_cron ":06" job-startup-timeout cluster (LOW).** CLEARED. Re-measured in the now-quiet post-outage window: hours 04:00–07:00Z = 100 % clean (0 non-succeeded over ~4,500 ticks); only non-succeeded row in the last hour is one job still *running* at 08:11. The 10-28 cluster was outage-retry bgworker contention at a crowded minute, not N distinct bugs — exactly as the filing predicted ("rule out that it clears when Dapper recovers"). No stagger needed.

## Health-drift triage (all GREEN)
- **Security:** clean. `rpc_ops_snapshot.security` invariants/anon_write_holes/rls_off_base/secdef_anon all `[]`; direct-catalog re-check (RLS-off public tables `[]`, anon/authenticated write-grants on RLS-off `[]`) agrees.
- **Trust health:** **0 breaches.** The former `candy_sales_stale_hours` breach is retired by the 10-28 re-verify-clock redesign (value 412.7h now < breach_at 1114.9; re-verify the candy_mlb row ~11-27). All FMV legs ok (topshot_fmv_stale 0.2, all `*_fmv_pct_stale_30d` 0, fmv_sanity_flags 0, pinnacle_fmv_impossible 0). edition_integrity_flags 22 (250), unmapped_resolution_backlog_max 0.
- **Pipelines:** `stalled_pipelines` [], `backward_cursor_rewinds` [], `wmc_null_edition_key` [], `function_search_path_drift` [], procedure pins/txn-control []. Sentinel TS-UUID-48h 0, ts_uuid_dupes_24h 0. The high 3-day failure_rates on atlas-editions-refresh/atlas-market-feed/topshot-pack-supply-atlas are **pooled across the Dapper outage** (R124) — the lanes are live again (last successful drains 08:03–08:05Z, newest events 08:03Z). topshot-pack-dist-names-onchain 10/18 (chronic pack-media HTTP 500). listing-cache mediums = the Flowty lanes above.
- **Vercel:** prod serves `dpl_ADSatXe63ik7yGs1jKj53UVKa5Mz` @ `1b2fb7f56` READY = origin HEAD (pre-carry). Last 6 prod: 3 READY / 3 CANCELED (superseded docs-only commits) / 0 ERROR. 24 h runtime errors: 5 groups, all chronic slow-board/IPFS read timeouts (ipfs-media 10, pack_lifecycle 4, pack_realized_ev 1, panini market-cap tile 1, pack-sniper 1), degrade-honest, none new, none deploy-traced to the 10-28 wave.
- **Sentry:** dark (SDK removed, #34). client_error beacon window clean.

## Post-ship regression watch — the 10-28 Cowork/CC wave (GREEN, nothing reverted)
- **analytics-smoke (dedup + recorded-outage-warn ships):** verified. Sequence at the recovery edge: 04:13Z paged (tg_sent), 04:43Z suppressed (dedup working), then ok=true / fail_count 0 from 05:13Z onward as All Day sales returned fresh. None of the focus-steer regression shapes occurred.
- **FMV basis_days_since_sale / parallel-names / topshot_subeditions refresh:** FMV legs all ok, sentinel 0, ts_uuid_dupes 0. editions nba_top_shot 14549→14605 (+56, the new Animated/Illustrated editions). topshot-subeditions-refresh shows 1 ok=false in 24h = the deliberate planted-defect test row (ledger 10-28).

## Overnight deltas (vs 10-28 metrics-latest.json)
- db_size 42,097 → 42,133 MB (+36).
- FMV HIGH+MED: nba 6565→6481 (-84), panini 17,990→18,035 (+45), nfl 1,733→1,696 (-37), pinnacle 929→902 (-27), candy 75→72 (-3), golazos 1 flat, ufc 0 flat. (Small recompute drift; no FMV route change shipped. All Day/Pinnacle inputs partly frozen by the outage tail — not a clean read, recorded not flagged.)
- editions: nba 14,549→14,605 (+56), **panini 40,000→40,116 (+116)** — NOT pinned at 40,000, so the 10-28 ingest-ceiling watch is CLEARED. Others flat.
- trust breaches 1 → 0 (candy retired by re-verify clock). unmapped backlog 8 → 0.

## Shipped (production): NONE.

## Docs-only commit
- **Stranded-output carry — `d300faa4d`:** the weekly flow-ecosystem-watch task wrote its 2026-10-28 entry to the laptop tree and never pushed it. Carried into origin verbatim (28 insertions, 0 deletions — origin content preserved; mount was origin + that one entry). Laptop copy untouched. **Revert:** `git revert d300faa4d` (docs-only, harmless).

## Queued / carried for Trevor or Claude Code (no change this pass)
- **Staged migration `docs/proposals/cadence-bridge-chain-arrivals-STAGED-MIGRATION.sql`** (Trevor/CC) — needs a DB write that raised unanswered MCP approval prompts; chain-arrivals cadence bridge to 11-05 + delete lapsed pinnacle-pull-chain bridge + clear the expired 10-01 Cadence Collapse ack. Apply with Trevor present; part (1) moot after 11-04. Until applied, Pipeline Sentinel may read CRITICAL on Cadence Collapse for chain-arrivals — that is this, not a caller fault.
- **#58 OPENSEA_API_KEY / Candy** (Trevor-only secret) — lower pressure now that candy_sales_stale is a re-verify clock, not a live breach.
- **Flowty three-lane teardown** — held by Trevor until Dapper fully back + 24 h (retire-not-repair; runbook §0).
- **CC-owned perf/watch:** panini_deal_board / _all cache-warm statement-timeout (WATCH, ≤2/day, falls back to last good snapshot). (#HF hot-floors, get_panini_franchise_panel perf, refresh_panini_offer_spread self-collision were closed per the 10-28 steer.)

## Failed / blocked / reverted: NONE.
