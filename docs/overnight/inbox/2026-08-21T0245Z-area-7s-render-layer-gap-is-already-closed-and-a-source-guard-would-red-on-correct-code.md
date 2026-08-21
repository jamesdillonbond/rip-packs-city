# Area (7)'s render-layer gap is already closed — 30 of 31 server pages discriminate, and a source guard would red on correct code

**Filed:** 2026-08-21 ~02:45Z (PT: 2026-08-20 19:45) · **Class:** correction to a filed proposal.
**Status:** NOTHING SHIPPED, deliberately. The recommended work would have been ~23 pages against a problem that is not there.

## What the filing proposed

> The remaining gap is the **render layer** — the code deciding whether a failed fetcher renders as
> an error or as "no results". 23 server pages consume a fetcher or call `fetch()` directly …
> **Proposal** — extend `server-pages-error-vs-absent-guard.test.ts` (today: 2 pages) across those
> 23, asserting the property it already asserts well: **the error branch precedes the empty branch**.

## Measured instead

Async server `page.tsx` files that actually read data: **31** (119 `page.tsx` total, 115 server).

| how it distinguishes a failed read from an absent one | count |
|---|--:|
| the canon helper (`summarizeDegraded` / `degradedFromSource`) | **22** |
| carries a named failure signal out of the fetcher (`ok` flag, `loadError`, `errored`) | **7** |
| **throws** to the retryable error boundary | **1** |
| **observes the error but collapses it into the empty value** | **1** |

**30 of 31 are correct.** The helper's adoption is already the dominant pattern; this workstream
appears to have been finished by whoever built `lib/insights/board-status.ts` and did not update the
prose. The single genuine instance is **`app/insights/page.tsx`**: `getHubStats()` does
`if (error || !data) return null`, which is the two-state collapse. ⚠ **Severity is low and should
not be inflated** — the page renders `stats?.market ? … : null` and `stats ? liveStat(…) : null`, so
a failed read WITHHOLDS the live numbers rather than fabricating a zero. It is an undifferentiated
silence, not a false claim, which is the acceptable end of the canon's three states. Fixing it is a
product decision (it needs a visible "unavailable" state to be worth anything), not a bug fix.

## ⚠ And the stronger reason not to build the proposed guard: I got it wrong FOUR TIMES

I wrote the detector four times, and each version reported false positives that were **correct code
using a spelling my regex did not know**:

| version | flagged | what they actually did |
|---|--:|---|
| `ok` flag / helper only | 6 | — |
| + `loadError` | 4 | `insights/market`, `admin/flowty-errors` returned `{ rows, loadError }` |
| + `errored` | 2 | `challenges`, `hot-floors` use `let errored` + `!errored && length === 0` — **exemplary**, exactly the property being asked for |
| + `throw` | 1 | `series/[slug]` THROWS to the error boundary; its comment documents the deep-audit D10 fix |

**Four correct idioms for one property.** A source guard banning this shape would have redded CI on
`challenges` and `hot-floors` — the two pages that implement it *best*. The bound-reads guard's own
header names this as the expensive direction: *"A FALSE POSITIVE … reds CI on correct code, and the
next person weakens the guard to get green."* At a true population of 1, a guard whose false-positive
rate was 6, then 4, then 2 is not an instrument; it is a tax.

## Recommendation

- **Do not extend the guard across the 23.** The existing 2-page bespoke version stays: it pins two
  specific, historically-broken fixes with page-specific strings, which is what source guards are
  good at. Generalising it is what fails.
- The honest coverage answer for this layer is **execution**, not source-matching: an async server
  component cannot be rendered by the jsdom component gate, so the only real instrument would be a
  render test harness for RSC. That is a real project, not a guard tweak — file it as such if wanted.
- ⚠ **Re-derive before believing this filing too.** The counts are a 2026-08-21 sample; the
  vocabulary list (`ok` / `loadError` / `errored` / `throw` / the helper) is the part most likely to
  grow, and a fifth idiom would make my "30 of 31" itself an undercount of correctness.
