# `/sitemap/3.xml` truncates on a statement timeout and returns the partial set as if it were complete — and it pages on a key where 72% of rows are ties

**Filed 2026-08-22 (PT) by Claude Code, interactive.** Found because a rendered-DOM probe I added
made four monitor arms visibly skip. The skip was the symptom; none of the below was the thing I
went looking for.

## The observation that started it

In the dispatched `e2e-smoke` run on `bb945049`, **four of eight entity arms SKIPPED**: `moment`,
`set`, `player`, `team` — every type that resolves from **sitemap segment 3**. In the SAME run,
segments 0, 1, 2 and 4 all resolved (`series`, `edition`, `edition_golazos`, `pack` passed). That
same-run contrast is the control: this is segment-specific, not a network blip. ⚠ **A skip is a
GREEN job** — `entity-smoke.spec.ts` fail-softs by design — so nothing about the run's success said
those four pages went unchecked.

## Root cause, measured in production rather than guessed

Vercel production runtime log, 2026-08-23T02:19:54Z:

```
GET /sitemap/3.xml 200 [info/serverless-middleware]
    [sitemap] editions page 24000 error: canceling statement due to statement timeout
```

⚠ **Read the error string, not the duration.** `canceling statement due to statement timeout` is
the POSTGRES statement timeout, not the ~2-minute Supabase gateway timeout that produces a
similar-looking delay. The deep `.range(24000, 24999)` offset scan is what exceeds it.

**And the response was `200`.** `fetchAllByCollection` (lib/sitemap-data.ts:169) logs the error and
**`break`s**, returning whatever it accumulated:

```js
if (error) {
  console.log(`[sitemap] ${table} page ${from} error: ` + error.message)
  break
}
```

So the caller receives **24,000 of 27,246 edition rows** with no way to tell that from "24,000 is
all there is", and segment 3 derives its set / player / team URL universe from the truncated set.
🚨 **This is the house defect class exactly** — a failed read rendered as a fact, here as a sitemap
asserting "these are our entity pages".

## The second defect, which the first one hides

The same paged read orders by **`editions.updated_at`**, which is **not unique**:

| measure | value |
|---|---|
| edition rows | 27,246 |
| distinct `updated_at` | 7,971 |
| rows sitting in a tie group | **19,632 (72%)** |
| largest single tie group | **1,084** |
| page size | **1,000** |

⚠ **The largest tie group is BIGGER THAN THE PAGE.** Postgres gives no stable order within ties
across separate statements, so `.range()` here can return the right *number* of rows and the wrong
*rows* — duplicates and omissions that cancel, which is precisely why every count-based check
passes. CLAUDE.md already carries this as a ban at zero: *"Any `.range()` pagination MUST carry a
deterministic `.order()` on a UNIQUE key."*

⚠ **A guard for this exists and is GREEN, because it can only see the spelling.**
`__tests__/paginated-range-requires-order-ratchet.test.ts` walks `lib/**` and asserts that a
`.order(` precedes each `.range(`. `lib/sitemap-data.ts` has one — on a column where 72% of rows
tie. **Presence of `.order()` is not uniqueness of the key**, and the guard's own stated purpose is
the property it cannot check.

## Recommended fix — two halves, only one of them mechanical

1. **Deterministic paging (safe, mechanical).** Add `id` as a TIEBREAKER, not a replacement:
   `.order('updated_at', {ascending:false}).order('id')`. ⚠ **Do not simply order by `id`** —
   segment 3 takes `editions.slice(0, 200)` as a "top 200 by recency" popularity proxy, so
   `updated_at` must stay the PRIMARY sort or that list silently becomes 200 arbitrary moments.
   Check the sibling `pack_distributions` call (line ~310, orders by `dist_id`) for the same
   property before assuming it is fine.
2. **The timeout (needs a decision).** Deep-offset paging costs more per page as the offset grows,
   so this gets worse as the catalogue grows and it will not be fixed by a tiebreaker. Keyset
   pagination (`WHERE (updated_at, id) < (last_updated_at, last_id)`) is the real answer. That is a
   rewrite of a shared helper on an SEO-critical path, which is why it is filed rather than shipped.

⚠ **Not shipped here, deliberately.** Half a fix would make the sitemap deterministic while still
truncating — and would move the truncation boundary, which is the kind of change that looks like a
fix in a diff and cannot be told from a regression in production.

## What is NOT measured

- **Whether the four arms skip because of the monitor's own 20 s fetch timeout** (`fetchSitemapLocs`
  passes `timeout: 20_000`) rather than an empty body. The response was **200**, so "serving
  nothing" is NOT established — a slow-but-valid response would produce the same skip.
- **How many entity URLs are actually missing** from the served sitemap. The truncation is
  measured; its exact SEO cost is not. The top-200 moment slice is taken from the HEAD of the
  ordering and is unaffected by a tail truncation.

---

## ⚠ SECOND OBSERVATION, 8 MINUTES LATER — THE SYMPTOM IS INTERMITTENT, AND HALF THIS FILING'S FRAMING IS RETRACTED

A re-dispatch on `6fce088b` (run 32612867443, 02:27:30Z) came back **100 passed, 0 flaky, ZERO
skipped**. All four segment-3 arms — `moment`, `set`, `player`, `team` — resolved and their pages
rendered.

**So `/sitemap/3.xml` is NOT persistently broken.** The heading above says "truncates", and on the
02:19Z sample it did; eight minutes later the same URL served enough for every arm to find a live
URL. ⚠ **A single observation of a failure is not a standing state, and I filed it eight minutes
before the evidence that says otherwise.**

**What SURVIVES the second observation** — all of it structural, none of it dependent on that one
sample:

- `fetchAllByCollection` **breaks on error and returns a partial list**, and no caller can tell a
  truncated read from a complete one. That is true on every run; the 02:19Z log is proof it fires.
- The paging key is **72% ties with a largest group of 1,084 against a page of 1,000**. True on
  every run.
- The guard asserts **`.order()` presence, not key uniqueness**. True on every run.

**What is RETRACTED:** "four arms are skipping" as a standing condition, and any reading of this as
a permanently broken sitemap segment. The honest statement is that a **deep-offset page
intermittently exceeds the Postgres statement timeout, and when it does the failure is swallowed
into a 200** — which is worse than a hard failure precisely because it is intermittent and silent.

⚠ **This changes the priority, not the diagnosis.** An intermittent silent truncation on an
SEO-critical path is still worth fixing, and is now known to be load-dependent — which points at
the same disk-IO saturation the rest of the register tracks, and means it will be WORST exactly
when the catalogue is largest.

---

## ✅ RESOLVED AND ARCHIVED — 2026-08-24 (Claude Code, Trevor's Windows box)

**Both defects this filing named are fixed, and the fix is verified in production against the database.**

- **Defect 1 (partial-under-200):** `fetchAllByCollection` no longer `break`s on a page error. It throws `SitemapReadIncomplete`, and `app/sitemap/[id]/route.ts` turns that into a **503** so a crawler retries and keeps the sitemap it already has. **A 503 from that route is now the fix working.** Fixed 2026-08-23 by `9b862dc8`.
- **Defect 2 (`updated_at` is 68.4% ties, largest group 1,084 > the 1,000-row page):** `fetchAllByCollection` now REQUIRES a `tiebreakColumn`, validated **by value** at runtime by `assertUsableTiebreak` — because the static ratchet this filing correctly called out can only see that a second `.order()` exists, not what was passed to it. Mutation proved that gap.
- **`maxRows` exhaustion**, a third silent truncation the filing did not name, also throws now: *"we stopped counting"* is not *"that is all of them"*.

**Closed on a SET comparison, not a status read** (2026-08-24 04:50 PT): every segment fetched live from `www.rippackscity.com` and its `<loc>` count compared against `count(*)` over `editions` **using the route's own predicates**. **Segment 2 = 7,283 vs 7,283** (All Day 6,190 + Golazos 575 + UFC 518). **Segment 1 = 13,241 vs 13,241** Top Shot rows surviving `dropTsFossils`. Segments 0 / 3 / 4 all 200 (117 / 4,607 / 8,078). ⓘ **An exact match on BOTH sides is the control the truncating loop could not have passed** — and the ties defect drops and duplicates in ways only a set comparison sees, so a count alone would have been the wrong instrument had it not matched to the row.

⚠ **What that measurement does NOT prove: it exercised the COMPLETE path, not the throw path.** That branch is covered by `__tests__/sitemap-data.test.ts` and `__tests__/api-sitemap-routes.test.ts`, not by the probe.

**Register:** known-issues **#28**, now ✅ RESOLVED. ⚠ This entry sat at 🔴 OPEN for a full day after the code fix shipped, with CLAUDE.md's honesty bullet pointing at it as open — **the register lagging the tree is the same stale-instrument class the register exists to catch.**
