# Sentry went dark at 2026-08-18T13:21:59Z — and the burst in the hour before it is 86% R19, which was fixed today

**Filed:** 2026-08-23 ~12:30 PT (19:30Z) · **By:** Claude Code, interactive · **Status:** MEASURED. Attribution still needs the operator; the CAUSE HYPOTHESIS is now narrow and falsifiable.

The standing filing had this as *"Sentry is dark, cause unknown — needs the operator's Stats page"*, with three
candidate causes (org quota · spike protection · per-DSN rate limit / deactivated key) and no way to choose.
This narrows it without the Stats page.

## 1. The stop time is a MINUTE, not "recently"

| window | error events |
|---|---:|
| last 24 h | **0** |
| last 14 d | **5,221** |
| **last event Sentry ever received** | **`2026-08-18T13:21:59Z`** |

Five days of continuous zero. ⚠ **This alone kills SPIKE PROTECTION**, which suppresses for the remainder of a
period and then recovers — it does not hold a project down for five days.

## 2. There WAS a burst, and it is 5.7× the prevailing rate

| window (2026-08-18) | events | rate |
|---|---:|---|
| 09:21–12:21 (3 h before) | 471 | **~157 / h** |
| **12:21–13:21 (final hour)** | **902** | **~902 / h** |

**The final hour carried 17% of everything Sentry received in 14 days.**

⚠ **This is the discriminator.** A **deactivated key or a configured per-DSN rate limit is a CONFIG CHANGE — it
has no reason to coincide with a 5.7× traffic spike.** An abrupt permanent stop *at the peak of a burst* is what
**quota exhaustion** looks like. Quota is now the leading hypothesis and the other two are disfavoured on
evidence rather than on preference.

## 3. 🚨 The burst is the defect that was fixed TODAY

Composition of the final hour:

| title | count | share |
|---|---:|---:|
| `edition detail unavailable: rpc get_edition_detail timed out after 45000ms` | 470 | 52% |
| `team detail unavailable: canceling statement due to statement timeout` | 117 | 13% |
| `set editions unavailable: canceling statement due to statement timeout` | 73 | 8% |
| `player detail unavailable: rpc get_player_detail timed out after 45000ms` | 57 | 6% |
| `team detail unavailable: rpc get_team_detail timed out after 45000ms` | 56 | 6% |
| **total — all R19** | **773** | **86%** |

**Every one of the top five is R19's unbounded entity detail/section throw**, and **all five are now bounded**
(`f2076b31`, `b601f6f4`, closed 2026-08-23). The edition page's `generateMetadata` throw — the single biggest
contributor — last occurred **2026-08-23T00:48Z** and has not recurred in ~18 h.

## What to do, and the falsifiable prediction

1. **Operator, one visit, two readings** (unchanged and still owed — the Sentry MCP has no stats/usage/quota
   tool, verified): **Stats/Usage** (accepted vs dropped, and the DROP REASON) and **Settings → Client Keys**
   (is the single key still enabled?).
2. ⚠ **PREDICTION, so this is falsifiable:** if the cause is quota, **ingest resumes on its own at the billing
   reset with no code change** — and the volume that returns should be **dramatically lower than 157/h**,
   because the five titles that made up 86% of the burst are fixed. **If ingest does NOT resume at the reset,
   quota is refuted and the key/rate-limit branch is the remaining one.**
3. ⛔ **Do NOT fire `update_dsn` blind** — it mutates the production reporter on an unconfirmed diagnosis and
   destroys the attribution. (A prior session declined this for the same reason; it still stands.)

⚠ **NOT established:** that the quota was exhausted. I cannot see accepted-vs-dropped from here. What is
established is the stop minute, the burst, the burst's composition, and that spike protection is ruled out by
duration.

---

## RE-CHECKED 2026-08-23 ~14:56 PT (21:56Z) — day 6, still zero, and two inferences replaced with measurements

**Still dark.** `search_events(dataset='errors', period='24h')` returns **no results** — 0 events in the
trailing 24 h, unchanged. That is now **six consecutive days** since `2026-08-18T13:21:59Z`.

**The DSN was not deleted — measured, not inferred.** `find_dsns` returns exactly one client key
(`Default`) for `rip-packs-city/javascript-nextjs`, and it is still there. This filing had ruled a
config change out on a *reasoning* argument ("a deactivated key has no reason to coincide with a 5.7×
spike"); one of the three config candidates is now eliminated by a direct read instead. ⚠ The response
shape does not carry `isActive` or a rate limit, so **deactivation and a per-DSN rate limit remain
unmeasured** — do not read this as clearing them.

🚨 **"Needs the operator's Stats page" is now VERIFIED, not assumed — and that matters, because it is the
thing this filing has been waiting on.** I searched the Sentry MCP tool catalogue for the outcomes
instrument (`organization stats outcomes quota usage rate limited dropped`): **there is no stats/outcomes
tool exposed**, and the org has **exactly one project**, so the cross-project discriminator does not exist
either. The accepted-vs-`rate_limited`-vs-`dropped` split — the one reading that separates *"the SDK stopped
sending"* from *"Sentry received and discarded"* — is genuinely unreachable from here.

**So the open question is unchanged and the path to it is now known to be operator-only:**
Settings → Subscription → **Usage / Stats**, look at the **outcomes** for 2026-08-18 13:21Z onward.
- `rate_limited` / `dropped` climbing → **quota**, and it resumes at the billing reset.
- Nothing arriving at all → the SDK or the DSN, and the burst coincidence was chance.

⚠ **The falsifiable prediction is NOT yet testable and should not be scored as pending-confirmed.** It says
capture resumes at the billing reset; six days in, no reset boundary is known to have been crossed. **Record
the billing anniversary when the operator reads the Stats page** — without it the prediction has no date to
be wrong on, which is how a prediction quietly becomes unfalsifiable.
