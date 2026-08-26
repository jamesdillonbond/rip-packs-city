# Sentry without paying: Vercel already covers the **server** half for free — and the residual gap is client-side, not server-side

**Filed 2026-08-26 (PT) by Claude Code.** Trevor's decision: **do not raise the Sentry
subscription.** That is consistent with the roadmap's *no infra spend pre-revenue* line,
so this filing answers the question that follows — **what does that actually cost us, and
what can be done for nothing?**

---

## 1. ⭐ We are not blind. Vercel's runtime-error aggregation is free and already running

`get_runtime_errors` returns **grouped error clusters** — signature, occurrence count,
affected routes, first/last seen, and sample stack traces with digests — **50 groups over
7 days**, with no quota and no plan change. It has been working the entire time Sentry has
been dark, and it is how everything in this filing was measured.

**For server-side errors this covers most of what Sentry was giving us.** The top clusters
in the last 7 days:

| cluster | 7d events |
|---|---:|
| `Vercel Runtime Timeout Error: Task timed out after 300s/800s/30s` | **24,027** |
| `Timed out acquiring connection from connection pool` (all routes combined) | **~18,600** |
| `rpc <fn> timed out after 45000ms with no response` (all surfaces) | ~10,000 |
| `canceling statement due to statement timeout` (all surfaces) | ~10,000 |

⚠ **Counts only.** `get_runtime_errors`' `users=` and `routes=` fields are documented in
`tooling-gotchas.md` as **untrustworthy** — attribution is smeared across unrelated paths
(measured 2026-08-21). No user-impact figure is claimed from this source anywhere in this
filing, deliberately.

## 2. ⛔ THE RESIDUAL GAP IS CLIENT-SIDE, and it is real

**Vercel only sees server execution.** A browser-side failure — a React render crash, a
hydration mismatch, a client fetch that dies — never reaches it.

Checked rather than assumed: **there is no non-Sentry client-error capture in the repo.**
No `window.onerror`, no `unhandledrejection` handler, no client logging endpoint. The only
paths are `app/global-error.tsx` and the per-collection `error.tsx`, and both report by
calling `Sentry.captureException`.

⭐ **So while Sentry is dark, client-side errors are captured by NOTHING.** That matters
here specifically because this repo has already been bitten by a browser-only class —
`React #418` hydration from reading a clock during render — which by construction never
appears in a server log. **That is the honest cost of the decision, and it is worth
knowing rather than discovering.**

## 3. ✅ SHIPPED — the quota guard now covers the largest THROWN class it was missing

The guard sampled exactly one signature (`rpc-deadline`, 1-in-20). Rebuilt the sizing from
Vercel (since Sentry cannot report on itself), restricted to errors that are actually
**thrown** — a `console.error` line never becomes a Sentry event, so raw log counts would
overstate this badly:

```
team detail unavailable: canceling statement due to statement timeout … 2,460 / 7d
set editions unavailable: canceling statement due to statement timeout  1,358 / 7d
```

**≈3,818 in 7 days ≈ 16,400/month from one signature the guard did not cover** — on its
own several times a 5,000/month quota. Added `pg-statement-timeout` at the same 1-in-20.

⚠ **Deliberately NOT added: `Timed out acquiring connection from connection pool`.** It is
the single largest class, and the guard's existing negative control asserts it is *not*
sampled. That is correct and should stay: a pool-acquire failure and a statement timeout
are **different faults with different fixes**, and the pool one is the symptom of the
saturation everything else is downstream of. Sampling it would make the loudest signal
about the platform's actual bottleneck quieter.

## 4. ✅ SHIPPED — `global-error` no longer tells users a human has seen it

`app/global-error.tsx` rendered:

> *"An unexpected error occurred. **Our team has been notified.**"*

**That sentence has been false since 2026-08-18**, and it will stay false. `captureException`
runs, the event is accepted with a `200`, and it is dropped.

⭐ **And the test that existed to protect this sentence could not see it.** It pinned the
implication *claim ⇒ capture-called*, on the reasoning that the capture is "the only thing
making it true". **That is right about the code and wrong about the world: no test can
observe whether the report is STORED.** The capture fired on every one of those users and
the suite stayed green for eight days.

Fixed by dropping the claim — the old test's own comment anticipated this, noting that
removing the sentence "is a fix, not a regression". New copy matches the sibling boundary,
which already had the right voice: **"We logged it — trying again often works."** A claim
about us, not about a third party.

The test is **inverted, not deleted**: it still pins the capture (worth doing if the
collector recovers) and now pins the **absence** of a delivery promise, matched on the
property rather than one spelling. ⭐ **Proven in both directions** before shipping — the
old copy and two synonym rewordings all red it; the new copy and the sibling's copy do not.

## 5. 👉 What is left, and none of it costs money

- **The quota resets on Sentry's billing cycle.** When it does, the guard now keeps the two
  largest thrown classes at 1-in-20 instead of full rate. Whether that is enough to stay
  under a 5,000/month ceiling is **not yet measurable** — it needs one post-reset week.
- ⚠ **Nothing watches "did Sentry store anything recently".** A collector that has been
  dropping for eight days looks exactly like a quiet week, and that is how this went
  unnoticed. An arm on **stored**, not on `200`, is the follow-up — and it is free, because
  the check is a search of the last accepted event, not a paid feature.
- **The real lever remains cutting query cost.** Every one of the top clusters is a timeout,
  and timeouts are the saturation. Today's covering index (91% off the serial-board CTE) and
  the `rwfc` fast path are worth more to this error board than any amount of Sentry quota
  would be — **an error tracker that can see the fire is not a fire extinguisher.**

---

## 6. ⛔ The watchdog is blocked on a CREDENTIAL, not on money — and it was probed, not assumed

The follow-up in §5 ("nothing watches whether Sentry STORED anything") needs Sentry's
read API. Checked what exists rather than assuming:

- **`.env.local` has no `SENTRY_AUTH_TOKEN`** — the variable is documented in
  `.env.example` (alongside `SENTRY_ORG` / `SENTRY_PROJECT`) but is not set locally.
- **`.env.sentry-build-plugin` DOES carry one**, and that file is correctly gitignored
  (`.gitignore:95`).
- ⚠ **But it is upload-scoped.** Probed with three real requests rather than a
  `[ -n "$VAR" ]` presence check, per the repo's rule that *a credential can be present
  and dead*:

  ```
  ERR 403  organizations/<org>/projects/
  ERR 403  projects/<org>/<project>/
  ERR 403  projects/<org>/<project>/issues/?statsPeriod=14d&limit=1
  ```

  It authenticates for source-map upload and **has no read scope**, which is correct
  least-privilege for a build token and useless for monitoring.

👉 **The watchdog needs a read-scoped Sentry token (`project:read` / `org:read`).** That
is **free** — an auth token, not a plan change — and is the only thing standing between
here and an arm that would have caught this on day one instead of day eight. Small
operator step, deliberately not pursued further here since it is a credential decision.

⛔ **And there is no client-side substitute, checked:** the condition "Sentry accepted and
then dropped" is invisible from our side — the envelope endpoint returns **`200` with no
rate-limit header** in exactly the state where nothing is stored, which is precisely why
the earlier probe in this session read as success. **Only Sentry's own read API can
distinguish stored from dropped**, so there is no way to build this arm without that token.
