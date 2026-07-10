# Overnight pass handoff — 2026-06-21

**Mode:** GENUINE OVERNIGHT (fired 08:03Z / 01:03 PDT, in-window). **Push available** (sandbox clone `$HOME/rpc`; `origin/main` `0ad6f6a` unchanged start→end). **Shipped 0 / reverted 0 / repaired 0 / closed 0.** Drained 5 inbox files. A quiet, honest night whose value was the independent post-ship watch over the heavy 06-20 Stage B / Phase 3 / Phase 4 CC wave + last night's ship (ALL PASS, 0 reverts) and a sharpened operator finding on the special-serials MV cron.

The lock was RELEASED at start (last night's run, 06-20T08:32Z). No FREEZE. Genuine in-window run → normal shipping eligible, but no candidate was both warranted and fully-gated low-risk this run.

---

## Why shipped 0 (correct)

Every candidate from the inbox + ledger Queued + CLAUDE.md open/pending + tonight's health triage is one of:
- **Off-limits to auto-ship** — CC-owned route logic (FMV/ingest/pricing/pack-EV/conflation program — all hot files <48h), operator cron-wiring, Trevor decisions, or destructive SQL.
- **Gate-unmet** — the one near-actionable night-pass item (the REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT watchlist row) needs one post-fix automated cron `ok` tick before it can be watchlisted (L1 rule: never watchlist a pipeline before its first fire, or `detect_stalled` false-positives immediately). That tick **cannot occur** until the operator re-enables the cron — see the sharpened finding below.

The daytime monitor's last 5 ticks (18:18Z → 06:06Z) all reported **GREEN, 0 net-new candidates**. No additive migration was warranted (health triage surfaced no new finding needing one). Manufacturing work would violate the "don't look busy" rule.

---

## Post-ship regression watch — ALL PASS, 0 reverts

The 06-20 daytime CC wave was very heavy (the Stage B / Phase 3 / Phase 4 parallel-conflation program: ~20 commits, `979d06f`→`592e725`). Re-measured every affected surface; everything is healthy ~16h after the last code commit.

- **Phase-4 conflation-leak fix (`592e725` — subedition-aware history-backfill + durable remap) HOLDING.** `topshot_conflated_editions` guard = **27 rows** (the converged Phase-4 state, NOT drifting up), safe-DELETE fix live (`refresh_topshot_conflated_editions()` `has_where=true`, independently confirmed via `pg_get_functiondef`), `remap_topshot_base_keyed_parallel_sales()` present. `topshot-sales-history-backfill` **11 ok / 0 fail / 24h**, last 05:22Z, max 274s.
- **Phase 3a circulation backfill** (`topshot-subedition-circulation-backfill`, daily Vercel cron 21:10 UTC) **3 ok / 0 fail**, last 22:05Z, max 149.5s.
- **`topshot-buyer-backfill`** **47 ok / 0 fail / 24h**, last 07:34Z, **max 608.0s** — BUYERBF-PERINVOCATION-WORK holding, under the prior 740s, well under the 800s Pro cap; no creep.
- **`allday-listing-serial-backfill`** (last night's watchlist target, on-chain serial source) **8 ok / 0 fail / 24h**, last 06:34Z, max 10.6s — the watchlist row (600m/medium) is validated and not false-positiving (silence ~1.5h ≪ 600m).
- **Spine indexers fresh:** `topshot-sales-indexer` 72/0 (08:03Z, max 28.6s), `allday-sales-indexer` 72/0 (07:56Z), `offers-sweep` 72/0 (08:02Z, max 45.7s), `topshot-offers-indexer` 72/0 (07:52Z). `fmv-recalc` **92 ok / 0 fail**, last 07:48Z, max 289s.
- **FMV de-blending working as Stage B intends.** TS HIGH+MED **4247** (HIGH 1195 + MED 3052) — up from the 3332 night-pass baseline (06-20) and tracking the all-day improvement path (3332→4159→4227→4231→4098→4242→4247). AllDay HIGH+MED **874**. FMV reconciles **EXACTLY** to editions (TS sum 16,933 = 16,933; AllDay 6,191 = 6,191; 0 orphan/double-count). `fmv_sanity_flags` 0.

---

## Health-drift triage — GREEN

| Check | Result |
|---|---|
| RLS-off base tables | `[]` |
| anon/auth write on RLS-off base (relkind r/p) | `[]` (the 58-view result is the documented false-positive — needs the `relkind IN ('r','p')` filter) |
| `check_public_security_invariants()` | `[]` |
| `check_secdef_anon_execute_violations()` | `[]` |
| `detect_stalled_pipelines()` | `[]` |
| `get_pipeline_alerts()` | 1 INFO only (`golazos_sales` resolving_editions, 1/24h — long-standing, not a finding) |
| `v_rpc_trust_health` | **9/9 ok** (edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap $0/50, pack_ev_board_stale 1.43d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30, ts_uuid_dupes_24h 22/200, unmapped_resolution_backlog 22/100) |
| sentinel TS-UUID-keyed 48h | 22 (< warn 250; the known inert DQ4 dupe-writer leak / TS-WMC-UUID-FOSSILS — editions net-grew only by `::` parallels) |
| pipeline_runs fails 24h | 10, all transient/known: `evm-transfers-ingest` ×7 (Base 429 — benign STEER, don't chase), `alerts-dispatch` ×1 @01:29Z (deal stmt-timeout, isolated 1/96 at 1 sub), `analytics-smoke` ×1 @17:13Z (recovered), `refresh-conflated-editions` ×1 @15:17Z (pre-safe-DELETE-fix, cron not fired since) |
| Sentry | **1 unresolved** — `JAVASCRIPT-NEXTJS-A` (smoke-test transient, `POST /api/smoke-test`), 1 event 11h ago (~21:11Z), Seer super_low — the same recurring smoke false-alarm the monitor logged the last 4 ticks; FMV independently verified fresh; 0 new. Resolve after 24h quiet (currently 11h). |
| Vercel | prod **`592e725` READY**, **0 ERROR** (20 recent all READY/CANCELED; CANCELED = docs/monitor-inbox commits + superseded in-flight Phase-3 diagnostic commits) |
| Artifacts | estate **16, none RETIRED**; monitor validated all backing objects return rows at 06:06Z (2h ago) with no schema break from the Stage B / Phase 3 add-column migrations; none flagged broken → none repaired |

### Overnight deltas vs metrics-latest.json (06-20 night baseline)
- FMV TS HIGH+MED **3332 → 4247** (Stage B de-blending repricing the `::` parallels + LOW→MED escalation); AllDay **852 → 874**. Both improving.
- editions TS **15,543 → 16,933** (+1,390 `::` parallels cataloged by Stage B); AllDay 6,191 / Golazos 581 / UFC 446 flat.
- DB **4,899 → 5,023 MB** (+124 over ~1.5d — benign creep).
- sentinel TS-UUID-48h 0 → **22** (both ≪ warn 250; daily churn of the inert DQ4 leak, not a regression).
- open `unmapped_sales` 46 → **59** (56 AllDay incl. 34 `v1_tx_decode_budget_exhausted` fossils + 3 Golazos) — the known ALLDAY-V1-UNMAPPED-DRIFT accrual; held OUT of `sales`, no integrity risk (trust backlog 22/100).

---

## Sharpened finding (carried, operator) — REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT cron is NOT firing (likely disabled, not just gate-unmet)

**Refinement vs last night's framing.** The fix is fully deployed and the math now works: CC shipped `3613a94` (route `maxDuration` 120→240) + `audit_20260620_special_serial_owners_mv_refresh_timeout_200s` (fn `statement_timeout` 180→200s), prod READY ~21:01Z 06-20. The CONCURRENTLY refresh measured ~135–160s last night → comfortably inside fn 200s < route 240s. So once it fires it *should* log `ok=true`.

**But it is not firing at all.** `refresh-special-serial-owners-mv` has logged **exactly 2 runs ever** — `2026-06-20 00:32Z` and `02:16Z`, both `ok=false` (`canceling statement due to statement timeout` at ~30s, the OLD 30s fn-timeout). **Zero runs since 02:16Z** (~30h), including zero since the fix deployed. At the ~1.75h spacing of those two runs, a live cron would have produced ~15 runs by now. The pattern (two runs, then silence starting exactly when the failures were noticed and the timeout dial-in began) strongly implies the **cron-job.org entry was paused/disabled around 02:16–04:38Z 06-20 to stop the failing runs, and never re-enabled after the fix shipped.** The pipeline is also NOT on `pipeline_cadence_watchlist`, so its silence is invisible to `detect_stalled`.

**Blast radius LOW.** The MV (`topshot_special_serial_owners_mv`, 6,774 rows) was last refreshed 06-20 22:11Z (via CC's MCP refresh after Phase 3a), so the `/special-serial-owners` board is ~10h stale on a "latest-seen"-captioned holder snapshot — acceptable. I deliberately did **not** manually refresh it tonight (a manual refresh masks the disabled-cron signal and creates a night-pass dependency; ~10h staleness on a low-blast board doesn't warrant the ~150s DB IO + buyer-backfill contention risk).

**Operator action:** re-enable / verify the cron-job.org entry that hits `POST /api/cron/refresh-special-serial-owners-mv` (Bearer `INGEST_SECRET_TOKEN`). Confirm the first post-fix automated run logs `ok=true` (it should — refresh ~150s < route 240s). **Then** the night pass adds a generous `pipeline_cadence_watchlist` row (low cadence — the board captions latest-seen, so a modest threshold is fine). Revert of the live 04:38Z fix, if ever needed: `ALTER FUNCTION public.refresh_topshot_special_serial_owners_mv() SET statement_timeout='30s';` (leave it — correct, just was insufficient alone before `3613a94`).

---

## Queued — carried forward (unchanged, all off-limits / operator / CC / Trevor)

- **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT** (night-count 3) — sharpened above: fix deployed + sufficient; cron appears disabled since 02:16Z 06-20; **operator re-enables → night pass watchlists after first ok tick.**
- **refresh-conflated-editions cron — operator residual.** Safe-DELETE fix live (`20260620213921`, `has_where=true`); the daily cron-job.org entry is still not wired (only route fire ever was the 15:17Z pre-fix failure). CLAUDE.md already lists "wire the daily refresh-conflated-editions cron" as an operator item; watchlist it only after the cron exists + one ok run. Guard sits at the converged 27 meanwhile (forward-keying + route-wired remap converge it).
- **BUYERBF-PERINVOCATION-WORK** (CC route + operator cron) — max 608s, holding, no creep.
- **ALLDAY-V1-UNMAPPED-DRIFT** (operator/CC) — 59 open (34 budget-exhausted fossils); held out of `sales`, no integrity risk.
- **UFC-EDITIONS-SEED-GAP** (CC/operator seed-ingest), **TS-WMC-UUID-FOSSILS** (CC canonical-merge), **N1 snapshot-institutional-wallets** (operator cron), **BADGE-CATALOG-CRONJOB-DUP** (operator — delete a cron-job.org entry), **VERCEL cost family** (Trevor), **A1-WORKER-PASSTHROUGH-CLEANUP** (Trevor/wrangler), **get_user_top_owned_moments 3-arg orphan** (Trevor/CC destructive), **PIN-FMV-REKEY-WAVES 2/3**, **PIN-SYNC-CRON**, **P3-BUYERS**, **DUPE1**, **Q2/Q5/Q6**, **ANALYTICS-SMOKE-RESIDUAL**, **IPFS ×2**.

**STEER honored (do not re-flag):** SERIAL-FMV-MULT-CRON is BY DESIGN (weekly pg_cron jobs 5+6, Sun 11:00 UTC — next refresh today 06-21); evm-429 is benign, not chased.

---

## Failed / blocked / reverted

None. Nothing shipped, nothing reverted, no artifact repairs needed, no hard-stop.
