# Handoff — Open the front door + onboarding conversion fixes (2026-07-20)

> **STATUS (2026-07-24): COMPLETE / SHIPPED.** P0–P2 shipped and verified live (front-door migration + funnel instrumentation + copy reconcile + email-capture + dashboard cached-value seed); the P3 follow-ups moved to `handoff-2026-07-21-p3-followups.md` (also complete). The 07-24 monitor pass closed the last open item (signup-funnel wiring). Retained as historical record; no pending work.

## Context

Trevor's directive (2026-07-20, interactive Cowork): **open the front door to self-serve signup, keep strong "sign up" nudges, and do the rest of the onboarding-audit fixes.** This supersedes the standing "invite-only closed beta" posture for *account creation* (browsing/search were already public). The full audit is in the project doc `claude/onboarding-audit-2026-07-20.md`.

**Already shipped LIVE by Cowork via Supabase MCP** (verified; NOT yet in a committed migration file — Priority 0 below commits it):
- `check_email_allowed(text)` rewritten to **allow-by-default** (anyone gets a magic link) *except* emails that are explicitly revoked on `allow_list` or matched by an active `deny_list` entry. Migrations `audit_20260720_open_front_door_check_email_allowed` then `audit_20260720_open_front_door_check_email_allowed_v2_denylist_types` (v2 fixed the deny type literal to `email_domain`). Verified: brand-new email → allowed; all 26 existing active users → still allowed; anon still cannot EXECUTE (ACL unchanged `{postgres,service_role}`); deny_list email + domain bans proven to block, then test rows removed (`deny_list` back to 0).

**This handoff covers the code** (copy/UX/instrumentation/retention), plus committing the migration + ledger, and reconciling the now-stale "invite-only" docs. Repo HEAD at time of writing: `896eef5` (`docs(health): commit the 2026-07-20 weekly health snapshot`).

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape. (Every file path below was grep-verified against a fresh clone of `main`, but the repo moves fast.)

---

## PRIORITY 0 — Reconcile the live auth change (do first)

The gate is already open in prod. Sync the repo and docs so a future session / the nightly pass doesn't "fix" the open gate back to invite-only.

**0.1 — Commit the migration file.** Create `supabase/migrations/<timestamp>_audit_20260720_open_front_door_check_email_allowed.sql` with the FINAL function below. It is **already applied to prod via MCP** — this file is for repo/rebuild parity; re-applying is harmless (idempotent `CREATE OR REPLACE`).

```sql
-- OPEN THE FRONT DOOR (2026-07-20, Trevor-directed). Allow ANY email to receive
-- a magic link / pass the authed-route gate, EXCEPT explicitly-blocked emails.
-- Ban hammer: an allow_list row with revoked_at set or a blocking status, OR an
-- active deny_list entry (exact email or whole domain via 'email_domain'), blocks.
-- Stays SECURITY DEFINER + STABLE + service_role-only ACL.
CREATE OR REPLACE FUNCTION public.check_email_allowed(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM public.allow_list a
      WHERE lower(a.email) = lower(trim(p_email))
        AND (
          a.revoked_at IS NOT NULL
          OR a.status IN ('revoked','rejected','banned','suspended','denied','blocked')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.deny_list d
      WHERE d.active IS TRUE
        AND (d.expires_at IS NULL OR d.expires_at > now())
        AND (
          (d.pattern_type = 'email'
             AND lower(d.pattern) = lower(trim(p_email)))
          OR (d.pattern_type = 'email_domain'
             AND lower(split_part(trim(p_email), '@', 2)) = lower(trim(both '@' from d.pattern)))
        )
    );
$function$;
```

**Revert (re-close the door to invite-only):**
```sql
CREATE OR REPLACE FUNCTION public.check_email_allowed(p_email text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.allow_list
                 WHERE lower(email)=lower(trim(p_email)) AND status='active');
$function$;
```

**0.2 — Ledger entry** (`docs/overnight/ledger.md`, splice at top of the dated section — re-read from disk first per CLAUDE.md):

> **2026-07-20 · Opened the front door — `check_email_allowed` now allow-by-default (self-serve signup).** Trevor-directed (interactive). Was invite-only (`EXISTS active allow_list row`); now allows any email except explicitly revoked (`allow_list.revoked_at`/blocking status) or `deny_list`-matched (email / `email_domain`). Wires the previously-dormant `deny_list` in as the ban hammer. ACL unchanged (service_role only); anon can't execute; 26 existing users unaffected; deny email+domain bans verified. Applied via MCP (`audit_20260720_open_front_door_check_email_allowed` + `_v2_denylist_types`). **Revert:** restore the strict `EXISTS(... status='active')` body (SQL in handoff-2026-07-20-onboarding-conversion.md).

**0.3 — Kill the now-stale "invite-only" framing** (comments + copy, not logic — but they will mislead the next session). Grep `invite-only`, `closed beta`, `soft-launch`, `waitlist`, `not on the allow-list` and reconcile:
- `CLAUDE.md` — update the posture note to "self-serve magic-link signup OPEN as of 2026-07-20 (Trevor); `deny_list` is the ban hammer; browsing was already public."
- `app/pricing/page.tsx:23,113` — "free invite-only beta" → "free beta".
- `lib/auth/supabase-client.ts:6,38`, `app/api/auth/request-magic-link/route.ts` (header comment), `app/login/page.tsx:5` — update the "allow-list gate / waitlist" comments to reflect allow-by-default.

**0.4 — Auto-provision an `allow_list` row on self-serve signup (needed, not optional).** A self-serve user now signs in via `/login` without ever filling `/early-access`, so they have **no `allow_list` row** — and two things key off that row: the dashboard's `maybeAutoAttachAllowListWallet` self-heal (`app/api/profile/saved-wallets/route.ts:24`, which attaches their wallet so the dashboard isn't empty) and the prewarm pipeline. In `app/api/auth/request-magic-link/route.ts`, after the gate passes, upsert a minimal row when none exists for the email: `status='active'`, `source='self_serve'`, `approved_by='self_serve'`, `approved_at=now()` (idempotent on `lower(email)` — reuse `submit_allow_list_request` or a small direct upsert). This restores tracking + prewarm + the self-heal for self-serve users. Caveat: the self-heal only attaches when `allow_list.wallet_addr` is present, and email-only signups have none — so pair this with a prominent "add your wallet" first-run step (the searched-wallet carry in 2.3 covers users who searched before signing up).

---

## PRIORITY 1 — Make the copy match the open door + encourage signup

Root cause from the audit: a forced modal hides the hero, and the signup path is worded like a locked door (3 different names). Now that the door is open, the copy has dead/misleading branches.

**1.1 — Kill or 1-step the homepage onboarding modal.** `components/OnboardingModal.tsx` (flag `rpc_onboarding_complete`, opens 600 ms after load, covers the hero). This is the single highest-impact item — it re-implements the hero's own search box as a 3-click gauntlet. **Recommended:** delete the mount (the hero in `components/HomePageMarketing.tsx` already has the search + "no signup required"). If keeping anything, collapse to **one** non-blocking panel that never covers the hero search, and rename step 3 **"Connect Your Wallet" → "Search a wallet"** (`OnboardingModal.tsx:128`; the body at :129 already correctly says "Search any wallet…"). Find the mount with `grep -rn "OnboardingModal" app components`. Revert: `git revert <sha>`.

**1.2 — De-duplicate the onboarding modals.** There are *three* overlapping onboarding surfaces: `components/OnboardingModal.tsx` (homepage), `components/onboarding/WelcomeModal.tsx` (per-collection, flag `rpc_welcome_dismissed_v1`, "Three things you can do right now" / "Save your spot"), and `components/onboarding/FirstRunTour.tsx` (+`FirstRunTourMount.tsx`). Pick ONE. At minimum they must not stack for a new user. (Deeper consolidation is Priority 3.)

**1.3 — Rewrite the homepage invite-only block.** `components/HomePageMarketing.tsx`:
- `:761` currently: "Searching wallets and public insights are free with no signup. An account — to save wallets, set FMV alerts, and track your portfolio over time — **is invite-only while we're in closed beta. Request access below.**" → change the tail to something like: "A **free account** (instant — no invite needed) adds saved wallets, FMV alerts, and portfolio tracking."
- `:779` CTA "REQUEST BETA ACCESS →" → "CREATE FREE ACCOUNT →" pointing at `/login` (or `/early-access` if you keep the richer form). Keep `:152` "No signup required. Try a wallet address or username." — that's the correct free-search value prop; leave it.

**1.4 — Fix the login page's now-dead branches.** `app/login/page.tsx`: with the gate open, `request-magic-link` no longer returns 403, so `status === "waitlist"` (:132–181) and `isClosedBetaBlock` (`error=access_revoked`, :184–243) are unreachable/incorrect. Simplify: remove or repurpose those branches, and change the footer "No invite yet? **Request early access →**" (:319–322) to a positive nudge like "Free — no invite needed. **Browse without an account →**" or drop it. Keep the magic-link form + "Send magic link" as the primary path; consider a one-line subhead "Free account — magic link, no password."

**1.5 — Reframe /early-access as "create your free account."** `app/early-access/page.tsx`: "**Get on the soft-launch list**" (:163) and "**Request early access**" button (:350) → "Create your free account" / "Get started". Keep the optional wallet/username fields (they still drive `submit_allow_list_request` → prewarm, which is genuinely useful) but reword the helper from "we'll let you in as we open access" to "we'll pre-warm your collection so it's ready instantly." NOTE: `/login` email→magic-link is now the fastest path; /early-access is the optional richer setup.

**1.6 — Unify the gate's name.** One term everywhere. Recommend **"free account" / "sign up"**, retiring "beta access" (home), "early access" (login/early-access), and "soft-launch list". Grep the four strings above.

**1.7 — Placeholder truncation.** The hero search placeholder ("Search any Top Shot username, Flow wallet (0x…), or moment ID") is clipped by the input width on the homepage (`components/HomePageMarketing.tsx`). Either shorten it (e.g. "Top Shot username, 0x wallet, or moment ID") or make the input full-width/responsive so it isn't cut mid-word.

---

## PRIORITY 2 — Retention & measurement (the WAU levers)

**2.1 — Instrument the funnel.** `funnel_events` currently only records `home_view, wallet_paste, share_view, share_cta_click, insights_view, insights_card_click, collection_view` — it does NOT track search, sign-in, or signup, so drop-off is invisible. Widen the CHECK and fire the missing events.

Migration (apply via MCP or commit as `audit_20260721_funnel_events_signup_funnel.sql`):
```sql
ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'home_view','wallet_paste','share_view','share_cta_click','insights_view',
    'insights_card_click','collection_view',
    -- new signup funnel:
    'search_submitted','search_result_shown','signin_click','signup_started',
    'account_created','email_capture_submitted','onboarding_modal_shown','onboarding_modal_dismissed'
  ]));
```
Revert: restore the 7-value CHECK (definition above in this handoff). Then fire the events client-side via the existing funnel-tracking helper (grep `funnel_events` / `track-funnel` for the current insert path) at: hero search submit, results render, "Sign in" click, `/auth/confirm` success (`account_created`), and the modal show/dismiss.

**2.2 — Email-capture hook at the value moment (biggest retention lever).** On the collection analyzer result (`app/(collections)/[collection]/collection/page.tsx`), after a wallet's FMV renders, add a one-field "**Email me when a moment here drops below FMV**" capture — email only, **no account required**. Write to the existing `email_subscribers` table (cols: `email, wallet_address, deal_alerts, badge_alerts, portfolio_alerts, collection_ids, deal_min_discount, deal_max_price, deal_tiers, verified, verification_token, unsubscribed_at, created_at`). This converts anonymous searchers into leads + a reason to return, and warms them toward a full account. New route e.g. `POST /api/subscribe/deal-watch` (service-role insert). This is the single highest-leverage retention change; the audit shows `alert_subscriptions=1 / fmv_alerts=0` today.

**2.3 — Dashboard must never show $0 while a cached value exists (ROOT-CAUSED, verified).** The headline `totalFmv`/`totalMoments` (`app/dashboard/page.tsx:650-663`) and the per-collection cards are derived *solely* from the live `get_wallet_collection_stats` RPC, fetched once per unique wallet via `/api/profile/collection-stats` (`refreshStats` :376-410; correctly deduped to unique addresses at :468/:540). That route is `maxDuration=15` and returns **503 `stats_timeout`** on Postgres `57014` (statement timeout) — the exact timeouts Sentry logs for whale wallets. On that 503, or simply before the async fetch resolves, `statsByWallet` is empty and the dashboard renders **$0 / 0 moments / 0 collections** — even though the correct value is *already on the client*: `saved_wallets.cached_fmv_usd`/`cached_moment_count` is fetched onto the `wallets[]` objects (`SavedWallet.cached_fmv`, :45) and then **ignored** by the headline.

  Verified against Trevor's wallet `0xbd94…50ac`: `saved_wallets` caches ≈ **$94.2k** (TS $67,743 + AD $25,326 + Pinnacle $1,169 + Golazos $6); the live RPC *currently* returns ≈ **$68.4k** non-stale across 19,133 cached moments — i.e. it works, so the $0 I saw was a timeout / not-yet-resolved state, **not missing data**. (The two figures differ legitimately: the live headline excludes STALE-confidence per :664-666, and cached is a point-in-time snapshot. Neither should ever surface as $0.)

  **Fix:** seed `totalFmv`/`totalMoments` and each collection card from `wallets[].cached_fmv`/`cached_moment_count` as the immediate value, then upgrade to the live RPC when it resolves; on a 503/empty, **keep** the cached value rather than dropping to $0. Together with carrying the just-searched wallet into the first logged-in view, the dashboard then leads with a real number. NOTE: self-serve signups won't have an `allow_list` row, so the `maybeAutoAttachAllowListWallet` self-heal (`app/api/profile/saved-wallets/route.ts:24`) won't fire for them — do the P0.4 auto-provision (insert a `source='self_serve'` `allow_list` row on first magic-link) so their wallet still auto-attaches and the dashboard isn't empty.

---

## PRIORITY 3 — Bigger bets (each may warrant its own session)

**3.1 — Collapse the identity model.** Three notions of "you" reach a new user: the Supabase email account (real), a localStorage "owner key" (`rpc_owner_key` — silently adopted just by searching a wallet), and an FCL Flow wallet (`CURRENT_USER`). Plus four first-run flags (`rpc_onboarding_complete`, `rpc_welcome_dismissed_v1`, `rpc_onboarded`, `rpc:first-run-completed`). Pick one identity story for onboarding, collapse to one flag, and hide FCL wallet-connect until it's actually needed (it currently reads as a scary web3 action next to plain search).

**3.2 — Harden the activation-path queries (Sentry).** Recurring `canceling statement due to statement timeout` (Postgres `57014`) on `GET /[collection]/team/[slug]` and `/player/[slug]`, `Timed out acquiring connection from connection pool` on `GET /[collection]/pack/dist/[distId]`, and a `TypeError: Load failed` on `/[collection]/collection` — the pages a user hits right after their first search. **Verified for the dashboard's RPC:** `get_wallet_collection_stats` (which also 503-times-out — see 2.3) is **not** missing an index; `wallet_moments_cache` already has the covering `idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)`. Its failure mode is pool exhaustion / aggregation cost on whale wallets, so the robust mitigation there is the 2.3 seed-from-cache, **not** more indexing. For the team/player/pack RPCs (`get_team_detail` / `get_player_detail` / `get_pack_detail_bundle` — confirm the real names by grepping the routes), **profile before touching:** `EXPLAIN (ANALYZE, BUFFERS)` the RPC and add an index only if the plan shows a seq scan; consider a short `s-maxage` on these read routes to relieve the pool. Don't blind-bump `statement_timeout` — with pool exhaustion in play, longer statements make contention worse. Verify against the pack/team/player smoke tests.

**3.3 — `rip-packs-city.vercel.app` → canonical 301.** The `.vercel.app` serves the full site alongside `rippackscity.com` (duplicate content / SEO dilution). Set a permanent redirect to the apex — either a Vercel domain redirect (dashboard: add the domain as a redirect to `www.rippackscity.com`) or a host-based `redirect()` in `next.config.ts`. Operator/config step.

**3.4 — Weekly retention email** ("your portfolio moved X% this week") once 2.2's email capture exists — reuse the `email_subscribers` + alert-dispatch plumbing.

**NOT a to-do (verified already clean):** the audit's side-note that the concierge system prompt still calls Trevor a "Team Captain" is **stale** — `app/api/support-chat/route.ts` has no `Team Captain` / `Dillon-Bond` / `official Portland Trail` string in the current `main`. The identity scrub already landed. No action.

---

## Ops note for Trevor (now that signup is open)

Ban an abuser without a deploy (takes effect within ~60s — proxy caches the gate for 60s):
```sql
-- one email:
INSERT INTO deny_list (pattern, pattern_type, reason, active, added_by)
VALUES ('abuser@example.com', 'email', 'spam', true, 'trevor');
-- a whole domain:
INSERT INTO deny_list (pattern, pattern_type, reason, active, added_by)
VALUES ('spamdomain.com', 'email_domain', 'abuse', true, 'trevor');
-- un-ban:  DELETE FROM deny_list WHERE pattern = 'abuser@example.com';
```
Existing accounts are also revocable via `UPDATE allow_list SET status='revoked', revoked_at=now() WHERE email='...';`.

---

## Guardrails (standard — repeat every handoff)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- **Commit the ledger BEFORE the code** so the code commit is the deploy tip (a docs-only tip suppresses the Vercel deploy). Re-read the ledger from disk immediately before writing; splice, never rewrite; `grep -c '^### ' docs/overnight/ledger.md` must go UP.
- On Windows, **commit via PowerShell `git`** (Git Bash `git commit` can silently no-op). Verify the push: `git rev-list --count origin/main..HEAD` → expect `0`.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`. Force a rebuild with the v13 deployments POST (an empty or docs-only commit will NOT trigger a build — `ignoreCommand` skips it).
- Vercel Pro `maxDuration` hard cap is **800s** — anything higher sends the deploy to ERROR invisibly.
- CRLF: no string-replace patching on Windows — full-file writes.
- Verify pages by **rendered DOM, not HTTP 200** (streaming shells always return 200).
- Run `npx tsc --noEmit` clean and the vitest coverage ratchet (`npm run test:coverage`) before pushing; update any tests that assert the old copy/branches (e.g. `__tests__/api-auth-request-magic-link.test.ts` asserts the 403 waitlist path — it will need updating for allow-by-default).

## Expected end state

`main` advanced with: the committed `check_email_allowed` migration + ledger entry (gate already live), the homepage modal killed/slimmed, invite-only copy replaced with free-signup nudges across home/login/early-access/pricing, the signup funnel instrumented, and the email-capture hook live. Vercel deploy READY. Metric to watch: `funnel_events` starts recording `search_submitted`/`account_created`, and `auth.users` growth resumes (0 in the last 30 days today).
