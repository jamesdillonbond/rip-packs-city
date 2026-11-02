# Trading — feature roadmap (opened 2026-10-31, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Decision memo and the live-test handoff: [trading-revisit-2026-10-03.md](../trading-revisit-2026-10-03.md). Defects: [known-issues.md](../../reference/known-issues.md). Rules: [concierge.md](../../reference/concierge.md) (third exception).

**Why this file exists.** On 2026-10-31 Trevor asked to "continue building out our trade features" and chose **both** the user-to-user trade room and the Top Shot This trade-in tools, with the live two-wallet swap test **not yet run**. That reopened trading as a user feature (the 10-03 memo had left it as his call) under one hard rule: **no user wallet signs until the live test has sealed.**

## What it is today

### 1. The trade room (`/trades`, `/trades/<code>`) — built, signing gated

Two signed-in collectors swap NBA Top Shot Moments, shape A of the 10-03 memo: **one transaction, two authorizers, no escrow, no custody, no fee.**

| step | where | state |
|---|---|---|
| Start a room, share the invite link; the link's holder joins as side B | `app/trades/*`, `/api/trade-room` | ✅ live |
| Prove a Flow Wallet (FCL account proof) and pick the account the Moments sit in — the wallet itself or a Dapper account it links, read on chain | `lib/trade-room/trade-wallet.ts`, `discoverAccounts` | ✅ live |
| Pick up to 10 Moments to give; each pick is chain-checked HELD and UNLOCKED on save | `lib/trade-room/holdings.ts` (picker from `wallet_moments_cache`), `checkPicks` | ✅ live |
| Fair-trade hint: RPC FMV summed over confidently priced Moments; "N not priced" otherwise, never $0; no confidence tier | `lib/trade-room/valuation.ts` | ✅ live |
| Read the withdrawal notice, accept the EXACT version; any change resets both acceptances | `lib/trade-room/store.ts` | ✅ live |
| Simulate the whole swap on mainnet (a read) | `planRoom` → `planSwap` | ✅ live |
| **Sign**: initiator's wallet submits, the other wallet co-signs through `trade_room_relay` | `sendSwap` / `coSign` (the admin test's code) | ✅ **OPEN since 2026-10-31 ~4:00 PM PT** — `RPC_TRADE_ROOM_EXECUTE=1` in production after the live two-wallet test sealed twice (tx `c48f280a…`, two-way `3e1c0976…`; Trevor ↔ his wife's wallets) |
| After the seal: where each Moment landed, read from the chain; stored on the room | `verifyRoom` | ✅ built (reachable only after the gate opens) |
| Counterparty notices by email — joined · accepted (your turn) · ready (both accepted) · cancelled · sealed; by username, links the room, carries no wallet / Moment / price; opt-out honoured, fail closed; fire-and-forget after the response | `lib/trade-room/notify.ts` (Resend, same sender as the welcome mail) | ✅ live (10-31 afternoon) |

Tables (migration `20261031174000`): `trade_rooms` (code, status, version, tx_id, landed, expires_at 7 d), `trade_room_sides` (signer, source, accepted_version, notice_read_at), `trade_room_items` (a Moment is on at most one side), `trade_room_relay`. Service role only. A deleted account's side row is deleted and the room reads "a collector who left".

**Honesty rules built in:** a failed chain read is a 503 + retryable, never "not held" or "not yours"; a wallet RPC has not indexed reads "not indexed yet", never "holds nothing"; a submitted transaction whose seal could not be read is recorded as submitted and the chain is read again, never "failed".

### 2. Top Shot This trade-in tools (`/insights/trade-in`) — live, public

Top Shot's Series 2026-27 program counts every $10 of a player's Moments, at **Top Shot's own average sale price**, as one Top Shot This pack of that player. The 10-20 internal finder used RPC's last-10 average as a proxy and was held internal "until Top Shot's own ASP can be read". It can: `badge_editions.avg_sale_price` is Top Shot's figure (Atlas `averageSalePriceCents`, refreshed ~daily; 14,014 of 14,506 Top Shot editions at the 10-31 census).

- `v_insights_trade_in` (migration `20261031182000`, security_invoker, anon SELECT): per edition, Top Shot's ASP, lowest ask, Moments per pack = ceil(10 ÷ ASP), cost per pack at the ask, ASP ÷ ask. ~2k buffers / 40 ms for the cheapest 50.
- `get_topshot_trade_in_wallet(wallet, limit)` (afternoon, migrations `20261031190000` + `…190500`; jsonb, one scan): per player, ASP total, whole packs, ASP to the next pack **and the cheapest next pack** — the listed Moment(s) of that player that close the gap at the least cost, `ceil(gap ÷ ASP) × lowest ask`; plus `next_pack`, the same ranked cheapest-first across the whole wallet, and `total_players` / `players_with_fill`. ⚠ Players are keyed on the **catalog** name (`editions.player_name`): `wallet_moments_cache.player_name` carried 125 variant spellings on one wallet ("Luka Doncic" / "Luka Dončić") and every team Moment as "Team Moment", so the morning function split one player's $10 math and summed 30 teams under one name; both functions were re-keyed (`get_topshot_trade_in_portfolio` is kept, re-keyed, unused by the route). Reading no wmc column but the keys made the wallet read index-only: 627 buffers vs 13,270 heap blocks on the 15,668-Moment wallet.
- Route `/api/public/insights/trade-in` (`player=`, `sort=cost|ratio|asp`, `wallet=` → `players` + `next_pack`), page, layout (canonical, OG via the default card), registry, sitemap, `/insights` index card. Accent-blind retry on the player search (#207). The page pre-runs `?player=` (linked from every Top Shot player page) and `?wallet=` (linked from the dashboard, first saved Flow wallet).
- Concierge tool `get_trade_in` (afternoon): the finder (player-scoped, cheapest first) or the wallet read (username ladder, `not_indexed` never "holds nothing"); refused on any other named collection; its copy says ASP ≠ FMV, "counts for" not "worth", confirm eligibility in the Top Shot app.
- **Copy rules:** no FMV and no confidence on the board; the ask is "one Moment at that price confirmed, the next may cost more"; "confirm eligibility in the Top Shot app".

### 3. The Trade Block (`/trades/block`) — opened 2026-11-02

Trevor, 2026-11-02 (PT): "a Trade Block or Trade Post, where users can put up assets that they'd like to trade, maybe even also mention what they're looking for in return", while the swap mechanism keeps moving in its own thread. His three decisions the same morning: **browsing is public**; **a trade can span collections and carry several items**; **no cash, at this time**. This supersedes the "no public wants list" line under *Open → Discovery* below — that was a default awaiting his call, and he has made it.

**The split.** The block is the DISCOVERY layer; the trade room is the EXECUTION layer. A listing never moves an asset. An accepted proposal hands off to a trade room, and only the room's chain checks and signatures move anything. The block is not gated on the room widening to more collections, and the room widens collection by collection without any block change.

**Data model** (migration `20261102162558_audit_20261102_trade_block`; every table service-role only, RLS on, no policies, like the room tables):

| table | what a row is |
|---|---|
| `trade_block_wallets` | a Dapper/Flow account a user PROVED (FCL account proof, `lib/giveaways/claim-proof.ts`) — `(user_id, signer, source)`. Proof is the only ownership evidence; `saved_wallets.verified_at` is not used (listing-challenge verification lost its source, #59). |
| `trade_block_listings` | one post: `code` (10 base-36, the URL), `user_id`, `note` (≤ 280, filtered), `open_to_offers`, `status` open/closed, `expires_at` (30 d), `closed_reason`. Expired is derived on read, never stored. |
| `trade_block_items` | a line of a listing: `role` offer/want · `collection_id` · `kind` moment (a held asset, with its `source` account and a display snapshot) / edition (`edition_key`) / player (catalog name; Pinnacle says *character*). |
| `trade_block_proposals` | a signed-in collector's offer on a listing: `code`, `listing_id`, `proposer_id`, `status` pending/accepted/declined/withdrawn, `note` (filtered), `room_code` once a room is opened. |
| `trade_block_proposal_items` | `role` give (from the proposer's proven accounts) / get (a moment line of the listing). |

**Rules built in.**
- **Ownership:** an offered asset must sit in an account the poster proved, and in RPC's index of that account (`wallet_moments_cache`, scoped by `collection_id`). That index is a CACHE: the page says "in this account as of RPC's last read", re-checks at view time, and shows a line that has left the index as "may have moved" — never hides it silently and never claims it is gone. Top Shot lines are chain-checked again by the room before anything signs.
- **Collections:** the Flow collections a proven Dapper account can hold — Top Shot, All Day, Golazos, Pinnacle, UFC. Panini (Ethereum) and Candy (Solana) have no proof path yet, so they can be WANTED (by edition or player) but not OFFERED.
- **Wallets never leave the server.** Public reads carry username, items and FMV only — no `source`, no `signer`.
- **No cash.** No price field anywhere. Notes are refused (not stripped) when they carry a URL, an email, a payment rail (PayPal, Venmo, Cash App, Zelle, crypto tickers), a money amount, or an off-platform contact handle (Discord, Telegram, WhatsApp, @handles) — off-platform payment is the trading-scam route.
- **Fair-trade hint:** RPC FMV summed per side over HIGH/MEDIUM-priced lines only; "N not priced" otherwise; never a confidence tier; never $0 for unknown.
- **Signing eligibility:** an accepted proposal opens a trade room **only when every moment on both sides is NBA Top Shot** (the only collection the swap has proven). Otherwise it reads "agreed — signing on RPC is Top Shot only for now; All Day / Golazos / … are next", and nothing is offered that the product lacks.
- **Limits:** 10 lines per side, 20 open listings and 30 pending proposals per user, 30-day listing expiry, one pending proposal per (listing, proposer).
- **Email:** new proposal → lister; accepted / declined → proposer; same sender, opt-out fail-closed, username only, no items or prices (the room's `notify.ts` rules).

**Surfaces (v1).**
- `/trades/block` — public browse (anon-readable at the proxy), filter by collection and player/character; newest first.
- `/trades/block/<code>` — public listing page; a signed-in viewer can propose (pick what to give from their proven accounts, which offered moments they want, a note). Always `noindex` (listings live ≤ 30 days and close on a trade); `/trades/block` is the indexed surface.
- `/trades/block/mine` — signed in: prove an account, post a listing (pick offers from holdings across collections, add wants by edition search or player name), close listings, decide on proposals, open the room.
- Routes: `/api/public/trade-block` (list), `/api/public/trade-block/[code]` (one), `/api/trade-block` (signed-in: state + every mutation by `action`).

**v2 (shipped 2026-11-02, same day — Trevor: "Keep going"):**
- **Matcher** — `lib/trade-block/match.ts`, `GET /api/trade-block?matches=1`, the "Matches for you" panel on `/trades/block/mine`: open listings (newest 300; `complete:false` says when more exist) whose WANTS an asset in the caller's PROVEN accounts satisfies, and whose OFFERS the caller's own listings want; both = a **two-way** match, ranked first. One collection at a time; an edition want matches its catalog key, a player / character want an accent- and case-blind name (Pinnacle reads `character_name`). Each empty state names WHY (no proven account / no wants / nothing fits); a failed read is a Retry banner.
- **Match emails** — `lib/trade-block/match-notify.ts`: when a listing with wants is posted, every OTHER collector who proved an account on the block and holds a satisfying asset gets "X is looking for something you hold" — at most one a Pacific day (`trade_block_match_notices`, migration `20261102181928`, claimed BEFORE the send), ≤ 50 recipients per listing, username + link only. Proving an account on the block is the opt-in.
- **Room guide** — a trade room opened from an accepted proposal shows "Agreed on the Trade Block" (lister = side A gives the listed assets, proposer = side B gives theirs) as a guide for the picks; never a pick itself, and a failed read only drops the guide.
- **Concierge** — `get_trade_block` reads the public block (player/character/set, collection); it cannot post or propose and says so.
- Hardening found on the way: the items read behind every list was ONE `.in()` that PostgREST would clamp at 1,000 rows once enough listings existed (silently dropping lines) — now chunked at 40 listings (≤ 800 rows) per read.

**v3 (2026-11-02, ~11:15 AM PT):** every player / character page (the shared `[collection]/player/[slug]` page, so Pinnacle's `/character/` too) shows "N open Trade Block listings mention <name> →" from a client read of the public block — decorative, rendered only on a successful read that found ≥ 1 listing (`components/entity/OnTheBlockLink.tsx`); `/trades/block?collection=&q=` deep links start filtered.

**Next (not built):** the same module on edition pages; the prune for old closed/expired listings and old notice claims is WRITTEN but not applied — `docs/pending/trade-block-prune-run-in-sql-editor.sql` (the MCP holds a body carrying DELETE; run it in the SQL editor, then commit it as a migration); All Day / Golazos signing once their swap paths are proven; the browse filter's 1,000-line candidate read (fine at today's volume) should page once the block is large.

## Open — in order

1. ~~**The live swap test**~~ — **DONE 2026-10-31 (3:41–3:52 PM PT):** Flow Wallet signs as a non-paying authorizer across two devices; run 1 (`c48f280a…`) and the two-way run 2 (`3e1c0976…`) both sealed with chain-verified landings. `RPC_TRADE_ROOM_EXECUTE=1` is set (env id `TXIQkpES5NH7czBk`). **Next: a first real trade through `/trades`** — two RPC accounts (Trevor + his wife's), the same two wallets. Lessons from the test, now binding for the room: the picker must not trust `wallet_moments_cache.is_locked` (known issue #222 — 121 of 137 "unlocked" rows were locked on chain; the save's chain check caught every one, but the picker showed them) and a LISTED Moment (TopShotMarketV3 sale collection) is still in the collection, so the picker should read the sale collection too.
2. ~~**Expiry and housekeeping**~~ — shipped 10-31 afternoon: `prune_trade_rooms(30, 7)` on pg_cron `rpc-prune-trade-rooms` (jobid 814, 04:53 UTC daily) deletes rooms cancelled > 30 d and never-sealed rooms whose `expires_at` passed > 30 d (sides/items/relay cascade) and relay rows > 7 d; **sealed rooms are kept** as trade history (migration `20261031194500`, applied through the dashboard SQL editor — the MCP holds a body carrying DELETEs).
3. **Collections:** Top Shot only (`trade_rooms.collection` CHECK). All Day / Golazos need a holdings reader per collection and their own `SWAP_CADENCE` imports; Pinnacle is blocked by Dapper's link filter; UFC's Flow market is closed.
4. **Discovery:** ~~no matcher, no public "wants" list~~ — superseded 2026-11-02 by Trevor's Trade Block decision (section 3 above): public browse, multi-collection bundles, no cash. Still not done: the matcher and promotion (the accuracy gate and the 100-WAU rule still bind any promotion).
5. **Trade-in tools, next:** ~~the cheapest next pack per player~~ (shipped 10-31 afternoon, see above); ~~player pages linking into the finder~~ (shipped); a "cheapest path to N packs" planner for a player you do NOT hold yet is the board's cost-first sort (N × the row); refresh the ASP read if Top Shot's figure proves to lag its own trade-in screen (compare on a real trade-in); add `/insights/trade-in` to the `rpc-insights-health` artifact's surface list from a desktop session (a remote artifact update clears its tool grant).

## Decided (do not re-propose)

- **No escrow contract deployment** (`RPCTradeEscrow` stays undeployed; memo §9.6 of roadmap-2026-08-03 still binds).
- **No fee, no promotion** until the roadmap's accuracy gate and the 100-WAU rule allow it.
- **No wallet sign-in for anything else:** the trade room's connect is the fourth and last importer of `flow-wallet-connect.ts` unless Trevor names another.
