# Handoff 2026-06-18 — Public profile data-accuracy bugs (route-only fixes)

Plain text, iPhone-pasteable. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Context

The deeper site audit found the PUBLIC profile (/profile/[username]) showing materially wrong data: moment counts and cost basis inflated ~4x, a fake −79.3% P/L, an empty Top Movers section, and a double-@ handle. This is a public SEO/growth surface, so it matters for credibility.

ROOT CAUSE (confirmed via DB, read-only): get_user_saved_wallets(p_user_id) returns ONE ROW PER (wallet × published collection). For Trevor it returns 4 rows, ALL the same wallet 0xbd94cade097e50ac (disney_pinnacle / laliga_golazos / nba_top_shot / nfl_all_day). Three profile aggregation routes loop those rows and call a per-wallet RPC WITHOUT deduping the wallet address, summing one wallet's data once per collection-row → ~4x (it would be 5x for a user with all five collections). The underlying RPCs are CORRECT (verified: get_collection_breakdown, get_wallet_cost_basis, get_wallet_tier_counts, get_top_movers all return right data per wallet). All fixes are route-only (.ts) / .tsx — no DB or RPC change. Current prod d5f5f40.

## Item 1 (P1, material) — collection-breakdown over-counts ~4x (moments AND fmv)

File: app/api/profile/collection-breakdown/route.ts
Bug: ~line 77 builds addrs = wallets.map(w => w.wallet_addr).filter(...) with NO dedupe, then the loop (lines 86-118) calls get_collection_breakdown(addr) per addr and SUMS moment_count + total_fmv into a merged map. With 4 duplicate rows every collection is summed 4x → the audit saw 74,800 moments and ~$372K breakdown FMV vs the real 18,177 / ~$94K.
Fix: dedupe addrs. Replace the addrs assignment with:
  const addrs = Array.from(new Set(wallets.map((w) => w.wallet_addr).filter((a): a is string => typeof a === "string" && a.length > 0)))
The existing for (const addr of addrs) loop then runs once per distinct wallet; get_collection_breakdown already returns correct per-collection rows for that wallet.
Revert: git revert the commit.
Verify: /profile/<you> Collection Breakdown total ≈ 18,177 (TS ~14,523, AllDay ~3,705, Pinnacle ~181, Golazos ~44) and FMV ≈ $94K, matching the dashboard and /share.

## Item 2 (P1, material) — cost-basis-summary inflates spend/purchases ~4x (the fake −79.3% P/L)

File: app/api/profile/cost-basis-summary/route.ts
Bug: the loop (lines 73-105) calls get_wallet_cost_basis(addr, TOPSHOT_COLLECTION_ID) once per row; with 4 duplicate rows it sums totalSpent + totalPurchases 4x → $455.2K spent / 26,596 purchases / netPL −$361K / −79.3%.
IMPORTANT: totalFmv (line 74, summing w.cached_fmv_usd) is CORRECT as-is — cached_fmv_usd is per-collection (verified: Pinnacle $1,168.99 + Golazos $6.02 + TS $67,743.47 + AllDay $25,326.31 = $94,244.79). Do NOT change the totalFmv line; only dedupe the cost-basis call.
Fix: guard only the get_wallet_cost_basis call so each distinct wallet is counted once, while still summing cached_fmv_usd over every row. Before the loop add: const seenCb = new Set<string>(); Inside the loop, AFTER the totalFmv += line (74) and AFTER addr is computed (line 77), add: if (seenCb.has(addr)) continue; seenCb.add(addr); — the totalFmv += must stay ABOVE this guard so FMV still sums all collection rows.
Secondary (optional, product call): get_wallet_cost_basis is only ever called with TOPSHOT_COLLECTION_ID, so spend is Top Shot-only while totalFmv spans all collections — netPL compares TS-spend vs all-collection-FMV. After the dedupe the inflation is gone; for an apples-to-apples number consider comparing TS-FMV vs TS-spend, or label the card "Top Shot cost basis."
Revert: git revert.
Verify: spend ≈ a quarter of the prior figure; the % is no longer ~−79%.

## Item 3 (P2) — tier-breakdown over-counts ~4x

File: app/api/profile/tier-breakdown/route.ts
Bug: the loop (lines 75-102) calls get_wallet_tier_counts(addr) per row, summing tier counts 4x for the same wallet.
Fix: same dedupe — before the loop add const seenTier = new Set<string>(); inside, after addr is computed (line 77-78) add: if (seenTier.has(addr)) continue; seenTier.add(addr);
Revert: git revert.
Verify: tier counts sum to the real total (~18,177), consistent with Item 1.

## Item 4 (P2) — Top Movers renders empty though data exists

Files: app/profile/[username]/ProfileClient.tsx (and confirm it calls app/api/profile/top-movers/route.ts)
Finding: the RPC and route are FINE — get_top_movers('0xbd94cade097e50ac', 7) returns 5 gainers (LeBron +$1,080, Sabonis +$512, Durant +$275, Kyshawn George +$166, Sam Hauser +$125) and 5 losers (Thierry Henry −$779, Zion −$215, SGA −$213, C.J. Stroud −$176, Brock Purdy −$145); and top-movers/route.ts already dedupes by edition_id (so it is NOT affected by the 4x bug). The empty "Top Movers · 7D" is a FRONTEND wiring/timing issue: confirm ProfileClient fetches /api/profile/top-movers and renders gainers/losers, isn't gated owner-only, and isn't dropping the payload shape ({ gainers, losers }). Reproduce on /profile/<you>.
Revert: git revert.

## Item 5 (P3) — double-@ handle "@@jamesdillonbond"

File: app/profile/[username]/ProfileClient.tsx (handle render)
Bug: the handle renders with a literal "@" prefix while the source value already begins with "@" (or the username is stored with a leading @). Render a single @.
Revert: git revert.

## Item 6 (P3, minor) — /share/[wallet] internal TS moment-count mismatch

File: app/share/[wallet]/page.tsx
Finding: the header says "14,481 Top Shot moments" while the "Across Flow Collections" block says 14,523 on the same card — two different counts for the same thing (two sources / cache timing). Reconcile to one source.

## Item 7 (P4, cosmetic) — /insights/top-sales shows "#0 / 30"

Finding: one row (Christian McCaffrey) renders serial #0/30 — a null/zero serial_number rendering as 0. Suppress the serial chip when serial_number is null or 0 (board client or the top-sales source).

## Guardrails

- main only, no branches/PRs; if a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git (Git Bash git commit can silently no-op); re-verify with git rev-list --count origin/main..HEAD (expect 0).
- CRLF: full-file writes or findIndex on split lines, not string-replace patches.
- These are all route/.tsx — no DB change; nothing touches FMV/pricing/auth/secrets.

## Expected end state

The public profile shows correct moment counts (~18,177), correct FMV (~$94K), and a sane P/L; Top Movers populates; the handle reads @jamesdillonbond; the share card's TS counts reconcile. The same dedupe pattern (Items 1-3) protects every current and future user whose saved wallet spans multiple collections.
