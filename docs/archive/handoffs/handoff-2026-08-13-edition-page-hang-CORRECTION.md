# Correction to `docs/handoff-2026-08-13-edition-page-hang-qa.md` — the mechanism is right, the severity and the prescription are not

Cowork **cloud** session, 2026-08-13 ~10:30 PT (17:30Z). Read-only for this item; **no code changed.**

> ⚠ **NO-PUSH is specific to THIS cloud session** (git-proxy repo-set 403). Trevor's machine and
> Claude Code push normally via the PAT in `remote.origin.pushurl` — **commit this file as usual.**

The QA handoff filed the five `fetchEntityDetailRaw` SEO routes as **HIGH — the bulk of the
indexable SEO surface is unusable**, on the strength of a 15-minute browser window in which
3 editions / 1 player / 2 collections / 2 tabs all sat on `SCANNING THE MARKETPLACE…`. That
observation was real. Three of the conclusions drawn from it do not survive re-measurement.

## 1. ❌ "Persistent until a green re-check" — refuted. The pages render.

Fetched at **17:12Z today**, without JavaScript (so anything returned came from the server render,
not from client hydration):

- `/nba-top-shot/edition/124:4493` → full body. FMV `~$0.27`, ask `$0.59`, 11 sales/30d, tier
  COMMON, circulation 8,000, the sales table with serials + buyers + sellers, 8 observed pack
  pulls, and the notable-serial rows (#1, #5, #8000).
- `/nba-top-shot/player/cooper-flagg` → full body. 26 editions, total mint 3,434, FMV total
  $26,040, per-edition floors, top sales, collector holdings.

Both are in the hung set the handoff lists. **The content is in the server response**, which is the
one thing the QA session could not establish from a browser and the one thing that decides between
"the function never finished" and "the client never swapped the fallback".

⚠ Note the direction of the JS-free probe here. The catalogued trap
(`rpc-suspense-page-browser-qa` §3) is that a JS-free fetch returns a *shell* on a client-rendered
board and reads as broken. This is the **inverse**: a JS-free fetch returned *data*, and only the
server could have put it there. It is evidence in the safe direction.

## 2. ✅ The pool-acquire mechanism is real — and Vercel logs name it, which QA could not get

The handoff's runtime-log step timed out during QA. It completes now. `/[collection]/edition/[slug]`
over 24 h:

| error | count | users | last seen |
|---|---:|---:|---|
| `[edition] market_bundle canceling statement due to statement timeout` | 35 | 34 | 16:54Z **today** |
| `[edition] pack provenance Timed out acquiring connection from connection pool` | 19 | 19 | 15:47Z today |
| `[edition] market_bundle Timed out acquiring connection from connection pool` | 17 | 16 | 15:47Z today |
| `[entity-section] edition recent sales … degrading to empty` | 13 | 11 | 15:46Z today |
| `[entity-section] edition special serials … degrading to empty` | 5 | 5 | 15:46Z today |
| `[edition] insight_links Timed out acquiring connection from connection pool` | 12 | 12 | 15:45Z today |
| **`Error: edition detail unavailable: Timed out acquiring connection from connection pool`** | 10 | 2 | **2026-08-12** 21:33Z |
| `[edition] get_edition_detail error Timed out acquiring connection` | 4 | 2 | **2026-08-12** 21:33Z |

Read the last two rows carefully. They are the **structural** failures — the ones that throw and
take the whole page down. Their last occurrence is **yesterday**, and they affected **2 users**.
Everything logged today is a *decorative* section degrading to empty, which by design renders a
complete page with a thinner middle. That is the difference between "unusable" and "degraded".

## 3. ❌ "This is specific to the entity-detail family" — it is instance-wide

The same signature is on ~40 routes in the same 24 h: `/[collection]/pack/dist/[distId]`,
`/api/market`, `/api/sniper-feed`, `/api/cron/refresh-insights-cache` (5 candy-mlb boards timing out
every tick), all six `wallet-backfill-*`, `/api/fmv-recalc`, `/profile/[username]`. Measured the
same afternoon: the instance did **~870 GB/day of disk reads** over a 39.7 h window.

The entity pages are not a broken feature. They are **the most connection-hungry public page**
(5-wide top-level `Promise.all` plus the detail fetch) sitting on **an I/O-saturated instance**, so
they are the first surface to visibly break and the last to recover. Filing them as a page-level
regression points the next session at the page instead of at the instance. The disk-read ranking and
the one plan defect it found are in
`docs/overnight/inbox/2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md`.

## 4. ❌ Recommended fix #2 targets code that is already bounded

> *"cap total retry time in `rpcWithRetry` / `entity-section-rpc` so a stuck acquire fails fast
> instead of looping past `maxDuration`"*

`lib/analytics/rpc-with-retry.ts` as it stands on `main`:

- **3 attempts max**, backoff `50 ms → 200 ms`. Total *added* delay ≤ **250 ms**. It cannot loop.
- **57014 is already on `NEVER_RETRY_CODES`** — added 2026-07-26 precisely because the message
  heuristic was matching statement timeouts and tripling load on this exact route (the in-file
  comment cites `/[collection]/edition/[slug]`, 51.4% of collection page views, 272 timeouts/24h).
- Only `08xxx`, `53300`, `57P01` and the pool-acquire message shapes retry.

So there is no retry budget to cap. **The unbounded wait is inside each attempt** — the
Supavisor/PostgREST pool-acquire, whose ceiling `rpcWithRetry` does not set and cannot see. Three
attempts each waiting ~10 s on a saturated pooler is ~30 s of *acquire*, not of *backoff*. If
anything is to be bounded, it is the per-attempt acquire (an `AbortSignal`/`fetch` timeout on the
PostgREST call), and the honest description of that change is "fail the section faster", not
"stop the retry loop".

## 5. ⚠ Recommended fix #3 is still directionally right — with an arithmetic constraint

Moving `fetchMarketBundle` / `fetchHistory` / `fetchSales` below the `<Suspense>` boundary so the
hero paints from `get_edition_detail` alone is sound and matches the file's own comment. Two
constraints from the record before anyone ships it:

- `rpc-entity-page-connection-pool-fanout`: the proven fix set was **fewer pooled connections per
  request**, achieved by *dropping* a dead read and *bundling* three into one RPC. Moving reads
  across a Suspense boundary does not reduce the count — check that arithmetic explicitly.
- `react-suspense-fallback-not-hydrated`: a streamed group that can fail must not carry a skeleton
  fallback. **A fallback cannot time itself out** — React never hydrates a pending boundary's
  fallback, so any watchdog inside it is dead code. Use `fallback={null}` for anything that can fail
  to arrive, or render it in the shell.

## What I did not test

- Whether **set / team / series** render (only edition + player were re-fetched). They share
  `fetchEntityDetailRaw` and the same `loading.tsx`, so the inference is strong but it is an
  inference.
- Whether the pages render **in a real browser** right now. The JS-free fetch proves the server
  emitted the content; it does not prove the client swapped it in. If a browser still shows the
  fallback while the server response contains the body, that is a *different and more interesting*
  bug — the `$RC` / RSC-stream-consumption class from the 07-25 pack-page incident — and it should
  be filed under that heading, not this one.
- The 390 px mobile pass QA recorded as owed is still owed.

## Suggested disposition

Re-file as **MEDIUM, instance-capacity, not a route regression**: "entity-detail pages degrade
section-by-section, and occasionally fail structurally, during the midday disk-IO saturation
window." Keep the verification checklist — it is good — but change its pass condition from "renders"
to "renders *during* the 13:00–17:00Z saturation window", because outside that window it already
passes and a green re-check there proves nothing.
