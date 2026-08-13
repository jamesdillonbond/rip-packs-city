# AllDay GraphQL returns 403 (HTML WAF block) through `ALLDAY_PROXY_URL` — edition hydrate may be silently dead

Claude Code, interactive, 2026-08-11 ~21:28 PT (2026-08-12 04:28Z). **Read-only finding. NOT fixed —
the remedy is an env/proxy-routing change, which is operator-gated.**

⛔ **This is NOT the edge-function gate-key 403** documented in
`2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md`. That one is a **JSON** `403 {"error":"forbidden"}`
from Supabase edge functions whose `?key=` literals were half-rotated. This one is an **HTML page**
(`<title>block</title>`, dark styled body) returned by an upstream **WAF** for the All Day GraphQL
host. Different layer, different cause, different fix. Do not merge the two lanes.

## Evidence

`/api/admin/discover-moment-descriptors` (v3) probes All Day at the SAME endpoint and with the SAME
headers as the production ingest — `lib/editions-hydrate.ts` `alldayUrl()` = `ALLDAY_PROXY_URL ||
https://nflallday.com/consumer/graphql`, `X-Proxy-Secret` when the proxy URL is set, and (as of v3)
the identical `User-Agent: rip-packs-city/editions-hydrate`. The report confirms
`ALLDAY_PROXY_URL (set)` and `TS_PROXY_SECRET (set)`, and every All Day probe returns:

```
HTTP 403: <title>block</title>
<body style="font-family: system-ui; background: #2d2c32; color: white; ...
```

Both **control** fields fail — `playerName` and `classification`, which the live
`ALLDAY_RELAY_QUERY` selects on every run. So the arm is correctly reported INCONCLUSIVE; nothing is
being claimed about the All Day schema.

⚠ The v3 run was NOT a probe artifact: the **Top Shot arm on the same request went CONCLUSIVE**
(controls returned `Mike James` / `3 Pointer` / a real `dateOfMoment`), so the auth, the secret, and
the outbound path from the lambda all work. The failure is specific to the All Day endpoint.

## Corroborating signal (independent)

`editions.last_updated_at` is **NULL on all 6,190 `nfl_all_day` rows**, while `nba_top_shot` shows a
newest value of 2026-08-11 and 21 rows updated in the trailing 7 days.

⚠ **This is corroboration, not proof.** That column may simply never be written by the All Day
path — nobody has checked. Two independent signals pointing the same way is a reason to look, not a
reason to conclude. Do not file "the All Day ingest is broken" as fact until someone confirms the
write path.

## Why it matters more than it did yesterday

The same v3 run proved Top Shot exposes `description` and `headline` (plus box-score and player-bio
fields). All Day's `play { description }` has been selected by `ALLDAY_RELAY_QUERY` since that query
was written, and `editions.description` now exists to receive it (2026-08-11). If the hydrate is
403ing, that column can never populate for All Day no matter what the ingest code does — so this
blocks the descriptive-search work for one of the two biggest collections.

## What to check (operator)

1. What does `ALLDAY_PROXY_URL` actually point at in Vercel? A **direct** `nflallday.com` URL would
   explain an upstream WAF block. CLAUDE.md records that Cloudflare WAF on both All Day hostnames
   blocks Vercel/Supabase egress and that traffic is supposed to route through the `topshot-proxy`
   worker (`/allday` for public-api, `/allday-consumer` for `getMintedMoment`).
2. `ALLDAY_RELAY_QUERY` uses `allEditions`, which lives on the **consumer** endpoint — so the
   correct value is plausibly `<worker>/allday-consumer`, not `<worker>/allday` and not the bare
   host. Confirm against the worker's routes before changing anything.
3. Re-run the probe after any change; the arm going conclusive is the pass condition.

## Deliberately not done

No env var was touched and no routing was changed — both are outward-facing operator decisions, and
a wrong guess here would silently redirect a production ingest. Filing rather than fixing.

---

## ANSWERED — Claude Code, 2026-08-13. Routing confirmed against the worker source, not guessed.

The doc above asked for exactly this before anyone changed an env var. All three checks now
resolve, and they agree.

**1. `allEditions` is a CONSUMER-endpoint operation.** `lib/chains/flow/alldayGraphql.ts`
hardcodes `ALLDAY_CONSUMER_GRAPHQL_URL = "https://nflallday.com/consumer/graphql"`, and
`docs/allday-graphql-callers-broken.md` records on triage that
`scripts/backfill-residual-edition-metadata.mjs` "uses `allEditions(first, after)` for AllDay,
which still resolves on `nflallday.com/consumer/graphql`". So `ALLDAY_RELAY_QUERY` must reach the
**consumer** host — `/allday` (public-api) is the wrong route and would fail on the schema, not
the WAF.

**2. The consumer host REQUIRES a browser fingerprint, and only the worker route adds one.**
`workers/topshot-proxy/index.js` says so in its own header:

> `/allday-consumer` additional gating: the consumer endpoint serves a reduced public schema
> (no `getMintedMoment`) to non-browser-fingerprinted requests. This route adds Origin / Referer
> / browser User-Agent so the schema flips to the full view. **Scoped to this route only** —
> public-api routes stay on the bare `sports-collectible-tool/0.1` UA.

`ROUTE_HEADERS["allday-consumer"]` sets `Origin: https://nflallday.com`,
`Referer: https://nflallday.com/`, and a full Chrome `User-Agent`.

**3. The hydrate sends a NON-browser UA.** `lib/editions-hydrate.ts` sends
`User-Agent: rip-packs-city/editions-hydrate`. An HTML `<title>block</title>` body is a WAF
verdict on the CLIENT, which is exactly what that UA earns at `nflallday.com` — and it explains
why the Top Shot arm of the same request succeeded (different host, no such gating).

### Conclusion

`ALLDAY_PROXY_URL` should be **`https://<topshot-proxy-host>/allday-consumer`**. That single value
fixes both failure modes at once: it moves egress onto Cloudflare (off the WAF-blocked Vercel
range) **and** applies the browser fingerprint the consumer endpoint demands. A bare
`nflallday.com/consumer/graphql` — which is also the code's fallback when the env var is unset —
**can never work from a Vercel lambda**, so if the current value is the bare host, the observed
403 is fully explained.

⚠ **Still operator-gated**: this is a Vercel env-var write, and the pass condition needs
`RPC_ADMIN_TOKEN` to re-run the probe. Neither is available here.

**Operator steps:** set `ALLDAY_PROXY_URL` to the worker's `/allday-consumer` route → redeploy
(⚠ an empty or docs-only commit will NOT rebake it — use the v13 deployments POST, per
CLAUDE.md) → re-run `POST /api/admin/discover-moment-descriptors`. **Pass condition: the All Day
arm goes `conclusive: true`** (controls `playerName` + `classification` return real values).
Until then AllDay `editions.description` cannot populate, so AllDay prose stays absent from
narrative search — a disclosed coverage gap, not a search bug.

⚠ **One caveat that is NOT resolved here:** the corroborating signal above (all 6,190
`nfl_all_day` rows have `last_updated_at` NULL) still has not been traced to a write path.
It remains corroboration, not proof, exactly as the original filing said. Do not upgrade it to
"the AllDay ingest is broken" without checking whether that column is written by the AllDay path
at all.
