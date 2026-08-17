# ⛔ The concierge is TWO faults stacked. Topping up fixes the newer one and leaves a ~94% failure rate in place.

> ⛔ **SUPERSEDED 2026-08-17 00:1xZ — DO NOT ACT ON THIS. DO NOT TOP UP THE KEY.** Measured by a Claude Code
> interactive session: the concierge **answers real requests right now** (`session_id=probe-verify-001`,
> `category='fmv'`, `is_smoke_test=false`, HTTP 200 with a genuine tool-informed answer, 00:11:58Z).
>
> **Layer 2 is not a fault:** `support-chat` throws `buildSyntheticError()` into the same catch block that
> emits `[sc_err]`, so the smoke check's synthetic 403 is **byte-identical** to a real Anthropic 403. The
> logs cannot discriminate; every sampled line maps 1:1 (same second) to a `smoke-degradation-<ts>` row.
>
> **Layer 1 is not a fault either:** the 48 healthy 09:08Z answers are **32 `general` + 16 `shopping`, ALL
> `is_smoke_test=true`** — the smoke suite's *daily live-answer probe*. The "94%" is the ratio of two smoke
> checks' **cadences**, not a success rate. This document's own falsifier ("healthy rows at minutes other
> than 09:08") is **already answered at 00:11, with no top-up**.
>
> **What survives and is genuinely good:** the minute-of-day method, and the honest scope note
> (`is_smoke_test=false` on 0 of 1,132 — the refutation, printed under the headline). Slice by the flag that
> separates our own traffic from the world's **before** slicing by time. See the 2026-08-16 ledger entry
> "THE CONCIERGE IS HEALTHY — DO NOT TOP UP THE KEY".

Cowork **cloud** session, 2026-08-17 00:15Z / 17:15 PT. Read-only, nothing shipped.
**Confirms and then sharpens the 08-16 retraction — it does not contradict it.**

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally. **Commit as usual.**

## ✅ Layer 2 — confirmed independently, live right now

Vercel runtime logs, **5 of 5** `/api/support-chat` calls in a 15-minute window:
`status 403` · `mode credit_balance` · *"Your credit balance is too low to access the Anthropic API."* — every one returned **HTTP 200**, which is why every outside-in instrument reads healthy.

**The retraction was right. Fix = top up / raise the spend limit.** Boundary to the second: last healthy row **02:20:54.567Z**, first 403 **02:21:37Z** on 08-16.

## ⛔ Layer 1 — the older fault, which survives the top-up

The 08-16 note recorded the pre-exhaustion history as **"unexplained"**. It has a shape now, and the shape is a **schedule**.

Healthy responses by minute-of-day, trailing 18 days:

| minute (UTC) | healthy | unavailable |
|---|---:|---:|
| **09:08** | **48** | 16 |
| 00:01 · 02:20 · 00:05 | 1 each | 6 total |
| **every other minute** | **0** | **~1,110** |

By hour, **09Z is the only hour with a non-zero healthy count**; hours 00–08 and 11–23 each carry 11–94 unavailable and **zero** healthy.

**48 of 51 genuine LLM answers in eighteen days landed in one minute.** A credit block does not spare one minute a day for eighteen days.

⚠ **So the ~1,100 non-09:08 fallbacks may never have called Anthropic at all.** The fallback is a single canned string (`distinct_response_prefixes = 1`, avg 115 chars) vs 667–955 chars for real answers. Something upstream of the LLM call short-circuits almost all traffic; only the daily scheduled 09:08Z run gets through.

**Look at `concierge_ip_rate` first** — a per-IP limit produces exactly this shape (day's first probe succeeds, the rest fall back). Then the route's own guards/flags. ⚠ **Route code, not answerable from the DB** — next instrument is `app/api/support-chat/route.ts` plus Vercel logs for a **non-09:08** call, checking whether `[sc_err]` appears at all or whether the fallback fires with no Anthropic attempt logged.

## 👉 Why this matters tonight

**Topping up will not restore the concierge — it will restore it to ~3 working calls per day.**

Closing on "topped up, 200s are back" would look like a fix and leave an 18-day ~94% failure rate untouched, and the fallback's HTTP 200 guarantees nothing flags it. **Falsifier: after the top-up, check whether healthy rows appear at minutes OTHER than 09:08.** Cheap, and it is the whole test.

## Scope, bounded honestly

- **Zero real-user impact, measured:** `is_smoke_test = false` on **0 of 1,132** unavailable rows over 18 days. A broken instrument on a pre-launch surface — real, worth fixing, **not an emergency**.
- `category='concierge_unavailable'` first appears **2026-05-18**, so Layer 1 may be much older than the 18-day window I measured. **I did not test beyond 18 days.**
- Layer 1's cause is **NOT established**. Rate limiting is a hypothesis with a named table behind it, not a finding.

## Method note

The 08-16 pass reached "unexplained" from DB categories alone. What broke it open was the **minute-of-day** distribution — same table, one more `GROUP BY`. **A cause that looks random by day can be a schedule by minute; bucket a mystery by every time granularity you have before calling it unexplained.**
