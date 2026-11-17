# Overnight pass — 2026-11-09 (~01:05–01:20 AM PT, Cowork cloud)

> ⚠ **Environment scope:** this pass ran in a **Cowork cloud** session linked to Trevor's laptop. Push IS available (VM route + `.rpc-git-cred`; dry-run exit 0). There was **no `add_repo` tool**, so the cloud clone cannot push directly; all git writes went through the laptop-VM clone. This is a fact about this session, not the artifacts — **on Trevor's machine Claude Code commits/pushes normally via Git Credential Manager.**

**FIRST LINE (3+ nights routed):** #228 cold-whale `/api/collection-snapshot` SQL levers — **P3, Claude Code (in progress), 5 nights.** Still fires 4× in the last 24h (RPC_READ_TIMEOUT, read exceeded 20000ms, last 07:15Z). The ready-queue ✓ points at `ledger.md:265`, but that ship was a *feature* add (#237's empty-wallet-indexed flag), **not** the cold-whale timeout cut — so the close does not apply; the item stays open.

## Verdict

**GREEN · 0 shipped · idle: routed-to-claude-code · oldest routed: #228 collection-snapshot cold-whale, 5 nights.**

A genuinely quiet, healthy night. Every actionable candidate is either in **hot census files** being actively tuned by other sessions (off-limits to edit), a **code/query cut** that needs the handoff path (#242), or a **trust-gate decision** that is premature while the census is still expanding. Nothing was clearly-safe-and-net-positive to ship autonomously, so nothing was shipped. Clock verified against DB (shell 09:02:53Z / DB `now()` 09:03:11Z, no skew). Not frozen. Lock was cleanly RELEASED by the prior pass (`rpc-context-hygiene`, 18:49Z); taken for this run, released at the end.

## Health sweep (all independent instruments)

- **Security:** `rpc_ops_snapshot()` invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
  - ⚠ A **security smoke-test HARD FAILURE fired once at 02:20Z** (`rls_off_base_table:_scratch_golazos_official_before_20261108`). **Verified RESOLVED:** that scratch table **no longer exists** in `pg_class` (dropped between 02:20Z and now), and the live invariant check is clean. Transient window during 11-08 golazos work, already cleaned up. No action.
- **Pipelines:** `detect_stalled_pipelines()` `[]`. `pipeline_fails_24h` is the known Atlas/Cloudflare-challenge lane noise (all `upstream 0`: pack-mint-probes 62, topshot-pack-supply-atlas 30, atlas-pack-market 13, etc.) plus the two tracked census/rip-metadata timeouts below. `pipeline_alerts` = candy-census failure_rate (filed, see Q1) + 4 Atlas upstream-403/404 **info** rows with unmet escalation conditions (last-200 all current). Not findings.
- **Trust health:** 3 breaches, all known-shape, none new in kind:
  - `edition_integrity_flags` **20,627** (breach_at 250) — see Q3. Census-driven, fail-safe.
  - `candy_sales_stale_hours` 666h & `candy_ask_book_drop_pct` 86.2% — the Candy-closure cluster (dispositioned 11-08T2205Z). Unchanged.
  - `trust_precompute_max_age_hours` 5.27 (ok) — confirms the breaches are real, not a refresher artifact.
- **Sentry:** dark (SDK removed #34). **client_error beacon: 1 in 24h** (no spike).
- **Vercel 24h runtime:** 32 groups, ALL the chronic read-exceeded / statement-timeout / degrade-to-empty class (profile top-moments/hero-moment/top-movers, wallet-summary, panini_deal_board, market-pulse, set/player activity, collection-snapshot). Counts 1–20, first-seen Jul–Oct. **No new crash group, nothing spiking.** These are query-cost issues that need the handoff/tuning path, not autonomous fixes.
- **FMV accuracy gate** (`fmv_sales_backtest`, 7d) — **within band both collections:**
  - `nba_top_shot` published ALL median_ratio **1.000** (median_abs_err 14.5%, within25 69.1%); HIGH 1.000 / 12.0%.
  - `nfl_all_day` published ALL median_ratio **0.923** (HIGH 0.900, MEDIUM 0.933), median_abs_err **$0.03–0.05** — the 11-04 sub-$1 step, negligible in dollars. ≥ 0.90 → ACCEPT, consistent with 11-04→11-07. The 0.75 All Day LOW haircut (shipped 11-04) is in place.

## Post-ship watch — previous pass (11-08) ships

- **`rpc-candy-wmc-label-fill` row-budget (`20261109044329`, job runs step(60)):** HEALTHY. `check_pgcron_recent_failures()` `[]`; last 10 pg_cron runs all succeeded (11–17s, "1 row" each), converging without timeouts. The 11-08 fix holds.
- **Census scoped ghost-purge (`20261109044509`):** the ghost-purge statement-timeout fails (03:57/04:57Z) stopped after the ~04:45Z fix. The subsequent census fails are a *different* step (see Q1).
- **Census :43→:57 slot move:** did NOT clear `backfill-pack-rip-metadata` (still timing out at :53 — confirmed, see Q2). Known, #242.
- **No regression** traced to any 11-08 ship: FMV accuracy within band, security clean, latest production deploy READY (`7f02c1e`), no new Vercel crash group.

## Queued for Trevor / Claude Code

1. **[P3, Claude Code (in progress), 5 nights] #228 cold-whale `/api/collection-snapshot` SQL levers.** Still fires 4× in the last 24h (RPC_READ_TIMEOUT, exceeded 20000ms, last 07:15Z). Ledger:265's ✓ is a different ship (empty-wallet-indexed flag). Owned by Claude Code; the SQL lever is the open half.
2. **[MED, Claude Code, new] `candy-collections-census` contended on `wallet_moments_cache` (quiet-window CONFIRM, filing 2026-11-09T0708Z).** After the ghost-purge fix, the 3 post-fix runs (05:57/06:57/07:57Z) all failed on the **"2022 Leadoff ICONs"** set: 2× `wallet_moments_cache: canceling statement due to lock timeout` + 1× upstream Solana DAS `Database Error`. Pages advance (66→227), so it is **progressing, not wedged**, but it **intermittently lock-contends** with the every-4-min `rpc-candy-wmc-label-fill` writer on `wallet_moments_cache`. Confirmed in a **quiet window** (io_wait 4 / active 7 at 09:03Z — not a saturation spell), so this is not pure spell collateral. **Not autonomous:** `app/api/ingest/candy-collections-census/route.ts` and ~30 candy files were committed in the last 48h (hot). **Recommendation (Claude Code):** either cut the per-set page/row budget for that set's hydrate (same shape as the 11-08 label-fill step cut), or deconflict the census vs label-fill writes to `wallet_moments_cache` (a `lock_timeout` bump / scheduling offset so they don't collide). The DAS error is upstream transient — ignore unless it recurs across quiet windows.
3. **[MED, decision — Claude Code/Trevor, new] `edition_integrity_flags` = 20,627 (breach_at 250), census-driven (filing 2026-11-09T0105Z).** Decomposition: `candy_mlb` `canonical_missing_tier` ~6,313+ / `canonical_bad_circulation` / `canonical_missing_thumbnail`, all from the 11-08 insert-only census (candy_mlb editions 125 → 22,127). **Fail-safe, LOW blast radius** — the editions exist and Candy boards render; they carry null tier/circ/thumbnail on Candy surfaces. **Deferred, not shipped,** because (a) the census is **still expanding** (editions climbing each hour), so the flag count is a moving target and a gate edit now is premature; and (b) editing the trust-integrity view wrong would **blind the gate** to the Panini-class regression it exists to catch. **Recommendation:** first settle whether the non-registry Candy collections have a tier/circulation/thumbnail source *at all* (they are obscure Solana collections — registry/Base sets got a tier, the ~6.3k non-registry wave did not). If **structurally absent** → exclude the non-registry Candy columns from `v_edition_integrity_flags` the way the onchain-id columns already are (a `security_invoker` view edit, no data change, clears the breach without hiding a real defect). If a **hydration lane exists** → confirm it is scheduled and let it drain. Do **NOT** raise the 250 threshold. Best done once the census settles.
4. **[P4, Trevor, due ~11-11] `net._http_response` growth read** — weekly. Not due yet (today 11-09).
5. **[P4, Trevor, due ~11-27] #58 OPENSEA_API_KEY / candy_mlb silence re-verify** — not due yet.

### `backfill-pack-rip-metadata` — quiet-window re-measure (filing 2026-11-09T0412Z), carried under known-issues #242

Quiet-window CONFIRM done: it **recovers under low pressure** (06:53/07:53Z succeeded, 590/319 rows) but times out otherwise (08:53Z failed) — exactly the #242 prediction. The two eligibility legs cost ~19s/call regardless of `p_limit`; needs the three-file pinned query-cost cut (Claude Code). Not autonomous. Stays under #242.

## Closed / resolved this pass

- **Panini old-catalogue backlog steer (11-04) → DRAINED.** 2,097 editions older than 7d (was 18,431 on 11-04, 8,260 on 11-06 evening); non-WC >9d = 0, WC >9d = 0; oldest `last_seen_at` 10-31. Trevor's "keep 6 runs/day while the backlog clears" condition is satisfied.
- **All Day 7d FMV ratio steer (11-04) → within band.** Published ALL 0.923 ≥ 0.90, median_abs_err $0.03–0.05. No action.
- **golazos scratch-table security smoke failure (02:20Z) → self-resolved** (table dropped; invariants clean).

## Nothing failed or was reverted.
