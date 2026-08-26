> # ⚠ PARTLY RESOLVED 2026-08-22 — and **the headline "23" in this file's own title is WRONG**.
>
> **RE-DERIVE, DO NOT QUOTE THIS FILE'S NUMBERS.** The scan behind them matched `Array.from(` with a loose
> `/\.from\s*\(/` and counted client modules with no DB in them. supabase-js takes a STRING first argument
> on both `.from()` and `.rpc()`; with that required, and imports followed to depth 3, the count is **19**,
> not 23 — and it is **17** after the two bounds below.
>
> **SHIPPED since:** `scripts/check-unbounded-server-reads.mjs`, a **RATCHET** wired into the `typecheck`
> CI job (ceiling 17, may only fall), plus bounds on `lib/moment/resolve-moment-id.ts` and
> `lib/edition/legacy-redirect.ts`. §4's "no ban, no blanket sweep" reasoning still stands and is why this
> is a ratchet.
>
> **STILL OPEN:** the remaining 17. Each needs a per-page judgement about what its degraded render should
> say — several have no honest-degraded branch to reject INTO, and bounding those turns a slow page into a
> thrown error boundary. Burn them down one at a time, lowering the ceiling in the same commit.

# The unbounded-server-read class bit a FOURTH time — and 23 more instances sit outside the guard written to stop it

**Filed 2026-08-22 12:29 PT (19:29Z), Claude Code interactive. The measured instance is FIXED and pushed;
the population below is MEASURED and deliberately NOT swept.**

---

## 1. What happened, with the log line

The 13:15Z scheduled DOM smoke failed with `page.goto: Timeout 30000ms exceeded` on **four collections'
`/overview`** at once. The Vercel runtime log for that window names the cause exactly:

```
13:22:38 GET /ufc/overview 200 [warn/serverless-middleware]
  [popular-on-collection] hubs read failed collection=ufc: Timed out acquiring connection from connection pool.
13:22:02 GET /ufc/overview 200 [warn/serverless-middleware]
  [popular-on-collection] links read failed collection=ufc: Timed out acquiring connection from connection pool.
```

⚠ **Vercel logged `200` for every one of those requests.** The streaming shell answers immediately, so a
read that hangs shows up as a document that never finishes — never as an error. This is the
"200-but-broken-DOM" class CLAUDE.md already warns about, in its latency form.

**The mechanism, end to end:** `app/(collections)/[collection]/overview/layout.tsx` — the overview
SEGMENT's own layout, not the shared `[collection]/layout.tsx` — awaits `<PopularOnCollection>`, an async
server component, **with no Suspense boundary**. Its two reads were unbounded. The segment is
`revalidate = 3600`, so with a cold ISR entry (every deploy empties it) the first request per collection
performs the read inline and the whole document waits on it.

⚠ **I got this wrong once on the way in, and the correction is the useful part.** I first concluded "the
overview page does no server work" — true of `overview/page.tsx`, of `[collection]/layout.tsx`, of
`(collections)/layout.tsx` and of the root layout, all of which I grepped. The read is in a **nested
segment layout**. A grep of "the page and its layouts" is not a grep of the segment's layouts.

## 2. Fixed (shipped)

`lib/entity/popular-on-collection-fetchers.ts` — both reads now go through `withBoardBudget`. The bound
REJECTS, which lands in the `catch` each fetcher already had and produces the same `{ok:false, reason}`
an errored read produces, so **no new failure policy** — it just makes the honest-degraded branch
reachable from a SLOW read, which errors nowhere on its own. `withBoardBudget` gained an optional
`prefix` (default `"insights/"`, so all 36 existing call sites are byte-identical) because an
`[insights/...]` label on a non-insights surface sends an operator to the wrong subsystem.

Tests: three cases pinning that a HANGING read degrades exactly like a failing one, plus a no-change
control that a fast read never trips the budget. Negative control run: removing the bound reddens both
hang cases and leaves the control green.

## 3. The finding this file is actually for

`withBoardBudget`'s own docstring says this class had been fixed three times, each time **on the one page
that failed rather than on the shape**, and that
`__tests__/insights-server-pages-bound-their-reads.test.ts` is "the shape-level fix". It is not — it walks
`app/insights`, so **everything outside `/insights` is outside it BY CONSTRUCTION**. That is this repo's
own recorded rule ("ask what a passing guard is structurally SILENT about") landing on the guard written
to satisfy it. `PopularOnCollection` was a live instance sitting in that blind spot.

**Measured population, 2026-08-22:** of **81** async server `page.tsx`/`layout.tsx` files under `app/**`,
**23 reach a DB read with no budget primitive anywhere — and 0 of them are under `app/insights`.**

```
app/(analytics)/analytics/sets/[set_id]/page.tsx        via lib/analytics-sets-dashboard-compute.ts
app/(analytics)/analytics/wallets/[address]/page.tsx    via components/analytics/WalletProfile.tsx
app/(analytics)/analytics/wallets/page.tsx              direct query
app/(collections)/[collection]/challenges/page.tsx      direct query
app/(collections)/[collection]/edition/[slug]/page.tsx  via lib/badges/server-art.ts
app/(collections)/[collection]/fast-break/page.tsx      via components/fast-break/FastBreakClient.tsx
app/(collections)/[collection]/hot-floors/page.tsx      direct query
app/(collections)/[collection]/pack/[id]/page.tsx       direct query
app/(collections)/[collection]/pack/dist/[distId]/page.tsx  via lib/pack-dist/fetchers.ts
app/(collections)/[collection]/pack-sniper/page.tsx     via lib/packs/live-pack-listings.ts
app/(collections)/[collection]/player/[slug]/page.tsx   via lib/player-page-view.ts
app/(collections)/[collection]/road-to-the-ring/page.tsx via components/rtr/RTRClient.tsx
app/(collections)/[collection]/series/[slug]/page.tsx   direct query
app/(collections)/[collection]/set/[slug]/page.tsx      via lib/set-detail/tier-mix.ts
app/(collections)/[collection]/team/[slug]/page.tsx     via components/entity/TeamChecklist.tsx
app/admin/flowty-errors/page.tsx                        direct query
app/edition/[id]/page.tsx                               via lib/edition/legacy-redirect.ts
app/moment/[id]/layout.tsx                              via lib/moment/resolve-moment-id.ts
app/moment/[id]/page.tsx                                via lib/badges/server-art.ts
app/my-teams/page.tsx                                   via lib/fan-teams/fetchers.ts
app/pinnacle/moment/[id]/page.tsx                       via lib/pinnacle/moment-detail.ts
app/profile/[username]/page.tsx                         via lib/profile/public-profile.ts
app/profile/[username]/trophy-case/page.tsx             via lib/profile/public-profile.ts
```

⚠ **23 is a FLOOR, and my instrument's limit is the reason.** It follows **one** level of delegation.
`app/(collections)/[collection]/overview/layout.tsx` — the file that actually broke today — does **not**
appear in that list, because its read is two levels down (layout → component → lib). Anything else with
that shape is also missing. `app/admin/**` is likely a legitimate exclusion (operator-gated, not
prerendered) but I did not verify that.

## 4. What I did NOT do, and why

**No ban-at-zero guard.** This repo's ban only works when the population is driven to zero in the same
pass, and 23+ surfaces is far past what one session should sweep — several are on the roadmap's
untouchable list (pack-EV, sniper, FMV route logic). A ban here would ship a 23-entry allowlist, which is
the "curated list drifts" failure already recorded twice.

**No blanket sweep.** Each of these needs a judgement about what the degraded render should say, and
several have no honest-degraded branch to reject INTO yet — bounding those without first giving them one
would convert a slow page into a thrown error boundary, which is worse.

**The decision this file asks for**, in rising cost:

1. **Bound the PUBLIC prerendered ones first** — the entity pages (`edition`, `player`, `set`, `team`,
   `series`, `moment`) are the crawled corpus and the ones a build export can die on. ~8 surfaces.
2. **Ratchet, not ban** — a count that may only fall. Fits the existing population without an allowlist.
3. **Widen the existing guard's derivation** to `app/**` and two levels of delegation, wired to that
   ratchet — so the next instance is caught by the guard that was already meant to catch it.

⚠ Option 3 is the one that stops the recurrence; 1 is the one that reduces today's risk. They are not
alternatives.

## 5. Re-derivation

* Runtime log: Vercel MCP `get_runtime_logs`, project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`,
  `environment: "production"`, `since/until` 13:10–13:25Z, `source: ["serverless"]`. ⚠ Without the
  `source` filter the warn lines do not surface — the default view showed 47 clean `200` lines for
  `/nba-top-shot/overview` and nothing else, which reads as a healthy page.
* Population scan: walk `app/**` for `page.tsx`/`layout.tsx`, drop `"use client"` and non-`async default`,
  strip comments, then look for `readBoardOrLive` / `fetchBoardForPage` / `withBoardBudget` /
  `withPagedBoardBudget` in the file or in one level of imported `@/lib/**` or `@/components/**`.
* ⚠ Numbers are a dated sample. Re-run before quoting.

---

## ✅ THE POPULATION IS BURNED DOWN — ratchet at **0** as of 2026-08-26 (Claude Code, interactive)

This filing's banner closed on *"**STILL OPEN:** the remaining 17. … Burn them down one at a time,
lowering the ceiling in the same commit."* **They were. The ceiling is now 0 and it is a ban at zero,
which is what this repo prefers over an allowlist.**

Live: `182 page/layout file(s); 81 async server; **0 unbounded**`.

### ⚠ The last step was a READ, not a tightening, and the distinction is the point

The guard reported one BELOW its ceiling, which has **two** readings and only one is good news:
**(a)** the last instance was genuinely bounded, or **(b)** the guard lost sight of it — in which case
tightening locks in a blind spot and makes the ratchet's own comment a lie.

The comment made (b) plausible: it recorded `lib/packs/pack-deals.ts` behind
`/[collection]/pack-sniper` as a deliberate **FLOOR**, *"a surface that is deliberately off-limits"*.
And two facts still matched (b): that page is **still** an `export default async function` server
page, and `pack-deals.ts` **still** carries no budget primitive of its own.

✅ **What settled it was the call site:** the page now does
`await withBoardBudget(getPackDeals(collection, …), "pack-sniper")` and carries a real degraded branch
(`ok = false`, provenance stamped AFTER the read). It is **(a)**. The floor note is retired in the same
commit that lowers the number, so the next reader is not told a surface is untouchable when it is done.

### ⚠ A gap in the guard, recorded because the check above depended on it

`analyze()` marks a page bounded when a budget primitive is **REACHABLE**, not when it is **APPLIED**
to the read in question. A page could import `withBoardBudget`, wrap a cheap read with it, and leave
the expensive one bare — and this guard would pass it. **That is the same presence-vs-application gap
recorded on the `.range()`/`.order()` guard** ([08-23 filing](2026-08-23T0236Z-the-paginated-range-guard-states-the-uniqueness-rule-in-a-comment-and-cannot-check-it.md)),
now confirmed as a second instance of the shape. It is **not** what happened here — hence the read
rather than a grep — and it is left unfixed rather than silently tolerated: closing it needs call-graph
analysis, not a stronger regex.

### Verified both directions on the live tree

| run | result |
|---|---|
| clean tree | `0 unbounded (ceiling 0)`, exit **0** |
| synthetic unbounded async server page added | `1 unbounded`, **RATCHET BROKEN**, names the file, exit **1** |
| probe removed | exit **0** |

**A ban at zero that cannot detect the thing it bans is the failure this repo keeps recording, so the
middle row is the one that matters.**
