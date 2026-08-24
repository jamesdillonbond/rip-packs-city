# RPC Long-Term Ops-Safety & Data-Integrity Plan — 2026-06-27

**Status: PARTIALLY SHIPPED 2026-06-27** — the Cowork-lane safety work (B1 + C1) and the sentinel fix are live + verified (see "Shipped" below). CC-lane + Trevor items remain. Grounded in a live repo + DB inventory this session.

## Shipped this session (2026-06-27, verified)
- **Sentinel fix.** `allday-fmv-populate` was intentionally disabled in another thread (redundant — AllDay FMV is 0h-stale via fmv-recalc 5b + the studio writers; its last runs fetched 0 editions). Its watchlist row was false-paging a ~16h "stall." Deactivated it (`audit_20260627_deactivate_allday_fmv_populate_watchlist`); `detect_stalled_pipelines()` is now `[]`. **Revert:** `UPDATE pipeline_cadence_watchlist SET is_active=true WHERE pipeline='allday-fmv-populate';`
- **B1 — DELETE/TRUNCATE circuit-breaker** (`audit_20260627_delete_guard_circuit_breaker`). Statement-level guard on `wallet_moments_cache` (blocks >3 distinct-wallet deletes), `editions` (>25 rows), `pinnacle_editions` (>25 rows), + TRUNCATE block; intentional bulk ops opt in with `SET LOCAL rpc.allow_bulk_delete='on'`. Thresholds in `rpc_delete_guard_config`. **Verified 4/4 in a rolled-back test:** single-wallet PASS, multi-wallet BLOCKED, flag-bypass PASS, editions>25 BLOCKED. The 06-27 blind-delete (1,724 wmc rows, many wallets) is now impossible without explicit opt-in. **Revert:** drop the 6 triggers + `rpc_guard_block_destructive()` + `rpc_delete_guard_config`.
- **C1 — per-collection FMV freshness** (`audit_20260627_trust_health_per_collection_fmv_freshness`). Added `topshot/allday/golazos/ufc_fmv_stale_hours` to `v_rpc_trust_health` (breach 6/12/30/30h, measured-safe). Verified: 13 metrics, 4 new `ok`, 9 originals intact. Closes the global-freshness blind spot (a single-collection total-FMV outage now pages). `rpc_ops_snapshot` picks these up automatically. **Revert:** restore the prior 9-metric view def.

**Remaining — CC + Trevor (Parts C2/C3/D + B2/B3 below).**

## Why now

An increasingly-autonomous estate (nightly pass shipping to `main`, a 6×/day monitor, plus concurrent Cowork + CC sessions) just had a **near-miss**: a session blind-deleted 1,724 `wmc` rows (reverted from a snapshot, net-zero). The only thing that saved it was a session happening to re-read the ledger. The lesson isn't "be more careful" — it's that the system needs guardrails that make a destructive mistake *impossible*, plus sentinel coverage that can't be fooled, plus the data residuals fixed at the root instead of accumulating "accept it" decisions. This covers all three.

---

## Part A — Architecture review: the failure modes (what we're defending against)

| # | Failure mode | How it showed up | Current mitigation | Gap |
|---|---|---|---|---|
| 1 | Blind destructive DB op | wmc 1,724-row delete (06-27) | "read the ledger" convention — **just failed** | No hard guard against large/cross-cutting deletes |
| 2 | Stale handoff / concurrent-session collision | handoff-2026-06-27 premises already drained by a parallel CC session | "re-measure" instruction | No staleness signal, no claim on in-flight items |
| 3 | Sandbox clock skew | nightly mis-judged quiet-hours 06-23/24/25 | **fixed this session** (DB-time cross-check) | — |
| 4 | `/tmp` uid-squash | nightly re-homing clones | **fixed this session** (`$HOME/rpcwork`, per-task dirs) | — |
| 5 | Ledger lag / noise | resolved items re-raised for days | partial (reconciliation + hygiene task this session) | physical closure still manual |
| 6 | `maxDuration` silent-ERROR deploys | documented prior incidents | CLAUDE.md rule (≤800s) | no pre-deploy lint |
| 7 | **Sentinel blind spots** | AllDay FMV 16h-stale but global freshness read 3 min (see Part C) | per-pipeline watchlist caught it indirectly | global metrics mask per-collection staleness; thresholds hardcoded |
| 8 | **Cron-surface fragility** | `allday-fmv-populate` stopped firing 06-26 22:42Z | watchlist alert | cron-job.org triggers drop; critical writers still depend on it |

Items 3 & 4 are already closed. This plan addresses 1, 2, 5, 7, 8 (and notes 6).

---

## Part B — Safety guardrails (the core "done right")

### B1. Bulk/cross-cutting DELETE circuit-breaker on irreplaceable tables
A statement-level `BEFORE DELETE` trigger (using a `REFERENCING OLD TABLE` transition table, PG10+) on the **irreplaceable** tables — `wallet_moments_cache`, `editions`, `fmv_snapshots`, `sales`, `pinnacle_editions`, the `*_offers` tables — that **RAISES unless the session sets `SET LOCAL rpc.allow_bulk_delete = on`**, when the delete exceeds a safe per-table signal. Caches (`cached_listings`, `*_mat`) are explicitly **excluded** — they're regenerable and legitimately bulk-purged.

**The signal is per-table, and must be measured first (this is the non-negotiable step):**
- `fmv_snapshots`, `editions`, `sales`: **row-count** threshold. Inventory shows legit deleters are scoped/chunked (fmv-recalc ≤500 edition-slices; editions never routinely deleted; sales dedup small). A threshold a bit above the legit max blocks a blind bulk delete.
- `wallet_moments_cache`: **row-count won't work** — `upsert_wallet_moments` legitimately deletes one wallet's entire set, up to ~125k rows for an institutional wallet. The right signal is **distinct `wallet_address` span**: a legit refresh touches **one** wallet; the blind-delete spanned **many**. Guard = "block a wmc delete spanning > N distinct wallets unless flagged."

**Why opt-in flag, not blanket block:** the inventory found ~14 DB functions + ~12 routes that legitimately delete from these tables in small scoped batches. A blanket block breaks fmv-recalc, the FMV upserts, `promote_unmapped_sales`, `upsert_wallet_moments`, etc. The flag lets each *intentional* deleter opt in (one line), while an *accidental/blind* delete — which never sets the flag — is stopped cold. This directly kills the 06-27 failure mode.

**Build discipline:** (1) measure each table's max legitimate single-statement delete (read-only, from pg_stat + reading each deleter); (2) set thresholds above legit max with margin; (3) ship the trigger + a tiny `rpc_delete_guard_config` table (thresholds tunable without a deploy); (4) add `SET LOCAL rpc.allow_bulk_delete=on` to the handful of legit bulk deleters; (5) verify every legit deleter still works (force-run each in a transaction). Reversible: drop the trigger.

### B2. Handoff staleness convention
Every handoff doc carries a header: `verified-live-at: <UTC ts>` + `ledger-anchor: <commit SHA or ledger line>`. An acting session must re-read `ledger.md` for anything landed *after* the anchor before touching anything — and re-measure each figure live. Encode this in the `rpc-handoff` skill (writer stamps it) and the nightly/CC reading flow (reader checks it). Kills failure mode #2.

### B3. Claim marker for in-flight destructive/data items
Extend the `.lock` idea: when a session starts actioning a specific queued item that involves a destructive or data-write step, it writes a claim (item id + session id + ts) so a concurrent session sees it's taken. Lightweight; prevents double-action.

---

## Part C — Sentinel hardening (addresses the live alert + its blind spot)

**Live alert being addressed now:** `allday-fmv-populate` (primary AllDay marketplace-FMV writer, 21-min cadence) **stopped firing 2026-06-26 22:42Z (~16h silent)**. Root cause: its cron-job.org trigger dropped (the known degradation class; allday-specific, not cron-wide). Impact: AllDay marketplace FMV ~16h stale, partially backstopped by fmv-recalc Step 5b. **Immediate fix = operator re-enable/verify the cron-job.org entry (2 min).** Durable fix below.

- **C1. Per-collection FMV freshness check.** The sentinel's global `max(computed_at)` read 3 min (fresh) while AllDay sat 16h stale — TopShot's writers masked it. Add per-collection freshness tripwires (AllDay/Pinnacle/Golazos/UFC) so a single-collection writer death pages directly, not only via the watchlist. (Cowork-doable: additive sentinel logic / a DB helper.)
- **C2. Table-driven thresholds.** All 8 sentinel thresholds are hardcoded in `app/api/sentinel/route.ts` — tuning needs a deploy. Move them to a config table (mirrors `pipeline_cadence_watchlist`). (CC.)
- **C3. Decouple critical writers off cron-job.org.** `allday-fmv-populate` is the live victim; the listing-cache crons already moved to GHA (`35fb466f`). Move the critical FMV/ingest writers to GHA or pg_cron so a cron-job.org surface drop can't silently kill them. (CC.)

---

## Part D — Data root-cause (stop accepting residuals)

- **D1. TS `wmc` UUID fossils (~1,753).** The on-chain re-resolution infra already exists: `getMintedMoment` via topshot-proxy + the `drain-topshot-misattribution` route + `remap_topshot_from_onchain_map()`. It currently re-keys `sales`+`moments`, **not** `wmc`. Gap to close: a wmc-target selector (`wmc WHERE edition_key` is UUID-form, keyed by `moment_id`) + a wmc remap leg (set `edition_key = setID:playID`, honoring the `wmc.edition_key == editions.external_id` contract). Per-row audit table; reversible. Must set `rpc.allow_bulk_delete` if it re-keys via delete. (CC — touches the canonical-merge path.)
- **D2. AllDay V1 unmapped (242).** The recover route fixes **price for only 34** (and not edition mapping). Recommendation: **classify the rest as permanent residual** (correctly held out of `sales`, no corruption) and stop flagging — not worth a cron for 34 price-only fixes. (Trevor sign-off.)

---

## Part E — Sequencing & ownership

1. **NOW — operator (you), 2 min:** re-enable/verify the `allday-fmv-populate` cron-job.org entry (the live sentinel alert). Confirm it logs an `ok=true` tick within ~25 min.
2. **Cowork (me), careful, measure-first:** (a) measure per-table legitimate delete maxima [read-only]; (b) ship the B1 delete-guard trigger + config table; (c) ship C1 per-collection FMV-freshness. All additive, reversible, verified per legit deleter.
3. **CC handoff:** D1 wmc-fossil re-resolution; C2 table-driven sentinel thresholds; C3 cron→GHA decouple for critical writers; B2 handoff-staleness in the rpc-handoff skill.
4. **Trevor decisions:** D2 AllDay residual; the Vercel on-demand cap (separate, ~early-July deadline).

## Risk discipline (non-negotiable)
Measure before designing any threshold. Force-run every legitimate deleter against the new guard before trusting it. Every data fix audit-tabled + reversible. Nothing ships without per-item verification. The guard must be *proven* not to break the legit deleters — the measurement step gates everything in Part B.
