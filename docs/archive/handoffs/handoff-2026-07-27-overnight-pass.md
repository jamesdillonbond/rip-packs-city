# Overnight pass — 2026-07-27

**Mode:** GENUINE OVERNIGHT (fired 08:02Z / 01:02 PDT, INSIDE 00:00–06:00). No clock skew — shell 08:02:01Z ≈ DB `now()` 08:02:09Z ≈ max sale 07:51Z ≈ max fmv 07:54Z. Push AVAILABLE (`git push --dry-run` = up-to-date), no FREEZE, lock `night-20260727T080245Z-12839` taken over (prior run RELEASED 07-26T08:18Z).

**Outcome:** Shipped **0** (correct — see below), reverted 0, repaired 0, drained 2 inbox files. Health GREEN across the board; post-ship watch of the 07-26/27 wave ALL PASS, 0 regressions.

**Connectors:** Supabase + Vercel + Sentry MCP live; bash/git/clone/push up; Cowork artifact tools available.

---

## Why ship 0 was correct

This was an exceptionally busy night ALREADY: a heavy interactive Cowork + Claude-Code session shipped ~30 commits between ~00:00–05:56Z (the full Candy sealed-pack market layer, a live degraded-ME-feed incident + 3-iteration fix, perf-advisor remediations, unused-index drops, SECDEF-trigger revokes, an allday-pack-opens metric fix, and a test-coverage batch), all deploys READY. Consequently:

1. **The single new candidate is off-limits.** Both inbox ticks converge on `ALLDAY-DECODE-LEG-EFFICACY` — and both explicitly classify it as resolver ROUTE logic (`lib/chains/flow/allday-edition-onchain.ts` + `allday-resolve-unmapped`), i.e. ingest-adjacent, in the night-pass off-limits set. Its files were also committed <48h ago (hot). QUEUE, not ship.
2. **Every other plausible low-risk target was freshly touched tonight** (hot files, <48h): all Candy tables/views/routes, the security-invariant surface, the perf-advisor surface (FK indexes + unused-index drops just done), the SECDEF-trigger revokes. Re-touching any of them would collide with same-day committed work.
3. **The perf-advisor's remaining categories were explicitly declined tonight** as unsafe for a heuristic sweep (194 unused-index drops on empty-but-live pre-launch tables / 32 no-PK audit tables). Not re-litigating.
4. **Nothing regressed** — no auto-revert to perform.

Per the standing guidance, a quiet honest night is a good outcome; the ship budget is a ceiling, not a target.

---

## Post-ship regression watch — ALL PASS (0 reverts)

Re-measured the changes shipped in the last ~24–48h against their target metrics:

- **07-26 `audit_20260726_stagger_pgcron_pack_backfill_convergence` (pg_cron stagger).** Schedules verified intact live: jobid 29 = `1-58/3`, jobid 56 = `11,26,41,56`, jobid 83 = `6,16,26,36,46,56`. `check_pgcron_recent_failures()` = `[]`. No convergence pileup, no startup-timeout HIGH. **PASS.**
- **07-27 Candy sealed-pack market wave** (candy_packs / candy_pack_sales / candy_pack_listings / candy_pack_market + the listings/offers ratio→evidence-based deactivation fixes + 407-ask repair). Pipelines all green over 24h: `candy-listings-indexer` 8/8 ok, `candy-offers-indexer` 4/4 ok, `candy-sales-indexer` 8/8 ok, `candy-editions-ingest` 1/1 ok. `rpc_ops_snapshot` security `{invariants:[], anon_write_holes:[], rls_off_base_tables:[], secdef_anon_violations:[]}` — the new Candy tables carry no anon/RLS holes. **PASS.**
- **07-27 SECDEF-trigger EXECUTE revoke + new 4th security-invariant arm.** `check_public_security_invariants()` returns `[]` (folded into the snapshot). **PASS.**
- **07-27 perf-advisor remediations (FK indexes, RLS initplan, permissive-policy scope) + 9 unused-index drops.** Security invariants `[]`, no new Sentry, no new pipeline failures attributable. **PASS.**
- **07-27 `ingest-allday-pack-opens` v8 metric-honesty edge fix.** Deployed READY (`5891f728`); edge fn now reports real rows_written. No regression. **PASS.**
- **07-27 script batch-insert / classifier guards + test-coverage commits.** Test/script-only; all deploys READY. **PASS.**

---

## Health-drift findings + deltas (vs 2026-07-26 metrics-latest.json)

Baseline `rpc_ops_snapshot()` @ 08:03Z:

- **Security:** 0/0/0/0 — invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`.
- **Trust health:** 20 metrics, **0 breaches**. Notable non-breaching: `ufc_fmv_pct_stale_30d` 96.6 (breach 101 — thin collection, 314/518 NO_DATA, no pricing signal; not actionable autonomously), `topshot_fmv_pct_stale_30d` 32.3 (breach 50), `unmapped_resolution_backlog_max` 64 (breach 100, was 46).
- **Stalled pipelines:** `[]`. **pg_cron failures:** `[]`.
- **Sentinel** ts_uuid_editions_48h: **0**.
- **pipeline_fails_24h:** `allday-unmapped-resolver` 62 + `-tail` 6 — KNOWN/INTENDED (the 07-26 tripwire fix now honestly reports `ok:false degraded: 0 promoted`; NOT breakage, per both inbox ticks). `sales-seller-recovery-dune` 13 + `sales-ingest-dune` 12 — DUNE-DATAPOINT-CAP-402 (operator/billing, cursors parked). Remainder single self-recovering contention ticks.
- **pipeline_alerts:** all `info` severity now — the nfl_all_day unmapped-backlog-growth alert **dropped from HIGH → info** (28,442 actionable open rows; 20,456 frozen-by-design multi-NFT txs; live inflow 37/24h vs outflow 114/24h — net draining). ufc_strike unmapped 1,109 (info, 0 live inflow). golazos_sales + ufc_sales resolving_editions (standing info).
- **Sentry:** 0 unresolved production issues / 24h.
- **Vercel:** prod `5891f728` READY (newest non-docs tip); HEAD `95017724` is a docs-only monitor-inbox commit, correctly CANCELED by `ignoreCommand`; 0 ERROR-state across the last 20 deploys.
- **DB size:** 11,210 MB (was 11,109 → +101 MB, normal growth).
- **FMV TS HIGH+MED:** 807+2054 = **2,861** (was 2,807, +54). Editions TS **19,523** (was 19,513).

---

## Queued (not auto-shipped)

### NEW this pass
- **ALLDAY-DECODE-LEG-EFFICACY** (night 1) — LOW/MEDIUM. The always-on stage-2 decode leg in `allday-unmapped-resolver` runs ~60 Flow-REST tx fetches/tick and, over a full 24h (94 runs, 3,599 `decode_attempted`), resolved **0** rows — including 180× where the `0xe4cf4bdc1751c65d` contract-address class it was built for was actually reached, so the 07-26 "pays off as the class is reached" prediction is **falsified**. The scan leg is `scan_ineffective` (0 new holders tried, full budget spent). All 44 promotions in-window came from the Leg-A borrow / `decodeV1SaleTx` buyer path. **Suggested fix (ready to spec):** narrow the decode leg to fire only when the stored buyer was excluded/absent (not on every nil borrow), and reclaim `SCAN_CHUNK_BUDGET`. Net: −~3,600 wasted Flow-REST fetches/day + the occasional upstream-timeout blowout, zero loss of resolutions. **Why not auto-shipped:** resolver route logic = ingest-adjacent (off-limits set) + files hot (<48h). Trevor / Claude-Code item.

### Carried
- **ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH** — now `info` severity (was HIGH); net-draining (outflow 114 > inflow 37/24h). Resolver-throughput / off-limits. Tracked since 07-25.
- **SET-DETAIL-PAGE-POOL-RETRY-GAP** — `get_set_detail` lacks the `rpcWithRetry` wrapper; blocked as hot-file until `set/[slug]/page.tsx` ages past 48h. LOW code.
- **TS-PACK-OPENS-HISTORY-CURSOR-FASTFORWARD** — `topshot-pack-opens-history-backfill` re-scanning ~45M already-covered blocks (~19d, ~10.6k tx/day) for 0 rips; fast-forward `event_cursor.topshot_pack_opens_backfill` to ~62,000,000 or retire. NOT unilateral (band presence ≠ per-window completeness). Queued 07-27 (Cowork).
- **CANDY-CLASS-PURGE-GUARD-FLOW-CACHES** — port the evidence-based deactivation to the 4 Flow `*-listing-cache` purges; deliberately NOT shipped (FMV-feeding path, measured stable). Queued 07-27 (Cowork).
- **DUNE-DATAPOINT-CAP-402** — sales-ingest-dune / sales-seller-recovery-dune HTTP 402, operator/billing.
- Standing: REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST, CORRELATED-PIPELINE-DROPOUT-DETECTOR, PIPELINE-WATCHLIST-COVERAGE-AUDIT, TOPSHOT-BADGE-CATALOG-429, WMC-PRUNE-120S-CEILING, NON-WAVE-WALLET-BACKFILL-DRIVER, CLAUDE-MD-GOLAZOS-LOW-ASK-STALE, Panini go-live (Trevor editorial), chain-two/Candy public go-live (gated).

---

## Failed / blocked / reverted

None. No shipping attempted (correct), so no verification failures and no hard-stop.
