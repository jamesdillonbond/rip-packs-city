# Wallet verification options — 2026-11-15

Trevor: "let them have access until we can verify easily and effectively." Constraint (2026-08-08): no Dapper sign-in or wallet connect — RPC cannot get Dapper developer approval.

## What exists today

| Method | How | Reach | Used |
|---|---|---|---|
| Listing challenge | RPC picks a cheap Moment; the collector lists it on Top Shot at a price ~100× its value (≥ $10, random cents), RPC reads the live listing from Atlas, seller-matched | Flow wallets that hold an unlocked Top Shot Moment | 9 started, 9 finished (Apr–Jun). The dashboard button was gone 09-06 → 11-15; restored 11-15 |
| Trade Block / trade-room proof | FCL account proof from a Flow Wallet linked to the Dapper account | Only collectors who run Flow Wallet with a linked Dapper account | 1 (Trevor's test) |
| Owner attestation | Admin `admin_verify_wallet` | Anyone Trevor vouches for | 1 account |

Live controls 11-15: `atlas_verify_listing` matched a real open listing at its price and refused the same listing 1¢ off.

## Reach (measured 2026-11-15 ~2:40 PM PT)

All **55 of 55** unverified saved Flow wallets hold at least one unlocked, priced Top Shot Moment in `wallet_moments_cache`, so the listing check can reach every one of them today. Reach is not the gap; finding the button and having a reason to press it are. Shipped the same afternoon:

- the Verify button back on every unverified Flow wallet card (it had been missing 09-06 → 11-15);
- a verified listing claims the wallet's Top Shot handle (claim-then-release);
- the open modal watches for the listing every 20 s, so the collector does not have to come back and press Done;
- the public profile says how many of a collector's wallets are verified (`✓ VERIFIED` / `N VERIFIED`) — a trust signal for trades.

## Kept for later (no user needs them today)

- **All Day / Golazos / Pinnacle listing check** — Atlas reads `product:'nfl'` listings too, so the same challenge could pick an All Day Moment. 0 unverified wallets lack a Top Shot Moment, so not built.
- **Avatar change** — `profileImageUrl` comes back from the same ProfileService read and only the owner can change it. Weaker UX than a listing (the collector has to go to Dapper account settings and back), and unknown whether Atlas reflects the change quickly. Needs one live test before any build.

## Rejected: favourite-team challenge

⛔ **Skipped (Trevor, 2026-11-15 2:30 PM PT): Top Shot locks the favourite team for the season, so a collector cannot switch it on request.** Kept below for the record — do not re-propose.

Atlas `ProfileService/SearchUserProfiles {username}` (already used by the username lane) returns the profile's `favoriteTeamIds` and `profileImageUrl` alongside `flowAddress` — measured on jamesdillonbond 11-15: `["1610612757","1611661327"]` (Blazers + a WNBA team). Only the account owner can change those settings.

Flow: RPC reads the current favourite team, picks a different team, the collector switches to it in Top Shot settings, RPC sees the change, the collector switches back.

- **Easier than listing:** no Moment, no price, nothing on the market; works for an account that holds nothing, and for wallets whose cheap Moments are all locked or listed.
- **Sound:** a squatter cannot change someone else's profile. Requiring a change FROM the read value TO the picked team inside the window removes the 1-in-30 coincidence.
- **Unknown, and decisive:** whether Top Shot still lets collectors edit the favourite team, and how fast Atlas reflects the edit. One 2-minute test settles both: Trevor changes his favourite NBA team and RPC re-reads the profile.
- **Cost:** one Atlas ProfileService read per check; Atlas is burst-sensitive (keep checks rate-limited per user, as the listing check is).

## Not pursued

- Dapper sign-in / FCL connect — barred (no Dapper developer approval; Trevor 08-08).
- Offer at a unique amount — offers reserve the collector's balance; worse than a listing.
- Avatar change — the collector picks from a fixed set and cannot type a code; weaker than the team check, same reach.
