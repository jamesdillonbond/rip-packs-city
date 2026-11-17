# The sports-proxy 403 is TWO different causes needing TWO different fixes — the "three providers tightening bot-blocking" framing is refuted

**Filed 2026-08-17 17:57 PT / 2026-08-18 00:57Z, from Trevor's residential box** — the one network from which the decisive test could be run, and which every prior session lacked.

## What the repo said

`known-issues.md` #8 (and CLAUDE.md's open-items list) currently reads:

> three providers across two independent egress networks, all 403 … That pattern points at the providers tightening bot-blocking, **not** at one stale fingerprint or one blocked IP range of ours.

and ⛔ **"Ship no UA refresh or 403-retry before the decisive test: one `curl` of the `cdn.nba.com` URL from an ordinary non-datacenter network."**

That test has now been run. **The single-cause reading is wrong** — the lanes split cleanly, and they need opposite fixes.

## Measured (residential, non-datacenter, 2026-08-18 00:57Z)

| lane | from Trevor's residential box | from our egress | reading |
|---|---|---|---|
| `site.api.espn.com/.../nba/scoreboard` | **HTTP 200**, 9,448 bytes, 1.05 s | **403** (direct from Supabase edge) | ⚠ **EGRESS-NETWORK BLOCKING — the bot-blocking story holds for THIS lane only** |
| `cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json` | **HTTP 403** | 403 (via CF Worker) | ⚠ **NOT our egress at all — it refuses residential too** |

## The `cdn.nba.com` lane is not what anyone thought

- It returns an **Akamai `errors.edgesuite.net` "Access Denied"** page (445 bytes) — the same Akamai signature the file attributes to the DraftKings lane.
- ⚠ **It 403s on EVERY path tested, including the bare host root `https://cdn.nba.com/`.**
- ⚠ **Headers are not the lever.** Tested three ways from residential — the worker's current minimal 2-header request, `+` a current Chrome `User-Agent`, and `+` a full browser set (`Accept`, `Accept-Language`, `Referer: https://www.nba.com/`, `Origin`). **All three: 403.**

**So this lane is blocked on something a plain HTTP client cannot produce (TLS/JA3 fingerprint is the leading candidate), or the host is broadly locked down / the path retired.** Distinguishing those needs a real browser fetch; a Playwright run was attempted here and its first-launch cost exceeded the tool budget, so it is **NOT yet settled** — do not assume JA3 without running it.

⚠ **This directly falsifies the design assumption the code rests on.** `workers/sports-proxy/index.ts:564` calls `cdn.nba.com` an *"S3-served static scoreboard JSON — open to CF Workers, no WAF"*, and **because** of that belief it is the only fetch in the file with **no retry, no fingerprint rotation and a deliberately minimal request**. It is behind Akamai with a WAF and always was, or has become so.

## What this changes

1. ⛔ **Do NOT apply one fix to both lanes.** They are unrelated.
2. **ESPN is the cheap win and it is NOT a credential problem.** It works from an ordinary network and fails from Supabase edge egress — so **routing the ESPN call through a Cloudflare Worker** (as the other lanes already are) is the shaped fix. No secret, no rotation. ⚠ Worth checking first whether the CF Worker egress is *also* blocked by ESPN, since that determines whether this actually buys anything.
3. **`cdn.nba.com` needs a decision, not a patch.** A UA refresh or a 403-retry — the two things the ⛔ warning pre-emptively forbade — are now **measured to be useless** on this lane. Options are a real-browser/fingerprinting fetch, a different NBA data source, or dropping the lane.
4. **The `403`s are still ONE root cause for the SYMPTOMS** (projections ~27 d stale, `nba_players` 101 d stale at 174 players / 19 of 30 teams, `match-topshot-players` zero auto-aliases ever, Fast Break on a 19-team roster) — but **two root causes for the FIX**. Restoring ESPN alone may be enough to feed `nba_players`; that should be checked before touching the NBA lane at all.

## Confirmed NOT the cause (so nobody re-derives it)

The prior refutation stands and is reinforced: **no secret is involved.** The proxy returns 502-with-upstream-403 (not its own 401), the edge function's `has_url`/`has_secret` guard never fires, and the ESPN lane uses neither proxy nor secret. Nothing here is operator-gated — this is ordinary engineering work.
