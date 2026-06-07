# Handoff — rewards polish wave 2 (P/L privacy, cold-wallet verify, cosmetics wave 2, docs sweep) — 2026-06-07

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins on any disagreement. Direct to main, no branches/PRs.

================================================================
STEP 0 — push what's pending
================================================================
git status first. Several finished docs are sitting in the tree (the dial-in checklist edits, the executed referral/declutter/og-share handoffs, this file). Commit + push them by EXPLICIT PATH (never git add -A — concurrent-session hazard).

================================================================
ITEM 1 (small) — Net P/L becomes own-view-only on public profiles
================================================================
File: app/profile/[username]/page.tsx — the Cost Basis card currently shows TOTAL SPENT / CURRENT FMV / NET P/L (big red −$361.0K −79.3% on Trevor's) to EVERY visitor.
Default behavior to implement: keep TOTAL SPENT + CURRENT FMV public; render the NET P/L row ONLY when the viewer is the profile owner (the page already does an own-profile check for the Share buttons via /api/profile/me — reuse it).
(Trevor: if you'd rather keep P/L fully public, delete this item before dispatching.)
Revert: git revert.

================================================================
ITEM 2 (small) — cold-wallet fallback in the verify mint route
================================================================
File: app/api/profile/verify-challenge/route.ts (POST/mint path).
Today: if pick_verification_target returns no rows (wallet not yet indexed in wallet_moments_cache — true for any brand-new signup whose prewarm hasn't run), the user gets the "verification by listing unavailable" dead end.
Change: when the picker comes back empty AND the wallet has no wmc rows at all, (a) fire the existing wallet-backfill for that wallet (fire-and-forget, same pattern other surfaces use — POST /api/wallet-backfill with the Bearer INGEST_SECRET_TOKEN server-side), and (b) return a distinct response the modal renders as "We're indexing your collection — give it a few minutes and try again." Keep the true unavailable message only for wallets that genuinely have no displayable Moments after indexing.
Revert: git revert.

================================================================
ITEM 3 (small) — cosmetics wave 2 CSS + activation
================================================================
Cowork seeded three INACTIVE shop items (audit_20260607_rewards_cosmetics_wave2_staged):
  cos_border_ice    border:ice    500 credits
  cos_border_gold   border:gold   800 credits, min_status 500 (Role Player)
  cos_banner_nova   banner:nova  1200 credits, min_status 2500 (Starter)
Add the three styles to the shared maps in lib/cosmetics.ts (border ring treatments for ice + gold, banner treatment for nova) using brand tokens — no hardcoded hex except via tokens; visually distinct from classic/flame/ripcity. They render in the same places the existing cosmetics already do (profile avatar ring / banner, /rewards equip section) — no new wiring, just map entries.
POST-DEPLOY (only after the styles are live): UPDATE shop_items SET active=true, updated_at=now() WHERE sku IN ('cos_border_ice','cos_border_gold','cos_banner_nova');
Verify: redeem-and-equip one on a test basis renders correctly on /profile.
Revert: deactivate the rows + git revert the CSS.

================================================================
ITEM 4 (docs) — ledger entries for the un-recorded ships
================================================================
docs/overnight/ledger.md Shipped block is missing the last three commits. Add one consolidated line (match the file's style):
  Rewards/profile wave (2026-06-07): ba8a28e referral-on-challenge-verify wiring (rpc_ref -> p_referrer; DB guards); 0dfb01d public-profile declutter (trophy case x6 under KPIs; badges/sparkline/tier-breakdown/sniper-deals unmounted; saved wallets by collection); 6f4a2d5 profile OG card un-hollowed (owner_key->user_id keying; cached_fmv_usd) + share buttons (X intent/copy, UTM) + share_profile earn ACTIVE (+50/day, track allowlist). Cowork DB same window: owner_attested verification + admin_verify_wallet (Trevor attested), resolve_wallet_challenge_match (+p_referrer), pick_verification_target + target_* columns, global_daily_earn_cap, add_moment_shop_item, catalog policy (no physical/no chance; raffle deleted, mystery+merch held), cosmetics wave 2 staged. Reverts: git revert per commit; DB reverts in the dated handoffs.
Optional rider while in the listing-cache file for nothing else: the resolve_wallet_verification_challenges() call in app/api/topshot-listing-cache/route.ts (~L409-424) matches against frozen cached_listings and can never resolve — harmless no-op; remove the call or leave it with a comment. Either is fine.

================================================================
GUARDRAILS + VERIFICATION
================================================================
- tsc clean; deploy READY; explicit-path staging; no proxy.ts/security-model changes.
- Live checks: anon view of /profile/jamesdillonbond shows Total Spent + FMV but NO Net P/L row; own view still shows it. New-wallet mint path returns the indexing message instead of unavailable. The three new cosmetics appear in the shop only after their CSS deploys + activation UPDATE.

================================================================
END STATE
================================================================
Public profiles stop broadcasting losses, brand-new users can't dead-end in verification, the zero-cost shelf has a 250->500->800->1200 ladder across two tiers of status, and the ledger reflects reality. After this: the board is genuinely clear — everything else waits on Trevor (checklist, Moment picks, Dapper request, cohort) or on data.
