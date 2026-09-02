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

**What survives, and it is most of the filing:** the site list; `get_editions_latest_fmv` as the
drop-in; "widen the RPC deliberately, every column is carried per id"; "enumerate consumers by the
OBJECT, not by the language the first instances were written in" — which is exactly the rule that
would have caught the two sites this filing cleared. **What changes is the RANKING.** At ~50–70
buffers/edition the remaining sites are worth fixing in proportion to their id-list SIZE, not
uniformly: `wallet-search` on a 5,000-moment wallet is ~350k buffers where ~20k would do;
`recent-sales` is capped at 50 ids and is not worth touching. The exit condition should be
"large-list sites converted, each with its own before/after", not "the `.in()` count reaches zero".

⚠ The LATERAL is still the better shape everywhere (~4 buffers/edition against ~70) — a **17×** win,
not the 249× the concierge entry recorded. That correction is in `docs/reference/database.md`.

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

## The discriminator, in one line

**`.eq("edition_id", x)` is FINE. `.in("edition_id", [...])` is not.** A single-key predicate pushes
into the view and becomes a bounded index scan per partition; a list does not push and forces the
materialisation. That is the whole rule, and it is cheap to grep for.

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

Two are the safe single-key shape and need nothing: `app/api/overview-stats/route.ts:105` and
`app/api/support-chat/route.ts:2237` (both filter an embedded/other column for one edition).
`lib/concierge/fmv-distribution.ts` no longer reads the view at all — it was the seventeenth, and it
is fixed (`f7aae9c5`).

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

The concierge instance proved it is not merely a cost item. 16.7 s inside a 60 s lambda that also
runs an LLM tool loop meant the FMV tool did not answer at all: a live probe asking *"what is a Base
Set common worth?"* returned **"The FMV lookup timed out on that one."** Any of these sixteen sitting
inside a request path with other work has the same failure mode available to it.

## ⛔ The part worth generalising

**This class was already documented — on 2026-08-30 — and a live instance survived it.** That file
fixed three SQL functions and left a list headed *"Remaining consumers to measure"* naming four more
**SQL functions**. It did not name the application. The concierge read, and these sixteen, were never
in scope because the enumeration was done in the language the first instances happened to be written
in. **Enumerate consumers by the OBJECT — grep the view's name across SQL *and* application code —
not by the language you found the first instances in.**

## Why this is filed rather than fixed

Sixteen routes, several of them the busiest read paths in the product, each needing its own
before/after measurement and its own column list. Shipping that blind in one pass is how a
performance fix becomes an outage, and the repo's own rule is to rank by real callers first. The
cheap, honest next step is one query — rank these routes by actual traffic, fix the top two or three
with measurements, and re-file the rest. **The measurement, the discriminator, the site list and the
drop-in RPC are all here, so that pass is a morning's work rather than a re-derivation.**

**Exit condition:** the `.in("edition_id", …)` count over `app/` + `lib/` reaches zero, each removal
carrying its own before/after buffer figure. **Falsifier:** a site where the LATERAL rewrite measures
WORSE — plausible where the id list is large and the editions are cold, since the per-id probe pays a
random read each; that is the case to measure, not assume.
