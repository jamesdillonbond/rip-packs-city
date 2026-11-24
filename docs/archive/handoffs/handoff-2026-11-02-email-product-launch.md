# Handoff — Turn on the email product (WAU lever)

Authored 2026-11-02 (Cowork, read-only session). HEAD at authoring: `7e2ce69f8`, branch `main`.
Source analysis: `claude/build-brief-2026-11-01-unlock-anon-return-loop.md` (project) + the monthly review.

**Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.** Paths below were grepped live and exist, but line numbers drift.

## Status — 2026-11-02 ~8:50 AM PT (Cowork cloud)

- **Stage A — SHIPPED** (`15ed629f2`, verified live): A1 the confirm link renders its own public page (`/api/subscribe/verify`, no `/dashboard` redirect; says "confirmed" only on a matched token — an unknown token now reads "We don't recognise this link", 404); A2 `DealWatchCapture` on the wallet collection tab (`surface="collection"`); A3 on the `/insights/tc-report` result (`surface="tc-report"`). Both rendered at 390 px in production with no horizontal scroll.
- **B2 — CHECKED: deal alerts to `email_subscribers` have NO sender.** `email_subscribers.deal_alerts` is written by `/api/subscribe` and `/api/email/subscribe` and read only by admin analytics; the deal-alert engine (`dispatch_due_deal_alerts` / `alerts-dispatch`) serves the signed-in `alert_subscriptions` path. So at the Stage B flip, launch **digest-only**: flip `InsightsEmailCapture` to live weekly-digest copy, and leave `DealWatchCapture` on its "coming soon" deal-alert copy (its submit already sets `digestWeekly: true`, so those signups get the digest).
- ✅ **Stage B SHIPPED 2026-11-02 ~12:00 PM PT (Trevor supplied the address + go).** `RPC_SENDER_POSTAL_ADDRESS` (Vercel prod env only — the repo is public, so the value is never committed) and `SEND_DIGEST_ENABLED=1` set; `/api/send-digest` on a Vercel cron Mondays 8:23 AM PT (`23 16 * * 1`), now accepting CRON_SECRET, deduped per week via `alert_deliveries`, logging `pipeline_runs` (`send-digest`), with a counts-only `?dry=1`. B1: `InsightsEmailCapture` says "Weekly digest · every Monday" and describes what the email actually contains (deals below FMV + the 24 h market pulse — the old copy promised squeeze movers / +EV packs / rookie cohorts, none of which it sends); `DealWatchCapture` keeps deal alerts "coming soon" and now SAYS its signups get the Monday digest (the submit has always set `digestWeekly`).
- ✅ **11-09 FIRST LIVE SENDS VERIFIED (~8:50 AM PT, Claude Code cloud, scheduled check).** (A) Subscriber digest: the 8:23 AM PT Vercel cron run is ok=true, sent 0, `already_sent_this_week` 1 — the week's one send went out at **8:01 AM PT** from a run outside the cron schedule (ok=true, sent 1 = the 1 verified digest subscriber, errors 0; caller not identified — no pg_cron job, not in `vercel.json` at that minute); `alert_deliveries` `subscriber_digest` / bucket `2026-11-09` = 1 row. (B) Portfolio email: 8:33 AM PT run ok=true, **sent 8, skipped 15, guard_errors 0, skipped_incomplete 0**, 3.7 s; 8 `weekly_portfolio` deliveries, all `sent` at 8:33 AM PT (rippackscity −24.6 %, tetrislblock −22.8 %, notwhitelisted −11.9 %, juiceshack −9.5 %, webz_80 −8.5 %, jamesdillonbond −6.3 %, absolutsiikness −6.1 %, alxo −5.2 %). **Day-by-day check of every recipient's 11-02 → 11-09 `portfolio_snapshots` series: no one-day move > 50 % and no flip-flop** (largest: rippackscity −22.2 % on 11-04→11-05, tetrislblock −20.3 % on 11-02→11-03, both single steps that held) → `WEEKLY_DIGEST_ENABLED` left on. ⚠ Not sent but would have failed the check: vinosuas (88.5k → 68.7k → 81.3k flip on 11-05/11-06) and thunderhour (+36.6 % step 11-05→11-06) were among the 15 skipped. ⚠ Nearly every series steps down 5–9 % on 11-04→11-05, which lines up with the 11-04 FMV haircut changes — so part of this week's "▼" is a pricing-model change, not the market. Vercel runtime logs show no entries (no 307 to /login, no errors) for either path 8:00–8:40 AM PT; the `pipeline_runs` rows prove CRON_SECRET matched.
- ✅ **11-03 ~7:15 AM PT: `WEEKLY_DIGEST_ENABLED=1` and `/api/cron/weekly-digest` Mondays 8:33 AM PT** — #227's gate met (0 overnight FMV reversals, snapshot hold in place, 3 movers with clean series). Earlier status: ~~⛔ **`WEEKLY_DIGEST_ENABLED` (the portfolio-movers email to signed-in users) stays OFF — known-issues #227.** Its dry check would have mailed a real collector "+990.9 %" from a partial Sunday snapshot; the reader is fixed but one portfolio's FMV still flip-flops ~$2.7k day to day. `SIGNUP_REMINDER_ENABLED` left off: 0 eligible recipients today, and it needs a schedule when it matters.

## Context

The email product (weekly digest, portfolio digest, deal alerts) is **already built and hardened** and deliberately **dark behind feature flags**. The anon capture path `app/api/subscribe` is live, rate-limited, double-opt-in. The two capture widgets are intentional WAITLISTS ("launching soon"/"coming soon") because the senders are flag-disabled "until Trevor's go." `email_subscribers` = 1 as a result. This handoff makes the product real and places the capture where intent concentrates. Nothing here was shipped by Cowork.

Decision taken (Trevor, 2026-11-02): **prep everything, HOLD the live flip.** So Stage B (copy→live + flag flip) does NOT ship until Trevor supplies the CAN-SPAM postal address and says go. Stage A is safe to ship now.

## Operator pre-reqs (Trevor only — blocks Stage B)

1. `RPC_SENDER_POSTAL_ADDRESS` — a real physical address. `commercialSendBlockedReason` refuses to send without it. Legal (CAN-SPAM).
2. Vercel prod flags for Stage B: `WEEKLY_DIGEST_ENABLED=1`, `SEND_DIGEST_ENABLED=1`, optionally `SIGNUP_REMINDER_ENABLED=1`.

## Verify FIRST (dry-run — sends nothing)

Each sender has a dry-run that builds everything and sends nothing, ignoring the flag. Run on the box (needs the cron/ingest token in env) and eyeball the HTML before any live flip:

- Weekly digest: `app/api/cron/weekly-digest` dry-run param (see the route header comment for the exact query string).
- Portfolio digest: `app/api/send-digest` dry-run.
- Signup reminder: `app/api/cron/signup-reminder` dry-run.

Confirm: portfolio block renders for a wallet-attached subscriber, unsubscribe link present, no empty/zeroed digest. Only then consider Stage B.

## Stage A — safe to ship now (no email goes live)

### A1. Fix the verify redirect — `app/api/subscribe/verify/route.ts`
An anonymous confirmer currently lands on `/dashboard?verified=true`, a sign-in surface — a dead end for someone with no account. Redirect to a friendly PUBLIC confirmation page instead (e.g. `/subscribed` or `/?subscribed=true`). Full file is 31 lines; change only the two `NextResponse.redirect` targets (success + failure) to public routes. Revert: restore the `/dashboard?verified=` targets.

### A2. Place the capture on the #1 intent surface — `components/collection/CollectionMomentTable.tsx` (1155 lines; 172 of 222 outbound clicks)
Mount a capture near the table (below the FMV-alert form region, ~line 890+). Reuse `DealWatchCapture` (default export, props `{ wallet }`) — but the table is collection-scoped, not wallet-scoped, so either (a) a thin collection-scoped variant, or (b) pass the collection context. Keep WAITLIST copy until Stage B. CC: inspect the component's actual prop/scope shape and pick the cleaner path.

### A3. Place the capture on the other wallet-paste destination — `/insights/tc-report?wallet=`
`WalletSearch` (`components/WalletSearch.tsx`) routes pastes to `/share/<wallet>` (already has `DealWatchCapture`) OR `/insights/tc-report?wallet=` (has none). Add `DealWatchCapture` to the tc-report result, same placement as the share page (`app/share/[wallet]/page.tsx` imports it at line 8 and renders it after the FMV card — replicate that).

Stage A verification: `npx tsc --noEmit` clean; Vercel deploy READY; a 390px + 320px render pass on `/insights/<collection>` moment table and `/insights/tc-report?wallet=<addr>`; capture renders and the waitlist submit still returns `{success:true}` + fires `email_capture_submitted`.

## Stage B — ships WITH the flag flip only (gated on operator pre-reqs)

### B1. Flip copy from waitlist to live
- `components/insights/InsightsEmailCapture.tsx`: remove the "Weekly digest — launching soon" eyebrow + "once it launches / first on the list" lede; promise the live weekly digest.
- `components/DealWatchCapture.tsx`: remove "Deal alerts · coming soon" + "aren't live yet … we'll let you know when they are"; promise live deal alerts. ⛔ Only if B2 confirms deal alerts actually send to email_subscribers — otherwise leave the deal-watch box on digest-only live copy and keep deal alerts waitlist.
- ⚠ Do NOT ship B1 before the flags are on, or the UI promises a live product that sends nothing.

### B2. Confirm the deal-alert → email_subscriber wiring (#214)
#214 noted `email_subscribers.deal_alerts` had no sender wired to it (distinct from the `owner_key` `alert_subscriptions` engine that `alerts-dispatch`/`alerts-send` drive). Verify a verified subscriber with `deal_alerts=true` actually receives mail end-to-end. If not wired, either wire it or launch digest-only first.

Stage B verification: flags set in prod; one real dry-run diffs clean; a single live test send to a controlled inbox renders + unsubscribes correctly; `email_subscribers` verified count starts climbing.

## Guardrails (repeat every handoff)

- Direct to `main`, no branches/PRs. If a `claude/*` branch is checked out, switch to `main` first.
- Commit via PowerShell `git` (Git Bash commit can silently no-op). Re-verify push: `git rev-list --count origin/main..HEAD` → 0.
- Vercel REST from PowerShell `Invoke-WebRequest`, not Git Bash `curl`.
- No migration needed — `email_subscribers` and all tables already exist.
- Abuse caps already live in `/api/subscribe` (10/day IP, 3/day email, 500/day global, fail-closed) — do not weaken them.

## Expected end state

Stage A: capture placed on the two high-intent surfaces + a clean public verify landing, still waitlist — on `main`, deploy READY. Stage B (on Trevor's go + postal address): copy goes live, flags flipped, the first real digests send, verified `email_subscribers` and WAU/D7-return begin to climb toward the 100 gate.
