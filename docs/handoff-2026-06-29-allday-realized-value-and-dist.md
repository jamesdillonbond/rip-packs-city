# Handoff / ledger — AllDay realized pull value + per-dist attribution shipped (2026-06-29, Cowork)

Builds directly on CC's AllDay pack-open ingestion (`cd0c71a`: `pack_rips` + `allday_pack_pull` + `v_allday_pack_lifecycle`). This session filled the two pieces CC deferred — realized pull value, and per-dist attribution — both live + draining autonomously. All DB-side via MCP; this doc is the coordination record (revert paths below). **New crons are intentional** — night pass/monitor please treat as such.

## 1. Realized pull value (DONE, self-draining) — the reality-check AllDay never had

`allday_pack_pull.moment_nft_id → editionID` is NOT in any DB table (only 15/150 via wmc; `moments`/`sales` = 0), because the open tx just transfers a pre-minted moment. Resolved it **on-chain**: edge fn **`resolve-allday-pull-editions`** runs the CLAUDE.md-verified `borrowMomentNFT` script on the opener's `&AllDay.Collection` via Flow REST `/v1/scripts` (reachable from Supabase egress) → editionID → `editions.id` + FMV → fills `allday_pack_pull.edition_id/fmv_usd`. Verified: moment 9781818 → edition 4341 (matches wmc). SECDEF **`rollup_allday_rip_pull_value()`** sums valued pulls → `pack_rips.pull_value_usd` (only when every pull in a pack is valued, so totals aren't partial).
- **Live now:** `v_allday_pack_lifecycle_global` → 45 valued packs, **$1,475.51 realized, $32.79 avg/pack** (Trevor's single-common pack = $0.75, verified). Flows into CC's `v_allday_pack_lifecycle.realized_pull_value_usd` per dist automatically.
- **Crons:** `rpc-allday-resolve-pull-editions` (`9,39 * * * *`) + `rpc-allday-rollup-rip-value` (`14,44 * * * *`).
- **Coverage ~99% (UPDATE, supersedes the earlier ~54% cap).** Edge fn v3 borrows each pull at its **open block** (`pack_rips.block_height` via `get_allday_unresolved_pulls`), not the current block — the moment is always in the opener's collection right after the open, so this recovers moments the opener has since moved (verified: moment 4203516 @ block 156367718 → ed 1309, though moved since). Now **127/128 packs valued / $1,760 realized / $13.86 avg** (the avg fell from the held-subset-biased $32.79 to a representative figure). Only limit left: opens older than Flow's execution-state window (none currently; would stay NULL).

## 2. Per-dist attribution (machinery live, grinding) — pool-overlap is ambiguous for AllDay

Confirmed pool-overlap can't attribute AllDay dists (26/28 multi-moment packs match >5 dist pools — the weekly pools overlap too heavily). So per-dist depletion needs the authoritative `PackNFT.Mint{id,distId}` map (verified: pack 91259467786314 → dist 180). Edge fn **`resolve-allday-pack-dist`** is **targeted** — only resolves opened packs (`pack_rips`, dist NULL), scans `PackNFT.Mint` over the mint era (floor 148.9M) recent-first, writes `pack_rips.dist_id` directly, idles at floor (re-arm via `allday_mint_scan_state.next_height`). Cron `rpc-allday-resolve-pack-dist` (`*/2`, budget 150 ≈ 37.5k blocks/tick) sweeps ~6.8M blocks in ~6h; cost-flat (free Flow REST + cron). As dists resolve, `v_allday_pack_lifecycle.packs_opened` + `opened_pct_of_minted` (depletion) populate **with no view change** (CC's view already reads `pack_rips.dist_id`). **Known limit:** packs minted before block 148.9M stay dist-NULL (honest); lower the floor to chase them if needed.

## 3. Surfacing
CC's `v_allday_pack_lifecycle` (per-dist: opened, depletion, realized EV) + new `v_allday_pack_lifecycle_global` (aggregate) are both `security_invoker` + anon-SELECT. Per-dist depletion/realized-EV are **not yet wired to any route** (gated on dist attribution filling) — when ready, surface on the packs page / a `/insights/pack-reality` AllDay cut. Security invariants 0 throughout.

## Revert reference
```
SELECT cron.unschedule('rpc-allday-resolve-pull-editions');
SELECT cron.unschedule('rpc-allday-rollup-rip-value')