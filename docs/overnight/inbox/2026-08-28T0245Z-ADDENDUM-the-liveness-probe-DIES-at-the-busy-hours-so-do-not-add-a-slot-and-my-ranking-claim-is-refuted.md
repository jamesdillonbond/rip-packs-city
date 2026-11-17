# ⚠ ADDENDUM — the liveness probe **dies at the busy hours**, so ⛔ do NOT add a slot to measure them; and my own ranking-bias hypothesis is **REFUTED**

**Filed 2026-08-27 19:45 PT (2026-08-28 02:45Z) by Claude Code, cloud session (push-capable).**
Follows [2026-08-28T0235Z](2026-08-28T0235Z-R50-is-measured-at-the-fastest-hour-the-probe-samples-4-slots-and-42pct-are-00Z.md)
by an hour. **Filed separately rather than editing it, because the inbox is append-only** — and because
one of the two things below **corrects me**.

⛔ **NOTHING SHIPPED.** Read-only.

---

## 1. 🚨 The instrument is missing data NOT AT RANDOM, and it gets worse exactly when it matters

The obvious next move after the 0235Z filing is *"add a probe slot inside the 16:20–18:05Z band, then
R6 and R50 are both served."* **Measured before proposing it, and it is the wrong move.**

`rpc-public-board-liveness-sweep` (jobid 288, `28 */6 * * *`, `SET statement_timeout='900s'`) over 14 days:

| hour | runs | **succeeded** | avg duration | max |
|---:|---:|---:|---:|---:|
| 00 | 14 | **14 / 14** | **161 s** | 549 s |
| 06 | 13 | 10 / 13 | 500 s | 901 s |
| 12 | 11 | **6 / 11** | 618 s | 901 s |
| 18 | 12 | **8 / 12** | **679 s** | 904 s |

**The probe costs 4.2× more at 18Z than at 00Z and hits its own 900 s ceiling.** And the truncation is
visible in the data it leaves behind:

| hour | views recorded per sweep (of 45) |
|---:|---:|
| 00 | **45.0** |
| 06 | 43.2 |
| 12 | 31.0 |
| 18 | **26.9** |

⭐ **At 18Z the sweep records 60 % of the boards and dies.** So the history is not merely *sampled* at
four hours — at the busy hours it is **truncated mid-sweep**, and the missing observations are missing
for a reason correlated with what is being measured.

⛔ **Therefore: do NOT add a fifth slot in the degraded band.** It would add **~11 minutes of query time
at the worst hour of the day** to an instance whose binding constraint is disk IO — the exact opposite
of focus.md PRIORITY 3's lever (*cut work, never raise a timeout*) — and on this evidence it would
**probably time out anyway**, buying a truncated sample at maximum cost. ⚠ **The cheap way to measure
the bad hour does not exist; that is the finding, not an oversight.**

## 2. ⛔ REFUTED — my own hypothesis that R50's RANKING is biased

Having found the truncation, the natural escalation is: *if late-in-order boards are dropped more often
at busy hours, then boards have different hour mixes, and R50's ranking compares unlike things.* **I
tested it and it is false.**

Across all **45** boards, the share of each board's samples drawn from 00Z spans only **36 %–46 %**
(mean 42.6 %). That is close to uniform.

✅ **So R50's ORDERING is broadly sound. It is the LEVELS that are understated**, exactly as the 0235Z
filing said — and no further. ⚠ **The 0235Z filing did not make the ranking claim, and this is why:
the test came back negative.** Recorded so the stronger version does not get invented later from the
truncation fact alone.

⭐ **One residual, small and in the unflattering direction:** the *slowest* boards have the *lowest* 00Z
share (`allday_scarcity_board` 36 %, `candy_pack_market` 37 %) and faster ones the highest
(`topshot_set_squeeze_board` 46 %). So if anything the **fast-looking boards are the more understated**.
⚠ **A 10-point spread is too small to rank on** — stated as a direction, not a correction.

## 3. What survives from both filings

- ✅ The hour gradient is real and paired-controlled (296 pairs, 92.2 % slower at 18Z).
- ✅ R50's levels are understated; `allday_scarcity_board` at **169 s p50 at 18Z** is confirmed as the
  highest-value target.
- ✅ R50's ordering is sound.
- ⛔ The band cannot be cheaply instrumented, so **R6's owed degraded-band re-measure still needs a live
  reading taken inside 16:20–18:05Z** — by something that is already paying that cost, not a new probe.
- ⭐ **And the probe's own success rate is a free, already-collected saturation signal nobody is
  reading**: 14/14 at 00Z against 6/11 at 12Z, from a table that exists.

## 4. Revert path

Docs only.
