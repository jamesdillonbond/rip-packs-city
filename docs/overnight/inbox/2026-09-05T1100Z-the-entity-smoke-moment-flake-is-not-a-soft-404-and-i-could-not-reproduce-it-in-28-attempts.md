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

---

## ADDENDUM, same session — the SECOND hypothesis is refuted too, and the "check the row first" advice above is now DISCHARGED

The filing closed by suggesting the sibling failure (`/laliga-golazos/edition/407` missing the Dapper CTA) was probably **data** — that edition genuinely having no Dapper link — and said to *"check the row before touching the assertion."* Checked. **It is not data.**

**The CTA's two gates, read from source:**

```ts
const dapperEditionUrl = marketClosed ? null : dapperMarketEditionUrl(collection, detail.external_id)
// dapperMarketEditionUrl returns null unless:
//   · the collection is in DAPPER_MARKET_EDITION_SEG  { laliga-golazos, nfl-all-day }
//   · external_id is present
//   · external_id is PURELY NUMERIC  ( /^[0-9]+$/ )
```

**Both gates measured, not argued:**

| gate | result |
|---|---|
| `isMarketClosed("laliga-golazos")` | **false** — `CLOSED_MARKETS` holds only `ufc` / `ufc-strike` |
| Golazos editions with a null external_id | **0** of 575 |
| Golazos editions with a NON-numeric external_id | **0** of 575 |
| **Golazos editions that would legitimately hide the CTA** | **0 of 575 — 0.00%** |

**And the page itself, probed directly:** `/laliga-golazos/edition/407` (the exact URL that failed) plus two others, three loads each — **9 of 9 rendered the CTA**, on both the cold pass (`x-vercel-cache: MISS`) and the warm one, with a real `dapper.market` href present in the DOM each time.

## Where that leaves it

⛔ **Both plausible mechanisms are now refuted by measurement, and neither flake reproduces.** 37 probes across the two failures:

- `/moment/` empty shell — **0 of 28**; the soft-404-at-200 mechanism is refuted (`/moment/<bogus-uuid>` hard-404s in 0.4 s).
- Golazos missing CTA — **0 of 9**, plus a 0-of-575 population check that rules the data explanation out entirely.

⭐ **So the remaining explanation is a TRANSIENT** — a cold function instance, a momentary saturation spell, or a render that lost a race — and that is a claim about the environment, not about either page. ⚠ **It is also the explanation that is hardest to falsify, which is exactly why it should not be asserted confidently.** What is established is narrower and worth stating plainly: **the two specific defects a reader would reach for first are both ruled out, so do not spend the time re-deriving them.**

⛔ **Still do not "fix" this by loosening either assertion.** Both assert real, always-present properties: every Golazos edition page carries a Dapper CTA (0 of 575 exceptions), and a moment page renders 1,371–3,119 chars (0 of 28 exceptions). **An assertion that is right about the world and occasionally loses a race is a REPORTING problem, not a threshold problem** — the fix is to capture `x-vercel-cache`, the HTTP status and a re-read AT FAILURE TIME, so the next occurrence arrives with the evidence attached instead of sending someone on this same 37-probe walk.

---

## ✅ RESOLVED, same session — and the advice in the two sections above was WRONG

**Both flakes were one defect in the HARNESS, and it is fixed.** `assertHealthyPage` navigated with `waitUntil: "domcontentloaded"` and read the body **immediately**; the `waitForLoadState("load")` and the 1.5 s hydration settle ran **after** the content assertions. For a streaming App Router route DCL fires when the SHELL has parsed, so the assertion measured how fast the server flushed rather than whether the page works.

**Reproduced by reading at exactly the helper's moment** — same page, three times:

```
chars@DCL = 2061   chars@settle = 2061
chars@DCL =   25   chars@settle = 2061   <-- the smoke failed here
chars@DCL = 2061   chars@settle = 2061
```

**25 is the same number the failing run reported.** The Golazos CTA failure is the same cause: the read arrived before the content.

## ⛔ Two things this filing told the next reader, both wrong

1. **"The remaining explanation is a TRANSIENT."** It was not. It was deterministic given the timing, and reproducible in three attempts once the probe stopped waiting.
2. **"Do not 'fix' it by making the content assertion POLL — that converts slow into passing."** ⛔ **That argument was built on a wrong model of the code.** It assumed the settle already ran before the read. It did not. The fix *is* to read after the wait, and it is not a loosening — `EMPTY_SHELL`, a page that never fills, still fails, and that pair is now pinned by fixtures.

⭐ **The lesson worth keeping is about the 37 probes, not the fix.** Every earlier probe here waited for `load` and a settle before reading — **differing from the harness in the ONE dimension that decides the answer.** The repo's rule about a probe whose harness differs from production applies to investigations *of the harness* too, and the 0-of-37 result read as "cannot reproduce" when it actually meant "not measuring the same thing."

Shipped with a fixture whose content arrives 400 ms after DCL (must PASS), `EMPTY_SHELL` unchanged (must FAIL), and a mutation that restores the old ordering and reds the new fixture. Live: entity smoke 6 runs, 6 clean.
