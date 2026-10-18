# Wallet & portfolio — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

**Wallet and collection analytics.** Paste any wallet, or sign in and have your own wallet ASSUMED (never requested, never announced; routes-and-surfaces 09-28). You then get:
- the per-collection Collection / Binder tab, priced from `wallet_moments_cache`;
- a three-state lock pill (Locked / Unlocked / Lock ?);
- each edition's own "Floor";
- pack history (see [pack-ev.md](pack-ev.md));
- owner-only cost basis, per-moment P&L and CSV export (10-11).

There is no wallet verification. It was removed by decision (#0, 08-08).

**Public share card** `/share/<wallet>`. It is built on `get_wallet_collection_snapshot` and `get_wallet_intel_summary`. It is the week's one proven acquisition path: ChatGPT → `/insights/account-value` → share card → signup (mavhill, 10-10).

**Top Shot ownership index** (`topshot_ownership`). It holds walk-confirmed holdings only (`walk_missed_at IS NULL`). It feeds Top Owners, the rookie collector leaderboard, set completers, and squeeze "Top 5 hold". Live 10-17 ~6 PM PT:
- **528,568 rows**, of which **510,262 are live**;
- the unplaced-id queue is **207,728**: 111,327 added in 24 h by the Series 8 backfill, and only 1,704 still lack a predicted set.

**Profiles and trophy case.** `/profile/[username]` and the pinned case at `/profile/[username]/trophy-case`, which is distinct from the public #1-serial room `/insights/trophies`. Achievements are computed for **2 owners (14 rows)**, and their UI is unmounted.

## Shipped recently (since mid-September)

- **09-27 #142:** every `wallet_moments_cache` read keyed on `moment_id` is scoped by collection (guarded by a tree walk).
- **10-02:** share-card RPCs read 10.9× and 10.4× fewer buffers on a whale (Rigged: 744 k → 68 k).
- **10-10:**
  - **#176:** private watchlist and alert rows are keyed by the SESSION user, never a client owner key.
  - **#179:** ownership is re-attributed from newer sales.
  - The Binder's false "Ask" and "30d low" labels were fixed.
  - Badges are no longer borrowed from the wrong edition, and 1-of-1s lost their false Perfect Mint pill.
  - A never-checked lock no longer renders as "Unlocked". Golazos and UFC lost lock UI they cannot have.
  - **#88:** PACKS UNOPENED tile.
- **10-11:** account deletion exists (`delete_user_account`); security quick wins (owner-only P&L, open redirect closed).
- **10-14:**
  - **#191** plus the Top Shot cap confirmation: a tracked wallet that sold out of a collection no longer keeps its moments forever.
  - D8: every collection's wallet-cache metadata self-heals daily.
  - The share card gained a sign-up CTA (`next=/share/<wallet>`) and an own-collection lookup; Panini pages gained a username band.
- **10-15:**
  - Holdings boards stop crediting moments the owner's walk no longer finds (17,512 rows flagged).
  - Squeeze "Top 5 hold" measures against LIVE supply.
  - Player Top Collectors says when the index does not cover all of the player's editions.
  - Panini Collection leaves out cards seen later under another owner.
- **10-15 → 10-17 (Series 9 readiness):**
  - The index covers every non-Dune set from 219 up.
  - New collectors are found hourly.
  - 7,455 never-walked Series 8-era collectors were seeded.
  - Unplaced-id hydration runs 3× faster.
- **10-17:** `compute-achievements` is in git and repaired. It had been a silent no-op since April, and destructive when targeted (a read-is-a-delete).

## Open issues

- **The funnel stops at the share card.** Week of 10-08 → 10-14: 10 wallet pastes → 10 share views → **0 sign-in clicks**, and email capture was shown 16× with 0 submits. The 10-14 CTA has not yet been measured.
- **Ownership-index coverage limits** (topshot-ownership-index.md):
  - Set 218 (Series 8 Base) is excluded on purpose.
  - Dune-era sets lag, because Constellations trade-ins burn Rares the walk does not index.
  - The backfill needs ~8 more runs before squeeze census-complete stabilises.
  - Autograph and partnered-athlete status has no DB field.
- **Mega-wallets above ~100k moments** have no id source (#138; deactivated by decision).
- **#190:** pre-2023 Top Shot pack opens are missing for 33 of 34 saved wallets (declined).
- **The parallel seeder watch.** `never_queued` was 66,001 at the 10-17 fix and must fall each ~20 h cycle. If it does not fall across two cycles, file it (focus.md).
- **#114 (partial):** live Cowork dashboards still carry the failed-read-as-empty helper.

## Next — prioritized

**Now**
1. **10-20 Series 2026-27 launch verification** (owed ~7 PM PT): index rows for new sets, candidates seeded within the hour, and the unplaced queue draining. Why: launch-day collectors are walked or invisible. Falsifier: a new-set holding missing from `topshot_ownership` 24 h after its first sale.
2. **Watch the parallel seeder `never_queued` count** across two cycles (query in focus.md 10-17).
3. **Read the share-card CTA in the 10-22 demand re-read.** Count share view → `signin_click share_cta` → account. Falsifier: still 0 clicks on ≥10 views, in which case the CTA is not the fix.

**Next**
4. ✅ **DRAINING, read 2026-10-18 9:22 AM PT (Claude Code cloud):** actionable backlog 24,208 → 6,173 in 21 h (~860/h); hydration 8–18 k written/day vs ~1 k actionable added/day since the Series 8 backfill burst (> 20× headroom); 0 failing lanes in 48 h. Open `predicted_set IS NULL`: **1,573**, all predicted (the two neighbours disagree; dispatch's `unpredicted` counts `predicted_at IS NULL`, a different thing, and reads 0). Every open row is < 2 d old. Unresolvable residue is small and off the head: 67 `unmapped` (re-sent 3–7× on the 1-day cooldown), 416 `no_nft` (30-day retry). **Proposed, not shipped:** `topshot_index_unmapped_dispatch` sorts ambiguous ids last (`(predicted_set IS NOT NULL) DESC, …`), so a launch-day flood of predicted ids could hold them back; an age escalator `(predicted_set IS NOT NULL OR first_seen_at < now() - interval '12 hours') DESC` plus an `ambiguous`/`oldest_open_first_seen` stock count would close it. Re-check on 10-20 that no open row is > 2 d old.
   - (original item) **Drain the unplaced-id queue to steady state.** Report `predicted_set IS NULL` and the age distribution, not the total, because the total grows with discovery. Gate: hydration keeps up with seeding over 48 h.
5. ✅ **GUARDED 2026-10-18 (Claude Code cloud):** `__tests__/topshot-ownership-holdings-readers-filter-walk-missed.test.ts` walks the newest definition of every function/view/MV in `supabase/migrations` (dropped ones skipped, SQL comments stripped) plus every `.from("topshot_ownership")` TS file; 10 DB + 2 TS maintenance paths are suppressed with reasons, and a planted reader without the predicate reds it. Audit the same morning: **0 unfiltered holdings readers** (18,306 of 532,092 rows flagged, 3.4 %). `get_topshot_rookie_index_coverage` is suppressed as a coverage note ("the index walked this edition"), not a holdings count.
   - (original item) **Every holdings reader filters `walk_missed_at IS NULL`.** Add a tree-walk guard so a new reader cannot forget it. Falsifier: the grep finds an unfiltered reader.

**Later**
6. **Widen achievements** to every `profile_bio` user with saved wallets: a one-line change, ~16 cheap probes per user. Only when the achievements UI is mounted or the accuracy gate is declared passed.
7. **The 2026 rookie class**, on or after 11-11, from Series 9 rookie sets. The rookie collector leaderboard is then repointed.

## Decisions on record (do not re-litigate)

- **Achievements are NOT widened** (10-17). The roadmap keeps gamification off until the gate passes. Widening would only add badges to OG share cards, which is a growth surface.
- **No wallet verification** (#0, 08-08). The signed-in reader's wallet is assumed and never asked for.
- **No mega-wallet id source now** (#138, 09-25).
- **#190 declined** (10-17): no paid indexer for pre-2023 opens.
- **Parallel `#N / M`** is the moment's own serial over its own edition's run (D25, 10-13/10-17).
- **Never delete Dune rows** in `topshot_ownership`: the Dune route sizes paid walks from them.
- **Never publish RPC's own rank as Top Shot's** Yearbook / Blue Chip / Squad Goals rank. The scoring question is with Trevor.

## Where the detail lives

- [topshot-ownership-index.md](../../reference/topshot-ownership-index.md): writers, discovery, the cost model.
- [routes-and-surfaces.md](../../reference/routes-and-surfaces.md): the assumed-wallet rule, share and profile routes.
- [chain-strategy.md](../../reference/chain-strategy.md): `lib/address.ts`; never fold a Solana key.
- [roadmap-status.md](../../reference/roadmap-status.md): the 10-15 demand read, Series 9 readiness, the 10-17 decisions.
- Register: #0, #88, #138, #142, #176, #179, #190, #191 in [known-issues.md](../../reference/known-issues.md); D8, D25 in [deep-audit-register.md](../../audits/deep-audit-register.md).
