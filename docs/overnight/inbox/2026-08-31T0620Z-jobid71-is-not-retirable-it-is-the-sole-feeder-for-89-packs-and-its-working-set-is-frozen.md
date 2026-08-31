# 📏 jobid 71 is **not retirable** — it is the sole feeder for **89 of 598** Top Shot packs — and its daily working set is **frozen at ~92**, refreshed twice a day for 1,806 wasted seconds/day

**Filed:** 2026-08-30 ~23:20 PT (2026-08-31 06:20Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** pipeline characterisation · **Status:** MEASURED. ⛔ **Nothing shipped — pack-EV is an off-limits lane, and §5 confirms that blocker still holds.**

---

## 1. Why I looked

`supabase/analysis/cron-waste-triage.sql` ranks **jobid 71 `rpc-backfill-historical-pack-ev`** second in
the `LIVE` class at **1,806 wasted seconds/day** (78 failures in 14 d, `p_null` 0.000). Its name says
*"backfill … historical"*, which invites retirement — this repo's own rule is to
**retire a pipeline by measured yield, not by name**. So I measured the yield.

## 2. ⛔ It is NOT a backfill, and it does NOT drain

`cron.job.command` is `SELECT public.backfill_topshot_historical_pack_ev(15)`, and the function's
candidate set carries
`NOT EXISTS (… pack_ev_history … WHERE snapshotted_at > now() - interval '12 hours' AND edition_count > 0)`.

⭐ **That predicate makes it a RECURRING 12-HOURLY REFRESHER, not a draining backfill.** Every pack it
writes becomes eligible again 12 hours later. There is no cursor and no terminal state — it is named
for a job it stopped being.

## 3. 🚨 The finding: it is not retirable, and the count alone would have hidden why

| | dists covered, 8 d |
|---|---:|
| candidate population | **598** |
| covered by jobid **217** (`refresh_atlas_pack_ev`, `price_source` populated) | **509** |
| covered by jobid **71** (`price_source IS NULL` — its fingerprint) | **97** |
| covered by **any** writer | **598** (100%) |
| 🚨 **covered ONLY by jobid 71** | **89** |

**The two jobs very nearly partition the population** (509 + 89 = 598). ⛔ **Retiring jobid 71 would
take 89 Top Shot packs (14.9%) dark on a public +EV surface.** That is the answer to the question its
name provokes, and it is a "do not do this", not a "do this".

⚠ **Attribution is by MECHANISM (`price_source IS NULL`), not by schedule minute.** I began by
attributing at minute `:13` and stopped — the Atlas filing records that attributing this exact cluster
by minute was already wrong once, because a `-StartWhenAvailable` sibling fires off-anchor.

## 4. Its working set is FROZEN — and only a SET DIFF shows it

Daily distinct dists written by jobid 71 sat at **89 · 89 · 92 · 92 · 97 · 92 · 92 · 92** across eight
days. A stable count is equally consistent with *"cycling a fixed set"* and *"rotating through the
population"* — this repo has recorded exactly that ambiguity, so **diff the SET, not the count**:

| day | dists | **shared with previous day** |
|---|---:|---:|
| 08-30 | 92 | **89** |
| 08-29 | 92 | **92** |
| 08-28 | 97 | 92 |
| 08-27 | 92 | **92** |
| 08-26 | 92 | **92** |

**Near-total overlap: the set is frozen.** jobid 71 is refreshing the *same* ~92 packs twice a day —
which is precisely its 12-hour contract, correctly executed, on its own partition.

## 5. ⚠ A hypothesis I tested and had to DROP, plus one I corroborated

- ⛔ **"It is starved by a poison head."** The `LIMIT 15` carries **no `ORDER BY`**, so it reads in
  physical order, and rejected candidates never get a row — the classic
  [[limit-before-join-starves-a-backfill]] shape. **Refuted by outcome: 593 of 598 packs have
  succeeded at some point, and only 5 never once.** I measured the outcome table rather than reasoning
  from the control flow, and it killed my own hypothesis.
- ✅ **Corroborating the 08-16 filing, 14 days later and independently:** it tested
  *"rejected because `sec_ask IS NULL`"* and found **388 candidates, 5 without an ask**. Tonight:
  **475 candidates, 7 without an ask (1.5%)**. Same conclusion, same magnitude. ⚠ Two snapshots of a
  quantity that oscillates on a 12-hour cycle are **not** a trend — do not read 388 → 475 as growth.

## 6. ⚠ What is NOT established — the next measurement, named rather than implied

**~475 candidates are eligible at any moment and only ~92 distinct ones are ever inserted.** The
remainder are **computed and then rejected** by the two insert conditions the 08-16 filing did *not*
test — `(ev->>'ok')::boolean = true` and the survivor-bias cap `gross_ev <= 3 * sec_ask` — and each
rejection still pays the **full** `compute_pack_ev_per_edition_weighted` cost.

⭐ **That is almost certainly where the 1,806 s/day goes, and I did not prove it.** Proving it means
calling that function across the candidate set, and at ~1.05M buffers per call that measurement would
itself be a significant IO event on the binding constraint. **Named as the next step, deliberately not
run tonight.** ⚠ Note the 08-16 filing's hypothesis 2 tested **one of three** insert conditions and
concluded "not the mechanism" — that conclusion is sound for the condition it tested and
**under-determined for the other two**.

## 7. The lever is a fix that already exists and is correctly blocked

Per-candidate cost is dominated by `compute_pack_ev_per_edition_weighted`'s
`LEFT JOIN fmv_current` leg — measured **1,046,192 buffers vs 335** for the literal-list shape
(~3,100×), in
[2026-08-16T1829Z](2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md).
At 15 candidates per tick that is past the 600 s budget before anything else competes.

🚨 **I re-read the blocker rather than inheriting it, because CLAUDE.md warns that a sibling's stated
blocker turned out to be a measurement. Here the blocker HOLDS — and the two docs that look
contradictory are answering different questions:**

- **`focus.md`**: *"the pinned one is the measured one … **It can ship alone** (migration + pin `.sql` +
  repoint the PINS migration name)."* → this is about whether the **pin coupling** forces one
  coordinated migration across three functions. It does not.
- **CLAUDE.md**: *"blocked on a DECISION not a diagnosis … Trevor's call."* → this is the **off-limits
  lane**: the 08-16 filing states plainly that *"pack-EV logic, FMV/pricing, and ingest are explicitly
  off-limits for autonomous change."*

⭐ **Both are correct. The pin work is routine** — it is the same three-artifact operation I performed
tonight on `refresh_mv_pack_ev_latest` — **but routine pin work does not convert an off-limits lane
into a shippable one.** The decision is still Trevor's; what is new is a price tag on the delay:
**1,806 wasted s/day on the instance's binding constraint**, for a job that cannot be retired because
89 packs depend on it alone.

⛔ **And the two obvious cheap levers remain wrong, for the reasons already recorded:** lowering
`p_limit` cuts coverage on a queue that is already behind, and pack-EV publishes a public **+EV buy
signal** — making it staler is a product change wearing an optimization costume.
