# Ask-corroboration is Top-Shot-only BY DESIGN — and extending it to All Day is worth 320 editions (+5.2pp on that collection, +1.1pp on the gate)

**Filed 2026-08-21 ~20:20 PT (2026-08-22 03:20Z), Claude Code interactive. MEASURED, read-only.
NOT a defect and NOT shipped — this is a judgement call with a number attached.**

Follows the 02:56Z gate measurement, which put `nfl_all_day` at **22.7% HIGH/MEDIUM** and flagged it as
"where algorithmic headroom most plausibly sits — stated as a place to LOOK, since I did not audit the
confidence thresholds." This is that audit.

---

## The number

`escalateConfidence()` lifts a LOW edition to MEDIUM when a **live ask agrees with the sales median
within ±25%**, at **≥3 sales** (`MIN_SALES_ASK_CORROBORATION`). Applying that exact test to All Day:

| | count |
|---|---:|
| All Day editions currently LOW with ≥3 sales in 30d | **717** |
| …of which have a live floor ask (`allday_edition_floor_ask`) | **705** (98.3%) |
| …with a computable 30d sales median | 672 |
| **…whose median falls inside the ±25% band → would lift LOW→MEDIUM** | **320 (47.6%)** |

**All Day 1,407/6,190 = 22.7% → 1,727/6,190 = 27.9% (+5.2pp).**
**Overall gate 9,224/29,514 = 31.3% → 9,544/29,514 = 32.3% (+1.1pp).**

⚠ **Approximate, and here is exactly how.** I computed the median over a flat 30-day `sales` window;
`fmv-recalc` may widen to 90 days for thin editions and trims outliers before taking its median. The
real count will differ. The *eligibility* figures (717 / 705) are exact.

## ⚠ TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT — I nearly filed both

The data points hard at two defects. Reading the code dissolved both, and that is the part worth keeping.

**1. "All Day's `edition_offers.low_ask` is never populated."** True — `low_ask > 0` on **0 of 2,292**
All Day rows, against **12,259 of 12,464** for Top Shot, with both feeds updated within the hour. It
reads exactly like a broken writer. It is not: All Day's `edition_offers` carries the **BID** side.
`highest_offer > 0` on **2,292 of 2,292**. Different column semantics per collection, working as
intended.

**2. "The Top-Shot-only limitation is an expired premise."** The corroboration comment says the ask is
*"Absent for editions/collections without a live ask feed (e.g. All Day)"*, and `allday_edition_floor_ask`
now holds **4,350 live rows** that the deals board reads — so the premise looks stale. It is not stale;
it is deliberate. Fifty lines further down, `fmv-recalc` builds a **separate** All Day ask map on purpose:

> *"Build a SEPARATE map for the ceiling so the All Day floor never leaks into ask-corroboration
> (`editionAskById` stays Top-Shot-only **by design**): the ceiling only ever LOWERS an overstated FMV,
> corroboration RAISES confidence, so the two want different, independently-reasoned inputs."*

So All Day's floor ask **is already fetched in the same function**, and is deliberately withheld from
corroboration. This is a reasoned design boundary, not an oversight.

## The actual decision, and the evidence on both sides

**For extending it:** 320 editions, measured against the same ±25% test Top Shot already passes, on a
signal already loaded in the same request. No new pipeline, no new fetch.

**Against, in the author's own words and numbers:** raising confidence off a noisy input is not
symmetric with lowering an overstated price. And All Day's floor ask *is* measurably noisy — the same
comment block records, **measured 2026-08-08: 1,549 of 2,970 priced All Day editions had an FMV above
their live floor, avg 1.74×, max ~17×** — "a confident wrong number that fabricates 'deals'."

⚠ **The two sides are reconcilable, and the reconciliation is itself a measurement.** The ±25% band IS
the independence test — it rejects the disagreeing asks. And it demonstrably works harder on All Day
than on Top Shot: **52.4% of All Day candidates are rejected**, against ~42% for Top Shot (from the
modelled "~1,291 rescue / ~915 correctly stay LOW"). The noisier feed is being filtered more, which is
what the guard exists to do. Whether that is *enough* independence is the judgement — and it is
Trevor's, not mine.

## If it is taken

The change is small and local: pass All Day's `floor_ask` into `editionAskById` (keyed by `edition_id`
directly — simpler than the `external_id` path Top Shot needs). ⚠ It must **not** be done by merging
`editionCeilingAskById` into `editionAskById`; that erases the separation deliberately, and the two maps
want to stay independently reasoned even if both end up carrying the same numbers.

⚠ **Not shipped for a structural reason, not just caution:** FMV/pricing route logic is on CLAUDE.md's
off-limits list for autonomous shipping, and unlike a migration a route change goes live on push — there
is no "committed but unapplied" state to stage it in.

## What this closes

The 02:56Z filing's open item — *"`nfl_all_day` is where algorithmic headroom most plausibly sits"* — is
now answered with a number. The headroom is real (**320 editions**), it is not a bug, and it costs one
design decision rather than any new data.
