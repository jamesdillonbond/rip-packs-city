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

## 2b. ⚠ An instrument defect found while measuring this — real and reproducible, but CONDITIONAL

**`get_runtime_errors` returns different counts for the same window depending on whether `since` is RELATIVE or an explicit ISO timestamp.** Reproduced twice, same route, minutes apart:

| call | count |
|---|---:|
| `since: "24h"` | **139** |
| `since: "2026-09-04T16:45:00Z"` (the same instant) | **44** |
| `since: "12h"` | 20 |
| `since: "2026-09-05T04:50:00Z"` (the same instant) | 20 |

⭐ **The ISO form is internally consistent and ADDITIVE** — the two sub-windows either side of the deploy return 29 and 15, which sum to exactly the 44 above. **The relative form at 24h does not reconcile with anything**: it is not the lifetime count either (that is 300 since 09-03T00:00).

🚨 **CORRECTED after filing — I checked whether it generalises and it DOES NOT, so the original scope claim (“affects every error-surface number in this repo”) was too strong.** Two controls:

| control | relative | ISO, same instant |
|---|---:|---:|
| same route, **12 h** | 20 | 20 — **agree** |
| **different route** (`/[collection]/edition/[slug]`), **24 h** | 7 / 2 / 1 | 7 / 2 / 1 — **agree** |

⚠ **So the disagreement is not a property of the relative form as such** — it is specific to this high-volume group at 24 h (300 lifetime events) and did not reproduce on a low-volume group over the same nominal window on the same day. A sampling/extrapolation path on large groups is the obvious suspect and is **explicitly NOT claimed**.

⛔ **The cause is NOT established and this filing does not guess at one.** The operational rule is what matters:

👉 **When the number matters, pass an explicit ISO `since`/`until`. Never quote a figure taken with a relative lookback, and never subtract two windows specified differently.**

✅ **Consequence for existing records — CHECKED, not assumed.** I re-measured my own figures from earlier today rather than leaving them caveated:

- **The edition-page counts in inbox `2026-09-05T1626Z` are CORRECT** — re-run with an explicit ISO window they return **7 / 2 / 1**, identical to the relative call. Nothing to amend there.
- **The DEP0169 discharge is unaffected** — it used an explicit ISO window throughout, and its positive control came from `pipeline_runs`, not from this tool.
- **The one figure that WAS affected is the `188/24h` baseline this filing set out to test**, which is why the discharge above is built on ISO windows and a mechanism, not on that number.

⭐ **The transferable point is the one that nearly slipped past me:** having found a real discrepancy, the temptation was to caveat every historical number and move on. **Checking whether it generalised took two calls and turned a broad, unfalsifiable warning into a narrow, testable one** — and incidentally confirmed the filing I had published an hour earlier.

---

## 🚨 CORRECTION, 2026-09-05 21:20Z — THE "90%" IS WRONG. Falsifier #1 fired, on my own re-check.

**§1's headline does not survive.** I ran this filing's own falsifier #1 (*"repeat with matched hours on the next pair of days"*) and got the opposite answer from a second window on the SAME pair of days:

| matched window | 09-04 | 09-05 | direction |
|---|---:|---:|---|
| **08:05 → 16:50** (8.75 h) — the one §1 used | 154 (17.6/h) | 15 (1.71/h) | **90% better** |
| **16:50 → 21:14** (4.4 h) — the one §1 did not use | 18 (4.09/h) | **58 (13.2/h)** | **223% WORSE** |

⛔ **Two matched-hours windows, same two days, same method, OPPOSITE SIGNS.** Whichever you pick is the answer you report, and §1 picked the flattering one — not deliberately, but that is exactly why the result is worthless as stated.

### Why: the series is BURST-dominated, and a rate cannot describe it

Today's events arrive in tight clusters with long silences: **26 events inside ~3 minutes** (16:50–16:52:43), then nothing for over three hours, then **32 events between 20:00 and 20:45:51**, then nothing for ~29 minutes. 09-04 is bursty too — **154 of its 194 daily events fall inside that one 8.75 h window**. ⚠ **A matched-hours control is standard good practice and it was NOT sufficient here**: it corrects for time-of-day traffic, and it does nothing about bursts that land in one window and not the other.

### The only summary that does not depend on window choice

| | events | per hour |
|---|---:|---:|
| **09-04, full day** | **194** | 8.08 |
| **09-05, 00:00 → 21:14 (21.2 h)** | **84** | **3.96** |

⇒ **≈ 51% fewer, not 90%.** ⚠ And even that is soft: 09-05 contains ~8 h of pre-fix time, and both days are burst-dominated, so **the honest statement is a RANGE and a direction, not a percentage.**

### ✅ What still stands, and it is the part that mattered

⭐ **§2's positive control is untouched: 100% of post-fix served requests come from `ipfs.dapperlabs.com`, not one from `ipfs.io`, at 52–1,210 ms.** The race demonstrably changed which upstream serves. **The MECHANISM claim holds; only the MAGNITUDE was overstated** — which is the third time today a magnitude of mine has moved while its mechanism survived.

### ⚠ Not established — two candidates for the bursts, neither claimed

1. **Deploy-driven cold cache.** Today saw an unusual number of production pushes (mine and a second session's); a deploy invalidates the edge cache and produces a wave of cold IPFS fetches — the documented cold-cache-miss class. The 20:00–20:45 burst does coincide with four of my own pushes. ⚠ **Suggestive only:** those four builds all show `CANCELED`, and the 16:50 burst PRECEDES the CSP deploy rather than following it.
2. **Upstream (gateway) hiccups**, which the race mitigates but cannot eliminate.

👉 **The right instrument for this is not another rate: it is per-event timestamps or a burst count.** Until then, treat any "N per hour" figure on this route — including the ones above — as a description of the window it came from.

## 3. Falsifiers

1. **§1** — repeat with matched hours on the next pair of days, ISO ranges only. If the post-fix rate climbs back toward 17/h, the improvement was the upstream, not the race.
2. **§2** — grep the success leg for `gateway=`. If `ipfs.io` reappears as the dominant winner while timeouts stay low, the race is no longer the explanation.
3. **§2b** — re-run the four calls in the table. If they now agree, the discrepancy was transient and this section should be struck.

⚠ Dated samples on a live upstream. Re-derive before quoting.
