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
| **Sign**: initiator's wallet submits, the other wallet co-signs through `trade_room_relay` | `sendSwap` / `coSign` (the admin test's code) | ⛔ **gated** — `relay_post` answers `execute_closed` until `RPC_TRADE_ROOM_EXECUTE=1` |
| After the seal: where each Moment landed, read from the chain; stored on the room | `verifyRoom` | ✅ built (reachable only after the gate opens) |

Tables (migration `20261031174000`): `trade_rooms` (code, status, version, tx_id, landed, expires_at 7 d), `trade_room_sides` (signer, source, accepted_version, notice_read_at), `trade_room_items` (a Moment is on at most one side), `trade_room_relay`. Service role only. A deleted account's side row is deleted and the room reads "a collector who left".

**Honesty rules built in:** a failed chain read is a 503 + retryable, never "not held" or "not yours"; a wallet RPC has not indexed reads "not indexed yet", never "holds nothing"; a submitted transaction whose seal could not be read is recorded as submitted and the chain is read again, never "failed".

### 2. Top Shot This trade-in tools (`/insights/trade-in`) — live, public

Top Shot's Series 2026-27 program counts every $10 of a player's Moments, at **Top Shot's own average sale price**, as one Top Shot This pack of that player. The 10-20 internal finder used RPC's last-10 average as a proxy and was held internal "until Top Shot's own ASP can be read". It can: `badge_editions.avg_sale_price` is Top Shot's figure (Atlas `averageSalePriceCents`, refreshed ~daily; 14,014 of 14,506 Top Shot editions at the 10-31 census).

- `v_insights_trade_in` (migration `20261031182000`, security_invoker, anon SELECT): per edition, Top Shot's ASP, lowest ask, Moments per pack = ceil(10 ÷ ASP), cost per pack at the ask, ASP ÷ ask. ~2k buffers / 40 ms for the cheapest 50.
- `get_topshot_trade_in_portfolio(wallet, limit)`: a wallet's per-player ASP total, whole packs, ASP to the next pack, `total_players` (the function takes its own limit because PostgREST clamps a set-returning RPC at 1,000 rows silently — Trevor's wallet has 1,332 players).
- Route `/api/public/insights/trade-in` (`player=`, `sort=cost|ratio|asp`, `wallet=`), page, layout (canonical, OG via the default card), registry, sitemap, `/insights` index card. Accent-blind retry on the player search (#207).
- **Copy rules:** no FMV and no confidence on the board; the ask is "one Moment at that price confirmed, the next may cost more"; "confirm eligibility in the Top Shot app".

## Open — in order

1. **The live swap test** (Trevor's wallets, `/admin/swap-test`; §6/§9 of the memo). It settles whether Flow Wallet signs as a non-paying authorizer across two devices. **Then set `RPC_TRADE_ROOM_EXECUTE=1` in Vercel** (production env) and the trade room's Sign step opens with no code change; a first real trade should be Trevor's own two wallets through `/trades` before anyone else uses it.
2. **Expiry and housekeeping:** rooms expire at 7 days by `expires_at` (read-time; nothing deletes them). Add a weekly pg_cron sweep of sealed/cancelled/expired rooms older than ~30 days once there are rows to sweep.
3. **Collections:** Top Shot only (`trade_rooms.collection` CHECK). All Day / Golazos need a holdings reader per collection and their own `SWAP_CADENCE` imports; Pinnacle is blocked by Dapper's link filter; UFC's Flow market is closed.
4. **Discovery:** no matcher, no public "wants" list — the room is invite-only on purpose until the accuracy gate and the 100-WAU rule allow promotion (memo §5). A dashboard card is the only front door.
5. **Trade-in tools, next:** a "cheapest path to N packs" planner across editions (today's board ranks single editions); the per-player board on `/nba-top-shot/player/*` pages linking into the finder; refresh the ASP read if Top Shot's figure proves to lag its own trade-in screen (compare on a real trade-in).

## Decided (do not re-propose)

- **No escrow contract deployment** (`RPCTradeEscrow` stays undeployed; memo §9.6 of roadmap-2026-08-03 still binds).
- **No fee, no promotion** until the roadmap's accuracy gate and the 100-WAU rule allow it.
- **No wallet sign-in for anything else:** the trade room's connect is the fourth and last importer of `flow-wallet-connect.ts` unless Trevor names another.
