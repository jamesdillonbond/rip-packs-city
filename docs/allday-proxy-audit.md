# AllDay Cloudflare proxy auth-path audit

Date: 2026-05-03
Trigger: We rotated `TS_PROXY_SECRET`, `PINNACLE_PROXY_SECRET`, and `SPORK_PROXY_SECRET` in Cloudflare and Vercel/Supabase. The AllDay equivalent was never visible in Vercel env, but the worker continues to serve ~6.2k requests/day successfully. This audit answers: how is AllDay traffic actually authenticated, and what's the safe rotation procedure.

## TL;DR

1. **There is no separate `allday-proxy.tdillonbond.workers.dev` worker.** The hostname appears once in `next.config.ts:18` (CSP `connect-src`) but no worker source for it exists in the repo, and it does not appear in `proxy.ts` (the canonical CSP). All AllDay traffic is served by the **same** `topshot-proxy.tdillonbond.workers.dev` worker via its `/allday` path route.
2. **The worker has exactly one secret**: `env.PROXY_SECRET` ([workers/topshot-proxy/index.js:37](workers/topshot-proxy/index.js#L37)). Both Top Shot and AllDay traffic validate against the same value.
3. **The calling code is split between two env-var names** for the proxy secret. Both must be set to the same value as the worker's `PROXY_SECRET` for the codebase to keep working.

## What env var name does the calling code expect?

Inconsistent. Two different names are in use across 7 call sites:

### Sites that read `AD_PROXY_SECRET`

| File | Line | Pattern |
|------|------|---------|
| [app/api/sniper-feed/route.ts](app/api/sniper-feed/route.ts#L168-L169) | 168-169, 663 | `process.env.AD_PROXY_SECRET`; sent as `X-Proxy-Secret` only when both `AD_PROXY_URL` and `AD_PROXY_SECRET` are set |
| [app/api/allday-listing-cache/route.ts](app/api/allday-listing-cache/route.ts#L25-L26) | 25-26 | `AD_GQL_SECRET = process.env.AD_PROXY_SECRET ?? ""` |
| [app/api/allday-fmv-populate/route.ts](app/api/allday-fmv-populate/route.ts#L18-L19) | 18-19 | `AD_GQL_SECRET = process.env.AD_PROXY_SECRET ?? ""` |

### Sites that read `TS_PROXY_SECRET` for AllDay traffic

| File | Line | Pattern |
|------|------|---------|
| [app/api/allday-seed-editions/route.ts](app/api/allday-seed-editions/route.ts#L29-L30) | 29-30 | Reads `process.env.AD_PROXY_URL` but pairs it with `process.env.TS_PROXY_SECRET` |
| [lib/editions-hydrate.ts](lib/editions-hydrate.ts#L331-L332) | 331-332 | Same pattern: `AD_PROXY_URL` + `TS_PROXY_SECRET` |
| [scripts/seed-allday-editions.mjs](scripts/seed-allday-editions.mjs#L40-L41) | 40-41 | Same pattern |
| [scripts/backfill-residual-edition-metadata.mjs](scripts/backfill-residual-edition-metadata.mjs#L243) | 243 | Same pattern |

### Sites that bypass the proxy

| File | Line | Notes |
|------|------|-------|
| [supabase/functions/compute-allday-pack-ev/index.ts](supabase/functions/compute-allday-pack-ev/index.ts#L29) | 29 | Hits `api.production.studio-platform.dapperlabs.com/graphql` directly. Studio Platform is a different upstream (not the Cloudflare-protected `public-api`), so no proxy is needed. |
| [scripts/fetch-allday-collection.mjs](scripts/fetch-allday-collection.mjs#L50) | 50 | Hits `nflallday.com/consumer/graphql` with a real browser cookie. Not part of the production code path. |

### Phantom CSP entry

[next.config.ts:18](next.config.ts#L18) lists `https://allday-proxy.tdillonbond.workers.dev` in `connect-src`. No worker by that name exists in `workers/`, and `proxy.ts:80` (the actual production CSP middleware, applied via the Next.js 16 proxy layer) does NOT include that host — it lists `topshot-proxy` and `pinnacle-proxy` only. The `next.config.ts` CSP appears to be dead code shadowed by `proxy.ts`. Should be removed in a follow-up cleanup.

## Does that env var actually exist in Vercel/Supabase?

Cannot be verified from the repo. The repo doesn't ship `.env.local`, and the Vercel CLI is not installed in this environment, so `vercel env pull` is unavailable. From the request-volume evidence (the worker is doing 6.2k req/day), at least one of these two paths is working:

- **Most likely**: `AD_PROXY_URL` is set to `https://topshot-proxy.tdillonbond.workers.dev/allday` (per [workers/topshot-proxy/README.md:28](workers/topshot-proxy/README.md#L28)), AND **both** `AD_PROXY_SECRET` and `TS_PROXY_SECRET` are set to the same value (= the worker's `PROXY_SECRET`). This explains why both the `AD_PROXY_SECRET` and `TS_PROXY_SECRET` call sites successfully reach the worker.
- **Possible fallback path**: If `AD_PROXY_URL` is unset, every `process.env.AD_PROXY_URL || "..."` fallback falls back to `https://nflallday.com/consumer/graphql` (the consumer endpoint) — *not* `public-api.nflallday.com/graphql`. The consumer endpoint historically does not Cloudflare-block Vercel egress IPs the way `public-api` does, so this path can succeed without a proxy. That would mean some traffic is bypassing the worker entirely, and the worker volume comes from the routes that explicitly use `public-api` (e.g. `app/api/allday-sniper-feed/route.ts:65` hits `public-api.nflallday.com/graphql` directly with no proxy URL toggle at all — that one actually relies on Vercel's egress not being blocked for the `public-api` hostname today).

To confirm which path is live: in Vercel, run `vercel env ls` (or the dashboard equivalent) and check whether `AD_PROXY_URL`, `AD_PROXY_SECRET`, and `TS_PROXY_SECRET` are all defined. If `AD_PROXY_SECRET` is missing, then the three routes that read it are silently sending no `X-Proxy-Secret` header, and the worker is rejecting them with 401 — meaning their AllDay traffic is failing without alarms today.

## Does the worker validate auth, and what does it expect?

Yes. [workers/topshot-proxy/index.js:36-39](workers/topshot-proxy/index.js#L36-L39):

```js
const authHeader = request.headers.get("X-Proxy-Secret");
if (!authHeader || authHeader !== env.PROXY_SECRET) {
  return new Response("Unauthorized", { status: 401 });
}
```

It expects an `X-Proxy-Secret` request header equal to the worker's `env.PROXY_SECRET` (set via `wrangler secret put PROXY_SECRET`). Both `/topshot` and `/allday` paths share that single secret — there is no per-route auth in the worker.

## Recommended rotation procedure

The cleanest sequence avoids any window where the worker accepts the new secret but the callers still send the old one (or vice versa). Steps:

1. **Pick a new value.** Generate a strong random string. Call it `NEW_VALUE`.
2. **Pre-stage on Vercel.** Set both `TS_PROXY_SECRET` and `AD_PROXY_SECRET` to `NEW_VALUE` in Vercel (production + preview + development for both names). Do **not** redeploy yet — env-var changes only take effect on the next deploy. Production is still on the old value at this point.
3. **Update the worker.** Run `wrangler secret put PROXY_SECRET` against `topshot-proxy` and enter `NEW_VALUE`. The worker rotates within seconds, immediately rejecting old-value traffic.
4. **Brief failure window.** From step 3 until step 5, all proxied AllDay and Top Shot calls return 401. Expected duration: under a minute.
5. **Trigger a Vercel redeploy.** Empty commit + push, or click "Redeploy" in the dashboard. The new functions pick up `NEW_VALUE` and resume succeeding.
6. **Verify in `pipeline_runs.extra`.** Watch the next ~3 cron ticks across `compute-topshot-pack-ev`, `allday-listing-cache`, and `allday-fmv-populate`. `using_proxy: true` and non-zero `rows_written` confirm the new secret is reaching the worker.
7. **Optional cleanup** (separate PR, recommended):
   - Pick one canonical name (suggest `WORKERS_PROXY_SECRET`) and update all 7 call sites + the README to use it. Drop `AD_PROXY_SECRET` and `TS_PROXY_SECRET` in favor of the canonical name.
   - Remove `https://allday-proxy.tdillonbond.workers.dev` from `next.config.ts:18` — it's a phantom host.
   - Document in CLAUDE.md that Cloudflare worker secrets are write-only after `wrangler secret put`, so any rotation must be coordinated with the Vercel side rather than read-and-compare.

## Caller-by-caller reference (for the cleanup PR)

```
# Routes that hit AllDay GQL via the proxy
app/api/sniper-feed/route.ts                            AD_PROXY_URL + AD_PROXY_SECRET
app/api/allday-listing-cache/route.ts                   AD_PROXY_URL + AD_PROXY_SECRET
app/api/allday-fmv-populate/route.ts                    AD_PROXY_URL + AD_PROXY_SECRET
app/api/allday-seed-editions/route.ts                   AD_PROXY_URL + TS_PROXY_SECRET   ← inconsistent
lib/editions-hydrate.ts                                 AD_PROXY_URL + TS_PROXY_SECRET   ← inconsistent
scripts/seed-allday-editions.mjs                        AD_PROXY_URL + TS_PROXY_SECRET   ← inconsistent
scripts/backfill-residual-edition-metadata.mjs          AD_PROXY_URL + TS_PROXY_SECRET   ← inconsistent

# Routes that hit AllDay GQL directly (no proxy)
app/api/allday-sniper-feed/route.ts                     hits public-api.nflallday.com/graphql with no proxy toggle
supabase/functions/compute-allday-pack-ev/index.ts      hits api.production.studio-platform.dapperlabs.com (different upstream)
scripts/fetch-allday-collection.mjs                     hits nflallday.com/consumer/graphql with browser cookies
```
