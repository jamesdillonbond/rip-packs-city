# AllDay Cloudflare proxy auth-path audit

Date: 2026-05-03
Trigger: We rotated `TS_PROXY_SECRET`, `PINNACLE_PROXY_SECRET`, and `SPORK_PROXY_SECRET` in Cloudflare and Vercel/Supabase. The AllDay equivalent was never visible in Vercel env, but the worker continues to serve ~6.2k requests/day successfully. This audit answers: how is AllDay traffic actually authenticated, and what's the safe rotation procedure.

## STATUS: cleanup completed 2026-05-03

The audit identified a split between two env-var names for the same worker secret. That split has now been unified on `TS_PROXY_SECRET` across all 7 call sites. The legacy AllDay-specific env-var name is removed from the codebase. The Vercel env entry for the legacy name should be deleted from the dashboard so it does not drift back. See the "Caller-by-caller reference" section below for the post-cleanup state.

## STATUS UPDATE 2026-05-03 (later that day): phantom-worker conclusion was wrong

Cloudflare metrics for 2026-05-03 show `allday-proxy.tdillonbond.workers.dev` serving **6,000 requests over 24h with a 100% success rate** to upstream `nflallday.com`. That contradicts the original TL;DR claim that no separate AllDay worker exists. A real worker is deployed at that hostname and is doing real work. The original audit's grep was complete *for this repo*, but the worker lives outside it — so the audit's negative result is correct in scope but its inference ("therefore no such worker") was wrong.

### Re-investigation: where does the call site live?

A comprehensive sweep of the entire repo (every git-tracked file, every untracked file, all of `app/`, `lib/`, `supabase/functions/`, `scripts/`, `workers/`, `infrastructure/`, `.github/`, `next.config.ts`, all docs and env files) for the strings `allday-proxy.tdillonbond.workers.dev`, `allday-proxy`, `allday-proxy.tdillonbond`, `ALLDAY_PROXY_URL`, `ALLDAY_PROXY`, `AllDayProxy`, and `alldayProxy` returns these matches and no others:

| File | Pattern | Live? |
|------|---------|-------|
| [next.config.ts:18](next.config.ts#L18) | `connect-src 'self' https: wss: https://allday-proxy.tdillonbond.workers.dev` | **Dead.** The production CSP (verified from a `/api/smoke-test` response header) is the one in `proxy.ts:80`, which does NOT include this host. Per smoke-test response on dpl_3LpLb642iq9ED9GdDWADv5TCJHVQ, the served CSP lists `pinnacle-proxy` and `topshot-proxy` only. The `next.config.ts` CSP is shadowed by the middleware-set CSP from proxy.ts. Added by Trevor on 2026-04-17 in commit 50cde8e ("feat(sniper): AllDay UI polish + Cadence integer enrichment"). |
| [docs/allday-proxy-audit.md](docs/allday-proxy-audit.md) | This file | Documentation only |

`git log --all -p -i -S "allday-proxy.tdillonbond"` returns only the audit doc creation commit. `git log --all --diff-filter=AD --name-only | grep -i allday-proxy` finds no file ever named with `allday-proxy` outside `docs/allday-proxy-audit.md`. There has never been a `workers/allday-proxy/` or `infrastructure/allday-proxy-worker/` directory in this repo's history.

No code in this repo constructs the string `allday-proxy.tdillonbond.workers.dev` — checked literal occurrences, template-literal compositions (`workers.dev` + `/allday`), and env-var indirections (no `ALLDAY_PROXY_URL` variant exists; the codebase only reads `AD_PROXY_URL`).

### What the 6,000 req/day must therefore mean

Conclusion: a real `allday-proxy` Cloudflare worker exists, but its source-of-truth lives outside this repo. The audit's mistake was inferring "no source in repo → no worker." The real options for where it actually lives:

1. **Most likely — Vercel env redirect via `AD_PROXY_URL`.** The 7 in-repo callers that read `process.env.AD_PROXY_URL` would route to the standalone `allday-proxy` worker if Vercel's `AD_PROXY_URL` value is `https://allday-proxy.tdillonbond.workers.dev/...` rather than the README-recommended `https://topshot-proxy.tdillonbond.workers.dev/allday`. The standalone worker would then need its own `PROXY_SECRET` configured to the same value as `topshot-proxy`'s — that's why both Top Shot and AllDay traffic succeed under one `TS_PROXY_SECRET` env value. **Verification command**: `vercel env ls` (Vercel CLI not installed locally; use the dashboard at https://vercel.com/rippackscity-projects/rip-packs-city/settings/environment-variables and read `AD_PROXY_URL`).
2. **Cloudflare worker deployed manually from the dashboard** (not from this repo's `wrangler deploy`). Wrangler-managed workers in this repo: `topshot-proxy`, `pinnacle-proxy`, `spork-proxy`. The `allday-proxy` worker is published but not under any version control we can see. **Verification command**: `wrangler deployments list --name allday-proxy` against the tdillonbond Cloudflare account, or browse the Cloudflare dashboard → Workers & Pages → `allday-proxy`.
3. **Supabase Edge Function whose source isn't synced to this repo.** This repo's `supabase/functions/` contains 11 functions; the Supabase project might host more that were deployed via the dashboard or MCP tool and never committed. **Verification command**: `supabase functions list --project-ref bxcqstmqfzmuolpuynti` (or use the MCP `list_edge_functions` tool against project `bxcqstmqfzmuolpuynti` and grep the deployed source for `allday-proxy`).
4. **cron-job.org direct hit.** A cron entry on cron-job.org that POSTs to `https://allday-proxy.tdillonbond.workers.dev/...` directly — not invoked through any RPC code. This repo doesn't ship a `CRON_JOBS.md` (none exists), so the inventory of cron-job.org entries has to come from the cron-job.org dashboard itself.
5. **Less likely — browser code.** Production CSP blocks the host (smoke-test header confirms), so even if some sniper UI fetched it, the browser would refuse the request. Doesn't match a 100% success rate.

### Why the original audit got it wrong

The audit conflated "absence of evidence in the repo" with "evidence of absence." Three independent things were true and the audit collapsed them:

- The hostname is not constructed in repo code → correct.
- No worker source for it exists in `workers/` or `infrastructure/` → correct.
- Therefore the worker does not exist → **wrong**. Cloudflare workers can be deployed without their source ever entering this repo, and Vercel env vars can route in-repo callers to them.

The 6,000 req/day to `nflallday.com` upstream is the falsifying evidence. Those requests are happening, and the fact that they succeed means `X-Proxy-Secret` is being sent and accepted — meaning some caller (in or adjacent to our infra) holds a matching secret and a URL pointing to that worker.

### Next investigation step (to actually find the call site)

This requires resources outside the repo. In priority order:

1. Read `AD_PROXY_URL` in the Vercel dashboard for production. If it's `https://allday-proxy.tdillonbond.workers.dev/...`, mystery solved — every in-repo caller with `AD_PROXY_URL` indirection routes there, and we just need to decide whether to consolidate by repointing it at `topshot-proxy/allday` and decommissioning the standalone worker.
2. Check Cloudflare dashboard / wrangler for the `allday-proxy` worker's source and any scheduled triggers. If the worker has its own scheduled handler (Cloudflare Cron Trigger), it may be self-firing — that explains traffic without any RPC-side caller.
3. Use the Supabase MCP `list_edge_functions` against project `bxcqstmqfzmuolpuynti` and inspect any function whose source isn't in `supabase/functions/` here.
4. Audit cron-job.org for any job whose target URL contains `allday-proxy`.

Until one of those four sources is checked, do **not** decommission the `allday-proxy` Cloudflare worker. The 6k/day is real traffic with real callers.


## TL;DR

1. **There is no separate `allday-proxy.tdillonbond.workers.dev` worker.** The hostname appears once in `next.config.ts:18` (CSP `connect-src`) but no worker source for it exists in the repo, and it does not appear in `proxy.ts` (the canonical CSP). All AllDay traffic is served by the **same** `topshot-proxy.tdillonbond.workers.dev` worker via its `/allday` path route.
2. **The worker has exactly one secret**: `env.PROXY_SECRET` ([workers/topshot-proxy/index.js:37](workers/topshot-proxy/index.js#L37)). Both Top Shot and AllDay traffic validate against the same value.
3. **The calling code was split between two env-var names** for the proxy secret. The cleanup unified everything on `TS_PROXY_SECRET`, which now matches the worker's `PROXY_SECRET` value across all 7 call sites.

## What env var name does the calling code expect?

Post-cleanup: every caller reads `process.env.TS_PROXY_SECRET`. Pre-cleanup, three sites used a separate AllDay-specific name and four used `TS_PROXY_SECRET`; that inconsistency has been removed.

### Sites unified onto `TS_PROXY_SECRET` during the 2026-05-03 cleanup

| File | Pattern |
|------|---------|
| [app/api/sniper-feed/route.ts](app/api/sniper-feed/route.ts) | Sends `X-Proxy-Secret` only when both `AD_PROXY_URL` and `TS_PROXY_SECRET` are set |
| [app/api/allday-listing-cache/route.ts](app/api/allday-listing-cache/route.ts) | `AD_GQL_SECRET = process.env.TS_PROXY_SECRET ?? ""` |
| [app/api/allday-fmv-populate/route.ts](app/api/allday-fmv-populate/route.ts) | `AD_GQL_SECRET = process.env.TS_PROXY_SECRET ?? ""` |

### Sites that already used `TS_PROXY_SECRET` for AllDay traffic

| File | Line | Pattern |
|------|------|---------|
| [app/api/allday-seed-editions/route.ts](app/api/allday-seed-editions/route.ts#L29-L30) | 29-30 | Reads `process.env.AD_PROXY_URL` paired with `process.env.TS_PROXY_SECRET` |
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

Cannot be verified from the repo. The repo doesn't ship `.env.local`, and the Vercel CLI is not installed in this environment, so `vercel env pull` is unavailable. From the request-volume evidence (the worker is doing 6.2k req/day), at least one of these two paths was working before the cleanup:

- **Most likely**: `AD_PROXY_URL` was set to `https://topshot-proxy.tdillonbond.workers.dev/allday` (per [workers/topshot-proxy/README.md:28](workers/topshot-proxy/README.md#L28)), AND **both** the legacy AllDay-specific name and `TS_PROXY_SECRET` were set to the same value (= the worker's `PROXY_SECRET`). This explained why both sets of call sites successfully reached the worker.
- **Possible fallback path**: If `AD_PROXY_URL` was unset, every `process.env.AD_PROXY_URL || "..."` fallback fell back to `https://nflallday.com/consumer/graphql` (the consumer endpoint) — *not* `public-api.nflallday.com/graphql`. The consumer endpoint historically does not Cloudflare-block Vercel egress IPs the way `public-api` does, so this path could succeed without a proxy. That would mean some traffic was bypassing the worker entirely, and the worker volume came from the routes that explicitly use `public-api` (e.g. `app/api/allday-sniper-feed/route.ts:65` hits `public-api.nflallday.com/graphql` directly with no proxy URL toggle at all — that one actually relies on Vercel's egress not being blocked for the `public-api` hostname today).

Post-cleanup: the legacy AllDay-specific env-var entry on Vercel should be deleted manually so it cannot drift back. `TS_PROXY_SECRET` is now the only proxy-secret name the codebase reads.

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
2. **Pre-stage on Vercel.** Set `TS_PROXY_SECRET` to `NEW_VALUE` in Vercel (production + preview + development). Do **not** redeploy yet — env-var changes only take effect on the next deploy. Production is still on the old value at this point.
3. **Update the worker.** Run `wrangler secret put PROXY_SECRET` against `topshot-proxy` and enter `NEW_VALUE`. The worker rotates within seconds, immediately rejecting old-value traffic.
4. **Brief failure window.** From step 3 until step 5, all proxied AllDay and Top Shot calls return 401. Expected duration: under a minute.
5. **Trigger a Vercel redeploy.** Empty commit + push, or click "Redeploy" in the dashboard. The new functions pick up `NEW_VALUE` and resume succeeding.
6. **Verify in `pipeline_runs.extra`.** Watch the next ~3 cron ticks across `compute-topshot-pack-ev`, `allday-listing-cache`, and `allday-fmv-populate`. `using_proxy: true` and non-zero `rows_written` confirm the new secret is reaching the worker.
7. **Optional cleanup** (separate PR, recommended):
   - Remove `https://allday-proxy.tdillonbond.workers.dev` from `next.config.ts:18` — it's a phantom host.
   - Document in CLAUDE.md that Cloudflare worker secrets are write-only after `wrangler secret put`, so any rotation must be coordinated with the Vercel side rather than read-and-compare.

## Caller-by-caller reference (post-cleanup state)

```
# Routes that hit AllDay GQL via the proxy — all unified on TS_PROXY_SECRET
app/api/sniper-feed/route.ts                            AD_PROXY_URL + TS_PROXY_SECRET
app/api/allday-listing-cache/route.ts                   AD_PROXY_URL + TS_PROXY_SECRET
app/api/allday-fmv-populate/route.ts                    AD_PROXY_URL + TS_PROXY_SECRET
app/api/allday-seed-editions/route.ts                   AD_PROXY_URL + TS_PROXY_SECRET
lib/editions-hydrate.ts                                 AD_PROXY_URL + TS_PROXY_SECRET
scripts/seed-allday-editions.mjs                        AD_PROXY_URL + TS_PROXY_SECRET
scripts/backfill-residual-edition-metadata.mjs          AD_PROXY_URL + TS_PROXY_SECRET

# Routes that hit AllDay GQL directly (no proxy)
app/api/allday-sniper-feed/route.ts                     hits public-api.nflallday.com/graphql with no proxy toggle
supabase/functions/compute-allday-pack-ev/index.ts      hits api.production.studio-platform.dapperlabs.com (different upstream)
scripts/fetch-allday-collection.mjs                     hits nflallday.com/consumer/graphql with browser cookies
```
