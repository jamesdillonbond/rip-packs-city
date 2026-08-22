# 259 reads in `app/api/**` never destructure `error` — and two existing honesty guards exclude that tree on a premise that is false

**Filed 2026-08-21 ~19:45 PT, Claude Code interactive. MEASURED, with a positive control.
4 instances triaged and SHIPPED; the rest is a population, NOT a defect list — see §4.**

---

## 1. Why these survive: the guard estate stops at the route tree

The repo has ~20 honesty guards. Two of the most relevant **explicitly exclude `app/api/**`**, and both
give the same reason in the code:

    // app/api/** is the ROUTE tree — server code, already in the primary gate.   (client-failure-collapses-to-empty-ratchet)
    /** Every .ts/.tsx outside `app/api`, which the primary gate already measures. */  (server-page-data-access-ratchet)

⚠ **That is a claim about a DIFFERENT INSTRUMENT, and it does not hold.** "The primary gate" is the
vitest **coverage** gate. Coverage measures whether lines are EXECUTED by a test — it cannot see an
unhandled error branch, because **the branch does not exist to be uncovered**. A happy-path route test
gives an unguarded `const { data } = await supabase…` 100% coverage. The exclusion is reasonable for
avoiding duplicate *coverage* measurement and wrong as a reason to skip *honesty* checking.

**This is the same shape as `degradedFromSource`'s "the clients already surface as an age"** (fixed
earlier tonight): a suppression justified by a property of files the author did not check.

## 2. The measurement — and ⚠ MY FIRST ONE WAS WRONG BY 8×

| | |
|---|---:|
| route files scanned (`app/api/**/*.ts`) | 453 |
| reads **with** `error` destructured — **positive control** | **492** |
| reads **without** `error` destructured | **259** |
| files carrying ≥1 | **106** |

⚠ **I nearly filed "32".** My first detector used `[^\n;]*?` between `await` and `.from(`, which
**cannot cross a newline** — and the dominant formatting in this repo puts `.from()`/`.rpc()` on the
line *after* `await`. It therefore saw only single-line calls: **32 instead of 259**. I caught it while
re-measuring after the fixes, because the count barely moved. **That is precisely the defect class this
filing is about, committed by me, in the instrument used to find it.** A population derived from a
pattern that cannot match the common case is not a population.

The **positive control matters as much as the count**: 492 reads in the same tree DO destructure
`error`, so the detector discriminates rather than matching every supabase call. Without it, "259 hits"
is equally consistent with a regex that matches everything.

## 3. What was SHIPPED — 4 instances, triaged individually

Triage criterion that worked: **does a swallowed error become a CLAIM?**

- `app/api/cost-basis/route.ts` — ⚠ **the worst, and not an empty answer but a DIFFERENT one.**
  `resolveCollectionId` returned `string | null`, and the caller reads null as "no collection filter
  requested". A failed `collection_config` read therefore dropped `p_collection_id` and the RPC returned
  **every collection the wallet holds, rendered inside a single-collection tab** — about the reader's own
  money. On the live path the ambiguity is total: `CollectionTabClient` always sends `&collection=<slug>`,
  so null can ONLY mean the read failed. Now a discriminated result; the unscoped query is never issued.
- `app/api/market-movers/route.ts` — **both** failure paths published `{ movers: [] }` (swallowed error
  AND a bare `catch`), under `s-maxage=300`, so one failed read served "nothing moved in 24 hours" — a
  market claim — to every visitor for five minutes.
- `app/api/edition-stats/route.ts` — a failed edition lookup rendered **404 "Edition not found"**, a
  claim about the catalogue, on a public entity surface. Switched to `.maybeSingle()` so absent and
  unreadable stop sharing an outcome (see the note in-file on why not a `PGRST116` special-case).
- The acquisition-enrich read in `cost-basis` was left non-fatal **on purpose**: a null
  `acquisition_method` renders nothing in `SlabFooter`, so it degrades a field without making a claim.
  It was silent, though — logging was what was missing, not a status code.

⚠ **An existing test was INVERTED, not deleted:** `api-market-movers.test.ts` carried
*"swallows an RPC throw to an empty movers list"*, and the file header described the swallow as the
contract. A passing test asserting a promise is what holds that promise in place.

## 4. ⚠ THE REMAINING 255 ARE NOT A TO-DO LIST

**Do not sweep this.** CLAUDE.md already records the outcome of trying: a file-scoped version of this
predicate produced **12 false positives on a clean tree**, because *"losing a buyer address degrades a
FIELD while losing an event range moves the CURSOR — same expression, opposite correctness."* This
filing's own §3 has an instance of each in ONE route.

What the number is good for is **triage order**, highest claim-value first:

1. **Public, cached surfaces** — a false claim is served to everyone and outlives the failure.
2. **A reader's own account** — CLAUDE.md's named worst sub-class, because it is actionable.
3. **Anything whose empty state CONCLUDES** ("not listed", "not found", "no movers") rather than reports.
4. ⛔ **`app/api/support-chat/**` (26 + 6) is the largest cluster and is OFF-LIMITS** for autonomous
   shipping (concierge route logic). It is also where a swallowed read becomes a spoken claim, so it is
   worth a human pass — the concierge rule *"an errored tool is NOT an empty result"* is exactly this
   defect one layer up.

## 5. The guard I did NOT write, and why

A ban on the predicate would red 255 correct-and-incorrect files alike; a curated allowlist drifts, which
this repo has recorded three times. The honest options are (a) a **ratchet on the count**, which buys
little because the number is not the property, or (b) narrow guards on the surfaces in §4's tiers 1–3,
written per-surface where "is this a claim?" can actually be judged. **I did not add either on a
population I have not triaged** — a guard whose population is 255 files I have not read would be the
same mistake as the `[^\n;]` regex, one level up.
