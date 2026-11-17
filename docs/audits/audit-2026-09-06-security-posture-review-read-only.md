> Subagent report from the 2026-09-06 Cowork deep-audit session (Trevor present). Read-only; every number is a dated live sample — re-measure before quoting. Actions taken on it are recorded in docs/overnight/ledger.md (2026-09-06 entries) and known-issues #59–#62.

All checks complete. Here is the report.

---

# Rip Packs City — Security Posture Review (2026-09-06, read-only)

**Scope covered:** Supabase advisors (security + performance, both fully parsed via jq), live DB grants/RLS/SECDEF/extensions, live HTTP headers on 3 URLs, `proxy.ts` auth wall + rate limiting, repo secret hygiene, cron/edge token handling, known-issue #22 branch check. Nothing was modified; no secret values were read or printed.

## Headline

No CRITICAL findings. The DB hardening program recorded in `docs/reference/database.md` holds up live: **0 tables without RLS, 0 anon-readable SECDEF views, 0 anon-readable matviews, `check_secdef_anon_execute_violations()` returns an empty array, and every anon/authenticated-executable SECDEF function is in `secdef_anon_exec_allowlist` with a real reason.** The one open CRITICAL-class item remains the operator-only #22.

## Advisor summary

| Advisor | ERROR | WARN | INFO |
|---|---|---|---|
| security | 0 | 10 | 243 (`rls_enabled_no_policy`) |
| performance | 0 | 0 | 331 (269 `unused_index`, 60 `no_primary_key`, 1 `table_bloat`, 1 `auth_db_connections_absolute`) |

**All 10 security WARNs are known & accepted per repo:**
- `anon_security_definer_function_executable` / `authenticated_…` (0028/0029): `get_trophy_slab_data_by_username(text)`, `serial_fmv_estimate` ×2 overloads, `get_my_fan_teams()` — exactly the 4 rows of `public.secdef_anon_exec_allowlist` (approved 2026-07-21; migration `20260731213000_…justify_the_4_kept.sql`). Live grants match the notes (`get_my_fan_teams` anon=false).
- `function_search_path_mutable` (0011): `reconcile_all_saved_wallet_stats`, `rpc_trust_health_precompute_refresh_p` — documented as **must-not-pin** procedures with real `COMMIT` (database.md "get_advisors WILL KEEP TELLING YOU…", 08-23 outage). `series_chain_numbers` — IMMUTABLE pure lookup, EXECUTE TO PUBLIC justified in migration `20260904154741` header comment. All three are INVOKER, so no escalation path.

**New:** none at WARN level.

---

## HIGH

### H1 — #22 defeated credential purge: branch still exists (known, operator-only)
`git ls-remote` → `refs/heads/claude/todo-implementation-e4tib3` **YES, still present** (also `claude/todo-implementation-qi4350`). Remediation unchanged: delete via GitHub UI, GC, rotate regardless. Nothing new to add except that it is still there on 09-06.

## MEDIUM

### M1 — `pg_net` callable and readable by `anon`/`authenticated` (new to repo docs; Supabase default)
Evidence (live): `has_schema_privilege('anon','net','USAGE')=true`; EXECUTE on `net.http_get`, `net.http_post`, `net.http_delete` for both roles; `SELECT` on `net._http_response` (2,042 rows with bodies in last 24 h) and `net.http_request_queue` = **true** for both.
Mitigations already in place: PostgREST exposes only `public`, and **0** anon-executable `public` functions reference `net.*` (checked `prosrc`). So it is not reachable today — but it is one INVOKER function away from an anon SSRF-from-the-DB-host and from reading every pipeline HTTP response body. Not mentioned anywhere in `docs/reference`.
```sql
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA net FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA net FROM anon, authenticated;
-- verify: has_function_privilege('anon','net.http_post(text,jsonb,jsonb,integer)','execute') = false
```
(Keep `postgres`, `service_role`, `cron_heavy`/pg_cron owners.) Re-run `check_secdef_anon_exec_drift()` after.

### M2 — Default table grants far wider than RLS needs (known pattern; extent new)
`anon` holds 683 non-SELECT grants on `public` tables incl. **TRUNCATE on 146 tables** (`sales`, `editions`, `fmv_snapshots`, `moments`, `collections`, all partitions); `authenticated` holds 1,179 incl. INSERT/UPDATE/DELETE on `topshot_ownership`, `teams_master`, `special_serial_holders`. RLS makes INSERT/UPDATE/DELETE inert (verified: every matching permissive policy is `auth.uid()`-scoped, `service_role`-only, or `deny_anon_ts_listings USING false`; effective anon writes are only the four intentional telemetry/signup inserts `outbound_clicks`, `support_conversations`, `email_subscribers`, `funnel_events`, plus `portfolios` scoped by `request.jwt.claims->>'wallet'`). **TRUNCATE is not governed by RLS**; today 0 anon-executable functions contain `TRUNCATE`, so it is dormant. database.md:765 records the root cause (`ALTER DEFAULT PRIVILEGES` + PUBLIC default) but not the TRUNCATE dimension.
```sql
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
-- then re-GRANT INSERT on the 4 telemetry tables + the auth.uid()-scoped user tables to authenticated,
-- and fix the source: ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ... FROM anon, authenticated;
```
Apply in a low-traffic window (PGRST002 burst) and diff `role_table_grants` before/after; the anon-effective set above is the regression control.

### M3 — CSP `script-src 'self' 'unsafe-inline' 'unsafe-eval'` (new; not documented as accepted)
`proxy.ts:893`. Otherwise the CSP is strong: `default-src 'self'`, explicit `img/media/connect/font-src` allowlists (only wildcard is `https://*.supabase.co`, `*.arweave.net`, `*.sentry.io`), `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. HSTS 2y+preload, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` set; API `Cache-Control: public, max-age=0, must-revalidate`. Headers are applied on every proxy exit path (no exempt route; matcher excludes only `_next/static|_next/image|favicon.ico|img/`). `'unsafe-eval'` + `'unsafe-inline'` reduce XSS defence to nil. Shape: nonce-based CSP via `next/headers` (`script-src 'self' 'nonce-…' 'strict-dynamic'`), drop `'unsafe-eval'` unless a dependency (FCL?) genuinely needs it — measure with `Content-Security-Policy-Report-Only` first.

### M4 — Secrets accepted in query strings (known & accepted)
~40 `app/api/{admin,cron,*-indexer}` routes and 10 `supabase/functions/*` accept `?token=`/`?key=` in addition to Bearer (`lib/admin-auth.ts` documents why: cron-job.org cannot set headers). Consequence: gate keys sit in 13 `cron.job.command` rows and in Vercel/cron-job.org request logs. `cron.job` also carries a stray `SELECT` grant to `anon` (schema USAGE is false, so unreachable). Accept as documented, but `REVOKE SELECT ON cron.job FROM anon;` is free, and prefer moving keys to Vault (`vault.secrets` count = 0 today).

## LOW

- **L1 — Rate limiting is in-memory per Lambda** (`proxy.ts:148`, 60 rpm `/api/*`, 120 rpm anon DB-backed pages, keyed on `x-forwarded-for`). Effective only within one instance; `/api/cron` and `/api/ingest` are exempt, so token brute-force there is unmetered. `/api/auth/request-magic-link` (anon POST, calls `signInWithOtp`) has **no route-level limit** beyond the shared 60 rpm; `support-chat` has its own durable `concierge_ip_rate`. Shape: Upstash/Vercel KV sliding window on magic-link, `subscribe`, `early-access/submit`, `public/queue-wallet`.
- **L2 — `.gitignore` gaps:** `.env.staging`, `.env.development` (no `.local` suffix) and `*.pkey` (only `emulator-account.pkey` is named) are NOT ignored. Add `.env*` + `!.env.example` and `*.pkey`. Tracked-file check is clean: only `.env.example` is tracked; no `creds*`, `flow.json`, `.rpc-git-cred`.
- **L3 — 43 secret-bearing env vars referenced in code but absent from `.env.example`** (e.g. `HOT_WALLET_PRIVATE_KEY`, `SUPABASE_ACCESS_TOKEN`, `GITHUB_TOKEN`, `BREAKS_ADMIN_TOKEN`, `*_GATE_KEY[_OLD]` ×14, `*_PROXY_SECRET` ×8). CLAUDE.md acknowledges "3 absent"; the real number is much larger — a new operator cannot enumerate the secret inventory from the repo.

## INFO

- **Repo secret grep:** no literal token shapes (`sk_live_…`, JWTs, `ghp_/github_pat_`, AWS keys, PEM blocks) in the tree; the 655 matches are the word `service_role` in prose/tests and placeholder `sk_live` in `.env.example:62`.
- **Auth wall:** `isPublicPath` opens `/api/{auth,early-access,admin,cron,public,subscribe,support-chat,og,moment,entity,analytics}`, plus singletons (`wallet-search`, `teams/follow`, `rewards/track`, `track-click`, `track-funnel`, `telemetry`, `badge-image`). `/api/admin` and `/api/cron` are public *at the proxy* by design; a sweep of all 122 admin/cron/ingest `route.ts` found every one carrying a Bearer/token check (two delegate to `lib/studio-sales-history.ts:321`, live-probed → 401). Live unauthenticated probes: `/api/admin/evm-health` 401, `/api/fmv-recalc` and `/api/smoke-test` 307→login; `/api/cron/offers-sweep` GET 200 is a docs stub, POST gated. Anonymous POST handlers: 8 (magic-link, subscribe, early-access, 3× support-chat, `public/log/empty-sniper`, `public/queue-wallet`).
- **DB facts:** RLS on 100% of tables (244 with zero policies = deny-all; advisor INFO); `auth.users` = 24; extensions `pg_cron 1.6.4`, `pg_net 0.20.0`, `pg_stat_statements 1.11`, `pgcrypto`, `pg_trgm`, `pgstattuple`, `supabase_vault 0.3.1`, `unaccent`, `uuid-ossp`; 579 SECDEF functions, all with pinned `search_path`; 79 anon-executable INVOKER functions (availability class per database.md, 1 volatile writer `trim_recent_searches`, RLS-bound).
- **Performance INFO worth a look:** 60 `no_primary_key` tables (replication/upsert hazard) and 269 `unused_index` — the latter is documented as structurally unreliable (database.md:671); do not act on the count.

## Prioritised remediation order
1. Trevor: delete `claude/todo-implementation-e4tib3` (+ `qi4350`), rotate (#22).
2. M1 `net` schema revoke — one migration, zero app impact.
3. M2 default-privilege cleanup + `ALTER DEFAULT PRIVILEGES`, batched with (2) in one low-traffic window.
4. M3 CSP nonce migration behind Report-Only.
5. L1 durable rate limit on magic-link/subscribe; L2/L3 hygiene.