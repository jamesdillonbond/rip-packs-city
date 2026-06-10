# Handoff 2026-06-09 — reconcile 202+after() wrap (auto-disable immunity) + footer PRIVACY-clip fix

## Context

Cowork shipped the DB/ops half today: migration audit_20260609_watchlist_pinnacle_listing_cache_and_pinnacle_sync (then corrected by audit_20260609_unwatchlist_retired_pinnacle_listing_cache — net: pinnacle-sync watchlisted @1560m/medium), and via the cron-job.org console re-enabled the auto-disabled pinnacle-listings-reconcile entry (job 7589136) + test-ran it (200 OK 2.05s) — pinnacle_ask_stale_hours fell 19h -> 0.01h, trust-health BREACH cleared. This handoff covers the two remaining CODE items. Working tree verified at HEAD a9ab8a1 (docs push). Addendum record: docs/handoff-2026-06-09-session-closeout.md.

Why Item 1 is urgent: cron-job.org AUTO-DISABLES an entry after a streak of failed runs. Last night reconcile 500'd for 6.5h straight (26 consecutive failures, each 10-25s, during the 05-08:30Z DB-saturation window) and got silently disabled at 11:24Z; asks then froze 12.5h until tonight's manual re-enable. Any future saturation window repeats this unless the route stops surfacing failures to cron-job.org.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 (HIGH) — wrap /api/cron/pinnacle-listings-reconcile in the 202+after() CRON-30S pattern

File: app/api/cron/pinnacle-listings-reconcile/route.ts (verified; 104 lines; sync handle() that runs the RPC then returns 200/500).

This is the exact pattern already shipped in 76b6c2e for app/api/admin/analytics-smoke/route.ts and app/api/cron/lock-check-batch/route.ts — mirror those, do not invent a new shape.

Precise changes:
1. Import: add after to the next/server import (line 18), matching lock-check-batch line 1.
2. Keep ALL auth checks synchronous and unchanged (lines 31-35): missing-token 500, bad-token 401. cron-job.org must still see auth failures.
3. Move the entire body — the pinnacle_listings_reconcile RPC call, the extra{} bookkeeping, and the log_pipeline_run call (lines 37-86) — into after(async () => { ... }) unchanged. pipeline_runs remains the real success/failure signal (the pipeline is NOT watchlist-blind: trust-health pinnacle_ask_stale_hours breaches at 3h if the writer stalls, and the entry fires every 15min).
4. After scheduling the after(), return 202 immediately: NextResponse.json({ ok: true, accepted: true, pipeline: "pinnacle-listings-reconcile" }, { status: 202 }). Sub-second response, so cron-job.org can never see a failure streak or a 30s timeout again.
5. Update the stale header comment (lines 10-11 claim the RPC is "~ms... runs synchronously" — under contention it is 8-23s; that drift is what caused the auto-disable) to describe the 202+after() shape and reference the auto-disable incident.
6. Do NOT raise maxDuration past 60 (it's fine) and do NOT touch the RPC itself. The incremental-reconcile idea (option 2 in the overnight handoff) stays a separate, optional follow-up — the wrap alone removes the auto-disable failure mode, and the saturation windows are being attacked separately (DBSAT re-baseline).

Verification: npx tsc --noEmit clean; deploy READY; next :09/:24/:39/:54 tick shows Successful (sub-second) on the cron-job.org dashboard while pipeline_runs keeps logging real ok/error rows with editions_updated in extra; pinnacle_ask_stale_hours stays < 3 in v_rpc_trust_health.

Revert: git revert the commit.

## Item 2 (LOW, 2-line) — footer PRIVACY link clips on mobile: inline style defeats the media query

Files: components/SiteFooter.tsx (verified ~L173: the links div inside the .rpc-footer-bottom strip carries inline style justifyContent: "flex-end") and app/rpc-tokens.css (verified L954-975: .rpc-footer-bottom block + the 640px media query whose .rpc-footer-bottom > div { justify-content: center } is DEAD CODE because the inline style always wins).

Change:
(a) SiteFooter.tsx: remove justifyContent: "flex-end" from that div's inline style object (keep display flex, gap 16, flexWrap wrap).
(b) rpc-tokens.css: add a desktop default rule just above the existing @media (max-width: 640px) block: .rpc-footer-bottom > div { justify-content: flex-end; } — desktop rendering is then byte-identical, and the existing mobile center override finally applies, un-clipping the wrapped PRIVACY link.

Context note: an earlier in-flight edit attempting this exact fix was destroyed by the Windows-mount truncation incident on 2026-06-09 (rpc-tokens.css was restored from HEAD). This re-applies the intent cleanly.

Verification: npx tsc --noEmit clean; deploy READY; at <=640px width the footer bottom links center and PRIVACY is fully visible; desktop unchanged.

Revert: git revert the commit (pure presentation).

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Run the smoke test after deploy.
- While in the ledger: fold the addendum from docs/handoff-2026-06-09-session-closeout.md into docs/overnight/ledger.md (Cowork deliberately did not edit the ledger — mount-truncation repeat offender).

## End state

Two small commits on main, deploy READY: pinnacle-listings-reconcile is immune to cron-job.org auto-disable (the 19h-ask-freeze class can't recur), and the footer PRIVACY link renders centered and unclipped on mobile.
