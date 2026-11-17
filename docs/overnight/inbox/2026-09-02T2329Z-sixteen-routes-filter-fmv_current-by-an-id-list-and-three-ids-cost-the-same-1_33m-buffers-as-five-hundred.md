# Sixteen routes filter `fmv_current` by an id list — and THREE ids cost the same 1.33M buffers as five hundred

Measured 2026-09-02 23:29Z. Every number here is a dated sample; re-measure before quoting.

**NOT SHIPPED.** One instance (the concierge's) is fixed and deployed. The other sixteen are filed,
not touched — see "Why this is filed rather than fixed" at the bottom.

---

## ⛔ CORRECTION, 2026-09-03 ~00:1x UTC — DO NOT ACT ON THE TABLE BELOW. IT IS REFUTED, TITLE INCLUDED.

Left in full because the refutation is the useful part, and because the site list and the drop-in RPC
are still right. **Re-measured, same view, same session, both the literal-`IN` form and the bound
`= ANY($1)` form PostgREST actually emits:**

| ids | buffers (literal IN) | buffers (`= ANY($1)`) |
|---|---|---|
| 1 | 6 | 10 |
| 3 | **23** | **23** |
| 10 | 311 | 311 |
| 100 | 5,312 | 5,312 |
| 500 | 25,330 | 25,330 |

⭐ **The cost is PROPORTIONAL, ~50–70 buffers per edition. It is not fixed, and a three-id call costs
23 buffers, not 1,331,405.** The single-key number (8) is the only figure in the original table that
reproduces — and it sits on the same straight line as the rest, which is the tell: a genuinely fixed
cost would not pass through 8 at n=1.

**⛔ THE DISCRIMINATOR IS WRONG IN THE DIRECTION THAT DOES HARM.** *"`.eq("edition_id", x)` is fine,
`.in("edition_id", [...])` is not"* clears the two sites that were genuinely pathological and
redirects a morning's work at thirteen that are cheap. Both "safe, need nothing" sites were measured
warm within the hour and are **now fixed** (see the ledger entry for 2026-09-02):

| site the filing cleared | actual, warm | now |
|---|---|---|
| `/api/overview-stats` `.eq(collection_id).eq(confidence)` | **1,331,923 buffers / 14,085 ms** | `edition_fmv_current` — 909 / 39 ms |
| `/api/support-chat` `.eq("editions.external_id", k)` via `editions!inner` | **933,871 buffers / 1,390 ms** | `.eq("edition_id", edition.id)` — 6 / 0.06 ms |

Neither is a single-key predicate on the view. `.eq` on **some other column** — or on an EMBEDDED
table's column — is the pathological shape; `.eq` vs `.in` was never the axis. **The axis is whether
the qual is on `edition_id` at all.** That property is now a ban at zero:
`__tests__/fmv-current-reads-are-keyed-on-edition-id.test.ts`.

**Where 1.33M actually comes from.** Every entry in `pg_stat_statements` near that figure is a
collection-wide qual, a JOIN, or `IN (SELECT … FROM a CTE ordered by external_id)` — the last of which
the planner serves as a **hash** semi-join over the fully materialised view. Reorder that CTE by `id`
and the identical query is a **merge** semi-join at 152,869 buffers. There is no bound-array or
literal-list entry anywhere near 1.33M. ⚠ **A benchmark arm 38× worse than the same query issued the
production way is measuring the harness.**

**What survives:** the site list; `get_editions_latest_fmv` as the drop-in; "widen the RPC
deliberately, every column is carried per id"; and "enumerate consumers by the OBJECT, not by the
language the first instances were written in" — which is exactly the rule that would have caught the
two sites this filing cleared.

**⛔ WHAT DOES NOT SURVIVE IS THE PREMISE THAT THE SIXTEEN ARE WORTH A PASS.** Ranked by what they
actually cost in production — `pg_stat_statements` since its 2026-08-12 reset, every PostgREST read of
`fmv_current`:

| shape | calls | total blocks | per call |
|---|---|---|---|
| **collection-scoped** (the sniper All Day read, fixed) | **43** | **31,052,866** | 722,160 |
| id list, 5 cols (`wallet-search` / `cache-refresh`) | 3,786 | 7,731,152 | 2,042 |
| id list, 2 cols | 614 | 445,851 | 726 |
| id list, 3 cols | 13 | 424,578 | 32,660 |
| id list, other | 30 | 89,925 | ~3,000 |

⭐ **One shape, in ONE file, out-read every id-list call in the product combined by 3.6× — from 1% of
the calls.** 31.05M blocks against 8.69M over 4,443. **A file count is not a cost model, and "sixteen
routes" was a file count.**

⚠ And 2,042 blocks/call is **~29 editions**, not thousands. The tail is real — over 1,165 wallets,
distinct editions run p50 50 · p90 3,196 · p99 7,674 · max 11,349, with 223 over 1,000 — so a p90
wallet-search does cost ~224k buffers on the view. But that is a tail, not the common call. **Revised
exit condition: convert an id-list site when a wider helper exists for another reason, or when its
large-list tail becomes the common case — NOT "until the `.in()` count reaches zero".**
`recent-sales` is capped at 50 ids and should be left alone.

⚠ Caveat on both readings: `pg_stat_statements` is at 4,905 of 5,000 entries and therefore evicting,
so every total above is a LOWER BOUND. It is the right instrument for reading what a client sends; it
is not one for concluding a query never ran.

⚠ The LATERAL is still the better shape everywhere (~4 buffers/edition against ~70) — a **17×** win,
not the 249× the concierge entry recorded. That correction is in `docs/reference/database.md`.

### ⛔ A THIRD re-measurement, same evening, a DIFFERENT session — same verdict, arrived at by a different wrong turn

The session that wrote the original filing re-measured independently and reached the same two
retractions without seeing the block above. It is recorded here because **the two sessions' "before"
arms were broken in different ways and produced different wrong numbers, which is the whole lesson.**

| ids | this session, cold | the other session, warm |
|---|---|---|
| 1 | 16 | 10 |
| 60 | 1,931 (1,764 rows read for 60) | — |
| 500 | **42,342 / 9,998 ms** (40,034 rows read for 500) | **25,330 / 1,070 ms** |
| `get_editions_latest_fmv(500)` | 5,359 / 470 ms | 2,002 / 4.0 ms |

⚠ **Both are right; neither is "the" number.** Cold vs warm and two different 500-id sets (Base Set
editions carry more history than average) is the whole gap. What both agree on: **proportional, tens
of buffers per edition, and the LATERAL wins by roughly an order of magnitude** — 8× here, 17× there.
⭐ **Quote a range and say what was cold.**

**The broken arm, this session's version:** `IN (SELECT … LIMIT n)` — a **subquery**, which really
does force the whole `DISTINCT ON`. The other session's was `IN (SELECT … FROM a CTE ORDER BY
external_id)`, a hash semi-join over the same materialisation. **Same family, different spelling, and
neither is a shape PostgREST sends.** ⭐ **`IN (SELECT …)`, `= ANY(<array literal>)` and `= ANY($1)`
are three different queries with three different plans, and the one that is easiest to type in a SQL
console is the one the app never issues.** Read the PostgREST wrapper out of `pg_stat_statements` and
reproduce THAT.

**Mechanism, stated once:** it is **row amplification, not a missing pushdown.** The view has no
per-group `LIMIT`, so it reads every snapshot for each edition (~35 on average, ~80 for Base Set) and
`Unique` discards all but the newest. ⚠ **That means this gets worse on its own as `fmv_snapshots`
grows** — the per-edition cost is a function of retained history.

### ✅ Both gaps the ranking left open are now CLOSED

1. **Why does the `= ANY` row average only 2,042 blks/call?** Because most calls pass a
   **single-element array**, which costs ~16 buffers. Measured directly. The average is a mix of many
   cheap calls and a few large ones — **so do not quote 2,042 as "the bad shape's cost", and do not
   quote its 6.8 s/call as a small call's cost either.**
2. **Who issues the 722k-blocks/call query?** **`app/api/sniper-feed/route.ts:1165`** — the All Day
   FMV map, `.gt("fmv_usd", 0)` scoped by collection and paged. Identified from the repo after the
   filing said it could not be. ✅ **Already fixed in `c280d337b`** (424,475 → ~26,000 buffers), which
   landed before this identification did. ⭐ **The most expensive consumer in the database was in the
   file the filing had already listed — under a second, differently-shaped read on another line.**

---

## The measurement

`fmv_current` is `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id,
computed_at DESC`. Three shapes, same view, same session:

| shape | buffers | time | rows scanned to build the view |
|---|---|---|---|
| `where edition_id = <one id>` | **8** | 4 ms | pushed down — per-partition index scan |
| `where edition_id in (<3 ids>)` | **1,331,405** | 2,131 ms | 1,386,061 → 27,186 distinct |
| `where edition_id in (<500 ids>)` | **1,334,789** | 16,736 ms | 1,385,975 → 27,186 distinct |

⭐ **The cost is FIXED, not proportional.** Three ids and five hundred ids both pay the full
materialisation — **~1.33 M buffers, roughly 10.4 GB** — because the whole `DISTINCT ON` is built
before the semi-join. The list length only changes the join and output work on top.

⛔ **So "we only ask for a few editions" is not a defence.** A three-id call is **166,000× the
buffers of the one-id call** that returns the same kind of row.

## The discriminator — ⛔ CORRECTED TWICE, and the first version was wrong in the direction that does harm

**Superseded by the CORRECTION block at the top of this file. The rule that stands is: the qual must
be on `edition_id` at all.** ⚠ The version originally published here — *"`.eq("edition_id", x)` is
FINE, `.in("edition_id", [...])` is not"* — **is about the OPERATOR, and the axis is the KEY.** It
cleared `app/api/overview-stats/route.ts:105` and `app/api/support-chat/route.ts:2237` as safe; those
were the two genuinely pathological sites in the whole list, at **1,331,923** and **933,871** buffers
warm, and both are now fixed (`c280d337b`).

`collection_id` is not the `DISTINCT ON` key, so a qual on it cannot push down at all. Measured this
session: `collection_id = <uuid> AND fmv_usd > 0 ORDER BY edition_id LIMIT 1000` → **87,389 buffers /
13,523 ms**; `count(*) WHERE collection_id AND confidence = 'HIGH'` → ⛔ **did not finish inside the
60 s statement timeout.**

⚠ That site's own `Promise.allSettled` carries a comment isolating the count *"so a slow/failed
FMV-HIGH count over a huge collection's fmv_snapshots never zeroes the edition count too"* — **somebody
already noticed it was slow and defended against it FAILING rather than asking what it cost.** That is
the same shape as the read this whole finding started from.

⭐ **The property is now a ban at zero rather than a rule to remember:**
`__tests__/fmv-current-reads-are-keyed-on-edition-id.test.ts` requires an `edition_id` qual on every
`.from("fmv_current")` site in `app/` and `lib/`, and asserts the count it inspected.

## The sites

`grep -rn 'from("fmv_current")' app lib workers --include=*.ts`, triaged by the filter in the
following 8 lines. **Sixteen carry the `.in("edition_id", …)` shape:**

| route | line |
|---|---|
| `app/api/sniper-feed/route.ts` | 742, 1162 |
| `app/api/wallet-search/route.ts` | 583, 669 |
| `app/api/fmv/route.ts` | 88, 273 |
| `app/api/alerts/route.ts` | 80 |
| `app/api/allday-pack-ev/route.ts` | 322 |
| `app/api/allday-wallet-search/route.ts` | 271 |
| `app/api/cache-refresh/route.ts` | 515 |
| `app/api/golazos-sniper-feed/route.ts` | 80 |
| `app/api/pack-ev/route.ts` | 371 |
| `app/api/recent-sales/route.ts` | 95 |
| `app/api/rtr/lock-roi/route.ts` | 177 |
| `app/api/wallet/seed/route.ts` | 177 |
| `lib/market-sources.ts` | 214 |

⛔ **And the list above is SHORT BY TWO** — `app/api/profile/watchlist/route.ts:74` and
`app/api/watchlist/route.ts:67` reach the view through `selectInChunks(supabase, "fmv_current", …,
"edition_id", ids)`, which a `from("fmv_current")` grep cannot see. **Eighteen, not sixteen.**
⚠ **That is this filing's own enumeration lesson recursing inside it: grep the bare quoted table
name, not the `from("<table>")` call.**

⛔ **It also misses `app/api/sniper-feed/route.ts:1165`** — a second, collection-scoped read in a file
the table already lists for line 742. **The most expensive `fmv_current` consumer in the database was
inside a file this filing had enumerated.** Fixed in `c280d337b`.

⛔ **Neither "safe" site was safe.** `app/api/overview-stats/route.ts:105` (`collection_id` +
`confidence`, 1,331,923 buffers) and `app/api/support-chat/route.ts:2237` (`.eq` on an EMBEDDED
table's `external_id`, 933,871 buffers) were both cleared by the operator-based discriminator above
and are both fixed in `c280d337b`. ⚠ **The second is why a grep could not settle it: the offending
column is not in the read's own table.** `lib/concierge/fmv-distribution.ts` no longer reads the view
at all — it was the seventeenth, and it is fixed (`f7aae9c5`).

⚠ These are **not** all equally hot, and this filing does not claim they are. `sniper-feed`,
`wallet-search` and `alerts` are user-facing on-demand routes; `cache-refresh` and the pack-EV pair
are periodic. **Rank them by callers before touching any of them** — see below.

## The fix already exists

`get_editions_latest_fmv(uuid[])` (migrations `20260902225408` + `225443`) is a drop-in for the
edition-keyed case: same selection rule as the view, expressed as a per-id LATERAL LIMIT 1, verified
against the view on 500 ids at **500 = 500 rows, zero differing in either direction**. It returns
`edition_id, fmv_usd, confidence, computed_at`. Sites needing other columns
(`floor_price_usd`, `sales_count_30d`, …) need the RPC widened or a sibling — **widen deliberately,
because every added column is another thing the LATERAL carries per id**.

## Why this matters beyond speed

The concierge instance proved it is not merely a cost item. ~10 s (not the 16.7 s originally
published — see the correction at the top) inside a 60 s lambda that also runs an LLM tool loop meant
the FMV tool did not answer at all: a live probe asking *"what is a Base Set common worth?"* returned
**"The FMV lookup timed out on that one."** ⭐ **The user-facing symptom was real even though the
attributed cost was not** — which is why the fix survived both retractions. Any site with a large id
list sitting inside a request path with other work has the same failure mode available to it.

## ⛔ The part worth generalising

**This class was already documented — on 2026-08-30 — and a live instance survived it.** That file
fixed three SQL functions and left a list headed *"Remaining consumers to measure"* naming four more
**SQL functions**. It did not name the application. The concierge read, and these sixteen, were never
in scope because the enumeration was done in the language the first instances happened to be written
in. **Enumerate consumers by the OBJECT — grep the view's name across SQL *and* application code —
not by the language you found the first instances in.**

## Status — ⛔ SUPERSEDED, and the reason is worth more than the finding

The original section here said "sixteen routes, filed rather than fixed, rank by real callers first."
The ranking was then done, and **it inverted the finding.** What actually happened:

- ✅ **The three sites worth fixing are fixed** — `sniper-feed:1165`, `overview-stats:105` and
  `support-chat:2237`, in `c280d337b`. **Two of those three were on this filing's SAFE list.**
- ⛔ **The thirteen id-list sites this filing pointed at are mostly NOT worth a migration.** At ~50–70
  buffers per edition the cost tracks the id-list SIZE, and the hot id-list shape averages ~29
  editions per call. `recent-sales` is capped at 50 ids; leave it alone.
- ⭐ **One shape, in one file, out-read every id-list call in the product combined by 3.6× — from 1%
  of the calls. A file count is not a cost model, and "sixteen routes" was a file count.**

**Revised exit condition** (replacing *"the `.in()` count reaches zero"*, which was the wrong target):
convert an id-list site when a wider helper already exists for another reason, or when its large-list
tail becomes the common call — each conversion carrying its own before/after buffer figure.
**Falsifier:** a site where the LATERAL rewrite measures WORSE — plausible where the id list is large
and the editions are cold, since the per-id probe pays a random read each; that is the case to
measure, not assume.

⚠ **One known-stale artifact:** `get_editions_latest_fmv`'s own `COMMENT ON FUNCTION` still says
**249×**. Fix it on the next migration that touches FMV rather than spending a `PGRST002` burst on a
comment.
