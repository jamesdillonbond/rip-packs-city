# Incident and data-breach runbook

> Written 2026-10-11 (platform review C11). One page, meant to be followed under stress. Re-read the legal clauses before relying on them; they are the operator's understanding, not legal advice.

## What counts

- **Security incident:** unauthorised access to the Supabase project, Vercel project, GitHub repo, a leaked service-role key / bypass token / hot-wallet key, or a route found serving another user's private data (cost basis, email, shipping address, concierge transcript).
- **Personal-data breach:** any of the above where personal information left our control: emails (`auth.users`, `email_subscribers`, `allow_list`, `support_conversations.user_email`), shipping addresses (`redemptions.fulfillment`), linked wallets + account identity, concierge transcripts.

## First hour

1. **Contain.** Rotate what leaked: Supabase service-role key (Dashboard → Settings → API), `INGEST_SECRET_TOKEN` / `CRON_SECRET` (Vercel env + cron-job.org + GHA secrets — all three, per rpc-edge-fn-deploy §4), `RPC_ADMIN_TOKEN`, Resend key, the Flow hot-wallet key. A rotated bypass token stops every pipeline until cron-job.org and GHA carry the new one; that is acceptable.
2. **Preserve evidence.** Vercel runtime logs (`get_runtime_logs`, 7-day window), Supabase `query_logs`, `auth.audit_log_entries`, `usage_events`, `funnel_events`; export before they age out (`usage_events` purges at 31 d).
3. **Scope.** Which rows, which users, which window. Write it down with timestamps in PT.
4. **Freeze shipping.** Create `docs/FREEZE.md` so the autonomous passes stop.

## Notification duties (Oregon operator, US users)

- **Oregon Consumer Information Protection Act (ORS 646A.600–.628):** notify affected Oregon consumers without unreasonable delay and **within 45 days** of discovery; notify the Oregon AG if **more than 250** Oregon residents are affected. Covered data here is primarily email + account identifiers; the statute's definition should be re-checked against what actually leaked.
- Other states have their own thresholds and clocks; if affected users span states, notify on the strictest applicable timeline.
- **Vendors:** Supabase and Vercel each have a security contact; report if the compromise was on their side or used their credentials.
- **Users:** plain-English email from the Resend domain: what happened, what data, when, what we did, what they should do (rotate passwords is N/A — magic-link auth; advise watching for phishing that quotes their RPC data). Keep a copy.

## Ownership

- Trevor owns the decision to notify and the external message. Sessions (Claude Code / Cowork) prepare the scope query and draft, never send.
- Record the incident in `docs/overnight/ledger.md` (dated, PT) and open a known-issues entry with the root cause.

## After

- Root cause written up in `docs/audits/`; the fix carries a test that fails on the original defect.
- Review whether a retention period should shorten (less data = smaller blast radius): `run_weekly_log_purges` legs are the lever.
- Update `/.well-known/security.txt` contact if it changed.
