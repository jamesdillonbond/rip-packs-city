# Handoff — Rewards delivery follow-ups (earn hooks, cosmetics UI, raffle draw, swag) — 2026-06-04

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

================================================================
CONTEXT — DB already shipped live this session (Cowork); app code is what's left
================================================================
Shipped + verified live (migrations, this session):
- audit_20260604_rewards_delivery_infra — user_cosmetics table (RLS on, authenticated SELECT-own only), profile_bio.equipped_border/equipped_banner columns, fulfill_redemption() (per-type delivery), pro items set requires_verified_wallet=true.
- audit_20260604_rewards_redeem_autodeliver_and_lock — redeem_shop_item now (a) takes a per-user advisory lock to prevent concurrent double-spend, (b) AUTO-DELIVERS digital goods (pro/cosmetic) instantly via fulfill_redemption (status -> 'fulfilled' on redeem). award_points got the same per-user lock.
- audit_20260604_rewards_raffle_safety — raffle items deactivated (active=false, held_reason set) until official rules exist; raffle_draws table + draw_raffle() fair credit-weighted picker.
- audit_20260604_rewards_economy_tune_and_swag — referral_verified daily_cap=10; new cos_border_classic (250, instant); merch_stickers (800) + merch_tee (3000) staged INACTIVE pending shipping-address capture.
- audit_20260604_rewards_fix_pro_plan_value — pro grant uses plan='admin' (valid per pro_users CHECK) + granted_by='rewards'.

Smoke-tested in a rolled-back tx (real user): cosmetic redeem -> instant 'fulfilled', user_cosmetics row, profile_bio.equipped_border set; pro redeem -> pro_users row with 30d expiry. 0 rows persisted; pro_users still 21.

So: Pro + cosmetics DELIVER with zero app changes (the already-deployed /api/rewards/redeem calls redeem_shop_item, which now auto-delivers). What the app still needs: (1) wire the engagement earns, (2) SHOW cosmetics + let users equip, (3) reflect instant-delivery + Pro expiry in the /rewards UI, (4) a draw button in admin, (5) shipping-address capture before merch goes active.

================================================================
ITEM 1 (P1) — wire the engagement earns
================================================================
The rules view_squeeze_board / scout_wallet / add_watchlist_item exist but nothing fires them. Award server-side, never trusting client for user id or amount. Import { awardPoints } from "@/lib/rewards"; resolve uid from the session (getCurrentUser / requireUser from @/lib/auth/supabase-server).

1a. add_watchlist_item — app/api/watchlist/route.ts (POST add). After a successful insert, if there's a session user: await awardPoints(userId, "add_watchlist_item"). (daily_cap 5; dupes are no-ops.) There's also app/api/profile/watchlist/route.ts — wire whichever the UI actually POSTs to (check both; award in the one that creates a row).

1b. scout_wallet — app/api/wallet-search/route.ts. When a LOGGED-IN user runs a wallet lookup, await awardPoints(userId, "scout_wallet"). (daily_cap 5.) If wallet-search is also hit by anon, just guard on a resolved session user (no user -> skip).

1c. view_squeeze_board (and other view earns) — the /insights/squeeze surfaces are PUBLIC routes (app/api/public/insights/squeeze/route.ts), so don't award there. Instead add a NEW authenticated endpoint:
  app/api/rewards/track/route.ts — POST { event }. Resolve uid from session (401 if none). Map event -> action_key against a HARDCODED allowlist only: { "view_squeeze": "view_squeeze_board" }. Reject anything not in the allowlist. Call awardPoints(uid, action_key). Because the rule has daily_cap 1 and points 15, this is safe even though the client triggers it — the cap bounds it and no amount is ever client-supplied. The squeeze page fires this once on view for logged-in users.
  SECURITY: /api/rewards/track must NEVER accept an action_key or point amount from the body — only a fixed event string mapped server-side to the allowlist. This is the one client-triggerable earn; keep it tightly allowlisted.

================================================================
ITEM 2 (P1) — show + equip cosmetics
================================================================
Cosmetics now deliver (owned in user_cosmetics, auto-equipped to profile_bio.equipped_border/equipped_banner on redeem), but nothing renders them yet.

2a. Render equipped cosmetics — wherever the profile card / collector header renders (profile/[username] + the /rewards hero, and anywhere the user's own card shows): read profile_bio.equipped_border and equipped_banner and apply the matching CSS treatment. Define a small map value->style (e.g. border 'classic' | 'flame'; banner 'ripcity') using brand tokens. Unknown/null -> no decoration.

2b. Owned cosmetics + equip UI on /rewards — add an "Your cosmetics" section listing the user's user_cosmetics rows (pass them via /api/rewards/summary; add a select of user_cosmetics where user_id = me). Let the user switch which owned cosmetic is equipped per slot via a new endpoint:
  app/api/rewards/equip/route.ts — POST { sku }. Resolve uid from session. Verify the user OWNS that sku (select 1 from user_cosmetics where user_id=uid and sku=$sku). Look up the item's slot/value (from shop_items.metadata or user_cosmetics.slot/value). Set profile_bio.equipped_<slot> = value. Reject if not owned. (Owning is enforced server-side; the client only names a sku it already owns.)

2c. /api/rewards/summary additions — return: the user's owned cosmetics, their equipped_border/equipped_banner, their Pro status + expiry (call isProUser/getProStatus from @/lib/pro for their verified wallet), and referralCount (from the referral handoff). The /rewards UI uses these.

================================================================
ITEM 3 (P1) — reflect instant delivery + Pro in the /rewards UI
================================================================
redeem now returns { redeemed, status, delivered, spendable }. For pro/cosmetic, status is 'fulfilled' and delivered is e.g. 'pro_30d' or 'cosmetic:border:classic'. Update the redeem result handling on /rewards:
- pro -> toast "RPC Pro activated — 30 days" and refresh Pro status.
- cosmetic -> toast "Equipped!" and refresh the profile preview.
- moment/merch -> keep the "pending — we'll send it to your wallet/address" copy (these stay manual).
Also show the user's current Pro expiry on the hub if active.

================================================================
ITEM 4 (P2) — admin: raffle draw + (optional) pro-safe fulfill
================================================================
app/admin/rewards + app/api/admin/rewards/route.ts (RPC_ADMIN_TOKEN-gated):
- Add action "draw_raffle" { shopItemId } -> call rpc draw_raffle(shopItemId, 'owner'); show the returned winner_user_id + entrant/credit totals; list past raffle_draws.
- Optional: change the existing "fulfill" action to call rpc fulfill_redemption(redemptionId, tx, note, 'owner') instead of the direct UPDATE. Why: if you ever manually fulfill a pro/cosmetic that somehow stayed pending, fulfill_redemption delivers it (grants Pro / equips) instead of just marking it shipped. For moment/merch it behaves the same as today (marks shipped). Low priority since digital auto-delivers at redeem.

================================================================
ITEM 5 (P2) — swag (merch) shipping-address capture, then activate
================================================================
merch_stickers + merch_tee are active=false on purpose: there's no way to collect a shipping address yet. Before flipping them active:
- At redeem (or right after) for type='merch', collect a shipping address and store it on the redemption: redemptions.fulfillment = { ...,'ship_to': {...} }. Simplest: a small modal on /rewards for merch redemptions that POSTs the address to a new app/api/rewards/redeem path variant or an /api/rewards/shipping { redemptionId, address } endpoint (session-guarded, user owns the redemption).
- Admin "Fulfill" then shows the address to ship to.
- Once that's in: UPDATE shop_items SET active=true WHERE type='merch' (DB, or do it from /admin/rewards toggle).
Do NOT activate merch before address capture exists.

================================================================
GUARDRAILS
================================================================
- Direct to main, no branches/PRs. PowerShell git; git rev-list --count origin/main..HEAD = 0 after push.
- Supabase client typed as any in routes; never import lib/rewards.ts or the service client into a "use client" file.
- Every earn is server-side off a verified action; /api/rewards/track is the only client-triggerable earn and must stay allowlisted (no client action_key/amount).
- CRLF: full-file writes for new routes; edits to existing routes via findIndex/sed, not raw string-replace.

================================================================
VERIFICATION
================================================================
- npx tsc --noEmit clean; Vercel READY.
- Logged in: add a watchlist item -> +15 once/day (see it in rpc-rewards-console ledger). Run a wallet scout -> +20. View squeeze -> +15 once/day.
- Redeem cos_border_classic -> instant "Equipped", border shows on your profile, ledger shows -250 spend + a fulfilled redemption.
- Verify a wallet, then redeem pro_1mo -> Pro activates (getProStatus true, expiry ~30d), redemption fulfilled. (Pro requires a verified wallet — redeem is blocked with 'verified_wallet_required' until the user has completed fcl-verify.)
- /admin/rewards draw_raffle on a raffle with entries -> returns a weighted winner + writes raffle_draws.

================================================================
END STATE
================================================================
Engagement earns live (watchlist/scout/squeeze), cosmetics visible + equippable, Pro + cosmetics deliver instantly with correct UI, admin can draw raffles, and merch is ready to activate once address capture lands. Combined with the DB shipped this session, the only manual fulfillment left is Moments (bootstrap, partner-funded later) and physical swag.
