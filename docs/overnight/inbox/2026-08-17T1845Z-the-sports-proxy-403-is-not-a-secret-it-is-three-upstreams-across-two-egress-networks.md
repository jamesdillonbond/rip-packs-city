# The sports-proxy 403 is NOT a secret problem — it is three upstreams 403'ing across TWO independent egress networks

Filed 2026-08-17 11:45 PT / 18:45Z (Claude Code, interactive). Found by testing the *reason for deferral*
rather than the finding — the same move that closed the fossil drain earlier the same session.

## The claim being refuted

CLAUDE.md records this item in four places as **"operator-only"**, twice with the explicit reason
*"reading the secret would leak it into a transcript"*. It is called **"the single highest-value item"**
and is the one root cause behind three symptoms (projections 27 d stale, the player catalogue 101 d stale,
Fast Break on a 19-team roster).

**No secret is involved.** Nobody needs to read, rotate, or even look at a credential. The deferral reason
was never tested, and it is what kept the highest-value item parked across multiple sessions.

## Three independent grounds, all from data already on hand

**1. The proxy returned 502, not 401.** `workers/sports-proxy/index.ts:970-972` is the auth gate:

```ts
const auth = request.headers.get("X-Proxy-Secret");
if (!auth || auth !== env.PROXY_SECRET) {
  return jsonResponse({ error: "unauthorized" }, 401);
}
```

A bad or missing secret is a **401, returned before any upstream is touched**. The live payload carries
`dk_status: 502` / `rolling_status: 502` with `dk_upstream_status: 403` and
`rolling_upstream_status: 403`. **Recording an upstream status requires having already passed auth.**

**2. The edge function's own env guard did not fire.** `sync-nba-projections/index.ts:642` short-circuits
on `!SPORTS_PROXY_URL || !SPORTS_PROXY_SECRET` and emits `has_url` / `has_secret` diagnostics. That branch
is absent from every failing payload, so both are set.

**3. The ESPN lane does not use the proxy or the secret AT ALL — and it is also 403'ing.** Line 16 and
line 368 of the edge function say so outright: *"site.api.espn.com scoreboard (direct, no proxy)"*,
*"open to Supabase egress (no Akamai, no TLS-fingerprint...)"*. It fetches from **Supabase edge egress**,
a completely different network from the Cloudflare Worker, and returns `espn_status: 403`.

## What is actually happening

| lane | egress | result |
|---|---|---|
| DraftKings lobby | Cloudflare Worker | `dk_upstream_status: 403` — Akamai **"Access Denied"** page (`errors.edgesuite.net`) |
| `cdn.nba.com` scoreboard | Cloudflare Worker | `rolling_upstream_status: 403` |
| `site.api.espn.com` | **Supabase edge (direct)** | `espn_status: 403` |

**Three providers, two independent egress networks, all 403.** That pattern points at the data providers
broadly tightening bot-blocking, not at one stale fingerprint or one blocked IP range of ours.

⚠ **The `cdn.nba.com` failure specifically contradicts the design's stated assumption.** The route comment
says that host is *"static S3 mirror … **Open to CF Workers (no WAF)**"* and therefore *"scoreboard rarely
fails so a single attempt is fine"* — so it is the **one fetch in the file with no retry and no fingerprint
rotation**, and it sends a deliberately minimal 2-header request (`User-Agent` + `Accept` only, no
`Accept-Language`, no `Origin`/`Referer`, no `sec-ch-ua`). It was built thin *because* it was assumed
WAF-free. That assumption is what broke, and the escalation path that exists for the sibling DK lane
(`fetchWithDkRetry`: retry on 403 with a rotated fingerprint) does not cover it.

⚠ **A second, latent version of the same gap:** `fetchWithStatsRetry` returns immediately on any status
`< 500` — its comment reads *"4xx that won't change"*. That was true when written (stats.nba.com 520'd;
DK was the 403'er) and a bot-detection 403 is precisely a 4xx that DOES change on a rotated fingerprint.
Not the currently-failing lane, so **not** shipped as a speculative fix; recorded so it is not rediscovered
as the cause.

⚠ **`BROWSER_POOL` is ~2 years stale** — Chrome 126/127/128, Safari 17.5, Firefox 128, i.e. mid-2024
captures being presented in August 2026. A fingerprint claiming Chrome 126 today is itself a bot signal.
Real, but see below for why refreshing it is **not** obviously the fix.

## What I deliberately did NOT ship, and why

A UA/fingerprint refresh plus 403-retry on the cdn lane is the obvious patch. **I did not ship it**, on
merit rather than on capability:

- **It cannot touch the ESPN lane at all** — that one is direct from Supabase and shares no code with the
  worker. A worker-side fingerprint fix leaves one of the three 403s completely unaddressed, which is
  strong evidence the shared cause is not our fingerprint.
- **I cannot verify it.** The decisive test — does `cdn.nba.com` 403 a *non-Cloudflare* IP with the same
  minimal headers? — is unavailable here: the sandbox proxy answers `CONNECT tunnel failed, response 403`
  for that host. ⚠ **That is the SANDBOX's 403, not NBA's**; conflating the two is exactly the class this
  repo keeps paying for, so it is stated rather than used as evidence.
- **The blast radius is wrong for an unverified change.** `BROWSER_POOL`, `nbaHeaders` and the fingerprint
  helpers are shared by `/nba/scoreboard` and `/nba/odds` as well. Editing them to chase an unverified
  hypothesis risks the routes that are not currently broken.
- It needs an operator `wrangler deploy` regardless, so shipping it inert buys nothing until someone acts —
  and `atlas-proxy` is the standing example of inert worker code sitting unshipped at a real user-facing cost.

**This is the `match-topshot-players` disposition:** a correct-looking fix that cannot be verified and
cannot help while the upstream is starved is not an improvement, it is churn.

## The decisive test, for whoever has egress

One command from any ordinary (non-Cloudflare, non-Supabase) network:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json'
```

- **200** ⇒ the headers are fine and the block is **IP/ASN-based** on datacenter egress. A fingerprint
  refresh will NOT help; the fix is a different ingress (residential/proxy) or a paid feed.
- **403** ⇒ it is **header/fingerprint-based**, and refreshing `BROWSER_POOL` + adding 403-retry to the cdn
  fetch is worth doing.

Repeat with the ESPN scoreboard URL to classify that lane the same way. **Do this before writing any code** —
the two outcomes point at opposite fixes.

## Impact, restated honestly

- **Projections**: 27 d stale, but there are no NBA games in August (newest `game_date` 2026-07-20), so the
  impact is **deferred to preseason (~October)**, not absent. Do not close it on "no user impact".
- **`nba_players`**: 174 players / 19 of 30 teams, 101 d stale. This is the one with a **live** cost —
  **Fast Break** (`app/api/fast-break/{today,uses,optimize}`) reads it, so it is running on a partial roster
  now. `match-topshot-players` also grinds 1.67 M rows/day against this stub and has produced **zero**
  auto-aliases ever (`nba_player_aliases` = 7 rows, all `source='manual'`).
- **Monitoring**: `sync-nba-projections` is on **no `pipeline_cadence_watchlist` row**, so nothing pages.
  ⚠ Adding one would make the new `Pipeline Success Coverage` arm fire immediately and stably (3-hourly
  cadence, well inside its 24–48 h window) — correct, but it would page on a **known outage nobody can fix
  until the ingress question above is answered**, which is the "training the operator to skim" cost this
  repo has already paid with `ufc_fmv_stale_hours`. **Left as a judgement call, not shipped.**
