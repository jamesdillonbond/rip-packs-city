# `panini_sale_field_mapping_shortfall` is mathematically incapable of firing while `panini_sale_price_capture_dry_days` is breached — and its own comment says it "Reads 0" when it reads −19

Filed 2026-08-17 15:45 PT / 22:45Z (Claude Code, interactive). Found while re-deriving whether the
long-deferred `panini_sale_price_capture_dry_days` re-point still rests on a true premise. **It does — the
breached arm is correct.** Its *sibling* is the defect.

## First, the arm everyone is watching is RIGHT

`panini_sale_price_capture_dry_days` = **20**, and it is accurate. `v_panini_serial_sale_field_supply`
shows `raw_supplied_sale_price = 0` on **every** capture day for the last 12+ (the arm counts 20
consecutive). Upstream genuinely sends no `brought_at_price` in the raw payload. **Do not re-point this arm
on the theory that it is crying wolf.**

⚠ **I nearly filed the opposite, and the near-miss is the reusable lesson.** `panini_card_serials` shows
**832 sales in the last 7 days, 100% carrying `last_sale_usd`, newest two hours ago** — which reads as a
flat refutation. It is not: the arm measures the **raw upstream payload field**, while `last_sale_usd` is a
**stored column that survives across captures** (there is a whole `last_sale_preserved_at` mechanism for
exactly that). **Pairing a count from one table with a property sampled from another** is the documented
trap, and reading the metric's definition before believing my own refutation is what caught it.

## The actual defect: the sibling arm cannot fire

```sql
mapping_shortfall =
    count(*) FILTER (WHERE raw->>'brought_at_price' IS NOT NULL AND <> '' AND <> '0')      -- upstream supplied
  - count(*) FILTER (WHERE last_sale_usd IS NOT NULL AND last_sale_preserved_at IS NULL)   -- we stored, this capture
```

Its documented purpose (verbatim from `rpc_trust_health_precompute_refresh`):

> `panini_sale_field_mapping_shortfall` — **OUR ingest dropped a price upstream DID send. Reads 0; a defect
> we own and can fix.**

⚠ **It does not read 0. It reads −19**, and per-day values run to **−3,362**.

⚠ **And it is ≤ 0 BY CONSTRUCTION while the supply is dry.** The minuend is the count of upstream-supplied
prices — currently **0 every day**. So the expression is `0 − (a non-negative count)`, which cannot be
positive. **An arm that fires on `> 0` is therefore provably dead for the entire duration of the outage.**

**That is the wrong half to lose.** The two metrics were designed as a pair — *their* outage vs *our* bug.
The one we can actually fix is the one that is blind, and it goes blind precisely when the other is
breached, i.e. exactly when you most want to know whether your own mapping is also broken. ⚠ This is the
standing **"a permanently-green instrument is indistinguishable from a broken one at a glance"** rule, in
its least visible form: not permanently green, but permanently *negative*, which reads as "healthy, and
comfortably so".

## Why nobody caught it

The value was asserted in a code comment (*"Reads 0"*) and never re-read. The metric is precomputed, so it
never surfaces unless it breaches — and it cannot breach. **A metric whose only reader is its own threshold
is unfalsifiable when the threshold can't be met.**

## Options, and why none was shipped

⛔ **Nothing shipped — this is alerting semantics, which is a threshold judgement, not a measurement.**
Deciding what "shortfall" should mean is an owner call, and the three candidates differ in what they claim:

1. **Clamp at zero** (`GREATEST(0, …)`). Cheapest, and makes the arm honest about firing — but it silently
   discards the negative signal, which is itself information (it says the stored column is ahead of upstream).
2. **Redefine as a rate**, e.g. `supplied - stored` only over rows where `supplied > 0`. Preserves the
   original intent ("we dropped one they sent") and is well-defined during an outage — it simply has no
   rows to evaluate, which is honestly *no data*, not zero.
3. **Split the claim in two**: keep a shortfall count, and add an explicit `supply_present` boolean so the
   shortfall arm can report **NO_DATA** rather than a number, instead of quietly reading negative.

⚠ **Whichever is chosen, the code comment must be corrected in the same change** — it currently states a
value that has never been true, and a future session will trust it exactly the way this one nearly did.

⚠ **Do NOT re-point `panini_sale_price_capture_dry_days` as if it were the problem.** Its +1/day climb is a
correct reading of a real, ongoing supplier outage with a different owner.
