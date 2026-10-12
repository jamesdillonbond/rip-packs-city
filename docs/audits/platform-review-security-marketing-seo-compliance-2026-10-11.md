# Platform review — security · marketing · SEO · compliance — 2026-10-11

Read-only review of `main` @ `61d776dbe` (Sat 2026-10-11, evening PT), requested by Trevor: "look for improvements to security, marketing and SEO; make sure we're fully adhering to compliance standards and being responsible."

**Method.** Four parallel code audits (security, SEO, marketing/growth, legal/responsibility) over the working tree, each with file:line evidence, then every sharp claim re-derived against the LIVE database (Supabase advisors + catalog queries) or the local toolchain. ⚠ The web sandbox could not reach `www.rippackscity.com` (connection reset on every request), so **header/route behaviour below is from code, not from a production response** — re-probe from a laptop before quoting any of it as live.

**Status (2026-10-11, ~9:45 PM PT).** Steps 1 and 2 of §7 shipped the same evening (ledger entries dated 2026-10-11): C1 interim copy, C3, C4, C6 (incl. the funnel_events retention migration), M1, M5, S2, S5, S7, S8, security.txt. S9 was already closed live (the tree lagged production). Open from steps 1–2: **C2 (contact mailbox + postal address) — needs Trevor.** Later the same night (~11:45 PM PT) steps 3–7 shipped too: C1 proper (account deletion), C5/C7/C8/C11, S4, E1/E3/E5/E6/E7/E8, M2/M3/M4/M7/M8/M9 — ledger entries dated 2026-10-11. Still open: E4, S1/S3/S6 (secret rotation), C2, C10 (a11y lint), §5. **2026-10-12 (~5:00 PM PT):** E4, S4 (constant-time + the cron rate-limit exemption), C2 (mailbox only), C10 shipped — ledger entries dated 2026-10-12. §5 DECLINED with numbers (ledger). Remaining: C2 postal address (Trevor), S1 rotation / S3 / S6 (cron-job.org + GHA + Vercel env — operator), axe first-run findings.

**Verdict.** No critical defect. The platform's security posture is strong where it matters (RLS on all 617 tables, service-role key never in a client file, no secrets in the tree, SHA-pinned Actions, signed hot-wallet path fail-closed). The real gaps are (1) **four honesty defects on legal/marketing surfaces** — a privacy-policy promise with no implementation, a digest nobody sends, a transcript-storage practice the policy omits, no postal/contact address anywhere — (2) **a single shared secret that unlocks ~100 routes and the whole proxy wall**, (3) **ownership checks missing on five per-wallet financial routes**, and (4) SEO structured-data spent on auth-gated pages while the public ones carry boilerplate. Everything below is prioritised; §7 is the proposed execution order.

---

## 1. Security

### Verified LIVE (catalog queries, 2026-10-11 ~18:40 PT)

| check | result |
|---|---|
| public tables | 617, **all** `relrowsecurity = true`; 0 tables where anon can SELECT/INSERT/UPDATE/DELETE without RLS |
| RLS enabled but no policy (default-deny) | 447 — fine, these are service-role-only tables |
| anon INSERT allowed | 4 tables, each with a length-bounded WITH CHECK policy: `email_subscribers`, `funnel_events`, `outbound_clicks`, `support_conversations` |
| anon-readable views | 54, every one `security_invoker=on` |
| SECURITY DEFINER callable by anon | 3 (`get_trophy_slab_data_by_username`, `serial_fmv_estimate` ×2) — all read-only, `search_path` pinned |
| Supabase security advisor | 0 ERROR · 3 WARN (the 3 secdef above + 2 functions with mutable `search_path`: `rpc_trust_health_precompute_refresh_p`, `reconcile_all_saved_wallet_stats`) |
| Vercel WAF | no custom firewall config on the project (API 404 "Seawall Config not found") |

⚠ The security subagent flagged `profile_bio`, `pinnacle_ownership_snapshots`, `flow_backfill_progress`, `evm_nft_transfers_unresolved` as **"no RLS statement anywhere in `supabase/migrations/`"** and pre-dating the 06-24 default-ACL revoke. **Refuted live**: all four have RLS on; `profile_bio` has own-row INSERT/UPDATE/DELETE policies, the others service-role-only. What survives is a *parity* note: their RLS was applied outside the committed migrations, so a fresh `supabase db reset` would NOT reproduce production's posture. Worth a one-off `audit_` migration that re-states `ENABLE ROW LEVEL SECURITY` for every table (idempotent), so the tree is the truth.

### Findings

**S1 · MEDIUM — One shared secret unlocks everything.** `proxy.ts:1491-1495`: `INGEST_SECRET_TOKEN` *or* `CRON_SECRET`, via `Authorization` **or `?token=`**, short-circuits the whole wall (rate limit + session + allow-list) before anything else runs. The same token gates ~100 pipeline routes, is held by a third party (cron-job.org) and GHA, is accepted from the query string in `lib/admin-auth.ts:19`, `app/api/admin/cron/detect-league-drift/route.ts:6`, `app/api/admin/drain-fmv-cold-tail/route.ts:7`, and is the **fallback bot-bridge secret** in `app/api/support-chat/route.ts:5274-5275`, where the holder may set `body.ownerId` to any user (`:5472`) and act as them in the concierge (watchlist / alert / subscription tools). Query-string tokens land in Vercel request logs, analytics and referrers.
*Fix:* per-consumer tokens (cron-job.org ≠ GHA ≠ bot bridge; set `BOT_BRIDGE_SECRET` explicitly), header-only everywhere, and retire the proxy-wide bypass — every route already carries its own check (`bearerMatches`), so the bypass only widens blast radius. ⚠ Rotation touches cron-job.org + GHA secrets + Vercel env; sequence per `rpc-edge-fn-deploy` §4 / rpc-cron-ops.

**S2 · MEDIUM — Private per-wallet financials readable by any signed-in account.** `/api/cost-basis` (`route.ts:46-57`), `/api/wallet-cost-basis` (`:45-50`), `/api/portfolio` (`:21`), `/api/portfolio-export` (`:43`), `/api/owned-flow-ids` (`:27`) take `?wallet=` with **no** ownership check (verified: none of the five imports `requireOwnedKey` / `getCurrentUser` / `saved_wallets`); only the proxy session gate stands in front, and sign-up is open (`lib/auth/supabase-client.ts:9-11`). `proxy.ts:744-745` itself classifies cost-basis / P&L as "private (owner-only)". The underlying acquisitions are on-chain, so this is a *policy* leak, not a secret one — but RPC's own classification is the standard to meet.
*Fix:* route through `requireOwnedKey` (as `/api/profile/teams` does) or drop the `wallet` param and resolve from the caller's `saved_wallets`.

**S3 · MEDIUM — Admin = a static bearer token in `localStorage`.** `lib/admin-auth.ts:13-20` (no DB role, no session binding), `lib/admin-token.ts:16`; `/admin/*` is public at the proxy (`proxy.ts:528`); `app/admin/flowty-errors/page.tsx:33` also reads `?token=`. With `script-src 'unsafe-inline' 'unsafe-eval'` any XSS on the origin exfiltrates full admin control.
*Fix:* admin = Supabase session + server-checked `is_admin` (table or claim); if a token must remain, httpOnly cookie, never `localStorage`, never the query string.

**S4 · MEDIUM — Unmetered 401 oracle on `/api/cron/*` and `/api/ingest*`.** `proxy.ts:1500-1504` exempts those prefixes from the rate limiter *even without a token*, and `isPublicPath` passes `/api/cron/*` (`:553-554`); routes compare with non-constant-time `===` (e.g. `lib/studio-sales-history.ts:323-331`, `app/api/admin/prune-pipeline-runs/route.ts:21`).
*Fix:* rate-limit every `/api/*` unless the token *verified*; compare with `crypto.timingSafeEqual`. Seven routes use the inline `!TOKEN || auth !== \`Bearer ${TOKEN}\`` form instead of `bearerMatches` — the ratchet should cover them.

**S5 · MEDIUM (latent) — Open redirect in the auth callback.** `app/api/auth/callback/route.ts:46-49` accepts any `redirect` that `startsWith("/")`, which admits `//evil.example`, then `NextResponse.redirect(new URL(safeRedirect, req.url))` (`:71`) after a successful code exchange. Latent today because the only producer (`request-magic-link/route.ts:37`) sanitises first; any second producer (Supabase dashboard template, future OAuth) re-opens it. `lib/auth/safe-redirect.ts` already exists for exactly this.
*Fix (one line):* `safeRedirectPath(redirectParam) ?? DEFAULT_POST_AUTH_PATH`.

**S6 · MEDIUM — Rate-limit tier decided by an unverified cookie, state per-isolate.** `proxy.ts:256-283` parses the Supabase JWT *without* verifying its signature to pick the 240/min tier (`:203`); the `Map` store is per-edge-isolate (`:149-156`, acknowledged). The limiter is advisory.
*Fix:* verify `sub` (or key on the verified session), and either Vercel WAF rate rules (no infra spend; included in Pro) or a shared KV. Given the no-infra-spend rule, **WAF rules are the lever**: the project currently has no firewall config at all.

**S7 · MEDIUM — Dependency gate is red and structurally silent.** `node scripts/check-prod-dep-audit.mjs` exits **1** locally: `source-map-js` GHSA-68fv-2mgg-jv7q (high) is a root advisory not in `prod-dep-audit-baseline.json`. `dependency-audit.yml` runs only on `push`/`pull_request` to five paths + `workflow_dispatch` — **no `schedule:`**, so an advisory published after the last lockfile change never triggers a run. This is the CLAUDE.md "a CHECK THAT DIDN'T RUN reads as PASSED" class. Separately, `elliptic` (GHSA-848j-6mx2-7j84, low) **is** the hot-wallet signer (`lib/breaks/server-authz.ts:31,80`).
*Fix:* add a weekly `schedule:` to the workflow; resolve or baseline `source-map-js` with a reason; plan a migration of the signer to `@noble/curves` secp256k1 (constant-time, maintained) — with the cryptographic-verification tests CLAUDE.md already mandates.

**S8 · LOW — Two different CSPs are emitted.** `next.config.ts:44` and `proxy.ts:1283-1300` each set `Content-Security-Policy`; the proxy's is the stricter one (adds `frame-ancestors 'none'`, `base-uri`, `form-action`). Browsers enforce the intersection, so it works by accident. Consolidate to the proxy copy; keep `next.config` for the non-CSP headers only. (`'unsafe-inline'`/`'unsafe-eval'` remain — known; nonce-based CSP is a larger project.)

**S9 · LOW** — CORS allow-list includes `http://localhost:3000` in prod (`lib/allowed-origins.ts:9`); no credentials, so nil impact — gate on `NODE_ENV`. · `pro_users_public_read USING (true)` lets anon enumerate subscriber wallets of a removed feature (`20260404010000_pro_users.sql:17-20`) — drop. · `migration-autorecover.yml:112,270` holds `contents: write` and pushes to `main` on a schedule — a compromised step dependency can commit; pin to a bot branch + required check. · Pipeline work triggerable by any signed-in user with no token: `/api/allday-lock-refresh`, `/api/resolve-allday-buyers`, `/api/user-resolve` (cost lever). · No `/.well-known/security.txt` and no disclosure contact anywhere.

### Verified clean (so nobody re-audits it)
Service-role key never imported into a `"use client"` file; `NEXT_PUBLIC_*` set is appropriate (URL, anon key, site URLs, flags, WalletConnect id). No secrets in the tree; `.gitignore` covers `.env*` with `!.env.example`. All GH Actions SHA-pinned, no `pull_request_target`, `permissions: contents: read` everywhere but the autorecover job. Giveaway delivery signs client-side with Trevor's connected wallet (`lib/giveaways/admin-wallet.ts:138`); the server hot wallet is reached only via `app/api/breaks/[id]/*`, fail-closed on `BREAKS_ADMIN_TOKEN`. Concierge: 20 tools, none executes SQL, writes session-scoped; prompt-injection blast radius = self-scoped watchlist/alert writes + escalation spam. All sort/order params allow-listed; no dynamic `.from(<input>)`; `dangerouslySetInnerHTML` only on `JSON.stringify` JSON-LD + two constants. Stripe webhook verifies signatures; MCP keys stored hashed. `/login?next=` chain sanitised at every hop. IPs never stored raw (hashed in `lib/abuse/anon-rate.ts`, early-access, pack-pulls).

---

## 2. Compliance & responsibility

(Not legal advice; each item names the standard a careful US operator meets.)

### MUST-FIX

**C1 — The privacy policy promises an account-deletion control that does not exist.** `app/privacy/page.tsx:125-127`: "You can delete your account … from the Profile page. Deleting your account removes your records within 24 hours." Verified: no deletion route or UI anywhere (`deleteUser`, `account/delete`, profile-edit controls — zero hits); only the concierge chat-history delete exists (`app/api/support-chat/history/route.ts`). A false statement in a privacy policy is the textbook FTC §5 "deceptive practice" pattern, and CCPA/GDPR-style deletion rights need a working path. **This is the single most important item in the review.**
*Fix:* ship `DELETE /api/profile/account` (auth.admin.deleteUser + cascade across user-keyed tables incl. `support_conversations.user_email`, `email_subscribers`, alert subscriptions, rewards shipping addresses) with a Profile-page control. Until it ships, change the sentence to a working instruction with a real contact address.

**C2 — No functional contact address anywhere; no postal address in any email.** Privacy (`:65-73, 160-167`) and Terms (`:64-72, 177-184`) offer only the X handle. CAN-SPAM requires a **valid physical postal address** in every commercial email; CCPA/GDPR expect a usable contact; a DMCA agent needs a mailing address. Zero address hits across every outbound template (`weekly-digest`, `signup-reminder`, `alerts-send`, `admin/resend-welcome`, `subscribe`), and zero `List-Unsubscribe` headers repo-wide.
*Fix:* `privacy@`/`legal@rippackscity.com` + a postal address (registered agent or PO box) in both policies and a shared email footer constant; `List-Unsubscribe` + `List-Unsubscribe-Post` on digest/reminder sends. ⚠ Needs Trevor: the address.

**C3 — Concierge transcripts are stored, linked to email, for 90 days; the policy says only "processed by Anthropic".** Every turn is persisted (`app/api/support-chat/route.ts:5211-5212, 5361-5362`: `user_message`, `bot_response`, `user_wallet`, `user_email`) — live count **5,943 rows, 84 with email**, purged at 90 d by `run_weekly_log_purges`. Policy text (`app/privacy/page.tsx:84-86, 109-110`) discloses real-time processing only — not storage, email linkage, admin review (`app/admin/feedback`), or the retention period.
*Fix (copy):* "We store your concierge messages and our replies, linked to your account email if you are signed in, for 90 days to debug and triage feedback. You can delete them from the chat menu." Also surface it in the chat welcome text (`components/SupportChat.tsx:483-484`).

**C4 — Legal-text links fail WCAG contrast badly.** Footer TERMS / PRIVACY use `--rpc-text-ghost` = `rgba(255,255,255,.2)` on `#0D0D0D` (`components/SiteFooter.tsx:201-202`; tokens `app/rpc-tokens.css:16,39`) → **1.79:1** at 11px (AA needs 4.5:1). "Last updated" lines same token. Brand red `#E03A2F` inline links in both policies → 4.46:1 dark / 4.07:1 light, below AA for body text.
*Fix:* `--rpc-text-secondary` (6.25:1) for footer/legal links; underline red links or use the darker token. Note the tokens are theme-aware — use tokens, never a hex.

### SHOULD-FIX

**C5 — Terms gaps** (`app/terms/page.tsx`): *No Affiliation* (`:95-100`) omits MLB / MLBPA / Candy Digital, Panini America, the leagues and players' associations themselves, and Lucasfilm/Marvel (Pinnacle IP) — all indexed per `lib/collections.ts`; no age requirement in Terms (privacy says 18+; login has no age/agree control, `app/login/LoginClient.tsx:323-325`); no IP/DMCA notice or agent; "Last updated: May 2026" (`:189`) vs privacy's October 2026 — version both. Suggested text: *"You must be at least 18 to create an account. Rip Packs City is not affiliated with, endorsed by or sponsored by Dapper Labs, the NBA, NBPA, NFL, NFLPA, LaLiga, Disney, UFC, MLB, MLBPA, Candy Digital, Panini America, or any team or player. All marks and media belong to their owners and are shown for identification only. Copyright complaints: dmca@rippackscity.com."*

**C6 — Privacy processor list and disclosures incomplete.** Not named: **Resend** (all email), **Vercel Analytics + Speed Insights** (`app/layout.tsx:110-111`; cookieless, so no banner required — but they are processors), **Telegram** (alerts; 10 files). Undisclosed collection: user-agent + referrer on funnel/click rows (`app/api/track-funnel/route.ts:94-106`, `lib/outbound-click-row.ts:94`), hashed IP + UA on early-access / pack-pull submissions, **shipping addresses** for merch (`app/api/rewards/shipping/route.ts:22-28`), the `rpc_al_check` cookie holding `{email, expiresAt}` (60 s). Retention exists in code (usage_events 31 d, support_conversations 90 d, wallet snapshots 90 d) but is unstated — and **`funnel_events` has no retention at all**: 127,707 rows since 2026-05-31 with UA, referrer, visitor id. No CCPA categories / "do not sell" line (cheap to add, likely below thresholds today), no GDPR lawful-basis line. Good and worth claiming: GPC/DNT honoured (`lib/track-funnel.ts:162-163`); client-error beacon is path-only, UA truncated, stack capped (`ClientErrorBeacon.tsx:121`).
*Fix:* name the processors, list the categories + retention, add a `purge_old_funnel_events(180)` leg to `run_weekly_log_purges`, and disclose the beacon as "browser error reports (message, stack, page path, browser type)".

**C7 — Giveaway Official Rules are strong but missing dates and sponsor address.** `app/giveaways/[slug]/GiveawayClient.tsx:403-430` covers no-purchase, sponsor, 18+, void-where-prohibited, odds, ARV, tax, no-cash, data sharing — the right sweepstakes shape (free entry, random draw, RPC never custodies). Missing: explicit open/close date-times (only status labels, `lib/giveaways/view-format.ts:34-36`), sponsor address, and a line on NY/FL registration where ARV > $5,000.

**C8 — Rewards program needs program terms.** Points earned by invites/shares, redeemed for cosmetics/merch/gifted moments; no chance element, no consideration — a loyalty program, fine. State in Terms: points have no cash value, are non-transferable, may be modified/expired; merch fulfilment uses the address you provide.

**C9 — Email detail.** User-requested alerts (`lib/alerts/format.ts:235` "Manage: /alerts") have no unsubscribe link — acceptable for transactional, add a one-click pause. `signup-reminder` is proactive marketing to allow-list emails who never logged in; flag-gated OFF — before enabling, confirm marketing consent at capture and add address + unsubscribe.

**C10 — Accessibility programme is thin.** No `jsx-a11y`/axe anywhere (`eslint.config.mjs` only `next/core-web-vitals`; nothing in `e2e/`), no skip-link, `TopNav.tsx` / `GlobalSiteHeader.tsx` have 0 `aria-label`s, sniper table has 22 `<th>` with 0 `scope=`. `prefers-reduced-motion` IS honoured (`rpc-tokens.css` + 3 components).
*Fix:* `eslint-plugin-jsx-a11y` (ratchet it like the others), an `@axe-core/playwright` pass over 5 key routes in the existing E2E job, skip-link, `scope="col"`, labels on icon buttons.

**C11 — No `security.txt`, no status page, no breach runbook.** Oregon ORS 646A.604: notify affected consumers within 45 days; AG if > 250. Add `/.well-known/security.txt` (Contact, Policy, Expires) and a one-page incident/breach runbook in `docs/reference/`.

### NICE-TO-HAVE
**C12** — Public repo has **no LICENSE**; default is all-rights-reserved, which is probably intended — say so in one line in README so forkers aren't misled. **C13** — Hotlinked league/team/moment media (`next.config.ts:27-35`, `cdn.nba.com` via team-logo proxy) is defensible as identification-only use; the C5 attribution line + a DMCA contact strengthen it. **C14** — LiveToken appears in product code only as a label on Flowty's `livetokenFmv` field; the extraction method lives in a Cowork skill, not the product — avoid rendering "LiveToken" as a brand in UI without permission. **C15** — AI disclosure is present (`SupportChat.tsx:740` "Powered by Claude", `:830` "Not financial advice") — add "may be wrong; messages are sent to Anthropic and stored 90 days" to the welcome line.

### Verified compliant
No payments (Stripe routes unreferenced, 503 without keys; `/pricing` is a noindex redirect home). Not-financial-advice in Terms (`:84-93`), FMV methodology with confidence grades, concierge prompt bans recommendation phrasing and requires tool-sourced FMV (`support-chat/route.ts:1066-1080`). No "guaranteed / can't lose / free money / risk-free" in user copy; +EV surfaces show sample size and STALE / N/A states; sniper flags low-confidence FMV. Email opt-out guards fail closed; double opt-in exists. Fonts carry OFL licences. Children's language present; operator entity named (Rip Packs City LLC, Oregon). Holdings CSV export exists. "Team Captain" absent from every user-facing file.

---

## 3. SEO

### Already good (verified — do not re-report)
Root metadata complete (`lib/seo.ts:56-108`: `metadataBase`, title template, default OG 1200×630, `summary_large_image`, robots). Every anon-public `page.tsx` (128 surveyed) has metadata directly or via its layout; entity pages build absolute canonicals + OG URLs. **Sitemap #28 is fixed** — `fetchAllByCollection` throws `SitemapReadIncomplete`; segments 503 + `no-store` instead of a partial 200 (`app/sitemap/[id]/route.ts:41-55`); no "now" lastmod. All 34 insights layouts carry param-free canonicals; zero internal hrefs carry `?tab=|?sort=|?collection=|?page=`; robots blocks the user-scoped params. `notFound()` in 29 files; soft-404 shells carry `noindex`. Footer links insights + 5 overviews; insights↔entity drill-downs in 20 files; one `<h1>` per rendered branch; visible breadcrumbs mirror the BreadcrumbList JSON-LD; alt coverage complete. `next/font` self-hosts both brand fonts; www redirect in place.

### HIGH
**E1 — Structured data is spent where Google cannot see it.** `Dataset` ×14 / `DataDownload` ×27 are emitted only under `app/(analytics)/analytics/**` — auth-gated, unlisted. The 34 public `/insights/*` layouts each emit only `WebApplication` + `Organization` + a `$0 Offer` — root boilerplate, never a `Dataset`/`ItemList` describing the board. `/about` has no top-level `Organization`. Edition `Product+Offer` is correct (`lib/seo.ts:1140-1165`) — leave it.
*Fix:* move the Dataset builder to the insights layouts (name, description, `temporalCoverage`, `distribution` → `/api/public/insights/<slug>`); `Organization` (+`sameAs`, `logo`) on `/about`; one `WebSite+SearchAction` site-wide (already on home). Pin with a test: "schema only on anon-public routes".

**E2 — The five highest-authority collection pages render their primary content client-side.** `[collection]/overview/page.tsx:30` passes only the slug; `CollectionOverviewClient.tsx:224-234` fetches `/api/collection-stats` in `useEffect`. Same on `sets/page.tsx:22`, `market/page.tsx:9` (`MarketClient.tsx:343-397`), and three sitemap'd boards (`insights/pack-reality/page.tsx:148`, `squeeze-check/page.tsx:85`, `tc-report/page.tsx:179`). Googlebot renders JS on a second-wave budget; a slow API read indexes as the skeleton.
*Fix:* server-fetch overview stats + top entities and pass as props (the market-cap tile already does via `marketCapSlot`); first page of rows server-side on the three boards (the other 31 already do).

**E3 — Blog: no Article JSON-LD, no `publishedTime`, no RSS, 2 posts, 4 months stale.** `app/blog/*/page.tsx` set `og:type=article` but no `BlogPosting` schema or dates; byline "By Rip Packs City". No `/feed.xml`.
*Fix:* `articleJsonLd()` helper in `lib/seo.ts`, `openGraph.publishedTime`, `app/feed.xml/route.ts` from the `POSTS` array. ⚠ Marketing (§4) argues the blog is the wrong content engine — the insights boards are. Do the schema/RSS plumbing (cheap), don't invest in cadence.

### MEDIUM
**E4 — Edition pages render no unique prose although `editions.description` exists for ~69 % of Top Shot editions** (used by `/api/search`, never by `edition/[slug]/page.tsx` or `lib/edition/fetchers.ts`). 18K+ near-identical templates = the "Crawled – not indexed 5,033" bucket from the 10-03 GSC read. Render the paragraph under the hero; seed `editionPageMetadata.description` with its first sentence. Verify `get_edition_detail` carries the column first.
**E5 — OG gaps:** `account-value`, `tc-report` fall back to the generic insights card; `panini-premiums` borrows the collection card; blog posts use a collection card. A text-only `/api/og/insights/[slug]` default closes all four.
**E6 — `public/llms.txt` is stale and points AI crawlers at gated tabs** (`/nba-top-shot/collection`, `/sniper`, `/analytics/**`, `:74-83`) and omits `/insights/*`, Candy MLB, Panini, `/market`, entity pages. Since robots deliberately allows AI crawlers (Trevor, 08-01), this file *is* the answer-engine index — regenerate it from the sitemap's public set.
**E7 — ~19 FeatureTabGate shells 200 without `noindex`** (`components/collection/FeatureTabGate.tsx:20`; `RETIRED_COLLECTION_TABS` covers only `ufc/sniper` + Panini). `robots:{index:false, follow:true}` when `!collectionHasPage`, or extend the 307 set (filed 09-07 inbox).
**E8 — `/early-access` inherits the root title verbatim**, no `<h1>`, anon-public — duplicate of home. Add metadata or `noindex` (marketing §4 M2 argues retire it).

### LOW
**E9** — No Core Web Vitals figure recorded anywhere in `docs/` ("not enough CrUX data", 10-03). Pull the Speed Insights RES per route once and record it in `roadmap-status.md` with the edition page as LCP subject. **E10** — `app/sitemap/[id]/route.ts:14-15` is `force-dynamic` so its `revalidate` is inert; only the CDN `s-maxage=21600` protects the DB from a 27K-row walk — fine while Vercel caches, note it. **E11** — `docs/reference/routes-and-surfaces.md:73-75` says the Pinnacle pin page moved to `/disney-pinnacle/edition/<id>`; code says the opposite and is internally consistent (`/pinnacle/moment/<id>` self-canonicals, is sitemap'd, and `/disney-pinnacle/edition/:id` 308s TO it, `next.config.ts:143-146`). Fix the doc.

---

## 4. Marketing & growth

Frame: roadmap-2026-08-03 — *accuracy is the gate; every growth tactic removed until the data beats incumbents*; no paid tier until 100 WAU; no infra spend. Latest sample (roadmap-status.md): ~23–24 accounts, WAU 1–2, MAU 4–5. Everything below is honesty / trust-signal / plumbing, **not** traffic acquisition; items that would be traffic pushes are marked CONFLICT.

### HIGH
**M1 — `/insights` newsletter capture promises a weekly digest nobody sends.** `components/insights/InsightsEmailCapture.tsx:57,63` ("Get the weekly digest"), mounted site-wide under insights; POSTs to `app/api/subscribe/route.ts:7` → `digest_weekly=true`. The only sender, `app/api/send-digest/route.ts`, is on no schedule (0 hits in `vercel.json`, workflows, cron docs); `app/api/cron/weekly-digest/route.ts:8` is `DISABLED BY DEFAULT`. Live: **1** subscriber row. A subscriber gets a verification email, then silence — the honesty class on a marketing surface.
*Fix:* copy → "Be first to hear when the digest launches" with `digest_weekly=false`, or remove the capture until the gate clears. **Do not switch the digest on** — proactive outbound is a growth tactic the roadmap removed (CONFLICT if enabled without Trevor).

**M2 — Open-door signups get no welcome email; the welcome path hangs off a dead page.** Self-serve signup is open since 07-20 (`app/login/LoginClient.tsx:5,8`). The welcome email (`lib/emails/welcome-email.ts`) is sent only from `lib/allow-list/prewarm.ts`, invoked solely by `app/api/early-access/submit/route.ts`; `/early-access` has **zero inbound links**. The real funnel (home → /login → magic link → `AuthConfirmClient.tsx:105` `account_created`) never welcomes.
*Fix:* call `prewarm` from the auth-confirm path (transactional — no conflict), and retire `/early-access` + `EarlyAccessClient.tsx` (530 lines of dead surface; also closes SEO E8).

**M3 — The 100-WAU gate is unmeasurable from the product.** `app/admin/analytics/AdminAnalyticsClient.tsx:340-342` has a single "Total Signups" tile; no API computes WAU/MAU/cohorts; every WAU in `roadmap-status.md` is a hand-run SQL sample. Funnel events exist (`lib/track-funnel.ts:29`; allow-list `app/api/track-funnel/route.ts:35`) but nothing joins them to signups or week-N return.
*Fix:* one DB view/function `rpc_traction_snapshot()` (accounts, signups_7d, WAU, MAU, wallet_paste→account_created 7-day conversion, D7/D30 return — all `WHERE user_id NOT IN internal_accounts`) + one admin tile. Zero infra.

**M4 — The headline accuracy metric is public nowhere.** HIGH/MEDIUM share lives only in `public.rpc_trust_health_precompute`; 0 reads from any `.tsx`. `/legal/fmv-methodology` explains the grades but shows no live figure and is linked only from footer ghost text (`SiteFooter.tsx:200,225`, the 1.79:1 links from C4). Homepage TRUST bullets (`HomePageMarketing.tsx:173-177`) are uptime claims, not accuracy claims.
*Fix:* a per-collection "share of prices backed by sales (HIGH/MEDIUM)" table on `/legal/fmv-methodology`, read from the precompute (sentinel → "unavailable", never a number), and a one-line pointer in the TRUST band. It publishes the gate itself. ⚠ It will read low for Golazos (<1 %) — that is the honest state and the roadmap says a label beats a number.

### MEDIUM
**M5 — "Pricing" nav + "FREE DURING BETA"** (`HomePageMarketing.tsx:75-77, 756-762`) imply a paywall is coming — borderline CONFLICT with "no paid tier shown or considered". Rename the section to "Free account", drop "beta". (`/pricing` itself is correctly a noindex redirect.)
**M6 — Tagline drift.** chain-strategy.md (end): tagline stays "Flow blockchain … platform" until chain two ships; homepage already says "Flow and Solana" (~`:356`), About says "for the Flow blockchain" (`about/page.tsx:13`). Either the rule is stale (Candy MLB is `is_active`) or the homepage is early — **Trevor's call**, then align in one commit.
**M7 — Anonymous nav link that 307s to /login:** `TopNav.tsx:25` shows `/analytics` to signed-out users (not in `isPublicPath`). Hide for anon or point at the public collection analytics tab.
**M8 — Share OG card has no CTA** (`app/api/og/share/route.tsx:134` renders only the domain); the `/share/[wallet]` page CTA is good. One line: "See what yours is worth".
**M9 — Referral exists but is undiscoverable** (credit only on first wallet *verification*, `20260914160000…:78-82`; `/rewards` shows a count with no explanation). One explanatory line; do not widen to signup-pays.
**M10 — CAN-SPAM address** — same as C2; add the shared footer before any commercial send is ever enabled.

### LOW
Dead dep `oauth-1.0a` (0 imports — no X auto-posting exists; building it now would CONFLICT). Blog is stale (2 posts) — insights (32 boards, 29 with OG) is the real engine; don't invest in blog cadence. No community surface (X only) — creating one is a growth tactic, CONFLICT pre-gate, note only.

---

## 5. Database hygiene (from the live advisors — cost, not security)

| finding | live count |
|---|---|
| tables without a primary key | 110, nearly all `audit_*` / `*_backup*` / `_cohort_*` scratch |
| audit/backup-like tables in `public` | 192 · 545 MB |
| `flowty_archive` schema | 28 tables · 4.1 GB |
| unused indexes | 188 |
| unindexed FKs | 9 |
| DB size | 36 GB |
| Auth server pool | fixed at 10 connections; Supabase recommends percentage-based after the 09-20 Large upgrade |

Not urgent, but the `audit_*` population has no retention rule and each is a `no_primary_key` lint forever. A dated-prefix drop policy (e.g. > 60 d, after confirming no reader) and a one-time unused-index review are the two cheapest wins; both are pure DB-side and need no push. ⚠ Per CLAUDE.md, size the index drops by `pg_stat_user_indexes` **and** check pg_cron commands for readers before dropping anything.

---

## 6. What this review could NOT verify
- Live response headers, redirects and the 404/200 status of any URL (sandbox egress to the apex was reset). The code says HSTS preload, nosniff, DENY, Referrer-Policy and Permissions-Policy are set in `applySecurityHeaders` — confirm with one `curl -I` from a laptop.
- Whether the `dependency-audit` workflow's last *actual* run was red (it cannot have run since the advisory published unless dispatched).
- Supabase Auth dashboard settings (OTP expiry, rate limits, email templates — a second producer of the `redirect` param in S5).

## 7. Proposed execution order (all zero-spend)

1. **Honesty on legal surfaces (one copy commit + two small code changes):** C1 interim copy, C3 transcript disclosure, C6 processor list + retention lines, C4 contrast tokens, M1 digest copy, M5 "Free account". Needs from Trevor first: **a contact email and postal address (C2)**.
2. **Security quick wins (one commit each, each with a test):** S5 `safeRedirectPath`, S2 `requireOwnedKey` on the five wallet routes, S7 `schedule:` on dependency-audit + resolve `source-map-js`, S8 single CSP source, S9 drop `pro_users_public_read`, `security.txt` (needs the C2 contact).
3. **Account deletion (C1 proper):** route + cascade + Profile control + a test that the cascade covers every user-keyed table (tree-walk over `user_id` columns, not a curated list).
4. **Secret hygiene (S1, S3, S4):** per-consumer tokens, header-only, admin via session role, timing-safe compare, rate-limit all `/api/*` + Vercel WAF rules (S6).
5. **SEO:** E1 Dataset on insights + Organization on about, E6 regenerate `llms.txt`, E5 default OG, E4 edition description, E2 server-side first render on overview/sets/market + 3 boards, E7 noindex shells, E3 Article schema/RSS.
6. **Growth plumbing within the gate:** M2 welcome on confirm + retire `/early-access`, M3 traction snapshot, M4 public confidence table, M7/M8/M9 one-liners. M6 after Trevor's tagline call.
7. **Programme-level:** C10 a11y lint + axe pass, C11 breach runbook, C5/C7/C8 Terms additions, §5 DB scratch-table retention.

---

*Evidence base:* four subagent audits (security 59 tool calls, SEO 58, marketing 18, compliance 19) + direct live verification: Supabase `get_advisors` (security + performance), catalog queries over `pg_class`/`pg_policies`/`pg_proc`/`cron.job`, `run_weekly_log_purges` body, row counts on `support_conversations`/`funnel_events`/`email_subscribers`, `npm audit --omit=dev`, `scripts/check-prod-dep-audit.mjs` (exit 1), Vercel firewall API. Every number is a dated sample — re-measure before quoting.
