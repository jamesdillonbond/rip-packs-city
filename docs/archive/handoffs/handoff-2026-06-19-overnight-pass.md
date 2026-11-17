# Overnight pass — 2026-06-19 (GENUINE OVERNIGHT, 01:02 PDT)

**Mode:** genuine overnight (fired 08:02Z / 01:02 PDT, in-window). **Push available.** Clone to `$HOME/rpcwork` (NOT `/tmp/rpc` — `/tmp` squashes new files to uid `nobody`, blocking git writes). origin/main `48daa6c` at start.

**Verdict:** shipped **0** / reverted **0** / repaired **0** / closed **5**. First night pass since 06-17 (none ran 06-18 — Trevor ran daytime/evening Claude Code all of 06-18 instead). Drained the full 12-file inbox backlog. A quiet, honest night whose value was the independent post-ship regression watch over the dense 06-18 CC/Trevor wave + the 06-19 04:40Z buyer-backfill ship (all PASS, 0 reverts), full health verification (GREEN), and reconciling 5 carried items to closed.

No candidate was both warranted and a fully-gated low-risk production change. Every inbox item is shipped / resolved / by-design / CC-owned route logic; every open ledger item is off-limits (CC route logic / operator / destructive / Trevor decision).

---

## Post-ship regression watch — ALL PASS, 0 reverts

Re-measured every ship from the last ~24–48h (the 06-18 CC/Trevor audit-followups + next-batch + profile + alerts wave, plus the 06-19 buyer-backfill ship) against the metric each was meant to move.

- **`7a70a31` buyer-backfill BATCH 150→100 + maxDuration 600→800 (Trevor, ~04:40Z 06-19) — PASS, NOT a regression; CC residual + a new overlap finding.** This IS the queued BUYERBF-150 lever (maxDuration→800, the Pro hard cap) plus a batch cut. All 16 recent `topshot-buyer-backfill` runs **ok=true and logging**; post-deploy durations 581–710s, **max 710.5s (05:44Z), ~90s under the 800s cap**, none >770s, `detect_stalled` `[]`. The engine drains and logs — no invisible >cap death. The batch cut did NOT bound runtime (the monitor's reframe stands).
  - **NEW independent finding (richer than the monitor's "drain fills the budget"):** since ~05:14Z the cron fires ~4×/hr in two pairs ~10 min apart (:14/:24, :44/:54), and with ~600–710s runtimes the runs **overlap** (e.g. 07:44 start +644s ends 07:54:49, while 07:54:05 already started; 07:14 +673s overlaps 07:24 start). Two buyer-backfill lambdas running concurrently self-contend (concurrent on-chain decodes + DB writes) — the concrete cause of the post-deploy duration rise. Idempotent UPDATE keyed by sale, so overlap is wasteful-not-corrupting, but it eats the new headroom. Almost certainly Trevor's cron-cadence tuning correlated with the 04:40Z ship.
  - **Action: QUEUE → BUYERBF-PERINVOCATION-WORK (CC route + operator cron).** Not night-pass-shippable (CC-owned route, hot file committed ~3.5h ago, 800 = Pro hard cap so maxDuration can't go higher). Levers: (a) stop the overlapping cadence (one buyer-backfill at a time), and/or (b) cap rows-per-invocation so one run can't approach 800s. **Watch:** any run >770s, any run that stops logging, or a `detect_stalled` flag on `topshot-buyer-backfill`.
- **AllDay deal native buy-link — `64d4448` (+migration `audit_20260618_deal_board_allday_floor_nft_id`) + format.ts + `3b5837d`/`7a70a31` plural `/moments/` fix — PASS.** `cross_collection_deals_board` AllDay leg: **164/164** rows carry `low_ask_nft_id` (the buy link resolves). Board total 798 (TS 611 / AllDay 164 / Pinnacle 23).
- **AllDay floor-ask carry — `audit_20260618_allday_floor_ask_carry_listing_ids` — PASS.** `allday_edition_floor_ask` 3905 rows (DISTINCT ON carrying `floor_listing_resource_id`/`floor_flow_id`).
- **AllDay deal-board leg + §A scale path — `dd7e2bf` (+migrations `audit_20260618_allday_deal_board_leg` + `..._dispatch_due_deal_alerts_timeout_90s`) — PASS.** AllDay leg 164 rows; `alerts-dispatch` 96 runs/24h (1 fail = the documented 13:29Z 06-18 contention timeout, recovered), well under the 90s statement_timeout.
- **Profile owner-scoping + dedup — `4b9ed33` routes + `412bd08` proxy carve-out + `2327cb6` palette + `80100c1` dedup — PASS.** Security **0/0/0/0** — the GET/HEAD anon carve-out for `/api/profile/{collection-breakdown,top-movers,tier-breakdown}` opened no DB hole (`check_public_security_invariants` [], `check_secdef_anon_execute_violations` []); cost-basis-summary stays auth-gated. Prod READY, 0 Sentry attributable.
- **Pinnacle mojibake trigger — `audit_20260618_normalize_pinnacle_edition_de_double_encode` — PASS.** Board-wide double-encoded count **0** across set_name/character_name/franchise.
- **Alerts go-live (1 active subscription, Trevor 06-18) — PASS, healthy.** `alerts-dispatch` 96/24h + `alerts-send` 144/24h/0 fails, last 08:04Z. Materializing the deal boards each tick at 1 sub; do NOT flag the per-tick activity as an anomaly (focus.md).
- **`b86caaf` AllDay floor-listing serial recovery (Item 2) — edge fn live, cron NOT wired.** `allday-listing-serial-backfill` 0 runs/24h. Edge fn `backfill-allday-listing-serials` v1 deployed; `allday_moment_serials` seeded; deal-board AllDay leg correctly shows `low_ask_serial` NULL (documented Item-2-pending). NOT a regression — the buy LINK (Item 1) works; only the per-serial tag is pending the cron. **Action: QUEUE → ALLDAY-SERIAL-BACKFILL-CRON (operator).**

---

## Health-drift triage — GREEN

- **Security 0/0/0/0** — RLS-off base tables `[]`; anon/auth write-grants on RLS-off base tables `[]` (with `relkind IN ('r','p')` — the un-filtered query false-positives on 58 views, the documented footgun); `check_public_security_invariants()` empty; `check_secdef_anon_execute_violations()` `[]`.
- **`detect_stalled_pipelines()` `[]` · `get_pipeline_alerts()` `[]`.**
- **`v_rpc_trust_health` 9/9 ok** — edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap 0/50, pack_ev_board_stale 1.45d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30, ts_uuid_dupes_24h 0/200, unmapped_resolution_backlog 9/100.
- **Sentinel** TS-UUID-keyed-editions-48h = **0**.
- **pipeline_runs** 24h **9027 / 12 fails (0.13%)**, 6h 1928/2 — all transient/known: evm-transfers-ingest ×7 (Base 429, benign external rate-limit, focus.md don't-chase) + the 06-18 13:15–13:29Z micro-contention cluster (alerts-dispatch/check-alerts/wmc-fmv-populate, recovered) + lock-check-batch 18:08Z + offers-sweep 23:02Z GQL. No fail in the recent window except evm-429.
- **FMV reconciles EXACTLY to editions.** TS `fmv_current` total 15,543 = 15,543 editions; AllDay 6,191 = 6,191. TS **HIGH+MED 3,144** (HIGH 876 / MED 2268), ASK_ONLY 2622 (stable, not over-claiming), NO_DATA 3468 (improving from the 3697 06-17 baseline). AllDay HIGH+MED 844. Recovered from the 2,848 06-17 overnight trough → benign daily cycle (FMV-HIGHMED-DIP-WATCH closeable). Writers fresh: fmv-recalc last ok 07:48Z (0 fails/24h), TS snapshot 07:48Z.
- **editions flat** — TS 15,543 / AllDay 6,191 / Golazos 581 / UFC 446.
- **DB 4843 MB** (+105 over 2 days vs the 06-17 4738 baseline — benign creep; monitor 06:05Z read 4840).
- **unmapped_sales** 45 open (vs 43 baseline; all AllDay `v1_tx_decode_budget_exhausted` fossils — ALLDAY-V1-UNMAPPED-DRIFT).
- **Sentry** 0 new/24h; 1 unresolved (JAVASCRIPT-NEXTJS-A "fmv pipeline healthy" smoke, 1 event ~05:00Z, super_low) — FMV independently verified healthy → smoke false alarm; leave unresolved (<24h quiet).
- **Vercel** prod `b86caaf` READY; 20 recent all READY/CANCELED, **0 ERROR** (CANCELED = superseded docs/monitor rapid-pushes; the two newest commits 660b027/48daa6c are docs-only → CANCELED, expected).
- **Artifacts** 14 active enumerated (5 RETIRED tombstones correctly absent from manifest). Backing objects all return rows: deals_board 798, allday_floor_ask 3905, serial_premiums 276, perfect_mint 9, trophies 683, squeeze 9102, cohort_mat 158 (fresh), offer_sanity 228, tracked_fmv 21 (AF1 v3 fast), top_sales 583, underpriced 15. None broken; none repaired.

---

## Closed this run (5)

1. **FMV-HIGHMED-DIP-WATCH — CLOSED.** Benign daily cycle confirmed: TS HIGH+MED recovered 2848 (06-17 trough) → 3144, ASK_ONLY 2622 stable (not over-claiming), NO_DATA improved 3697→3468, FMV reconciles EXACTLY to 15,543 editions (0 orphan/double-count), writers fresh, fmv_sanity 0.
2. **SERIAL-FMV-MULT-CRON — CLOSED (BY DESIGN).** Independently verified `cron.job` 5 (`rpc-serial-fmv-multipliers-weekly`) + 6 (`rpc-serial-fmv-power-model-weekly`) both `active`, schedule `0 11 * * 0` (Sun 11:00 UTC). `serial_fmv_multipliers` ≤7d staleness is expected, not a missing cron. Next refresh Sun 06-21. Do NOT re-queue as escalating-cron-silent.
3. **ALERTS-DISPATCH-DEAL-TIMEOUT — CLOSED.** Zero-sub early-exit + §A 45→90s statement_timeout / maxDuration 60→120 both live (`dd7e2bf`). `get_pipeline_alerts()` []; 0 deal-leg timeouts in the recent window. Alerts live with 1 sub running clean (dispatch 96/24h avg well under 90s).
4. **AUDIT-FOLLOWUPS-UNPUSHED — CLOSED.** The 06-18 Items 1 (BATCH 200→150) + 4 (staleness caption) landed in `d5f5f40` and deployed; since superseded by `7a70a31` (BATCH 100 / maxDur 800). All four audit-followup items live.
5. **BUYERBF-150 / BUYERBF-DURATION-CREEP / BUYERBF-150-INSUFFICIENT-HEADROOM — CLOSED (lever shipped by Trevor).** The recommended maxDuration 600→800 lever is live (`7a70a31`). Stop re-recommending it. The remaining concern (runtime not bounded; new overlap) carries forward as the NEW item BUYERBF-PERINVOCATION-WORK.

---

## Queued this run

### NEW

- **BUYERBF-PERINVOCATION-WORK · [MED · CC route + operator cron] — buyer-backfill runs now fill the 800s budget (max 710s) and OVERLAP at the new ~4/hr cadence.** Since the `7a70a31` ship (~04:40Z), `topshot-buyer-backfill` fires ~4×/hr in pairs ~10 min apart (:14/:24, :44/:54); with ~600–710s runtimes the runs overlap (two concurrent lambdas), which self-contends and is the concrete cause of the post-deploy duration rise. All runs ok=true + logging + `detect_stalled` []; max 710.5s leaves ~90s under the 800s Pro hard cap (maxDuration CANNOT go higher → CLAUDE.md: >800 silently ERRORs the deploy). NOT night-pass-shippable (CC-owned route, hot file committed ~3.5h ago). Levers: (a) **operator** — stop the overlapping cadence (single buyer-backfill at a time / widen the interval past run duration); (b) **CC route** — cap rows-per-invocation so one run can't approach 800s. Watch: any run >770s, any run that stops logging, or a `detect_stalled` flag on `topshot-buyer-backfill` = the invisible >cap-death class.
- **ALLDAY-SERIAL-BACKFILL-CRON · [LOW · operator] — wire the `allday-listing-serial-backfill` cron.** `b86caaf` deployed the `backfill-allday-listing-serials` edge fn (v1) but no cron-job.org entry fires it (0 runs/24h). The deal-board AllDay leg shows `low_ask_serial` NULL until it runs (the buy LINK already works — Item 1). Operator: add a low-cadence cron-job.org entry hitting the route (Bearer `INGEST_SECRET_TOKEN`), then (after ≥1 logged run) a generous `pipeline_cadence_watchlist` row. Same cron-not-wired class as PIN-SYNC-CRON / SERIAL-FMV (pre-pg_cron). NOT night-pass-shippable (external cron creation = operator).

### Carried (off-limits to the night pass — all unchanged this run)

- **UFC-EDITIONS-SEED-GAP** (CC/operator) — 72 UFC editions held by wallets but absent from the editions catalog; seed/ingest off-limits.
- **TS-WMC-UUID-FOSSILS** (CC) — ~1,683 wmc rows keyed to merged/deleted UUID editions; stable, canonical-merge.
- **OFFER-SANITY-VIEW-REFINEMENT** (optional/CC) — `v_offer_sanity_flags` is now 100% sub-serial; optional `WHERE NOT has_sub_serial`. Edition-grain already covered by the trust leg (offer_edition_gap 0/50). Modifies a live view an artifact reads → not shipped autonomously.
- **ALLDAY-V1-UNMAPPED-DRIFT** (operator/CC) — 45 open unmapped, all AllDay `v1_tx_decode_budget_exhausted` fossils; `recover-v1-budget-exhausted` cron still 0.
- **N1 snapshot-institutional-wallets** (operator) — last ok 06-18 10:07Z (~22h, not currently stalled, detect_stalled []); intermittent external-cron drop. Move its slot off the rush / re-confirm the entry.
- **VERCEL cost family** (Trevor) · **A1-WORKER-PASSTHROUGH-CLEANUP** (Trevor/wrangler) · **get_user_top_owned_moments 3-arg orphan** (Trevor/CC, destructive) · **PIN-FMV-REKEY-WAVES 2/3** · **PIN-SYNC-CRON** · **P3-BUYERS** · **DUPE1** · **Q2/Q5/Q6** · **ANALYTICS-SMOKE-RESIDUAL** (optional) · **IPFS ×2**.

---

## Failed / blocked / reverted

None. No verification failure, no auto-revert, no production shipping (so the hard-stop rule was never triggered). Git push available throughout.
