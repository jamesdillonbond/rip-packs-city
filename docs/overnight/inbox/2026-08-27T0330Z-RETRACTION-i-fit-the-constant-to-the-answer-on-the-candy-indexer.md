# 🚨 RETRACTION — I fit the constant to the answer on the candy indexer, and a concurrent session had already falsified the premise

**Filed 2026-08-26 ~20:30 PT (2026-08-27 03:30Z) by Claude (Cowork cloud), interactive.**
**Retracts:** the causal claim in my own `perf(candy): batch mint resolution` work of ~02:45Z.
**Supersedes nothing shipped** — the change was never pushed, and §4 is why it is now on HOLD.

---

## 1. What I claimed

That `candy-listings-indexer`'s 300 s `maxDuration` kill was caused by per-mint resolution:

> round-trips 1,813 × 2 = 3,626, strictly sequential
> `maxDuration` 300 s ⇒ **~83 ms per round-trip closes the arithmetic**

I wrote *"the arithmetic closes exactly"* into a commit message, a ledger entry and
known-issues #39.

## 2. ⛔ Why that is not a measurement

**I divided the known outcome by my hypothesised operation count and called the quotient
evidence.** 300,000 ms ÷ 3,626 = 83 ms. That division **cannot fail** to produce a
plausible-looking per-operation latency for *any* operation count I might have proposed. Had
I hypothesised 1,813 operations it would have yielded 165 ms — equally "ordinary", equally
"exact". A constant fitted to the answer is not a constant that was measured.

**I never measured a single round-trip.** Not one. The whole causal claim rested on a number
I obtained by assuming the conclusion.

⚠ **And I had written the rule myself, hours earlier, in this same session.** From the
`refresh_wmc_fmv_changed` filing:

> ⭐ *"A plausible mechanism is not a measurement, and this one is a good example: the chunk
> constant is conspicuous, sits right at the top of the body, and carries a comment that
> invites the conclusion. It is still not the cost."*

I applied that standard to someone else's hypothesis and not to my own headline. The tell was
identical in both cases — a conspicuous structure that *invites* a causal reading.

## 3. The falsification, which existed before I published

Concurrent commit `f11fe69` (Claude Code, Trevor's box, 2026-08-27 03:12Z) killed it directly:

> - **N+1 `wallet_moments_cache` lookups: FALSIFIED**, it is an Index Only Scan at
>   **1.39 ms / 3 buffers** (my first `EXPLAIN` used a guessed UUID and picked a different
>   index — a plan measured against a fake key is not the real plan).

**1.39 ms, not 83 ms.** The DB side of the lookup is ~60× cheaper than my fitted constant
requires. What remains of my claim is network + PostgREST overhead per round-trip — a term I
did not measure and still cannot measure from here, because it is a Vercel→Supabase path and
this container is a different egress.

ⓘ **Their diagnosis, which is better founded than mine:** `fetch()` has no default timeout,
and `fetchListings`/`fetchActivities` were bare fetches, so an upstream that accepts a
connection and holds it open consumes the entire 300 s budget. ⭐ The clinching part is not the
hypothesis but the reasoning around it — *"bounding the wait does not require knowing which it
is"* — which converts an invisible kill into a cheap logged failure whichever cause dominates.
⭐ And the fix already existed one file away and had never spread: `solUsd()` in the same route
carries `AbortSignal.timeout(8000)` with a comment naming this exact failure mode, written for
CoinGecko and never applied to Magic Eden.

ⓘ Worth recording that they nearly made a neighbouring error and caught it themselves: their
first `EXPLAIN` used a guessed UUID, which picked a different index. **A plan measured against
a fake key is not the real plan** — a good companion rule to this filing's.

## 4. ⛔ Why the change is on HOLD rather than merged

The batching work is **not withdrawn** — 3,626 sequential round-trips is real work that
should not be done, and with their new **240 s whole-sweep deadline** wasted time now costs
*coverage* directly rather than merely being slow. But it must not ship yet, for a reason that
is about evidence rather than caution:

**Their fix is not verified in production.** As of 03:25Z the board is still **44.7 h stale**,
`candy_listings.max(last_seen_at)` = 2026-08-25 06:42Z, and there are **zero terminal
`candy-listings-indexer` rows in 6 hours** — the deploy has not taken effect.

⭐ **If my change lands alongside an unverified fix and the pipeline recovers, neither of us
learns which one did it.** That is this repo's own rule — *do not fix a monitor in the same
session you changed its input conditions* — applied to a pipeline. **A change that is correct
is still the wrong move if it destroys the measurement that says whether it was needed.**

👉 **The order that keeps the evidence:** let `f11fe69` deploy and prove itself. If ticks then
complete comfortably inside 240 s, my batching is a cost improvement to weigh on its own
merits and the round-trip term was never dominant. If ticks complete but bump the deadline or
report `budget_exhausted`, the resolution cost is the next thing to remove and the patch is
ready. **The diff is preserved at `cowork-2026-08-26/candy-batching-HOLD.diff`.**

## 5. What survives, and what does not

**Withdrawn:**
- *"~83 ms per round-trip closes the arithmetic"* — fitted, not measured.
- *"the round-trips are the cause of the 300 s kill"* — unsupported; the better-founded cause
  is the unbounded fetch.
- The framing of known-issues #39 and its ledger entry, which asserted both. Neither was
  pushed, so neither reached `main`.

**Survives, because it was measured rather than inferred:**
- ME book **1,813 listings / 1,813 distinct mints / 19 pages**; all 19 pages fetch in **7.3 s**
  from this egress.
- **1,901 of 1,901** active book mints resolve as CARDS (0 packs, 0 neither) — so every mint
  takes both lookups, and the resolution loop really is 2 round-trips per mint.
- wmc rows disagreeing on `edition_key`: **0**. Candy editions sharing an `external_id`: **0**.
  (These make the batch provably equivalent whenever it does ship.)
- The batching itself, its four verified mutations, and the guard that pins round-trips to
  PAGES rather than LISTINGS.

⭐ **The transferable rule, which is the only reason this filing is worth its length:**
**when a hypothesised operation count and a known deadline are the only two numbers you have,
their quotient is arithmetic, not evidence.** Dividing them will always produce something that
looks like a plausible per-operation cost. **Measure one operation, or say the magnitude is
unknown.**
