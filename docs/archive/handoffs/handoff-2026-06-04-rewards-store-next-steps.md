# Handoff — Rewards Moment-store next steps (gift-to plumbing + merch activation) — 2026-06-04

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

================================================================
CONTEXT
================================================================
The Moment prize store is GO: fixed-price store redemptions are the low-legal-risk shape (no chance element — loyalty-redemption, unlike the held raffle), Top Shot gifting has NO ownership cooldown (Trevor confirmed; ignore the 2021-era 7-day rule), and the recipient's Top Shot username AUTO-RESOLVES from their linked wallet — wallet_usernames covers 44/44 linked wallets (user_profiles.topshot_username is empty; the wallet path is the source).

Already done (Cowork, live):
- DB stocking helper add_moment_shop_item(edition_external_id, serial, cost_credits, min_status default 1000, collection default 'nba_top_shot') — builds the full shop_items row (name + image from editions, stock=1, per_user_limit=1, requires_verified_wallet=true, metadata with serial/tier). SECDEF, service_role only. Tested: '2:188' -> "Andre Iguodala — Base Set #4444" with image; dupe SKU rejected. Stocking happens the moment Trevor supplies his Moment list — no app work needed for it.
- The rpc-rewards-console artifact's pending queue already shows a "Gift to (TS)" column resolved via: coalesce(redemptions.fulfillment->>'gift_to', user_profiles.topshot_username, wallet_usernames lookup through the user's saved wallet, preferring verified).

THIS HANDOFF: three app items so the in-app surfaces match — the admin queue shows the gift target, the redeeming user confirms it, and merch (RPC swag) can finally go active.

THE STANDING SECURITY RULE: user id always session-resolved; no endpoint accepts a points amount; users may only write fulfillment details (gift_to / ship_to) on redemptions THEY own and only while status='pending'.

================================================================
ITEM 1 (P1, small) — admin queue: show the gift target
================================================================
Files: app/api/admin/rewards/route.ts (GET) + app/admin/rewards/page.tsx (pending-queue table).

In the GET payload's pending-redemptions query, add a resolved ts_username per row. Resolution order (same as the console):
  1. r.fulfillment->>'gift_to'           (user-confirmed override, from Item 2)
  2. up.topshot_username                  (profile field, currently empty but future-proof)
  3. lateral: the user's saved_wallets joined to wallet_usernames on lower(wallet_addr), ORDER BY (verified_at IS NOT NULL) DESC, verified_at DESC NULLS LAST, id DESC LIMIT 1
Exact lateral shape (adapt to the query builder in the file — it may be simpler to do this as one raw SQL via supabaseAdmin.rpc/execute or a small view):
  LEFT JOIN LATERAL (
    SELECT wun.username FROM saved_wallets sw
    JOIN wallet_usernames wun ON lower(wun.wallet_addr)=lower(sw.wallet_addr)
    WHERE sw.user_id = r.user_id
    ORDER BY (sw.verified_at IS NOT NULL) DESC, sw.verified_at DESC NULLS LAST, sw.id DESC LIMIT 1
  ) wu ON true
Render a "Gift to" column in the page's pending table; show "unresolved" (muted chip) when null so Trevor knows to ask the user. Revert: remove the join + column.

================================================================
ITEM 2 (P1, small) — /rewards: confirm the gift target at moment-redeem
================================================================
Files: app/api/rewards/summary/route.ts, app/rewards/page.tsx, app/api/rewards/shipping/route.ts.

2a. summary: add resolvedTsUsername to the payload — same resolution order as Item 1 (minus the per-redemption override): up.topshot_username, else the wallet_usernames lateral for the session user. One extra query via supabaseAdmin.

2b. /rewards UI: on moment-type items (and on a just-created moment redemption), show "Will be gifted to @<resolvedTsUsername> on Top Shot" with a small "not right?" affordance. If resolvedTsUsername is null, prompt for it before/right after redeeming.

2c. Persist a correction: extend the existing /api/rewards/shipping endpoint (built in 7ede297) to also accept { redemptionId, giftTo } and merge { gift_to: <value> } into redemptions.fulfillment. Guards (same as ship_to): session user owns the redemption, status='pending', item type is 'moment' for giftTo (or 'merch' for ship_to), value is a sane string (trim, length cap ~40, no control chars). The admin surfaces (Item 1 + the console) already prefer fulfillment->>'gift_to' once set. Revert: remove the giftTo branch + UI affordance.

================================================================
ITEM 3 (P2) — merch: shipping modal, then activate the swag
================================================================
Files: app/rewards/page.tsx (+ a small client modal), /api/rewards/shipping (exists), app/admin/rewards/page.tsx.

3a. Redeem-time modal for type='merch': after a successful redeem (status pending), pop a small form (name, street, city, region, postal, country) and POST to /api/rewards/shipping { redemptionId, address }. Store as fulfillment.ship_to. Until submitted, show the redemption in HISTORY with an "add shipping address" nudge.
3b. Admin: in the pending queue row for merch, render fulfillment->>'ship_to' so Trevor can ship, then Fulfill as usual.
3c. Activate the swag ONLY after 3a+3b deploy: UPDATE shop_items SET active=true, updated_at=now() WHERE type='merch';  (or use the admin toggle). Until then merch stays active=false by design.
PRIVACY: the address lives only in redemptions.fulfillment (service-role surface, RLS keeps it owner-only on the user side). Never render it anywhere public; never put it in a URL.
Revert: deactivate merch items + remove the modal.

================================================================
GUARDRAILS (repeat)
================================================================
- Direct to main, no branches/PRs. PowerShell git; git rev-list --count origin/main..HEAD = 0 after push.
- Supabase client typed as any; lib/rewards.ts + service client stay server-only.
- No proxy.ts changes expected; /api/rewards/* is session-gated as-is.
- tsc --noEmit clean before push; Vercel deploy READY after.

================================================================
VERIFICATION
================================================================
- Admin: with a test moment redemption pending, /admin/rewards shows the resolved "Gift to" username (and the console artifact agrees).
- User: redeem a moment item -> sees "Will be gifted to @<name>"; correcting it writes fulfillment.gift_to and the admin surfaces switch to the override.
- Merch: redeem a merch item -> address modal -> address shows in admin -> Fulfill. Only then flip merch active for real users.
- Anon: /api/rewards/shipping rejects unauthenticated + non-owner + non-pending writes.

================================================================
END STATE
================================================================
One commit on main, deploy READY. Trevor stocks the store with add_moment_shop_item (one call per Moment, already live), redeemers see + confirm exactly where their Moment is going, the admin queue and console show the gift target without asking anyone, and RPC swag is activatable the moment the address modal lands. Combined with no-cooldown gifting, fulfillment is: see username -> gift on Top Shot -> mark fulfilled.
