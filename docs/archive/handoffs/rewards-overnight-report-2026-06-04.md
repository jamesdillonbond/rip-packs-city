# RPC Rewards — Overnight Audit & Actions Report

**Date:** 2026-06-04 (overnight) · **For:** Trevor · **Mode:** autonomous, low-risk only
**Scope:** the rewards program. Everything below is net-new/additive and isolated to the rewards feature — nothing touched FMV, pricing, ingest, pack-EV, concierge, sniper, auth/`proxy.ts`, secrets, or the hot/payer wallet. Nothing was pushed to users (dial-in respected).

---

## TL;DR

You asked me to make the prizes actually deliver, handle the raffle, wire more earns, and tune the economy — then to keep going autonomously and report back. I did all four, **found and fixed 3 real bugs in the process**, shipped 5 additive DB migrations live (all verified + smoke-tested in rolled-back transactions, zero test data persisted), deactivated the legally-risky raffle, and packaged the remaining app code as two Claude Code handoffs. The rewards security invariant still holds: no user-writable path to points, every SECDEF function is `service_role`-only, `check_secdef_anon_execute_violations()` = `[]`.

**The headline finding:** redeeming Pro or a cosmetic delivered **nothing** before tonight — "Fulfill" only marked an order shipped. That's now fixed: Pro grants into `pro_users` and cosmetics are stored + auto-equipped, both **instantly** at redeem time, with no app change required (the already-deployed redeem route calls the function I rewrote).

---

## 1. Audit findings

**Bug 1 — Prize delivery was a no-op for digital goods (fixed).** Fulfilling a Pro or cosmetic redemption only set `status='fulfilled'`; nothing extended `pro_users` and there was nowhere to store a cosmetic. A user could spend credits and receive nothing. → Built `fulfill_redemption()` (per-type delivery) and made `redeem_shop_item` auto-deliver digital goods instantly.

**Bug 2 — Concurrency double-spend (fixed).** `redeem_shop_item` checked the balance with `SUM(delta)` without locking the user, and only locked the *item* row. Two simultaneous redeems of **different** items by the same user could both pass the balance check and overspend (negative balance). → Added a per-user advisory lock (`pg_advisory_xact_lock`) to both `redeem_shop_item` and `award_points`, serializing a user's mutations.

**Bug 3 — Pro grant violated a CHECK constraint (fixed; caught by the smoke test).** My first delivery function set `pro_users.plan='rewards'`, but that column is CHECK-constrained to `founding|moments_payment|pro_grandfather|pro_paid|pro_trial|admin`. Every Pro fulfillment would have errored. → Grants now use `plan='admin'` (the comp bucket) with `granted_by='rewards'` for provenance. Re-smoke-tested: Pro row created with a 30-day expiry. This is exactly why the rolled-back smoke test was worth running.

**Finding 4 — No wallets are verified yet (0 of 44 `saved_wallets`).** Pro and Moment items are now `requires_verified_wallet=true`, so those redemptions are correctly blocked with `verified_wallet_required` until a user completes `fcl-verify` (which sets `verified_at`). Expected during dial-in — flagging so it's not mistaken for a bug when you test. Cosmetics don't require a wallet, so they're redeemable immediately.

**Finding 5 — `saved_wallets.user_id` has a cross-schema FK to `auth.users`.** My earlier schema scan only looked at public-schema FKs and reported "no FK on user_id." It actually references `auth.users(id)`, confirming `user_id` is a real auth uid. The rewards tables intentionally have no such FK (matching the repo's looser convention; the app always passes a valid session uid) — fine, just now documented.

**Finding 6 — The live raffle was a standing legal exposure.** A points→prize raffle implicates sweepstakes/lottery law. → Deactivated the raffle item (`active=false`, `held_reason` recorded) and wrote a no-purchase-necessary official-rules **draft** to vet with a lawyer before it ever faces users.

**Finding 7 — Engagement earns exist as config but never fire (handed off).** Rules for `view_squeeze_board`, `scout_wallet`, `add_watchlist_item` are seeded, but no code awards them, so after day-one onboarding there's no ongoing earn. Wiring them is app code → handoff (with a security-careful pattern for the public squeeze surface).

**Security re-verified after every change:** RLS on all rewards tables (incl. new `user_cosmetics`, `raffle_draws`); `anon`/`authenticated` are SELECT-only (own-rows); all 8 rewards SECDEF functions are EXECUTE-locked to `postgres, service_role`; `check_secdef_anon_execute_violations()` = `[]`.

---

## 2. Actions taken (shipped live — all reversible)

| Migration | What it does |
|---|---|
| `audit_20260604_rewards_delivery_infra` | `user_cosmetics` table (RLS, own-row SELECT) + `profile_bio.equipped_border/banner` + `fulfill_redemption()` per-type delivery + Pro items require verified wallet |
| `audit_20260604_rewards_redeem_autodeliver_and_lock` | `redeem_shop_item` auto-delivers digital goods + per-user advisory lock; same lock added to `award_points` |
| `audit_20260604_rewards_raffle_safety` | Deactivated raffle items; `raffle_draws` table + fair credit-weighted `draw_raffle()` |
| `audit_20260604_rewards_economy_tune_and_swag` | Referral `daily_cap=10`; added `cos_border_classic` (250, instant); staged `merch_stickers`/`merch_tee` **inactive** pending address capture |
| `audit_20260604_rewards_fix_pro_plan_value` | Pro grant uses `plan='admin'` (valid) + `granted_by='rewards'` |

Verified: catalog = 5 active items (3 cosmetics 250/400/600, 1 Pro 1500, 1 Moment 2000), merch + raffle inactive; 9 active earn rules. Clean state confirmed (0 ledger / 0 redemptions / 0 cosmetics / `pro_users` unchanged at 21 / 0 leaked test rows).

Also written this session: two Claude Code handoffs + the raffle rules draft (below).

---

## 3. Handed off to Claude Code (app code — Cowork can't push)

1. **`docs/handoff-2026-06-04-rewards-delivery-followups.md`** — wire the engagement earns (watchlist/scout, + an allowlisted `/api/rewards/track` for the public squeeze view); render + equip cosmetics; reflect instant delivery + Pro expiry in the `/rewards` UI; admin raffle-draw button; merch shipping-address capture before activating swag.
2. **`docs/handoff-2026-06-04-rewards-referral-wiring.md`** (refreshed earlier) — the client half of referrals (capture `?ref`, send it in the verify body). The server already credits + blocks self-referral.

Neither is shipped (no git creds in this session) — they're ready for you to run through Claude Code.

---

## 4. Suggested improvements (prioritized)

**Now / via the handoffs (P1):** ship the delivery follow-ups (earns + cosmetics UI + instant-delivery copy) and the referral wiring. These make the loop feel complete before any user sees it.

**Soon (P2):** add a global per-user daily earn cap as defense-in-depth (individual rules are capped, but nothing caps total/day); calibrate point values from real behavior once the Monday `rpc-rewards-weekly-pulse` has data; consider a login-streak bonus (cheap retention, Phase-2-lite).

**Your call (P3):** the partner-funded Moment/pack prizes via **Flow grants + direct Dapper** (do this when there's a few weeks of engagement data to pitch with — not Flow Rewards, which is dormant); legal review of the raffle before activating it; the bigger Phase-2 depth (seasons, trade-in desk, leagues) only once there are users to retain.

**Economy curve as it stands** (for your sanity check): a new user earns ~850 on day one (link 500 + profile 250 + team 100) + ~25/day baseline, rising to ~75/day once engagement earns are wired. Cheapest reward is the 250 border (instant gratification right after verifying); Pro (1500) is ~1.5 weeks of active engagement; a Moment (2000) is a real grind. Reads sane to me; tune once you see real behavior.

---

## 5. What I deliberately did NOT do

- **No app-code pushes** — no git credentials here; all app changes are handoffs, not silent edits.
- **Nothing off-limits** — no FMV/pricing/ingest/pack-EV/concierge/sniper/`proxy.ts`/secrets/hot-wallet changes (per CLAUDE.md autonomous guardrails).
- **No user exposure** — didn't activate merch (no address capture yet), didn't activate the raffle (no rules yet), didn't push `/rewards` to anyone.
- **No real points moved** — every functional test ran inside a transaction that rolled itself back; `pro_users` and the ledger are untouched.
- **Didn't edit `docs/overnight/ledger.md` or `CLAUDE.md` from Cowork** (the mount truncates large docs). Ledger line for you/Claude Code to add:
  > Rewards delivery — shipped live 2026-06-04 (5 `audit_20260604_rewards_*` migrations: delivery infra, redeem auto-deliver+lock, raffle safety, economy tune+swag, pro-plan fix). Pro+cosmetics now deliver instantly; raffle deactivated pending rules; concurrency double-spend closed. App follow-ups: `docs/handoff-2026-06-04-rewards-delivery-followups.md`. Reverts in the overnight report.

---

## 6. Revert appendix

Each migration is additive and independently reversible:

- `…_fix_pro_plan_value` → re-`CREATE OR REPLACE fulfill_redemption` with the prior body (or just leave it; `admin` is correct).
- `…_economy_tune_and_swag` → `DELETE FROM shop_items WHERE sku IN ('cos_border_classic','merch_stickers','merch_tee'); UPDATE points_rules SET daily_cap=NULL WHERE action_key='referral_verified';`
- `…_raffle_safety` → `DROP FUNCTION draw_raffle(bigint,text); DROP TABLE raffle_draws; UPDATE shop_items SET active=true WHERE type='raffle';` (only re-activate the raffle with rules in place).
- `…_redeem_autodeliver_and_lock` → re-`CREATE OR REPLACE` the prior `redeem_shop_item`/`award_points` bodies (in the first rewards handoff / migration history).
- `…_delivery_infra` → `DROP FUNCTION fulfill_redemption(bigint,text,text,text); DROP TABLE user_cosmetics; ALTER TABLE profile_bio DROP COLUMN equipped_border, DROP COLUMN equipped_banner; UPDATE shop_items SET requires_verified_wallet=false WHERE type='pro';`

Full teardown of the whole program is in `docs/handoff-2026-06-04-rewards-program.md`.

---

*Good night — nothing here is live to users, and the Monday pulse will start watching automatically. Morning priorities, in order: skim this, run the two handoffs through Claude Code, and (when you want) put the loop through its paces yourself to see the delivery work end to end.*
