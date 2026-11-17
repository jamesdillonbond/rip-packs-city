# Secret rotation plan — the nine Vercel `sensitive` vars (known issue #229, item "rotation")

Written 2026-11-06 ~9:30 PM PT (Cowork cloud, read-only mapping; nothing was rotated). Source of the ask:
`docs/audits/2026-11-04-ciso-security-audit.md` §"Optional belt" — the nine vars were type `encrypted`
during the April-2026 Vercel incident window (Context.ai OAuth → non-sensitive env vars decrypted for a
subset of customers; Vercel notified affected customers directly). They are `sensitive` (write-only) since
11-04, so rotation guards only against a value that may ALREADY have left.

**Was this account notified?** Not settled. A Gmail search of Trevor's inbox (2026-11-06) found **no mail
from vercel.com at all between 2026-04-01 and 2026-11-01** — so the inbox cannot rule a notice in or out
(it may have gone elsewhere or been deleted). If Trevor can confirm "never notified", the whole plan drops
to optional.

⛔ **Rule for every step:** a new secret value is generated at the provider and pasted by Trevor into each
consumer. It never passes through a chat transcript, a commit, a ledger line or a tool argument.

⚠ **Vercel env changes apply on the NEXT deployment.** After editing env vars, redeploy the CURRENT
`main` tip (Deployments → the newest production deployment → ⋯ → Redeploy). Never redeploy an older
deployment — on 2026-10-31 that silently rolled prod back four commits (sessions/2026-11.md).

## Measured consumer map (grep of `main` @ 34946dc + live reads, 2026-11-06)

| Var | What it is | Readers | Verdict |
|---|---|---|---|
| `RPC_API_KEY` | — | **0** in app / lib / supabase / workers / scripts / workflows | **Dead — delete the Vercel var, no rotation** |
| `MARKET_FEED_TOKEN` | gate for `/api/market-feed` | route **deleted 2026-10-03** (#163); 0 readers | **Dead — delete the Vercel var, no rotation** |
| `TOPSHOT_SUBEDITION_KEYING` | feature flag (`=== "1"`, `app/api/ingest/route.ts`) | 1 file | **Not a secret — nothing to rotate** |
| `ANTHROPIC_API_KEY` | concierge model key | Vercel only (`support-chat`, `smoke-test`); CI uses a placeholder | Tier 1 — one place |
| `RESEND_API_KEY` | email sending | Vercel (17 files) + Supabase edge secret (`pipeline-failure-alerts`) | Tier 1 — two places |
| `TELEGRAM_BOT_TOKEN` | ops alert bot | Vercel (10 files) + GitHub Actions secret (`pipeline-sentinel.yml`, `site-availability-alarm.yml`) | Tier 1 — two places |
| `TS_PROXY_SECRET` | shared secret to our Cloudflare proxies | Vercel (24 files) + 4 Supabase edge functions + 8 Cloudflare workers (atlas, dune, helius, odds, reddit, sales-counterparty-backfill, sports, topshot) | Tier 2 — break window until every side matches |
| `CRON_SECRET` | Vercel cron bearer + accepted by ~100 route checks | Vercel env (Vercel crons send it automatically); any cron-job.org entry configured with it (header values are not readable from a session); laptop `.env.local` as a FALLBACK only (`INGEST_SECRET_TOKEN` preferred) | Tier 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | full DB access | Vercel (80 files) + GitHub Actions secret (18 uses / 15 workflows) + 3 Cloudflare workers (pack-events-ingest, rpc-mcp-proxy, sales-counterparty-backfill) + laptop `.env.local`; edge functions get it injected by Supabase; 0 pg_cron jobs inline a JWT, Vault holds only gate keys | **Tier 3 — a project, see below** |

## Order and steps

**Tier 0 — ✅ DONE 2026-11-06 ~9:20 PM PT** (Cowork via Trevor's Chrome, on his "Do what you think is best"): `RPC_API_KEY` and `MARKET_FEED_TOKEN` DELETED from Vercel (all environments), after re-grepping latest `main` for readers (0). No redeploy needed — nothing reads them. Seven vars remain on this list, one of which (`TOPSHOT_SUBEDITION_KEYING`) is a flag.

**Tier 1 (≈10 min each; do at a quiet hour; verify before moving on):**
1. **Anthropic** — console.anthropic.com → API Keys → create key → Vercel `ANTHROPIC_API_KEY` → redeploy
   main tip → verify: ask the concierge one question on rippackscity.com → then DISABLE the old key in the
   Anthropic console.
2. **Resend** — resend.com → API Keys → create (sending access, domain rippackscity.com) → Vercel
   `RESEND_API_KEY` AND Supabase → Edge Functions → Secrets `RESEND_API_KEY` → redeploy → verify: one
   magic-link sign-in email arrives → delete the old key in Resend.
3. **Telegram** — in Telegram, `@BotFather` → `/revoke` → pick the RPC bot → it replies with the new token
   (the OLD ONE DIES IMMEDIATELY, so have both destinations open) → Vercel `TELEGRAM_BOT_TOKEN` + GitHub →
   repo Settings → Secrets and variables → Actions → `TELEGRAM_BOT_TOKEN` → redeploy → verify: run the
   `pager-test.yml` workflow by hand (dispatch) and the next Sentinel message lands.

**Tier 2 (≈30 min each, with Claude watching the pipelines):**
4. **`TS_PROXY_SECRET`** — generate a long random value (password manager) → `wrangler secret put
   TS_PROXY_SECRET` for each of the 8 workers (Claude can drive `scripts/deploy-workers.mjs` on the laptop,
   Trevor pastes the value at the prompt) → the 4 Supabase edge-function secrets → Vercel → redeploy.
   Between the first and last paste, proxied calls fail; the pipelines retry on their next tick. Verify:
   `pipeline_runs` for the atlas/topshot/sports lanes go `ok` again within one cadence.
5. **`CRON_SECRET`** — new random value → Vercel → redeploy → Vercel crons pick it up on their own. Then
   any cron-job.org entry that 401s on its next run was using it: open that entry → Headers → replace the
   value. Update laptop `.env.local` only if it carries `CRON_SECRET` without `INGEST_SECRET_TOKEN`.

**Tier 3 — `SUPABASE_SERVICE_ROLE_KEY` (not a dashboard click).** This project still runs on the LEGACY
JWT keys (`get_publishable_keys`: legacy `anon` enabled, plus one new `sb_publishable_` key). The legacy
service-role key cannot be rotated alone: rotating the JWT secret also replaces the anon key (8 client
files read `NEXT_PUBLIC_SUPABASE_ANON_KEY`) and signs every user out. The clean path is the new key system:
(a) create an `sb_secret_` key and move every server consumer above onto it (test PostgREST + the workers'
REST calls first), (b) move the client from the legacy anon key to the `sb_publishable_` key, (c) then
**disable the legacy JWT keys** — only that step retires a possibly-leaked service-role key. (a)+(b) are a
Claude Code change with a deploy; (c) is Trevor's click after both are verified.

## Done when
Each rotated var: new value live, old value revoked at the provider, one real-caller success observed.
Record each in `docs/overnight/ledger.md` (var name and time only — never a value) and strike it in #229.
