# ✅ CLOSED — the unbounded-`fetch()` class is down to **1**, and that one is a **checked** exclusion rather than an excused leftover

**Filed 2026-08-27 18:15 PT (2026-08-28 01:15Z) by Claude Code, cloud session (push-capable).**
Completes the class triaged in
[2026-08-27T0320Z](2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-carry-the-shape-whose-failure-is-invisible.md);
continues [2026-08-28T0100Z](2026-08-28T0100Z-the-three-dune-routes-are-bounded-by-a-DERIVED-deadline-and-the-ratchet-falls-21-to-11.md).

---

## 1. Where it landed

**21 → 1 site**, 13 → 1 file, in two pushes. The ratchet's anti-slack arm forced each step.

| bounded this pass | bound | where the bound came from |
|---|---:|---|
| `support-chat` HIGH escalation page ×2 (Telegram + Resend) | 10 s | `alerts-send`, same upstreams |
| `weekly-digest`, `signup-reminder` (Resend) | 10 s | ” |
| `analytics-smoke`, `detect-league-drift`, `early-access/submit` (Telegram) | 10 s | ” |
| `bots/discord` follow-up (Discord) | 10 s | ” |
| `seed-wallet-refresh` (Top Shot GraphQL) | 15 s | `lib/verify-wallet-gql.ts`, same proxy |
| `public/queue-wallet` (internal) | 45 s | that route's own `maxDuration = 60` |

⭐ **Not one of these bounds is a new number.** The triage filing's warning — *"a short cap converts
working behaviour into failure"* — bites when the cap is a guess about an upstream. Every value here
is one **already measured and shipped for the same upstream**: 10 s from `alerts-send`, whose comment
records **276 runs over 48 h, avg 1,494 ms, p95 1,644 ms**, against a **58,670 ms** outlier that came
within **1.3 seconds** of a `maxDuration` kill. The single exception is `queue-wallet`, derived from
its own declared ceiling.

**This is the filing's own headline lesson executed:** it was not the DEFECT that spread by
copy-paste, it was the FIX that failed to. Spreading it is the whole job.

## 2. 🚨 The one that mattered most

`app/api/support-chat/route.ts` — the **HIGH-urgency escalation page**. Its surrounding code already
carries a careful comment: `pageDelivered` exists so a dead token or non-2xx can never let us tell a
user *"you've been paged"* when nobody was, because **a real HIGH emergency would vanish with a false
confirmation and no trace**.

⭐ **An unbounded `fetch` defeats that guard by a route it does not consider.** Under `after()` with
`maxDuration = 60`, a hung Telegram or Resend send burns the whole budget and takes the lambda with
it — so the page is not delivered **and** the `catch` never runs **and** nothing is logged. The exact
failure the block was written to prevent, arriving from the side it does not watch. Both calls are
now bounded, and an abort throws into the existing catch leaving `pageDelivered` **false** — the
honest outcome.

## 3. ⭐ The last site is an exclusion, and exclusions are claims

`app/api/smoke-test/route.ts:47` stays unbounded **on purpose**. `smokeFetch` is a wrapper that
forwards its caller's `init`, and the triage filing lists *"inside a caller that already imposes its
own deadline"* as a legitimate reason.

⚠ **But that is a claim about a DIFFERENT instrument**, and CLAUDE.md is explicit: *"an exclusion
justified by ANOTHER instrument is a claim about it — check that one can SEE the property."* Two
guards have already skipped `app/api` on exactly that shape and been wrong.

✅ **So it is checked, not asserted.** A new `smoke-test-callers-are-bounded` block verifies that
**every one of the 24 `smokeFetch`/`smokeFetchRetry` call sites carries an `AbortSignal`** — with
**the count it inspected asserted** (so it cannot pass by inspecting an empty set) and **a negative
control** proving the matcher can see an unbounded caller. If a caller ever drops its signal the test
reds, while the ratchet would not move, because the wrapper itself is unchanged.

⛔ **Do not "finish the job" by bounding `smokeFetch` itself.** Its callers pass per-attempt timeouts
that the retry path deliberately replaces with a fresh, more generous one; a wrapper-level cap would
silently become the ceiling for all 24 and could make a slow-but-passing smoke check fail.

## 4. ⚠ What is NOT claimed

- **These paths are not all exercised yet.** The bounds are correct by construction and by the
  precedent they reuse; only `analytics-smoke` (142 runs / 7 d) and the alert routes run often enough
  to exercise soon. The dune routes remain drained.
- **A bound does not make a failure visible on its own** — it makes it *reachable* by the caller's
  existing error path. Each site was read to confirm that path exists (per-recipient `try/catch` that
  counts a skip and writes no delivery row, so the recipient is retried; `.catch()` that logs;
  `pageDelivered` left false). **That reading is per-site and was not automated.**
- **`RATCHET = 1` is not "zero defects".** It is one *checked* exclusion. The 115-site whole-repo
  population outside the `after()` + `maxDuration` shape is untouched and still un-triaged.

## 5. Revert path

`git revert` the commit. Restoring any single site additionally requires raising `RATCHET`. No DB
state, no schedule change, no data mutation.
