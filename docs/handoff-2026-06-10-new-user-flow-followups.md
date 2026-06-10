# Handoff 2026-06-10 — new-user flow follow-ups (activation leaks from the first organic signup wave)

## Context

Eight organic signups landed tonight (2026-06-10 01:29-02:17 UTC). The prewarm/backfill half of onboarding is now solid (21929f6 + tonight's Cowork migrations), but watching real users go through the funnel exposed four post-approval leaks. Evidence per item below. HEAD at time of writing: 21929f6.

Already shipped live by Cowork tonight (do NOT redo):
- Data heals: forced backfills for katzler/vinosuas/edogg-real-wallet; seeded_wallets rows for all 8 (migrations audit_20260610_seed_allowlist_signup_wallets + _wave2 + username fills); allow_list wallet corrections for miaflsurf (audit_20260610_fix_miaflsurf_allowlist_wallet) and edogg (audit_20260610_fix_edogg_allowlist_wallet); pre-saved banana_boat's saved_wallets rows (audit_20260610_presave_banana_boat_wallet).
- DB half of Item 4: migration audit_20260610_auto_approve_eligible_onchain_moments_signal — auto_approve_eligible gained a 5th param p_onchain_moments integer DEFAULT NULL (+40 when >0, +20 more when >=100, reasons wallet_has_onchain_moments / wallet_has_substantial_collection). The old 4-param overload was DROPPED and the new fn is service_role-only. Existing 4-arg calls bind the new fn (verified live) — the deployed route keeps working unchanged.

No collision with the overnight ledger (nothing queued/declined touches allow-list, prewarm, early-access, or saved-wallets). All items are small; no FREEZE needed. Items are in priority order.

## Item 1 — auto-attach the allow_list wallet at first login (biggest activation leak)

Evidence: justin.studer07@gmail.com (banana_boat, 9,176 TS moments already cached) logged in 10 seconds after his welcome email and bounced before the save-wallet step — zero saved_wallets rows, so his dashboard keyed off nothing. 5 of tonight's 8 logged in within ~15 minutes; one of those 5 hit this.

Files (verified): app/api/profile/saved-wallets/route.ts (the POST upsert shape to mirror: onConflict user_id,wallet_addr,collection_id; accent_color defaults '#E03A2F'), app/auth/confirm/page.tsx (login landing, client).

Suggested change (CC's call on exact placement): in the saved-wallets GET handler, when the authed user has ZERO saved_wallets rows, look up allow_list by lower(email) via the service-role client; if status='active' and wallet_addr is present, upsert one row per published collection (mirror the POST shape: username from allow_list.username, pinned_at now(), leave verified_at NULL — verification stays with the listing challenge), then return the fresh list. That makes the attach self-healing on every surface that lists wallets, with no auth-flow changes. Guard: only when the user has zero rows EVER (a user who deliberately deleted wallets also has zero rows — acceptable at current scale; note it in a comment).

Watch out: the GET handler runs with the user's RLS context — the allow_list read must use the service-role client (supabaseAdmin), not the session client.

Revert: git revert the commit.
Verify: tsc clean, deploy READY; then delete-and-relist with a test account, or confirm the next fresh signup's first dashboard load shows their collection with no manual save.

## Item 2 — wallet sanity warning on the early-access form

Evidence: 2 of tonight's 8 typed a wrong/empty wallet (edogg gave a 1-moment wallet, real one had 5,400+; miaflsurf gave a 0-moment wallet, real one had 2,697 TS). Both needed manual SQL to fix.

Files (verified): app/early-access/page.tsx (form), /api/wallet-search is public (proxy.ts bypass) and returns summary.totalMoments.

Change: on wallet-field blur (or before submit), POST /api/wallet-search with { input: <wallet>, collection: "nba-top-shot" }; when it returns 200 with summary.totalMoments === 0, show a NON-BLOCKING inline warning, e.g. "This wallet shows 0 Top Shot moments on-chain — double-check it. You can find your address in your Dapper account settings." Never block submission (Golazos/UFC-only collectors legitimately have 0 TS moments); fail silent on fetch errors or timeouts (use an AbortController ~8s). Debounce so it fires once per blur, not per keystroke.

Revert: git revert the commit.
Verify: tsc clean, deploy READY, manual check on /early-access with a known-empty wallet shows the warning and still submits.

## Item 3 — welcome email dedupe on prewarm re-runs

Evidence: banana_boat has prewarm_attempts=2 and received the welcome email twice (welcome send fires unconditionally on every non-failed prewarm pass).

File (verified): lib/allow-list/prewarm.ts.

Change: in processSinglePrewarmRow, skip sendWelcomeEmail when the row already has welcome_email_sent_at set (and welcome_email_error is null), and skip the fallback-loading email under the same condition. The AllowListRow interface doesn't currently carry welcome_email_sent_at — extend it and make sure BOTH callers populate it (the drain route's claim payload via allow_list_claim_prewarm, and prewarm-now's manual row fetch; if the claim RPC's return shape doesn't include the column, do a cheap supabaseAdmin select of the two columns inside processSinglePrewarmRow instead — one read per prewarmed row is fine at this volume). Deliberate resends stay available via app/api/admin/resend-welcome (verified exists).

Revert: git revert the commit.
Verify: tsc clean, deploy READY; hit PREWARM NOW twice on a test row — exactly one welcome email.

## Item 4 — wire the on-chain count into auto-approval (route half; DB half is live)

Evidence: all 6 of tonight's manually-approved signups scored null/<60 — every positive signal except email-domain requires the wallet to already be in RPC's data. Real 4k+ collectors sat in pending until Trevor woke up.

File (verified): app/api/early-access/submit/route.ts (the auto_approve_eligible call around line 264).

Change: the inline 4-arg scoring call stays as the fast path. Add a slow path inside the existing after() block (first-time submissions only, wallet present, not already auto_approved/rejected): POST ${SITE_ORIGIN}/api/wallet-search with { input: wallet, collection: "nba-top-shot" } (public route; ~1-17s is fine inside after()); read summary.totalMoments; re-call auto_approve_eligible with p_onchain_moments set; re-apply the same decision branches the fast path uses (blocked -> rejected; score >= 90 -> active + auto_approved_at + approved_by='auto'; >= 60 -> record score).

Product decision for Trevor (default to strict if unsure): an unknown-to-RPC real collector now reaches 70-85 (onchain 40 [+20 substantial] + gmail 10 + maybe sales 15) — still below the strict 90 bar, so with 90 unchanged this feature rarely fires. Recommended: auto-approve when score >= 60 AND reasons include wallet_has_onchain_moments AND blocked_by is empty. Risk is low — read-only intelligence product, free beta, deny_list still hard-rejects, and the Telegram signup ping still fires for every signup.

If the slow path auto-approves, ALSO fire the prewarm so the user isn't approved-but-unprewarmed until an admin opens the console: simplest is a fire-and-forget POST to the prewarm-drain route with Bearer INGEST_SECRET_TOKEN (verify its claim semantics pick up status='active' + prewarm_status='pending' rows — adapt if the claim predicate differs). Check whether a cron already hits prewarm-drain on a cadence; if one does, this POST is just an accelerator.

Revert: git revert the commit. (DB revert if ever needed: restore the 4-param fn body from migration history and drop the 5-param overload — but the new fn is backward compatible, so app-only revert is safe.)
Verify: tsc clean, deploy READY; submit a test signup with a real wallet and confirm pipeline-of-events in allow_list: auto_approval_score recorded, status active (if the lenient rule is adopted), prewarm runs, welcome email sent once.

## Guardrails (standing)

- Commit and push directly to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s. No maxDuration changes should be needed here.
- CRLF: no string-replace patches on Windows; full-file writes or findIndex on split lines.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Expected end state

Commits on main, deploy READY: a brand-new signup with a real wallet auto-approves within seconds (if the lenient rule is adopted), gets prewarmed + backfilled with no human in the loop, receives exactly one welcome email, sees a warning if they typo their wallet, and lands on a populated dashboard on first login even if they skip the save-wallet step. Trevor's remaining role in onboarding drops to reviewing the Telegram ping and the sub-60 queue.
