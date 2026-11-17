# 🚨 SETTLED — Sentry is not broken, misconfigured, or blocked. The ORG ERROR QUOTA is exhausted, and one already-tracked signature burned it

**Filed:** 2026-08-25 ~22:25 PT (2026-08-26 05:25Z) · **By:** Claude (Cowork cloud), interactive
**Closes the diagnosis half of:** known-issues **#38** · inbox [2026-08-23T0250Z](2026-08-23T0250Z-sentry-has-received-nothing-since-08-18-while-production-throws-the-same-error-hundreds-of-times-a-day.md) · [2026-08-23T1930Z](2026-08-23T1930Z-sentry-went-dark-at-a-precise-minute-and-the-burst-before-it-is-the-defect-fixed-today.md) · [2026-08-26T0100Z](2026-08-26T0100Z-sentry-is-dark-on-day-seven-and-the-monitor-reads-the-silence-as-health.md)
**Status:** cause PROVEN by direct measurement · one half shipped as a patch (not pushed) · the other half is operator-only

## 1. The measurement, and it is a single request

The prior filings named quota as the *leading hypothesis* and recorded that it could not be
tested, because *"the sandbox gets the agent proxy's 403, not Sentry's"*.

⛔ **That premise is FALSE and it is the reason this sat open for seven days.** Sentry's ingest
host **is** reachable from the Cowork cloud container. One POST of a minimal envelope at the
production DSN answers:

```
HTTP/2 429
retry-after: 60
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
{"detail":"Sentry dropped data due to a quota or internal rate limit being reached."}
```

**`organization:error_usage_exceeded`.** Sentry is up, the DSN is valid, the key is active, the
SDK is fine, egress is fine. The org has run out of error quota and is dropping everything.

⚠ **Controls, both directions, because a 429 alone would not have been conclusive:**
- **Positive control on reachability + auth:** the same endpoint with an EMPTY body answers
  `400 {"detail":"empty request body"}` — i.e. the request reached Sentry and the `sentry_key`
  was accepted. A blocked host or a dead key cannot produce that.
- **Negative control on the app:** every one of the 8 unresolved issues reads `Last seen: 7 days
  ago`. Not one runtime, not one route — **everything** stopped at the same moment. That is a
  property of the receiving end, not of any emitter.
- ⚠ **No fake issue was created.** A 429 is a drop; the probe event was never ingested.

ⓘ **Method note worth keeping:** this test costs one `curl` and settles a class of question
("is the collector receiving?") that no amount of reading our own code can. **When an
observability pipeline goes dark, probe the COLLECTOR before auditing the emitters.** Three
filings audited emitters.

## 2. What burned the quota — and why raising it alone does not fix anything

The burn is **one already-tracked degradation**. From the bounded comment in
`app/(collections)/[collection]/edition/[slug]/page.tsx`, measured over the 7 days to 2026-08-23:

> `"edition detail unavailable: rpc get_edition_detail timed out after 45000ms"` threw
> **15,388 times across 2,963 distinct users**.

One error. One week. And the sibling shapes on set / player / team / series pages are the same
family. Sentry's own issue list corroborates: `JAVASCRIPT-NEXTJS-26` alone carries **2,872
events**, and the visible 14-day total is **5,142** — a total that stops dead on 08-18 because
that is when acceptance stopped.

⭐ **So the ratio is the finding: a single known-broken RPC can consume an entire monthly error
budget in about two days.** Raise the quota and the next quota goes the same way. **The durable
half is a bound on how much of a finite shared budget any one signature may take.**

## 3. What shipped (patch written, NOT pushed — this session has no git push)

`lib/observability/sentry-quota-guard.ts` + wiring into all three LIVE inits
(`sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts`).

⚠ **Measured first: the repo has NO `beforeSend`, NO `sampleRate`, NO `ignoreErrors` and NO
`denyUrls` anywhere.** A repo-wide grep returns only three boilerplate *comments*. Everything
Sentry has ever been sent was unfiltered and unsampled.

The guard samples the RPC-deadline signature at **1 in 20** and passes everything else at 100%.
Three properties keep it honest, and each is pinned by a test whose mutation was **run**, not
asserted:

1. **DEFAULT IS SEND.** Only listed signatures are sampled; an unrecognised error is never
   dropped at any random draw. *(Mutating the default to drop reds 3 tests.)*
2. **EVERY KEPT EVENT CARRIES ITS OWN RATE** (`sentry_sample_rate`, `sentry_sampled_signature`),
   so an issue count can be read back to an incidence instead of being quietly wrong by 20x.
   *(Removing the tag reds 1 test.)*
3. **THE DROPS STAY COUNTED** — returning null from `beforeSend` makes the SDK file a client
   report with reason `before_send`, which appears in Sentry's Dropped stats. The true volume
   stays observable; it just stops costing quota.

ⓘ It also sets `environment` and `release` on the three live inits. Those were previously set
**only** in `sentry.client.config.ts`, which production's turbopack build never bundles
([2026-08-24T1510Z](2026-08-24T1510Z-there-are-two-client-sentry-inits-and-which-one-wins-depends-on-the-bundler.md)) — so **no event on any runtime has ever been attributable to a deploy**.
⛔ **Session replay was deliberately NOT added** while the quota is the binding constraint; that
filing's own warning stands and now has a measured reason behind it.

## 4. ⛔ Operator-only, and it is now a decision rather than an investigation

**Trevor:** Sentry → Settings → Subscription. The org is over its error quota. Either raise the
plan / enable an on-demand budget, or accept the drop until the period rolls. ⚠ **Do this
*with* the guard above, not instead of it** — §2 is the reason.

⚠ **And a second, cheaper operator lever if the plan is not to be changed:** the DSN's own
`rateLimitWindow`/`rateLimitCount` can bound per-key intake. That protects the org budget from a
single project but does **not** distinguish signatures, so it would thin novel errors along with
the storm. The `beforeSend` guard is strictly better; the DSN limit is a blunt fallback.

## 5. What this does NOT fix, stated so it is not read as closed

- **The RPC timeouts themselves are untouched.** `get_edition_detail` and its siblings still
  exceed 45 s. This filing stops them blinding us; it does not make them stop.
- ⚠ **The `2026-08-26T0100Z` observation stands and is now sharper:** the monitor reads Sentry's
  silence as health. A collector that has been dropping for 7 days looks identical to a quiet
  week. **Nothing watches "Sentry accepted an event recently"** — and after this filing the
  quota is a KNOWN recurring failure mode, so that arm is worth building.
