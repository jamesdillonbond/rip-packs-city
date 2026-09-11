# 9,486 All Day sales record the Dapper CUSTODIAN as the buyer — the exact value this repo decided, in writing, "would be a lie" — 2026-09-11T10:14Z

Filed by Claude Code on Trevor's box (interactive, 03:14 PT). Found while probing **#70 / go-live
M2** ("All Day's FMV confidence is sliding; the next probe is upstream, not another pipeline read").
It is not the answer to that question — it is a different defect the probe walked into. Every figure
below is from the live instance.

---

## The finding

**`0xddfbe848a81b2236` is the constant Dapper CUSTODIAN for All Day, not a buyer**, and **9,486 All
Day sales rows carry it in `buyer_address`** — across **62 distinct days**, **1,819 editions**,
**2026-05-18 → 2026-09-10**.

⭐ **This repo already knows the address and already made the call.** From the 2026-07-19 handoff, on
the counterparty-recovery worker:

> *"Set `buyer` to NULL for AllDay/UFC. Those collections deposit to a constant Dapper custodian
> (`0xddfbe848a81b2236`), so writing it as the buyer would be a **lie**. Seller only."*

and in the ledger for the same ship:

> *"AllDay/UFC deposit to a constant Dapper custodian … that **re-forwards to the real buyer in a
> LATER tx**, so writing `AllDay.Deposit.to` as buyer would be a lie — we fill seller only and leave
> buyer NULL (same honesty stance as the multi-moment guard)."*

⛔ **That decision was applied to the RECOVERY worker and never to the MAIN INDEXERS.** The 9,486 rows
come from `onchain_dapper_v2` (**6,482**, 06-14 → 09-10) and `onchain_dapper_v1` (**2,997**, 05-18 →
09-10), plus 7 from `allday_studio_history_v1`. Those are the primary sale lanes, not a backfill.

## It is intermittent, it declined sharply, and it is NOT over

| month | rows | days affected | last |
|---|---:|---:|---|
| 2026-05 | 721 | 13 | 05-31 |
| 2026-06 | 2,740 | 29 | 06-30 |
| 2026-07 | 5,290 | 14 | **07-20** |
| 2026-08 | 174 | 5 | 08-14 |
| 2026-09 | **561** | 1 | **09-10** |

⚠ **The July cliff sits on 07-20, one day after the buyer-honesty decision — but do NOT read that as
cause.** That ship changed the *recovery worker*, and these rows come from the *indexers*. The
correlation is suggestive and unproven; what is measured is that the volume fell ~97 % and **did not
stop**.

🚨 **It fired again last night.** 09-10 is the only day in the last 21 with a single such row, and it
produced **561** of them: 516 from `onchain_dapper_v2`, 45 from `v1`. Every other day 08-21 → 09-11
reads **zero**. So this is a rare TRANSACTION SHAPE, not a steady leak — and a single bulk event
re-creates hundreds of rows at once.

⛔ **Not a recovery artifact, which was the obvious hypothesis and is refuted.** 09-10 carried both
real-time ingests and a post-outage catch-up burst (21:56–22:20Z). Splitting on ingest time:
**511 custodian rows landed in REAL TIME** (< 21:40Z) against 50 in the catch-up. The live indexer
writes it.

## Blast radius

`buyer_address` is the key for buyer-side surfaces — wallet pages, buyer analytics, "top buyer"
boards and the insider detectors. **A custodian credited with 9,486 purchases across 1,819 editions
is a single fake mega-buyer sitting in all of them**, and it is the *inverse* of the honest shape the
07-19 decision chose: a NULL says "we do not know who bought this", which is true; the custodian says
"this wallet bought it", which is not.

⚠ **FMV and M2 are NOT implicated by this field.** The sales themselves are real moments at real
prices; only the counterparty attribution is wrong. Do not fold this into the M2 slide.

## Suggested actions — none taken here

1. **Apply the existing decision to the indexers**: where the All Day deposit target is the known
   custodian, write `buyer_address = NULL` rather than the custodian. The rule, the address and the
   rationale are already written down — this is extending a made decision, not making a new one.
2. **Backfill the 9,486 existing rows to NULL.** ⛔ **Not autonomous** — it is a bulk `UPDATE` on
   `sales`, and this estate treats that as destructive. It is also the honest end state.
3. **Add the discriminator as a guard.** A check that no All Day sale carries a known-custodian buyer
   would have caught this in May. ⚠ Needs the custodian list to live somewhere both lanes read; today
   the address appears only in a handoff and a ledger entry, which is why the decision reached one
   writer and not the other. ⭐ **That is the transferable half: a decision recorded in prose reaches
   the session that wrote it and nothing else. A constant with a comment, or a guard, is what makes a
   decision binding on the NEXT writer.**

**Risk of doing nothing:** stable and low-severity — it has been true since May and nothing pages on
it — but every buyer-keyed surface keeps publishing a counterparty the repo has already ruled is not
one, and the next bulk event adds several hundred more.
