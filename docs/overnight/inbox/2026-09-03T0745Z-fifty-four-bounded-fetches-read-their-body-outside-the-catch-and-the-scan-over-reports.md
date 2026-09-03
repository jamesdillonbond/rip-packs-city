# 54 bounded fetches read their response body OUTSIDE the catch — but the scan over-reports, and nobody should act on the list as-is

**Filed 2026-09-03 ~00:45 PT (07:45Z) by Claude Code. NOTHING SHIPPED FOR THIS.** Three instances of the
class were fixed tonight on their own evidence; this filing is the **population sweep** that followed,
and it is a candidate list produced by a syntactic rule, not a finding.

## 0. The class, established tonight rather than hypothesised

An `AbortSignal` attached to a `fetch` **stays live for the response body**. So a body read that sits
outside the `try` which wraps the fetch can reject — on the deadline, or on a mid-transfer reset —
where no `catch` in the handler can see it, and the handler throws instead of answering.

Measured, not argued: `/api/public/ipfs-media/[cid]` produced **426 uncaught `TimeoutError`s across 60
users in the 24 h to 2026-09-03**, with one request logging `ok … elapsedMs=6037` and then four of
them — a 200 whose transfer was killed after the headers went out. Fixed, along with the same shape in
`badge-image`, `moment-thumbnail` and `avatar-media`. The **streaming** half of the class is now a ban
at population zero (`__tests__/image-proxy-routes-bound-their-upstream.test.ts`).

## 1. The sweep (re-runnable, and the method matters more than the list)

TypeScript AST, not grep: for every `app/api/**/route.ts` that attaches a bound
(`AbortSignal.timeout(` or `new AbortController(`), find each `await <x>.json()|.text()|
.arrayBuffer()|.blob()|.formData()` with **no lexically-enclosing `TryStatement`**.

**Result: 54 files.**

## 2. ⛔ WHY THE NUMBER IS AN UPPER BOUND, AND THE FALSE-POSITIVE RATE IS UNMEASURED

The rule asks about **lexical** enclosure. It cannot see a `try` at the **call site**, and this codebase
routinely puts one there — so a helper that reads a body and is only ever called from inside a
`try/catch` is counted as unguarded and is not.

⭐ **This is not a theoretical caveat: it is the first row I checked.**
`app/api/public/pinnacle-image/[renderId]/route.ts` is flagged at `res.json() @49`, and its only
caller wraps `resolveSignedUrl(...)` in `try { } catch { url = null }`. **Correct as written.**
`app/api/pack-ev/route.ts:71` is the second: that helper's design is to THROW (`throw new Error(...)`
on `!res.ok` and on GraphQL errors), so a rejecting `res.json()` is the same contract, not a leak.

**Two of two spot-checks were false positives.** Nobody should work this list top-down.

## 3. What would make it actionable

- **Caller-aware analysis.** Follow each flagged function to its call sites and ask whether *every*
  one is inside a `try`. That is the measurement this filing does not have.
- **Then rank by BLAST RADIUS, not by count.** On a cron/ingest route a throw is visible: the tick
  fails, and `pipeline_runs` records `ok=false` or the row is simply absent — loud, and read by the
  sentinel. On a **user-facing** route it is a 500 where a status was owed, which is the honesty class
  this repo tracks. Of the 54, most are indexers, backfills and admin drains; the user-facing subset is
  small and is where any work belongs.

## 4. ⚠ What NOT to conclude

- ⛔ **"54 routes are broken."** They are 54 routes whose body read has no *lexically* enclosing try.
  Two of the first two examined were correct.
- ⛔ **"Wrap them all in try/catch."** A blanket wrap on a route whose contract is to throw would
  swallow a real failure into a success-shaped response — the fabrication class, introduced by the fix.
- ⓘ The three fixed tonight were each fixed on **their own** evidence (a live error group, or the
  measured sibling shape), not because they appeared in a list.
