# Vercel's runtime-error ROUTE attribution is smeared — the homepage is not failing on a Panini board

**Filed:** 2026-08-21 ~10:15 PT (17:15Z) · **Class:** INSTRUMENT DEFECT (no code change)
**Why it matters:** the nightly-pass runbook names Vercel runtime logs as *the* instrument for public-page
health ("group 5xx by route, then read `level=error` lines"). That instrument currently reports `/` and
`/pricing` as failing on boards those routes cannot reach.

## What `get_runtime_errors` says (24h window, measured 17:05Z)

> `[panini-squeeze] backing view error: canceling statement due to statement timeout`
> **count=395 users=340** routes=`/[collection]/edition/[slug].rsc, /pricing.rsc, /[collection]/overview,
> /profile/[username], /moment/[id], /, /index.rsc, /[collection]/team/[slug]…` (26 routes)

Eight `[candy-mlb] candy_*_board` groups carry the same shape (55–250 each, ~1,700 total), each listing
`/`, `/moment/[id]`, `/profile/[username]` and the collection tabs.

Read at face value: the marketing homepage and the pricing page are erroring on the Panini WC Prizm
squeeze board and on eight Candy MLB boards, affecting 340 users.

## Why that is false

`[panini-squeeze] backing view error` is emitted from **exactly one line** —
`lib/insights/panini-board.ts:43` — inside `fetchPaniniSqueezeDefault`. That function has **exactly two
importers**:

- `app/api/cron/refresh-insights-cache/route.ts`
- `app/insights/panini-squeeze/page.tsx`

`/`, `/pricing`, `/moment/[id]`, `/profile/[username]` and `/[collection]/team/[slug]` are none of them,
and cannot reach it by any import path.

## The measurement that settles it

`get_runtime_logs` for the same string, grouped by `requestPath`, 6h window:

| requestPath | count |
|---|---|
| **/api/cron/refresh-insights-cache** | **64** |
| /nba-top-shot/collection | 9 |
| /nba-top-shot/packs | 5 |
| **/** | **4** |
| … 48 more paths | 1–3 each |

`candy_scarcity_board error` reproduces it exactly: **64** on the cron, then a 1–2 tail across seven
unrelated paths including `/`.

So the true emitter is one route — the 15-minute insights-cache cron — and roughly a third of the lines
are attributed to whatever unrelated request happened to be in flight nearby.

## ⚠ The obvious mechanism is REFUTED — do not repeat it

My first explanation was `after()`: background work outliving the response and inheriting the next
request's attribution. **`app/api/cron/refresh-insights-cache/route.ts` does not use `after()`** — it is
synchronous with `maxDuration = 60`. Checked before writing it down. Lambda instance reuse remains a
plausible explanation and is **not tested**; it is recorded as a hypothesis, not a finding.

## What to do with the instrument

- **The `routes=` list on a `get_runtime_errors` group is not the set of routes that produced the error.**
  Treat it as a hint, then confirm by `get_runtime_logs` + `group_by: requestPath`, and confirm again by
  grepping for the literal log string to find its real emitter. Two importers beat 26 attributed routes.
- **`users=NNN` inherits the same defect.** "users=340" on the panini group is not 340 people meeting a
  broken page.
- **The inverse risk is the dangerous one:** a genuine per-route failure on `/` is diluted into the same
  long tail, so this smearing makes real user-facing breakage *harder* to see, not just noisier.

## Not claimed

The underlying timeouts are real — `panini_squeeze_board` and the candy boards genuinely time out for the
cron. Nothing here says the boards are healthy. It says the ROUTE ATTRIBUTION is wrong, and that the
health runbook's headline instrument needs the confirmation step above before anyone acts on it.
