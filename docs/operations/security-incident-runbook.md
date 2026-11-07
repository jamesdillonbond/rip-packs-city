# Security incident runbook

Written 2026-11-04 from the CISO pass (`docs/audits/2026-11-04-ciso-security-audit.md` §6 asked for one place to look). One person runs this platform, so every step names the ONE screen or command, in order. Times to Trevor are PT. Re-check the legal numbers against the audit's sources before relying on them — they are dated samples like everything else here.

## 0. What RPC holds, so you know what an incident can expose

- **Personal data:** login e-mail (Supabase `auth.users`), chosen username / bio / avatar URL (`profile_bio`), saved wallet identifiers and usernames (`saved_wallets`, `wallet_usernames` — public on-chain identifiers, but tied to an e-mail here), `email_subscribers`, support-chat transcripts (`support_conversations`, `chat_sessions`), feedback rows, `usage_events` (page views keyed by user id / visit id). No passwords (magic link only), no payment data (no Stripe customers while dormant), no government IDs, no private keys of any user.
- **Not held, by design:** custody of any asset. The trade room is shape A (two authorizers, no escrow) — RPC relays a signable, it never signs for a user. That is what keeps the Candy Digital failure class (custodial keys drained, Oct 2026) off the table; **re-read §3 before changing that shape.**
- **Secrets that would matter if leaked:** the Vercel `sensitive` vars (service-role key, Resend, Telegram, Anthropic, `CRON_SECRET`, `TS_PROXY_SECRET`; `TOPSHOT_SUBEDITION_KEYING` is a flag — `RPC_API_KEY` and `MARKET_FEED_TOKEN` were dead and DELETED 2026-11-06; rotation map: `docs/operations/secret-rotation-plan-2026-11.md`), `RPC_ADMIN_TOKEN`, `INGEST_SECRET_TOKEN`, the edge-function gate keys, the Flow hot wallet `0x3aa11c84d776838f` (giveaway delivery only), the GitHub push credential.

## 1. Detect — what fires, and what does not

- The sentinel (Telegram + `/admin/alerts`), the smoke suite, the scheduled `E2E DOM Smoke` badge, Vercel runtime errors, Supabase advisors. A **client-only** failure reaches nothing but the `usage_events.client_error` beacon.
- GitHub: secret scanning + push protection are ON; Dependabot alerts are ON (11-04).
- Nothing watches: a provider-account takeover (Vercel/Supabase/GitHub/Cloudflare/Resend/cron-job.org logins) — MFA on each account is the control, and the April-2026 Vercel incident is the reason. **Read 2026-11-06 in Trevor's Chrome:** Supabase ✅ (2 authenticators) · Vercel ✅ (TOTP) · GitHub ✅ (authenticator app, required) · **cron-job.org ✅ TOTP device added by Trevor ~9:55 PM PT** (was none at 9:45 — it holds the bearer/gate tokens of ~67 jobs) · Cloudflare and Resend not signed in on that browser — unverified.
- **A failed read rendering as a fact is not an incident; a write landing from an unexpected caller is.** Read `pipeline_runs` / `cron.job_run_details` for the caller, not the dashboard badge (CLAUDE.md, Honesty).

## 2. Contain — in this order, each reversible

1. **Stop autonomous shipping:** create `docs/FREEZE.md` on `main`.
2. **Stop user signing:** Vercel env `RPC_TRADE_ROOM_EXECUTE` → off, then **Redeploy** the current production deployment (a Vercel env change only reaches the next deployment); verify `/trades` shows signing closed.
3. **Stop abuse at the edge:** Vercel → Firewall → Attack Challenge Mode (free, instant); add a deny rule for the offending path/IP under "Block sensitive paths".
4. **Cut a leaked secret:** rotate at the PROVIDER first (Supabase service-role key, Resend key, Telegram `BotFather /revoke`, Anthropic console, GitHub token), then paste the new value into Vercel (type `sensitive`), then the edge-function secret store / GitHub Actions secret where the same value lives (`docs/reference/tooling-gotchas.md` lists the surfaces). ⛔ Never paste a secret into a Claude session — it lands in the transcript (the 2026-08-18 nine-key leak).
5. **Kick sessions:** Supabase → Authentication → Users → remove the user's sessions (or delete their `auth.sessions` rows via the SQL editor); admin browser sessions expire in 12 h on their own (`lib/admin-session.ts`), or rotate `RPC_ADMIN_TOKEN` to void them all.
6. **Worst case:** Supabase → pause project (reads stop; the site degrades honestly through the error helpers). Vercel → pause project if the app itself is the problem.

## 3. Assess — before any notice goes out

- Which tables were read or written, by whom, when: Supabase → Logs (Postgres + API), `pg_stat_statements`, `pipeline_runs`, the Vercel runtime logs (search ≤ 4-day windows, per `tooling-gotchas.md`). Write the timeline into `docs/audits/<date>-incident-<slug>.md` as you go.
- **"Covered" personal information under Oregon's breach law** is the e-mail + anything that lets someone log in or impersonate; a dump of public wallet addresses alone is not. Decide, and write down why.
- Count affected Oregon residents (user e-mails joined to whatever location signal exists — usually none; assume the worst until shown otherwise).

## 4. Notify — the clocks (from the 11-04 audit's reading of the statutes; confirm before sending)

| who | when | how |
|---|---|---|
| Affected users | Oregon: ≤ 45 days from discovery · California residents: ≤ 30 days (from 2026-01-01) | Resend broadcast from the sending domain; plain language: what happened, what was exposed, what we did, what they should do (change wallet-site passwords if reused, watch for phishing that mentions RPC). ⛔ No marketing in it; no tracking links. |
| Oregon Attorney General | same window, if > 250 Oregon residents | Oregon DOJ consumer-protection breach report |
| Other state AGs | per state thresholds | only if residents there are affected |
| Providers | immediately if their key/system is involved | Vercel, Supabase, Resend support tickets; GitHub Support for a credential in history (ticket #4811268 is the precedent) |
| Users of the trade room | immediately, regardless of threshold, if any signable or relay was tampered with | the room notice path (`lib/trade-room/notify.ts`), then e-mail |

FinCEN / MSB obligations do not apply while RPC is non-custodial. COPPA: no under-13 data is knowingly collected (`/terms` 18+).

## 5. Recover and close

- Rotate everything the incident could have touched, not just what it did touch; re-run the audit's VERIFIED-CLEAN probes (register R143–R150's evidence column); check `secdef_anon_exec_allowlist` drift and RLS on every exposed table (Supabase advisors).
- Remove `docs/FREEZE.md`; re-enable `RPC_TRADE_ROOM_EXECUTE` only after a two-wallet test trade seals.
- Postmortem in `docs/audits/`, a register row, a ledger entry, and one durable lesson promoted to CLAUDE.md or the matching `docs/reference/*.md`. Blameless; name the control that was missing, not the person.

## Where the standing posture lives

`docs/audits/2026-11-04-ciso-security-audit.md` §6 — identity, authorization, signing, supply chain, data, abuse, detection, cadence (next full audit **2027-02-04**).
