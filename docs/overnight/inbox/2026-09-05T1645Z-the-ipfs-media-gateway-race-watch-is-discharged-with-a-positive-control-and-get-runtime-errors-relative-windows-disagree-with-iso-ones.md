# ✅ The `ipfs-media` gateway-race watch is DISCHARGED — 90% fewer timeouts at matched hours, with a positive control that rules out "the upstream just recovered"

**Filed 2026-09-05 09:45 PT (16:45Z), Claude Code (Trevor's box, interactive). MEASUREMENT ONLY — nothing shipped.** Discharges the watch left by the 2026-09-05 night-pass handoff: *"the 188/24h `ipfs-media body timeout` count should drop materially now ipfs.io is no longer the sole upstream."*

---

## 1. The result, on a matched-hours control

⚠ **The first comparison I ran was confounded and is not the one below.** Comparing the post-fix window against the *overnight* window immediately before it showed only 1.88/h → 1.71/h — a 9% change — because **overnight traffic is lower, so fewer requests produce fewer timeouts regardless.** Comparing a full day against a partial one has the same defect in the other direction.

**The honest comparison is the same hours of the day, on adjacent days**, both specified as explicit ISO ranges:

| window (UTC) | events | rate |
|---|---:|---:|
| **09-04 08:05 → 16:50** (pre-fix) | **154** | **17.6/h** |
| **09-05 08:05 → 16:50** (post-fix) | **15** | **1.71/h** |

**A 90% reduction — 10.3×.**

## 2. ⭐ The positive control, which is what makes this a discharge rather than a coincidence

⛔ **A self-resolving upstream incident produces exactly the same count signature**, and the deploy sits on the boundary between a bad day and a clean one. Counts alone cannot separate the two.

**What separates them is WHICH gateway now answers.** The route logs its winner on the success leg, and over the whole post-fix window every single served request reads:

```
[ipfs-media] ok cid=… gateway=ipfs.dapperlabs.com … elapsedMs=52 … 1210
```

**100% `ipfs.dapperlabs.com`. Not one `ipfs.io` — the pre-fix sole upstream — and not one `gateway.pinata.cloud`.** Elapsed times are **52–1,210 ms**, against a 12,000 ms body timeout.

👉 **So the mechanism is confirmed, not merely correlated: the race changed the upstream that serves, and the new winner is one to two orders of magnitude faster.** An upstream that "just recovered" would have shown `ipfs.io` winning.

⚠ **One honest limit on that sample.** These are Top Shot CIDs, which are Dapper-pinned — the same sampling bias that made an earlier static gateway *ranking* wrong and broke every UFC image until it was caught. **That bias is exactly why the RACE is the right design and a ranking was not:** for a UFC CID, `ipfs.dapperlabs.com` 403s in 0.3–0.5 s and a different gateway wins, with no table for anyone to get wrong. **This filing does not claim Dapper is fastest for everything — only that racing works.**

---

## 2b. 🚨 An instrument defect found while measuring this, and it affects every error-surface number in this repo

**`get_runtime_errors` returns different counts for the same window depending on whether `since` is RELATIVE or an explicit ISO timestamp.** Reproduced twice, same route, minutes apart:

| call | count |
|---|---:|
| `since: "24h"` | **139** |
| `since: "2026-09-04T16:45:00Z"` (the same instant) | **44** |
| `since: "12h"` | 20 |
| `since: "2026-09-05T04:50:00Z"` (the same instant) | 20 |

⭐ **The ISO form is internally consistent and ADDITIVE** — the two sub-windows either side of the deploy return 29 and 15, which sum to exactly the 44 above. **The relative form at 24h does not reconcile with anything**: it is not the lifetime count either (that is 300 since 09-03T00:00). At 12h the two forms agree exactly, so this is not a blanket relative-vs-ISO bug.

⛔ **The cause is NOT established and this filing does not guess at one.** The operational rule is what matters:

👉 **When the number matters, pass an explicit ISO `since`/`until`. Never quote a figure taken with a relative lookback, and never subtract two windows specified differently.**

⚠ **Consequence for existing records:** any "N events in 24h" figure in this repo's history taken with `since: "24h"` may be inflated — including ones I wrote earlier today. The DEP0169 discharge is unaffected (it used an explicit ISO window), and the edition-page figures in inbox `2026-09-05T1626Z` were used only to establish that the counts are *small*, a conclusion an inflated number cannot break.

---

## 3. Falsifiers

1. **§1** — repeat with matched hours on the next pair of days, ISO ranges only. If the post-fix rate climbs back toward 17/h, the improvement was the upstream, not the race.
2. **§2** — grep the success leg for `gateway=`. If `ipfs.io` reappears as the dominant winner while timeouts stay low, the race is no longer the explanation.
3. **§2b** — re-run the four calls in the table. If they now agree, the discrepancy was transient and this section should be struck.

⚠ Dated samples on a live upstream. Re-derive before quoting.
