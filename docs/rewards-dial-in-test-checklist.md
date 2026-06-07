# RPC Rewards — Dial-In Test Checklist

**Purpose:** a thorough manual walkthrough to confirm the rewards loop works before inviting any users. Do this logged in on production (`www.rippackscity.com`). Keep the **`rpc-rewards-console`** artifact open in Cowork in another window — it's your live verification surface (reload it after each step).

**Heads up before you start:**
- Testing on your real account writes **real** ledger rows / redemptions / a real Pro grant to your wallet. That's fine (it's you) — see "Reset" at the end to zero it out, or use a throwaway account.
- **Pro and Moment redemptions require a verified wallet.** If you haven't completed wallet verification (`fcl-verify`), those will correctly block with `verified_wallet_required`. Verify a wallet first if you want to test them.
- There's a **global earn cap of 5,000 credits/day per user** — heavy repeated testing in one day can hit it (you'll see `global_daily_cap_reached`). It resets at UTC midnight, or bump `rewards_config.global_daily_earn_cap` temporarily.

---

## 1. Earn — each action credits once and is capped

- [ ] **Daily visit** — load `/rewards`. Expect **+25** once. Reload `/rewards` again → **no** second award (20h cooldown). *Console: a `daily_visit` earn row, spendable 25.*
- [ ] **Link wallet** — verify a wallet via the Dapper sign-in. Expect **+500** (`link_wallet`, one-time). Re-verify → no second award.
- [ ] **Complete profile** — finish your profile/bio. Expect **+250** (`complete_profile`, one-time).
- [ ] **Set favorite team** — save a favorite team. Expect **+100** (`set_favorite_team`, one-time).
- [ ] **Watchlist** — add a Moment to your watchlist. Expect **+15** (`add_watchlist_item`, up to 5/day). Add a few more → caps at 5/day.
- [ ] **Scout a wallet** — run a wallet search/scout. Expect **+20** (`scout_wallet`, up to 5/day).
- [ ] **View squeeze board** — open `/insights/squeeze` while logged in. Expect **+15** (`view_squeeze_board`, 1/day) via `/api/rewards/track`. View again → no second award.

**Verify the two-number system:** after the above, your **Status** (lifetime, sets your tier) and **Credits** (spendable) should both reflect the earns. Crossing 500 status → tier **Role Player**. *Console "User balances" row shows your tier + both numbers.*

---

## 2. Redeem — digital delivers instantly, physical queues

- [ ] **Cosmetic (instant)** — redeem **Profile Border: Classic** (250). Expect: credits drop 250, status unchanged (spending never costs status), and an **instant "Equipped"** result (not "pending"). *Console: a `spend` ledger row + a redemption marked **fulfilled**; "Cosmetics owned" KPI ticks up.*
  - [ ] **Render check (the one I can't do):** open your public `/profile/<username>` and confirm the **border** actually renders on your card. Then on `/rewards`, use the "Your cosmetics" section to **equip a different** owned cosmetic and confirm the profile updates.
- [ ] **Insufficient credits** — try to redeem something you can't afford (e.g., Pro at 1500 before you've earned enough). Expect a clean **"insufficient credits"** block, no charge.
- [ ] **Pro (instant, needs verified wallet)** — once you have ≥1500 credits and a verified wallet, redeem **1 Month of RPC Pro**. Expect: credits −1500, **"RPC Pro activated — 30 days"**, and Pro now shows active. *Console: "Pro grants (rewards)" KPI = 1; verify `getProStatus` shows Pro true with ~30-day expiry. Without a verified wallet it blocks with `verified_wallet_required` — that's correct.*
- [ ] **Moment (manual)** — redeem **Common Moment Mystery Pick** (2000) if you have the credits + verified wallet. Expect: **pending** (not auto-delivered), and the card/history shows **"Will be gifted to @\<your-TS-username\>"** (auto-resolved from your linked wallet) with a "not right?" editor — try correcting it and confirm the admin queue + console switch to your override. *Console: it appears in the "Redemption queue" with the Gift-to column.*
- [ ] **Merch (manual — now active)** — redeem **RPC Sticker Pack** (800). Expect: **pending** + a **shipping-address modal**; submit an address and confirm it's stored (admin shows it; it must never render anywhere public). Skip the modal once and confirm HISTORY shows the "add shipping address" nudge.

---

## 3. Admin console (`/admin/rewards`, RPC_ADMIN_TOKEN)

- [ ] Loads with the **economy KPIs** + **pending redemption queue**.
- [ ] **Fulfill** the pending Moment from step 2 (gift the actual Moment on Top Shot first — no cooldown — then mark it). Confirm it flips to **fulfilled**.
- [ ] Pending rows show the right identities: **"Gift to @username"** on the moment row (your override if you set one), the **ship-to address** on the merch row.
- [ ] **Manual adjust** — grant yourself some test credits via the adjust form; confirm the ledger shows an `adjust` row by `admin:owner`.
- [ ] **Draw raffle** — (the raffle item is held inactive, so there won't be entries; just confirm the action exists and returns "no entries" gracefully). Real draws are for later, after rules ship.
- [ ] **Toggle** a shop item active/inactive and confirm it reflects on `/rewards`.

---

## 4. Referral (needs a second, fresh account)

- [ ] Copy your referral link from `/rewards` (`/?ref=<your-id>`). In a **fresh browser/incognito**, open it, then sign up + verify a **new** Dapper wallet. Expect **your** balance to gain **+300** (`referral_verified`). *Console: a `referral_verified` earn row credited to you.*
- [ ] **Self-referral** — open your own `?ref=<your-id>` and verify → **no** award (blocked server-side).

---

## 5. Security spot-checks (do these logged OUT / incognito)

- [ ] `/rewards` and `/api/rewards/summary` → **redirect to `/login`** (no anon points path).
- [ ] `/api/admin/rewards` → **401** without the token.
- [ ] There is **no** request that grants points by amount — earns only happen as side effects of the verified actions above, and `/api/rewards/track` only accepts a fixed `event` (not an action key or amount).

---

## 6. Reset (optional, after testing)

Your test activity is harmless (it's your own account), but to zero it:
- Credits: `admin_adjust_points('<your-user-id>', -<spendable>, -<status>, 'reset test', 'owner')` — or leave it.
- Pro grant: it expires in 30 days on its own; or `DELETE FROM pro_users WHERE wallet_address='<your-lowercased-wallet>' AND granted_by='rewards';`
- Cosmetics: `DELETE FROM user_cosmetics WHERE user_id='<your-user-id>';` and clear `profile_bio.equipped_border/equipped_banner` if you want.

---

### What "dialed in" looks like

Every earn fires once and respects its cap; cosmetics equip and **render on your profile**; Pro activates on redeem; the admin queue + fulfill works; referrals credit the referrer and block self-referral; and the console reflects all of it. When that's all green, it's ready to invite the first cohort — and the Monday pulse will start reporting real activity. If anything's off (especially the cosmetic render), send me what you saw and I'll spec the fix.
