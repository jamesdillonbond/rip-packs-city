# Handoff 2026-06-10 — onboarding: make approve/prewarm actually load the user's wallet

## Context

Tonight's first organic signup wave exposed a gap: the allow-list prewarm marks NBA TOP SHOT "complete" when /api/wallet-search returns 200, but NOTHING in the onboarding flow dispatches the real multicollection wallet backfill or creates a seeded_wallets row. Result: ts.edogg1976@gmail.com (wallet 0xec6119051f7adc31) sat at COMPLETE_PARTIAL with an empty dashboard — zero wallet_moments_cache rows — and the hourly reconciler would have skipped him forever because reconcile_allow_list_prewarm() hard-requires an active seeded_wallets row (the missing_seeded_wallets_row guard added after the juiceshack silent-fail; the guard works, the orchestrator half was never built). aaron.hickle only got full data because something hit /api/public/queue-wallet for his wallet 25s before approval.

Already done live by Cowork tonight (do NOT redo):
- Manual force multicollection backfill for 0xec6119051f7adc31 (all 5 collections scanned: TS 1, AllDay 3, UFC 1, Pinnacle 0, Golazos 0 — genuinely a 5-moment holder).
- Migration audit_20260610_seed_allowlist_signup_wallets: seeded_wallets rows for edogg1976 + giannistocleveland (tags ['early_access_signup'], priority 1, is_active true). Revert: DELETE FROM public.seeded_wallets WHERE username IN ('edogg1976','giannistocleveland');
- Ran reconcile_allow_list_prewarm() manually → edogg promoted to prewarm_status='complete'.

This handoff is the durable code fix so the next signup doesn't need manual intervention. No collision with the overnight ledger (no queued/declined items touch allow-list or prewarm). Both items below are small and safe; no FREEZE needed.

## Item 1 — prewarm orchestration dispatches the real backfill + seeds the wallet

File: lib/allow-list/prewarm.ts (verified exists; the orchestrator shared by prewarm-drain and prewarm-now). Touch only this file so both admin paths get the behavior.

Change: in processSinglePrewarmRow, after the resolveUsernameToWallet call and the TS seeder block (i.e. once row.wallet_addr is known), when row.wallet_addr is non-null:

1. Fire-and-forget POST to ${origin}/api/wallet-backfill-multicollection?force=true with header Authorization: Bearer ${process.env.INGEST_SECRET_TOKEN} and JSON body { wallet: row.wallet_addr }. The route ACKs in ~1s (dispatch phase; the heavy work runs in after()), so a plain await fetch with a short AbortController timeout (~15s) is fine — do NOT wait for backfill completion. On fetch error, log and continue; record something like backfill_dispatch: 'failed: <msg>' in the summary _meta so monitoring can see it. This is what creates the wallet_backfill_state rows the reconciler checks and what actually fills wallet_moments_cache so the dashboard isn't empty.

2. Upsert a seeded_wallets row via supabaseAdmin so the user enters the recurring scan rotation and the reconciler's missing_seeded_wallets_row guard passes. Schema facts (verified live): UNIQUE constraint is on username only (seeded_wallets_username_key); wallet_address has no unique constraint; username is nullable. So do a select-by-wallet_address first and insert only when absent (insert with username: row.username ?? null, wallet_address: row.wallet_addr, display_name: row.username, tags: ['early_access_signup'], priority: 1, is_active: true). Do not use ON CONFLICT (username) — a null username never conflicts and a username collision with an existing row should be treated as already-seeded, not an error. If the insert errors on the username unique key, swallow it (the row exists).

Ordering note: keep both steps BEFORE the allow_list_finish_prewarm call so a thrown error surfaces in attempts/telemetry, but wrap each in its own try/catch — neither should be able to flip finishStatus to failed or block the welcome email. The TS seeder result stays the only thing that determines failed.

Why not in the approve route or early-access submit: prewarm-now and prewarm-drain both funnel through processSinglePrewarmRow, and it runs after username→wallet resolution, which is the earliest point a wallet is guaranteed known.

Verified counts: reconcile_allow_list_prewarm() function body (live DB) requires EXISTS seeded_wallets WHERE wallet_address = row.wallet_addr AND is_active. Nothing in app/ inserts into seeded_wallets today (repo grep: only reads). The only DB fns that insert it are resolve_topshot_username, sync_seeded_wallet_to_username_cache, grant_pro_grandfather, discover_and_seed_active_wallets — none wired to onboarding.

Revert: git revert the commit.

Verify after deploy: npx tsc --noEmit clean; deploy READY; then either run a test prewarm via POST /api/admin/allow-list/prewarm-now on a dummy row, or wait for the next real signup and confirm (a) pipeline_runs shows wallet-backfill-multicollection-dispatch for the new wallet within ~1 min of prewarm, (b) seeded_wallets gains the row, (c) the next allow-list-reconcile tick promotes complete_partial → complete with no skipped_detail.

## Item 2 — admin allow-list page renders the _meta object as a garbage chip

File: app/admin/allow-list/page.tsx, around line 894-900 (verified): Object.entries(row.prewarm_summary).map renders every key, so the structured _meta sibling shows as "_META: [OBJECT OBJECT]" (visible in tonight's screenshot). The summary may also carry username_resolution_failure (a string — useful, keep it).

Change: filter entries to string values only, e.g. .filter(([k, v]) => typeof v === "string" && !k.startsWith("_")) before the .map. Optionally render found counts from _meta._meta is out of scope — just stop the garbage chip.

Revert: git revert the commit.

Verify: tsc clean, deploy READY, /admin/allow-list shows per-collection chips without the _META chip.

## Guardrails (standing)

- Commit and push directly to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. (No maxDuration change should be needed here.)
- CRLF: no string-replace patches on Windows; full-file writes or findIndex on split lines.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Expected end state

One or two commits on main, deploy READY: every future approved signup gets its wallet backfilled across all 5 collections and a seeded_wallets row automatically (reconciler promotes without manual SQL), and the admin card no longer shows the _META chip. Tonight's two users are already healthy and need nothing.
