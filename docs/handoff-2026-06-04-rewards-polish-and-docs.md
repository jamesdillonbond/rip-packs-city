# Handoff — Rewards polish + docs reconciliation (final two items) — 2026-06-04

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

================================================================
CONTEXT
================================================================
The rewards program is functionally complete (DB live via Cowork; app commits c689771, 830bfdb, 7ede297, cc82283 all READY). Two things remain that only Claude Code can do: a UX nudge on the verified-wallet gate, and reconciling CLAUDE.md + the overnight ledger with the whole rewards workstream (unsafe to edit those from Cowork — the mount truncates big docs).

Also FYI, shipped DB-side since cc82283 (no app work needed): add_moment_shop_item(edition_external_id, serial, cost_credits[, min_status, collection]) — SECDEF stocking helper that builds a complete Moment shop item from editions (name/image/tier, stock=1, verified-wallet gated). Trevor stocks the store by picking Moments; Cowork runs the calls.

================================================================
ITEM 1 (P1, small) — turn the verified-wallet gate into an onboarding nudge
================================================================
Files: app/rewards/page.tsx (+ its client component), app/api/rewards/summary/route.ts.

1a. summary: add hasVerifiedWallet boolean to the payload — exists(SELECT 1 FROM saved_wallets WHERE user_id = <session uid> AND verified_at IS NOT NULL) via supabaseAdmin.

1b. /rewards UI, two touches:
  - Passive: when hasVerifiedWallet is false, show a small banner/chip near the shop: "Verify your wallet to unlock Moment + Pro rewards (and earn 500 credits)" linking to the Dapper sign-in flow (the SignInWithDapper surface on /profile — link to wherever that component lives today).
  - Active: when a redeem returns error 'verified_wallet_required', render that same CTA instead of a raw error string. The gate is the sybil protection — the goal is to make hitting it feel like the next step, not a failure.
Do NOT weaken the gate itself (no changes to redeem_shop_item / requires_verified_wallet flags).
Revert: remove the banner + error-CTA branch + the summary field.

================================================================
ITEM 2 (P1, docs) — reconcile CLAUDE.md + docs/overnight/ledger.md
================================================================
The rewards workstream is invisible to the autonomous passes until it's in the ledger. Add (adapt formatting to the files' existing style):

Ledger (under Shipped):
Rewards program (2026-06-04, Cowork DB + CC app): off-chain points economy shipped end-to-end. DB: 11 audit_20260604_rewards_* migrations (core tables/SECDEF fns/owner views/seed; delivery infra incl. user_cosmetics + fulfill_redemption; redeem auto-deliver + per-user advisory lock; raffle safety with draw_raffle + raffle items HELD inactive pending official rules; economy tune + swag; pro plan='admin' fix; global daily earn cap via rewards_config; add_moment_shop_item stocking helper). App: c689771 (/rewards hub, redeem/summary, earn hooks, /admin/rewards), 830bfdb (referral client wiring), 7ede297 (engagement earns, cosmetics render/equip, raffle draw UI, shipping endpoint), cc82283 (gift-to resolution end-to-end, merch address modal, merch ACTIVATED). Security invariant: no user-writable points path; all mutations via service_role-only SECDEF fns; RLS on all rewards tables. Monitoring: Cowork artifact rpc-rewards-console + scheduled task rpc-rewards-weekly-pulse (Mon). Status: DIAL-IN, not user-facing; store stocking awaits Trevor's Moment picks. Revert paths: docs/rewards-overnight-report-2026-06-04.md appendix + the four rewards handoff docs.
Also add to the ledger's "Declined — do not re-suggest" ONLY if Trevor wants: nothing declined this workstream.

CLAUDE.md Recent sessions (compact entry, top of the section):
### June 4, 2026 — Rewards program shipped end-to-end (off-chain points economy; dial-in, not user-facing)
2-3 sentences max + pointers: strategy doc, overnight report, the four handoffs, the security invariant line, and the note that raffle items are held pending docs/rewards-raffle-official-rules-DRAFT.md legal review and that Flow Community Rewards is dormant (partner path = Flow grants + direct Dapper). Keep it tight — the detail lives in the docs.

Stage ONLY these two files plus nothing else (concurrent-session staging hazard — stage by path, never git add -A).

================================================================
GUARDRAILS
================================================================
- Direct to main, no branches/PRs. PowerShell git; git rev-list --count origin/main..HEAD = 0 after push.
- tsc --noEmit clean; Vercel deploy READY (docs-only changes still deploy — confirm READY).
- Supabase client typed as any; no proxy.ts changes; do not touch the points security model.

================================================================
VERIFICATION
================================================================
- Logged in without a verified wallet: /rewards shows the verify banner; attempting a Moment/Pro redeem shows the CTA (not an error string). After verifying: banner gone, redeem proceeds.
- CLAUDE.md + ledger render correctly on GitHub (no truncation — verify file sizes vs HEAD before committing).

================================================================
END STATE
================================================================
One commit on main, deploy READY. The verified-wallet gate reads as onboarding instead of rejection, and the autonomous passes + future sessions can see the entire rewards workstream in the ledger/CLAUDE.md with revert paths. After this: nothing remains on the app side — the program waits only on Trevor's dial-in test and his Moment picks for the store.
