# 🚨 SECOND RETRACTION, same night, same route — I refused to guess a number and then reasoned as if it were zero

**Filed 2026-08-26 (PT) / 2026-08-27 04:05Z by Claude (Cowork cloud).**
**Withdraws: "the batching diff is NOT recommended for merge."** Upstream `6455fb9` shipped exactly
that change on a measurement, and it was right.

---

## 1. What I withdrew, and what I said instead

Ninety minutes ago I retracted a causal claim about the candy indexer for a good reason: I had
divided a **hypothesised** operation count by a **known** deadline and called the quotient evidence.
The rule I wrote from it stands and I still endorse it:

> *when a hypothesised operation count and a known deadline are the only two numbers you have, their
> quotient is arithmetic, not evidence.*

Then, with the fix deployed and the pipeline recovered, I wrote the disposition — **and this is the
part that is wrong**:

> *"At the upstream's measured 1.39 ms per lookup, 1,100 listings is ~1.5 s of a 240 s budget —
> 0.6%. The batching diff is NOT recommended for merge."*
>
> *"And I am deliberately NOT making the argument that would rescue it: '1.39 ms is DB execution
> time; a real round trip is ~30 ms; 1,100 × 30 ms ≈ 33 s, which IS material.' That is the identical
> error I retracted at the top of this file. The wall-clock round trip is unmeasured, and I am not
> going to guess it twice."*

## 2. ⭐ What upstream measured, and why it settles it

`6455fb9` / `cca8f9f`: **the cost IS round-trip count.** Per-mint `wallet_moments_cache` probes are
an Index Only Scan at **~1.4 ms / 3 buffers** — but issued one at a time for **~1,600 listings**,
that is ~1,600 **sequential** Vercel→Supabase round trips at **~240 ms per listing**, which is the
entire ~385 s sweep. Batched into three chunked lookups per page: **~1,600 round trips → ~16–32**,
pinned by a test that reports `expected ONE batched wmc query for 25 mints, got 25` when reverted.

And the same author had already named the trap, one entry earlier, about their own falsification:

> *"A per-item cost of 1.4 ms is not an argument against N+1 — it is the thing you multiply by N."*

**That is exactly the argument I made. I used their per-item measurement as a dismissal of the
aggregate, which is the error they had already corrected in themselves.**

## 3. ⭐⭐ THE DURABLE LESSON, and it is not the one I already wrote

The first retraction's rule was *don't multiply a guess and call it evidence*. **I obeyed it and
still got the wrong answer, because I applied it in the one direction that felt safe.**

> ⭐ **"I refuse to guess this number" is a reason to MEASURE it. It is not a reason to reason as
> though it were zero.**

I had an unmeasured quantity — wall-clock round-trip latency — and two options for what to do with
it. Turning it into a finding is the error I retracted. **Turning it into a dismissal is the SAME
error**: both substitute a non-measurement for a measurement, and both let me write a confident
sentence about a number I did not have. The second one is more dangerous precisely because it wears
the costume of the first one's discipline — *"I am being careful, so I will conclude nothing is
there"* reads as rigour and is not.

⭐ **The tell, stated so it is checkable:** I wrote a **disposition** ("NOT recommended for merge")
whose only support was a term I had just declared unmeasurable. **A recommendation that rests on an
unmeasured quantity is a guess whichever way it points.** The honest output was the one sentence I
did write and then buried: *"one line of per-phase timing would settle in a single tick what two
rounds of arithmetic could not."* **That should have been the whole disposition.**

⚠ And a second, smaller tell worth keeping: **I compared against the wrong denominator.** I used
1,100 listings (a *budget-truncated* tick) against 240 s. The healthy sweep is ~1,600 listings over
~385 s. Sizing a term off a truncated sample understates it — the same class as this repo's
standing "a spot rate is not a rate" and "a sample that never moves is not a measurement of the
population" lessons, in a third costume.

## 4. What is now true, so nobody is left holding my wrong conclusion

- ✅ **Batching the per-page mint resolution is CORRECT and is SHIPPED upstream** (`6455fb9`). My
  held diff is superseded; **`cowork-2026-08-26/candy-batching-HOLD.diff` should be discarded, not
  merged** — upstream's implementation also closes an honesty defect mine did not (the sequential
  version destructured only `data`, so a failed `wallet_moments_cache` read silently classified a
  listing as "not a Candy mint" and DROPPED it; the batched lookups throw).
- ✅ **The 240 s sweep budget was wrong and is now 600 s** (`1139e95`), because all three healthy
  sweeps on record ran **375.7 / 389.2 / 391.2 s** — above the declared 300 s `maxDuration` and all
  three completed. ⭐ **`maxDuration` is what the platform DECLARES; the success band is what the
  route actually GETS.**
- ⛔ **My known-issues #40 was written against the 240 s budget and its framing is now wrong** — it
  called the truncation "the designed degradation reporting honestly, not a regression". The
  degradation *was* honest, but the budget that caused it was mis-sized, and both halves of the
  answer (600 s budget, batched round trips) landed within the hour. **#40 is corrected in place.**
- ⚠ **My original hypothesis is still NOT vindicated as stated.** I claimed the round-trip term was
  dominant *from arithmetic I fitted to the deadline*. It turned out to be dominant *for a reason I
  had not measured and could not have quoted*. **Being right about the conclusion while wrong about
  the evidence is not being right** — it is the outcome this repo's whole method exists to
  distinguish from the real thing.

## 5. 👉 The one open reading

Upstream's own note: *"Expected effect stated as a PREDICTION, not a result … Re-measure
`extra.duration_ms` on the next successful tick before quoting any improvement."*

**The reading, and it is a single observation:** on a post-batching tick, `extra.duration_ms` should
collapse from ~252–391 s, `budget_exhausted` should go `false`, `sweep_complete` `true`, and
`activities_seen` should return to ~1,000. **If `duration_ms` does not move, round-trip count was
not the dominant term after all** — and that would falsify the shipped fix, not restore mine.
