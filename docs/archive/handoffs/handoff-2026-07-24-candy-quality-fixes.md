# Handoff — Candy quality-audit fixes (REVISED — perf is now the headline)

**Date:** 2026-07-24 (revised after round-2 deep audit) · **Author:** Cowork · **For:** Claude Code (Trevor's machine)

**Supersedes the earlier version of this file.** During the audit the surface was actively being iterated (the round-1 troll-floor fix landed live mid-audit — good, but it introduced the perf regression that is now Item 1). All evidence is live from Supabase `bxcqstmqfzmuolpuynti`, 2026-07-24 (203 listings, 127 sales, 81/125 FMV-priced).

## Item 1 — HIGH (go-live perf blocker): the FMV-heavy Candy boards do full-warehouse FMV scans

**Symptom.** Four boards compute "latest FMV per edition" from the **global** `fmv_current` view, which is `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id, computed_at DESC` — **no collection filter**, so it materializes the entire `fmv_snapshots_2026` partition (~896,700 rows) every time. EXPLAIN `SELECT *` costs:

| Board | Cost | Notes |
|---|---|---|
| `candy_secondary_board` (Market tab) | **163,303** | scans global FMV **2×** (own `fmv_current` + via `candy_listing_floor`) |
| `candy_offer_spread_board` | **163,199** | scans global FMV **3×** |
| `candy_special_serials_board` | 71,058 | + a 16k-cost full-wmc InitPlan for the treasury wallet |
| `candy_deals_board` | 54,324 | `l.price_usd < fc.fmv_usd` forces full `fmv_current` materialization |

**Observed:** `candy_special_serials_board` and `candy_deals_board` **timed out (>60s)** during the audit. The Market-tab query *returned* when the FMV partition was warm — so it's **contention-sensitive**, not a hard failure: warm it's several seconds, cold or under IOPS pressure (the candy + all-collection pipelines run constantly) it exceeds 60s. Either way, cost 54k–163k **blows the public route budget** (anon 3s / service 30s) — on go-live these tabs would intermittently render the empty/"plausible-empty" state that no health check catches ([[rpc-read-path-timeout-budget]], [[rpc-iops-throttle-2026-07]]).

**Root cause + why it regressed.** The round-1 troll-floor fix added `fmv_current` joins **inside** `candy_listing_floor` (its `tier_median` CTE and `scored` CTE), and `candy_secondary_board`/`candy_offer_spread_board` join both `candy_listing_floor` **and** `fmv_current` — so the full 896k scan now happens 2–3× per render. The other candy views (`candy_scarcity_board`, `candy_holder_board`, `candy_player_board`) scope FMV to candy and are instant.

**Fix.** Introduce a **candy-scoped** latest-FMV and repoint everything to it:

```sql
CREATE VIEW candy_fmv_current WITH (security_invoker = on) AS
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd, confidence, computed_at
  FROM fmv_snapshots
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ORDER BY edition_id, computed_at DESC;
```

Then replace **every** `fmv_current` reference in the candy views (`candy_secondary_board`, `candy_offer_spread_board`, `candy_deals_board`, `candy_special_serials_board`, and both CTEs of `candy_listing_floor`) with `candy_fmv_current`. This scans only candy's ~few-thousand FMV rows instead of 896k. Output is identical (candy editions only have candy FMV rows) — it's purely a scan-scoping change. Grant/RLS: `candy_fmv_current` is anon/authenticated-REVOKE, service_role only, like the other candy views (and it'll pass the now-hardened `check_public_security_invariants`).

**Also (special-serials):** it recomputes the treasury wallet via a 16k-cost full-`wmc` InitPlan each render — reference `candy_treasury_wallet` (already a view) or scope it.

**Verify:** after the change, `EXPLAIN SELECT * FROM candy_secondary_board` (and the other three) should drop from 5-/6-figure cost to a few hundred, and each board should return in <1s cold. **Revert:** restore the prior view defs; `DROP VIEW candy_fmv_current`.

## Item 2 — RESOLVED (do not redo): troll-floor guard

CC shipped it during the audit. `candy_listing_floor` now excludes asks above `10 × max(fmv, tier_median_fmv)`; verified live: **0 editions with floor >10× FMV** (was 4), 17 troll listings excluded, Market/spread floors clean (Andy Pages floor now NULL/excluded, Murakami floor $22 not $19,740). Correctness is good — **but its implementation is the source of Item 1's regression, so fold the scoped-FMV fix into it.**

## Item 3 — LOW: `spread_pct` still noisy

Even with clean floors, `candy_offer_spread_board.spread_pct` still reaches **13,410%** because bids are lowball ($0.22 best offers). The spread number is dominated by the bid side, so it reads as noise. Consider capping/flagging `spread_pct`, or only surfacing it when the best bid is within a sane band of FMV.

## Item 4 — COSMETIC: `fmv_usd` renders to 4 decimals ($3.2500) on the deals/spread boards vs 2 elsewhere. Round to 2.

## Verified CLEAN (no action)

- **Integrity:** editions 125 / wmc 25,375 / sales 127 — 0 orphans, 0 impossible serials, **0 double-owned serials**, 0 wash, 0 dup tx.
- **Listings resolution:** 203/203 matched, 0 expired-active.
- **Player board:** rollup exact — 100 players, 125 editions, 25 rainbow, 25,375 supply, 0 bad rows (Rainbow-colour rollup correct).
- **Holder board:** treasury correctly excluded (0 treasury rows), valued via FMV (not troll-polluted asks).
- **Pack-EV:** live and self-updating (common_priced 44→78 as sales grew; Actual EV $86→$72 as the priced-subset bias shrinks). Disclosure intact.
- **Offers:** 0 expired-but-active. **Deals logic:** sound (14 legit deals, trolls correctly excluded).

## Guardrails

Direct to `main`, no branches. PowerShell `git`, re-verify push (`git rev-list --count origin/main..HEAD` = 0). New view = `security_invoker=on` + REVOKE anon/authenticated + `has_table_privilege` check. `npx tsc --noEmit` clean + Vercel READY. Log to `docs/overnight/ledger.md` with revert. **Claude Code's file inspection wins — the view defs are being actively iterated; re-read current defs before editing.**

## End state

One scoped `candy_fmv_current` powers every Candy board; all four FMV-heavy tabs drop to sub-second and sub-budget; troll floors stay clean; `spread_pct` tamed; cosmetics tidied. Then the boards are genuinely public-route-ready and the only thing left is Trevor's go-live flip.
