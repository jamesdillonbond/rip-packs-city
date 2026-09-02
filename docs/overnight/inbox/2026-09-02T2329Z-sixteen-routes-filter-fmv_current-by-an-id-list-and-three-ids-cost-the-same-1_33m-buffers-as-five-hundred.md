# Sixteen routes filter `fmv_current` by an id list — and THREE ids cost the same 1.33M buffers as five hundred

Measured 2026-09-02 23:29Z. Every number here is a dated sample; re-measure before quoting.

**NOT SHIPPED.** One instance (the concierge's) is fixed and deployed. The other sixteen are filed,
not touched — see "Why this is filed rather than fixed" at the bottom.

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
