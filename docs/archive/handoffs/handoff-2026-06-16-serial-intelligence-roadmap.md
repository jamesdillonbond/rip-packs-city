# Handoff 2026-06-16 — Forward roadmap: serial-intelligence + soak + density

The core serial-FMV thread is shipped/live. This is the prioritized "what's next," grounded in feasibility checks Cowork ran today. Items 1 + 3 have backing views already built live; Item 2 is the high-value data project; Items 4–5 are small. Pick by priority.

---

Item 1 (small, ready) — Perfect-mint premiums toggle on /insights/serial-premiums

Built live (Cowork, migration `audit_20260616_topshot_perfect_mint_premiums_board`): `public.topshot_perfect_mint_premiums_board` — same shape/conventions as `topshot_serial_premiums_board` (security_invoker=on, anon-granted, security invariants = 0), but for the PERFECT mint (#N/N, the last serial). Columns mirror the #1 board with `perfect_serial`, `perfect_last_sale_usd`, `perfect_sold_at`.

It's intentionally THIN — 10 rows (perfect serials trade rarely; aggregate premium ~7.8× vs #1's ~16.6×). So surface it as a **#1 / perfect toggle on the existing Serial Premiums page**, NOT a standalone page (a 10-row page is weak). The #1 board uses `no1_*` column names and the perfect board uses `perfect_*`; either alias them in the two API branches, or generalize both to `headline_serial`/`headline_sale_usd` when you add the toggle. Revert: `DROP VIEW public.topshot_perfect_mint_premiums_board;`

Item 2 (HIGH value — the moat unlock; data project) — "Underpriced #1s" deal board

The most valuable serial-intelligence surface: a #1 (or perfect) mint currently LISTED below its serial-FMV estimate — actionable deal-finding nbatopshot.com can't do, tying the serial-FMV layer to live asks. BLOCKED today: there is no per-serial TS listing feed. `cached_listings_v2` is empty for TS (0 active — the retired Flowty cache), and `badge_editions.low_ask` is edition-level (lowest ask across all serials), not per-serial. So the prerequisite is a real data feed:
- Ingest active TS listings WITH serial into a queryable table (the live source is the TS marketplace GQL the sniper feed already reads — `searchMarketplaceTransactions`/listings, which carry serial + ask + listingResourceID). A `topshot_active_listings` table (edition_key, serial, ask_usd, listing_url, listed_at, active) refreshed by a cron, keyed so it can join `serial=1`/`serial=circulation`.
- Then the deal board is a thin view: active #1/perfect listings JOIN `serial_fmv_estimate(...)` WHERE ask < estimate, ranked by discount. (The serial estimate function + the multiplier grid already exist.)
This also unblocks the serial/jersey/last-mint alert filters that the omni-channel alerts noted are "saved but inert until a per-serial live listing feed lands" — same feed, two payoffs. Scope it as the next serial-intelligence build when you want the deal angle.

Item 3 (small, ready-ish) — Grid-tile price-range (phase 2 of the LOW-badge UX)

The moment-page version shipped (`30d2aca`, `get_moment_detail.price_band_30d`). Phase 2 = the same cleaned band on the collection-grid/profile tiles. It was Item 2 of `docs/handoff-2026-06-15-low-badge-price-range-ux.md` (deferred). To do it: add a cleaned `price_band_30d` (p10/p90 over 30d sales, same dust+outlier cleaning) to `get_wallet_moments_with_fmv`, gated to high-volume LOW/MEDIUM rows to bound cost, and render the band on the tile. (Cowork can pre-build the RPC field if you want to split it.)

Item 4 (optional) — tshb cadence (the density lever)

`topshot-sales-history-backfill` is 497 done / 287 pending (~63% of the 784 zero-sale tail), draining at its GitHub-throttled pace (~6–10 fires/day). It lifts TS HIGH-coverage AND tightens the serial multipliers (improving both the per-moment estimates and the premiums boards) — so finishing it is the foundational FMV-quality push. To accelerate without more fires: raise `EDITIONS_PER_TICK` in `app/api/cron/topshot-sales-history-backfill/route.ts` (currently 40, gated by the 120s budget) toward ~80 so each throttled fire drains more — verify it stays under the 300s synchronous cap. Low urgency (the tail finishes on its own in ~1–2 weeks); do it only if you want the coverage faster. Note: it's a finite TS tail — there's no AllDay equivalent (AllDay #1 density is market-limited, not backfillable).

Item 5 (cosmetic) — delete the dormant `allday-unmapped-resolver` Supabase edge function (un-chained, safe; not required).

---

Soak status (verified by Cowork, no action needed): the AllDay on-chain resolver drained the priced backlog to steady-state (8 priced-unresolved, 42 total incl. the 34 zero-price held); the new `unmapped_resolution_backlog_max` trust-health leg is live + ok (breach at 100); security 0/0; the public serial line + Serial Premiums page verified live earlier.

Standard guardrails: insights surfaces → run `rpc-insights-qa`; direct-to-main, PowerShell git, full-file writes, Vercel maxDuration ≤ 800s; CC's direct inspection wins over this doc.

Recommended order: Item 2 is the real moat (do when ready for the data project); Items 1 + 3 are quick wins; Item 4 is a slow-burn quality dial; Item 5 is tidy-up.
