# Wallet & portfolio — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## ⭐ 2026-11-16 — saving YOUR wallet vs following a FRIEND's

Trevor asked how collectors mix the two up, then "Do it all" (ledger 11-16 ~7:30 PM PT).

- **The trap:** the binder and the share card offered a one-click save right beside a wallet the visitor was LOOKING at — often a friend's. Saving makes it yours (binder, totals, possibly the public handle — see the owner rule above), and it was the only way to keep a friend's wallet handy: member→member `follows` had 0 rows and cannot follow a non-member. No mix-up was on record (0 wallets saved by two accounts), but nothing stopped one.
- **Now:** save buttons read "This is my collection" (binder) / "This is my wallet — save it" (share) and open "Is @handle your wallet?" before any write (`components/profile/OwnWalletConfirm.tsx`). **+ Follow** sits beside them (`WalletFollowButton`, table `followed_wallets`, `/api/profile/followed-wallets`, cap 50, own wallet refused); Friend Activity reads followed wallets in every collection and lists them with ✕ unfollow (`FollowedWalletsList`). The binder now offers both on a USERNAME search too (it passes the resolved address).
- **Measured:** usage events `own-wallet-confirm` {step shown|yes|cancel, surface binder|share} and `wallet-follow` {on, surface}. A high cancel share = people were about to save a friend's wallet. Re-read in the weekly activity review.
- **Rule:** never tell a collector to SAVE a friend's wallet to watch it (the concierge prompt says so too).
- **The device key had the same mix-up (fixed 11-16 ~9:30 PM PT):** every binder search wrote the searched wallet into the device key (`rpc_owner_key`, "This device's wallet …"), signed in or not. Signed in, looking at a friend made the friend "you" on that device — `/sets` reads the key BEFORE the saved wallet, edition grids count owned moments from it, the warm-up preloads it. Now `deviceOwnerKeyAfterSearch` (`lib/owner-key.ts`) writes the ACCOUNT's Flow wallet for a signed-in collector (a search landing before the session answers is parked, never written first), and any binder visit sets a drifted key back. The "This device's wallet" chip no longer shows to any signed-in viewer (Trevor's 11-07 rule; it showed while looking at someone else). Signed out is unchanged — there the last searched wallet IS the device's profile, and the chip says so.
  - Residue: a device pointed at a friend before this fix is repaired on its next BINDER visit, not by `/sets` itself. Candy's Solana slot still takes the searched wallet (the account wallet is Flow).
- **QA:** `node scripts/qa/save-follow-layout.mjs [username]` renders the save confirm and + Follow SIGNED IN at 390 / 767 / 1280 px with no account (in-browser answers for `/api/profile/me` etc.; every write aborted). 11-16: card on its own line under Search/Follow at all three widths, Search 35 px, no horizontal overflow.

## ⭐ 2026-11-15 — wallet verification is live again, and it means something

Trevor: "let them have access until we can verify easily and effectively" (full trail: ledger 11-15 1:35–4:05 PM PT; options note `docs/research/wallet-verification-options-2026-11-15.md`).

- **Measured first:** only 2 accounts had ever verified (both June). The dashboard **Verify** button had been missing since 09-06 (#59, dead host) although the listing check worked on Atlas from that evening; 9 of 9 challenges ever started finished. All 55 unverified Flow wallets hold a listable Top Shot Moment.
- **How a collector verifies:** press **Verify** on the dashboard wallet card → list the picked Moment at the shown price (~100× value, ≥ $10, odd cents; never a Moment worth > $99.90, because the price caps at $999) → the window re-checks every 20 s and verifies on its own → delist. A Trade Block / trade-room Flow Wallet proof also verifies (`verification_method = 'fcl_other'`).
- **What verifying does:** ✓ VERIFIED on the public profile (`verified_wallet_count`); the wallet's Top Shot username becomes the handle if free, taken back from an account that only SAVED the wallet (claim-then-release, R151). Nothing requires verification.
- **Handles without proof:** the handle goes to the wallet's OWNER under the shared rule (`lib/wallet/wallet-owner.ts`: proved > verified > first saver). 3 owning accounts were backfilled 11-15.
- **One verified flag:** new `saved_wallets` collection rows inherit the user's existing verification for the wallet (trigger `20261115230729`).
- **Adoption read:** scheduled one-off Wed 11-18 10:23 AM PT.

## ⭐ 2026-11-26 — Binder Packs filters; "Sealed", never "Unopened" (Trevor)

Trevor (11-26 11:59 AM PT): "Can we add more filters within the packs section within my binder?" — picked all four offered; then "We should also change unopened packs to sealed packs".

- **Filters (binder Packs tabs + `/dashboard/packs`, one shared `components/packs/PackFilterBar.tsx`):** search by pack name · sort (newest/oldest, value, cost, P&L, name, and on Opened "Still held" = pulls still in the wallet at wallet FMV) · All / Winners / Losers · tier chips with counts. Applied in `get_wallet_pack_history` (v38–v40) BEFORE the page, so the count, the page and the tab metrics are one population.
- **Winners / Losers = packs paid for** (v39, Trevor "Yes do that"): a $0 cost (reward pack, box pack) is in neither bucket; it still lists, sorts and totals.
- **The filters live in the address bar** (`packs_view`, `packs_q`, `packs_tier`, `packs_result`, `packs_sort`): refresh, back and a shared link keep the view.
- **Wording rule:** a pack still in the wallet is **Sealed** everywhere a user reads it (tab, dashboard tiles, share card, Panini tile, insights copy, the pack-history status). Internal keys (`unopened`, `held`) unchanged.
- Detail: `docs/reference/packs.md` (the `get_wallet_pack_history` bullet, v38–v40); ledger 11-26 ~12:45 PM → ~2:55 PM PT.

## ⭐ 2026-11-24/25 — My Binder: one big number, plain stats, a table that fits (Trevor)

Trevor (11-24 ~5:05 PM PT): "We need to make these figures very simple and digestible, no subtext. We also need to have this binder page be more visibly appealing."

- **Header** (`components/wallet-stat-row.tsx`, live-market branch):
  - One whole-dollar **Collection value**, with the stale-priced share folded in (the 11-22 one-number rule reaches the Binder).
  - Below it, plain stats: Moments · Unlocked · Top offers · Profit / Loss.
  - A Packs / Market / Rewards / Gifts / **Other** bar. The bar spans the whole count; the unknown-source share is "Other".
  - No captions. The Locked FMV tile and the cost-basis strip are gone.
  - Profit / Loss shows only from the wallet-wide `get_wallet_summary`.
  - Unlocked still excludes moments whose lock state was never checked; the stat's hover title names them.
  - Closed-market and UFC-on-Aptos branches unchanged.
- **Close to completing:** one chip per set, linking to the Sets tab.
- **Cards** (viewport < 768 px): two-up sleeve grid from 600 px, art on a tier-coloured glow.
- **Desktop table:**
  - The Series label no longer repeats its season ("Series 2024-25", not "Series 2024-25 · 2024-25") and stays on one line.
  - The Parallel column is folded into the Set cell, as a tag on real parallels only.
  - The non-parallel printing reads **Standard**, never "Base" (11-25: "Base is a set"). `parallelLabel` / `isParallelRow` cover what users see or export; the internal "Base" default is unchanged.
  - The Packs column is hidden for signed-out visitors (it was "?" on every row).
  - Binder-scoped cell padding (`.rpc-table--binder`) lets 13 columns fit 1280–1920 px, measured on live rows.
- **Packs tab:**
  - Both rows use the same stat strip.
  - Coverage captions moved to hover titles. Net P&L withholding unchanged.
  - The Unopened Market cell stacks Ask / Rip EV / Last one per line.
- **Record:** ledger 11-24/11-25; session log 11-24 ~5:05 PM entry; handoff `claude/handoff-2026-11-24-binder-simple-hero.md` (project).

## ⭐ 2026-11-25/26 — Saved Wallets tiles, Panini inside the one number (Trevor)

- **Units:** Pinnacle counts are "Pins"; Panini and Candy are "Cards" (`getEntityLabels`; Candy now uses Panini's sports labels sitewide). Never "Moments" for those three.
- **Unopened Packs per collection:** each Flow tile shows that collection's held sealed packs (`wallet_held_pack_value.by_collection`, from `get_wallet_pack_history` v37 `held_by_collection`); the tile FMV = fresh + stale-priced Moments + those packs at capped low ask, so **the tiles add up to Portfolio FMV** (verified live 11-26: $66,593 both ways). A cache row written before v4 has no split → the tile shows no pack column, never "0".
- **Panini and Candy tiles:** the first Flow wallet card carries a Panini tile per linked username (newest `panini_portfolio_daily` value) or "+ Link your Panini username", and "+ Add your Candy wallet" until a Solana wallet is saved.
- **Panini inside Portfolio FMV** (Trevor 11-25: "Yes it should be"): linked Panini usernames' cards and recorded value join Total Assets / Portfolio FMV / Collections on the dashboard and public profile (`/api/public/profile/<u>/panini`, totals only), a third "Panini cards" band on Value / 30D, the weekly email's Estimated value (like-for-like week rule), and the concierge snapshot for the asker's own wallet. The wallet-scoped share card / OG keep no Panini part. One server reader: `lib/panini/linked-value.ts`. A failed read adds nothing and says "Panini cards couldn't load — not included".
- **Verified live 11-26:** dashboard tiles sum to Portfolio FMV ($66,593), public profile shows the same $66.6K / 20,824 assets, 58/58 member wallets carry the per-collection pack split, no client errors after the deploys. **Still to see once:** the weekly email's Panini block on its first real send (Mon 11-30 8:33 AM PT) — the scheduled task "RPC: verify weekly email carries Panini cards (11-30)" (9:47 AM PT) checks it and fixes it if wrong.

## ⭐ 2026-11-22 — one Portfolio FMV number, Total Assets (Trevor)

- **Portfolio FMV** (dashboard, public profile, share card) is ONE figure: fresh + stale-priced Moments across EVERY collection — UFC included (Trevor ~3:09 PM PT: "We should have ufc"; a 3:05 PM closed-market exclusion was reversed) — + sealed packs at capped low ask.
- **Value / 30D** is a stacked area (moments + sealed packs, top edge = total). Sealed-pack values for the 30 nights before 11-22 were BACKFILLED (`backfill_portfolio_snapshot_pack_values_step`, migrations `20261122231506` → `20261122233915`): held-on-night from pack buy/rip/sell times, that night's hourly lowest ask (Nov 15 on) or the earliest observed ask carried back, capped by the live reference rule. `portfolio_snapshots.pack_value_basis` names how (NULL = measured live); the tooltip says "Sealed packs (est.)". No breakdown caption; "Adding sealed packs…" while loading, "not included" on a failed pack read. Supersedes the 09-04 "headline = total − stale" rule and the 11-21 separate pack line.
- **Total Moments → Total Assets** = Moments + cards (Panini included) + sealed packs. Profile share tweet says "N assets".
- Live-checked in Trevor's Chrome 11-22: dashboard/profile/share agree within the cache-vs-live drift (~$34). The dashboard and profile read the `saved_wallets` cache (stamped 8:17 AM PT at the check); the share card reads `get_wallet_collection_snapshot` live. After closed markets came out: dashboard $65,716, profile $65.7K, share $65,681.40.

## ⭐ 2026-11-09 night — audit-pass changes (found by walking production signed in)

- **Cost basis count:** the Collection tab printed "27 moments with a known cost" beside a cost basis summed over 6,628 moments; the count came from the rows on screen. It now uses `get_wallet_summary.moments_with_cost`.
- **Locked + Unlocked vs Wallet FMV:** the split includes stale-priced moments and the headline does not ($54,437 + $2,981 vs $52,275 on one wallet); a caption says so when stale-priced moments exist. ⚠ **Superseded on the Binder 2026-11-24:** the header is one Collection value with the stale-priced share folded in, and there is no Locked tile or caption (see the 11-24/25 section above).
- **Locked tile** no longer reads "n/a for this collection" while loading on a collection that has locking.
- Dashboard, trophy cases, pack history, transaction history, public profile, trades, trade block and API keys were walked and read correctly.

## What it is today

**Wallet and collection analytics.** Paste any wallet, or sign in and have your own wallet ASSUMED (never requested, never announced; routes-and-surfaces 09-28). You then get:
- the per-collection Collection / Binder tab, priced from `wallet_moments_cache`;
- a three-state lock pill (Locked / Unlocked / Lock ?);
- each edition's own "Floor";
- pack history (see [pack-ev.md](pack-ev.md));
- owner-only cost basis, per-moment P&L and CSV export (10-11).

There is no wallet SIGN-IN (#0, 08-08: identifiers only). Verification is optional and live — see 2026-11-15 above.

**Public share card** `/share/<wallet>`. It is built on `get_wallet_collection_snapshot` and `get_wallet_intel_summary`. It is the week's one proven acquisition path: ChatGPT → `/insights/account-value` → share card → signup (mavhill, 10-10).

**Top Shot ownership index** (`topshot_ownership`). It holds walk-confirmed holdings only (`walk_missed_at IS NULL`). It feeds Top Owners, the rookie collector leaderboard, set completers, and squeeze "Top 5 hold". Live 10-17 ~6 PM PT:
- **528,568 rows**, of which **510,262 are live**;
- the unplaced-id queue is **207,728**: 111,327 added in 24 h by the Series 8 backfill, and only 1,704 still lack a predicted set.

**Profiles and trophy case.** `/profile/[username]` and the pinned case at `/profile/[username]/trophy-case`, which is distinct from the public #1-serial room `/insights/trophies`. **Since 2026-11-06 a collector can also keep up to 10 extra cases and enter challenge cases** — the first is Dame Time (`/trophy-challenges/dame-time`, Damian Lillard Top Shot + Panini, held pieces only, checked server-side); Trevor's own entry was the first, 6/6 on 11-06. **The trophy picker (2026-11-08)** searches the whole wallet server-side, every typed word in any field ("Damian Lillard extra spice" spans player + set), and pages past its 96-row cap with "Load 96 more" — 3 of the 15 Dame Extra Spice holders had theirs behind their first 96 Dames. Opened from a challenge, it loads every page of the challenge's player automatically (up to 480 rows; the most Dames anyone holds is 390), so a cheap set piece is on screen without a click. **The Dame Time weekend (11-07/08) and what it changed (11-09).** 22 real entrants, 17 complete; 6 of them pinned all-Dame sets into their MAIN case instead (the main picker now says it is the main case and offers the entry), rrx69 held 15 eligible editions and stopped at 5/6 after ~20 picker opens ("Fill my case" now proposes and pins the rest), and at Trevor's request every partial that could reach 6 was filled at 11:50 PM PT, 10 minutes before close (blaise_27, edogg1976, rrx69 — `fill_partial_challenge_cases`, one-off pg_cron, audited in `audit_challenge_autofill`). Six registered holders who could have completed never started (`scripts/challenge-nudge-targets.sql`: crottykid 63 held, coach_p0625 23, alexthedon 22, banana_boat 17, awesemo 12, reddiemiller31 7) — the next challenge's mid-run reminder is the lever, sent at Trevor's call. Model and routes: schema-truth.md / routes-and-surfaces.md "trophy cases". Achievements are computed for **2 owners (14 rows)**, and their UI is unmounted.

## Shipped recently (since mid-September)

- **10-18 (Claude Code cloud, ~4:28 PM PT): listing-challenge wallet verification also matches the on-chain book**, so a wallet holding only All Day or Golazos can verify, and verification survives Flowty's shutdown. The v2 leg requires the listing to postdate the challenge; verified on real rows with a rolled-back probe (`20261018232027`, `…232134`).

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

- **The funnel stops at the share card.** Week of 10-08 → 10-14: 10 wallet pastes → 10 share views → **0 sign-in clicks**, and email capture was shown 16× with 0 submits. The 10-14 CTA has not yet been measured. ↳ **First read 10-18 ~12:15 PM PT (Claude Code cloud; `usage_events`, 10-14 12 AM PT → now, rows without `metadata.automated`, joined by `vid`): 4 human share-card viewers → 1 reached `/login` after the share view → 1 magic link requested.** The first non-zero step past the share card, but n = 4: a signal, not a rate. Leave the formal read to the 10-22 demand re-read. ⚠ Read humans ONLY via `metadata.automated IS NULL`: since 10-14 the same table holds ~15,900 page views flagged automated (playwright 14,151 from 12,930 vids · lightpanda 939 · headlesschrome 534 · crawler 293) against **145 human page views from 47 visitors**, so any `page-view` count without that filter is ~99 % bots.
- **Ownership-index coverage limits** (topshot-ownership-index.md):
  - Set 218 (Series 8 Base) is excluded on purpose.
  - Dune-era sets lag, because Constellations trade-ins burn Rares the walk does not index.
  - The backfill needs ~8 more runs before squeeze census-complete stabilises.
  - Autographs: tracked since 2026-10-19 (`editions.autographed_at`; Collection tab AUTOGRAPHS toggle + "Autographed" pill). Partner-athlete status is still not stored.
- **Mega-wallets above ~100k moments** have no id source (#138; deactivated by decision).
- **#190:** pre-2023 Top Shot pack opens are missing for 33 of 34 saved wallets (declined).
- **The parallel seeder watch.** `never_queued` was 66,001 at the 10-17 fix and must fall each ~20 h cycle. If it does not fall across two cycles, file it (focus.md).
- ✅ **#114 RESOLVED 2026-10-20** (known-issues #114): the 11 live dashboards were ported to claude.ai artifacts whose reads throw on failure. Was: live Cowork dashboards still carry the failed-read-as-empty helper.

## Next — prioritized

**Now**
1. ✅ **VERIFIED 2026-10-24 ~8:50 AM PT (Cowork cloud; Q4 of `docs/operations/series-2026-27-launch-checks.sql` + a per-sale join):** 21 Series-9 editions (6 base + 15 parallels), 15 `topshot_ownership` rows on them; all 4 Series-9 sales so far (first 10-21 8:04 PM PT; one moment resold) are indexed to their CURRENT owner (`onchain_walk`, observed within the day); `series8_era_backfill` unwalked 0; walks 7 ok-unbudgeted of 7 in 24 h. Falsifier not hit. Was: **10-20 Series 2026-27 launch verification** (owed ~7 PM PT): index rows for new sets, candidates seeded within the hour, and the unplaced queue draining. Why: launch-day collectors are walked or invisible. Falsifier: a new-set holding missing from `topshot_ownership` 24 h after its first sale.
2. **Watch the parallel seeder `never_queued` count** across two cycles (query in focus.md 10-17).
3. **Read the share-card CTA in the 10-22 demand re-read.** Count share view → `signin_click share_cta` → account. Falsifier: still 0 clicks on ≥10 views, in which case the CTA is not the fix.

**Next**
4. ✅ **DRAINING, read 2026-10-18 9:22 AM PT (Claude Code cloud):** actionable backlog 24,208 → 6,173 in 21 h (~860/h); hydration 8–18 k written/day vs ~1 k actionable added/day since the Series 8 backfill burst (> 20× headroom); 0 failing lanes in 48 h. Open `predicted_set IS NULL`: **1,573**, all predicted (the two neighbours disagree; dispatch's `unpredicted` counts `predicted_at IS NULL`, a different thing, and reads 0). Every open row is < 2 d old. Unresolvable residue is small and off the head: 67 `unmapped` (re-sent 3–7× on the 1-day cooldown), 416 `no_nft` (30-day retry). **Proposed, not shipped:** `topshot_index_unmapped_dispatch` sorts ambiguous ids last (`(predicted_set IS NOT NULL) DESC, …`), so a launch-day flood of predicted ids could hold them back; an age escalator `(predicted_set IS NOT NULL OR first_seen_at < now() - interval '12 hours') DESC` plus an `ambiguous`/`oldest_open_first_seen` stock count would close it. ⚠ **Checked the same morning and NOT shipped: that escalator does not do what it says** — inside the first sort bucket rows still order by `last_seen_at DESC`, so an old ambiguous id stays behind every newer predicted id; it only reorders ambiguous ids among themselves. A real fix orders by age within the bucket (e.g. `… DESC, (first_seen_at < now() - interval '12 hours') DESC, last_seen_at DESC`), and with > 20× hydration headroom starvation is bounded anyway. Re-check on 10-20 that no open row is > 2 d old.
   - (original item) **Drain the unplaced-id queue to steady state.** Report `predicted_set IS NULL` and the age distribution, not the total, because the total grows with discovery. Gate: hydration keeps up with seeding over 48 h.
5. ✅ **GUARDED 2026-10-18 (Claude Code cloud):** `__tests__/topshot-ownership-holdings-readers-filter-walk-missed.test.ts` walks the newest definition of every function/view/MV in `supabase/migrations` (dropped ones skipped, SQL comments stripped) plus every `.from("topshot_ownership")` TS file; 10 DB + 2 TS maintenance paths are suppressed with reasons, and a planted reader without the predicate reds it. Audit the same morning: **0 unfiltered holdings readers** (18,306 of 532,092 rows flagged, 3.4 %). `get_topshot_rookie_index_coverage` is suppressed as a coverage note ("the index walked this edition"), not a holdings count.
   - (original item) **Every holdings reader filters `walk_missed_at IS NULL`.** Add a tree-walk guard so a new reader cannot forget it. Falsifier: the grep finds an unfiltered reader.

**Later**
6. **Widen achievements** to every `profile_bio` user with saved wallets: a one-line change, ~16 cheap probes per user. Only when the achievements UI is mounted or the accuracy gate is declared passed.
7. **The 2026 rookie class**, on or after 11-11, from Series 9 rookie sets. The rookie collector leaderboard is then repointed.
8. ✅ **SHIPPED 2026-11-14 (Claude Code, commit "offers + serial search…"):** the analytics Offers card's **Open** tab (outbid / superseded by you / stale 14d+ / at-or-above floor) + a "My offers" link on /dashboard; source was already there (`offers.buyer_address`, OffersV2 indexer). Step 0: 93 % of 300 sampled >90-day "open" offers confirmed open in Atlas, 0.7 % closed. (original item) **Track my own outgoing Top Shot offers** (user request, `beta_feedback_inbox` 12361, 2026-11-09; signup-wave roll-up P3): each offer I have out vs the edition's floor and top bid, flagged outbid or stale. READ-ONLY, so it fits concierge rule 1 (tracking an offer is not making one). Today RPC has only the offer-spread board (`/insights/offer-spread`) and incoming standing offers on held Moments via wallet check. First question: whether any source we already read exposes offers BY OFFERER; if none does, this needs a new indexer and is sized as one.

## Decisions on record (do not re-litigate)

- **Achievements are NOT widened** (10-17). The roadmap keeps gamification off until the gate passes. Widening would only add badges to OG share cards, which is a growth surface.
- **No wallet sign-in** (#0, 08-08). The signed-in reader's wallet is assumed and never asked for. Verification (listing challenge / Flow Wallet proof) is optional and gates nothing (#59; 2026-11-15).
- **No mega-wallet id source now** (#138, 09-25).
- **#190 declined** (10-17): no paid indexer for pre-2023 opens.
- **Parallel `#N / M`** is the moment's own serial over its own edition's run (D25, 10-13/10-17).
- **Never delete Dune rows** in `topshot_ownership`: the Dune route sizes paid walks from them.
- **Never publish RPC's own rank as Top Shot's** Yearbook / Blue Chip / Squad Goals rank. The scoring question is with Trevor.
- **A pack in the wallet is "Sealed", never "Unopened" or "Held"** in user-facing copy (Trevor, 11-26).
- **Winners / Losers count only packs paid for** — a $0 reward or box pack is in neither (Trevor, 11-26).

## Where the detail lives

- [topshot-ownership-index.md](../../reference/topshot-ownership-index.md): writers, discovery, the cost model.
- [routes-and-surfaces.md](../../reference/routes-and-surfaces.md): the assumed-wallet rule, share and profile routes.
- [chain-strategy.md](../../reference/chain-strategy.md): `lib/address.ts`; never fold a Solana key.
- [roadmap-status.md](../../reference/roadmap-status.md): the 10-15 demand read, Series 9 readiness, the 10-17 decisions.
- Register: #0, #88, #138, #142, #176, #179, #190, #191 in [known-issues.md](../../reference/known-issues.md); D8, D25 in [deep-audit-register.md](../../audits/deep-audit-register.md).
