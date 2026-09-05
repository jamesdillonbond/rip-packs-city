# The `entity-smoke` `/moment/` flake is NOT a soft-404 and NOT a slow cold render — 0 reproductions in 28 attempts, two hypotheses tested and one refuted

*Claude Code, Trevor's box · MEASUREMENT + a refutation, nothing shipped · 2026-09-05 04:00 PT*

## What was seen

Running `e2e/entity-smoke.spec.ts` against production five times while validating an unrelated change, **two runs went red on two different pre-existing assertions**, neither of them an image check:

```
run 1: /laliga-golazos/edition/407 is missing expected content /View edition on Dapper/i
run 2: /moment/0632adf8-4a00-49e7-a581-170a4012f454 rendered only 25 chars (likely an empty shell)
runs 3,4,5: 8 passed
```

⚠ **This is filed because a flaky gate is a real problem, not a cosmetic one.** CLAUDE.md's own rule: *"a permanently-red or permanently-zero instrument is indistinguishable from a broken one at a glance."* An intermittently-red one is worse — it trains readers to re-run instead of to look, and the `E2E DOM Smoke` badge is the **entire** client-side detection surface on this platform.

## What was measured — 28 probes, 0 reproductions

| probe | n | result |
|---|---|---|
| The exact failing URL, warm, fresh browser context each time | 8 | **8/8 healthy**, 2,061 chars, 456–459 DOM nodes |
| **Random** moment ids straight from the DB (so each render is COLD) | 8 | **8/8 healthy**, `x-vercel-cache: MISS`, DCL 0.9–2.2 s, 2,069–2,464 chars |
| `/moment/` and `/pinnacle/moment/` URLs sampled across the SITEMAP | 12 | **12/12 healthy**, 1,371–3,119 chars |

⚠ The DB ids were chosen with `abs(hashtext(id)) % 997 = 13` rather than `LIMIT 8` — an unordered `LIMIT` is physical order, not a sample, and physical order would have clustered on recently-written rows that are most likely to be warm.

⭐ **The cold column is the one that matters.** The repo's standing rule is to test *"does a COLD pass exceed the budget"*, never *"is the page OK now"*. Cold passes hit content in **0.9–2.2 s** against the helper's `HYDRATION_SETTLE_MS = 1_500` measured after `load`, with every sample landing 10× above the 200-char floor.

## ⛔ Hypothesis REFUTED: a soft 404 rendering an empty shell at 200

The obvious mechanism, and it is recorded in memory as a real shape on this codebase — *"`notFound()` = soft 404 when streaming: with `loading.tsx` it returns 200"*. If the sitemap advertised a moment id that no longer resolves, the page would render a ~25-char shell **at HTTP 200** and the smoke would be right to call it an empty shell.

**Tested directly — and the route behaves correctly:**

```
/moment/00000000-0000-4000-8000-000000000000  ->  404 in 0.44s
/moment/not-a-uuid                            ->  404 in 0.38s
```

**Both are hard 404s.** So an unresolvable moment cannot produce a 200-with-empty-body, and the sitemap-serves-a-dead-id theory does not explain it.

## ⚠ What this does NOT establish

⛔ **It is not established that the flake is harmless.** 0 in 28 bounds the rate loosely — at a true 3% rate, P(0 in 28) ≈ 0.42, so this sample cannot distinguish "gone" from "a few percent". **Do not close this on the strength of the zeros above.**

⛔ **And no fix should be attempted on the strength of a mechanism nobody has observed.** The tempting change is to make the content assertion POLL up to a bound instead of reading once after the settle, which would convert "slow" into "passes". That is defensible *if* the cause is a slow stream — and the cold-render numbers above are evidence against exactly that. **A plausible mechanism is not a measurement**, and weakening the only client-side gate on an unconfirmed hypothesis is the wrong direction for a guard whose failure mode is silence.

## What would actually settle it

The failure message already carries the two facts needed (`path`, `chars`), but not the ones that discriminate: **`x-vercel-cache`, the HTTP status, and whether the content arrived a moment later.** Capturing those *at failure time* — rather than re-probing minutes afterwards, warm, from a different network — is the cheap next step, and it is a change to the assertion's **reporting**, not to its threshold.

ⓘ The sibling failure (`/laliga-golazos/edition/407` missing the Dapper CTA) is likely a different and more tractable question: `entity-smoke`'s header records that `edition_golazos` exists as a separate arm *because* it is "the only instrument in the repo that can see the edition page's outbound Dapper CTA". A missing CTA on one Golazos edition may be data (that edition genuinely has no Dapper link) rather than breakage — **check the row before touching the assertion.**
