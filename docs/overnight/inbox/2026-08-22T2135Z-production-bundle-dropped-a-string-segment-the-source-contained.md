# The production bundle rendered a user-facing sentence that the committed source does not contain — a `+`-joined template literal lost the tail of its first chunk

**Filed 2026-08-22 ~21:35Z (14:35 PT), Claude Code interactive.** Found while verifying the D12b fix in a real browser, which is the only reason it was caught at all.

## What was measured

The D12b disclosure was written as three template literals joined with `+`:

```ts
export const TS_ORDERBOOK_RETIRED_BODY =
  `The Top Shot orderbook sampler was switched off on ${TS_LISTINGS_RETIRED_ON} and its last row was ` +
  `written on ${TS_LISTINGS_LAST_ROW_ON}, so no depth is shown here rather than a figure derived from ` +
  `a single stale row. Live Top Shot ask data is on the Sniper deal feed.`
```

Production rendered:

> "The Top Shot orderbook sampler was switched off on 2026-05-26**written on** 2026-05-15, so no depth is shown here…"

**`" and its last row was "` — the text after the FIRST template's last interpolation — is gone.** Everything else survived, including the second template's own post-interpolation tail.

## Why this is a build defect and not a source mistake

Each step was checked rather than assumed:

- The committed source contains the phrase: `git show origin/main:lib/analytics/ts-listings-retired.ts | grep -c 'and its last row was'` → **1**. Same for the deployed commit `e0f3186d`.
- Only one commit has ever touched that file, so no concurrent session edited it.
- **The served JS chunk itself is wrong.** Grepping the chunk the browser actually loaded returns `"...switched off on 2026-05-26written on 2026-05-15..."`. The date constants are **inlined as literals**, so the bundler constant-folded the concatenation — and dropped one quasi while folding.
- Project bundler, from the deployment metadata: **`"bundler": "turbopack"`**.

⚠ **No source-level test could have caught this.** vitest evaluates the module directly and gets the correct string; `tsc` is clean. The defect exists only in the built artifact. It was found by a **real-browser render check of production**, which is the only instrument that sees it.

## Fixed

`lib/analytics/ts-listings-retired.ts` now holds **one** template literal on one line, with a comment saying why it must not be re-split.

## What is NOT established — read this before acting

⚠ **The generalization is UNVERIFIED.** One instance is measured. It does **not** follow that every `+`-joined template literal is corrupted; the fold may depend on the chunk, the bundle target, or the specific shape.

A structural scan of `app`, `components`, `lib`, `workers` (excluding tests) finds **28 sites** with the at-risk shape — a template literal carrying text *after* its final `${}`, joined by `+` to another template. Each would lose exactly that tail if the same fold applies. Notable, with the text that would vanish:

- `app/(analytics)/analytics/wallets/[address]/page.tsx:83` — `" on Flowty NFT lending (historical archive). "` (page **description** metadata)
- `app/(analytics)/analytics/wallets/[address]/page.tsx:149` — `" (marketplace closed May 2026). "` (JSON-LD **Dataset** description)
- `app/api/cron/alerts-send/route.ts:113` — `" from Rip Packs City\n"` (**outbound alert copy**)
- `app/api/cron/stale-fmv-monitor/route.ts:211,222` — `" min). "`
- `app/api/cron/data-integrity/route.ts:202-204` — `", "`, `"%, "`, `"h, "`
- `app/api/cron/pinnacle-events-ingest/route.ts:200` — `" — non-JSON response from worker URL; "`

⚠ **An attempt to confirm the wallet-page instance was INCONCLUSIVE, not negative** — `/analytics/wallets/0x020bd0f0ff4ac966` served the ROOT metadata description, so `generateMetadata` did not produce the custom string on that request and the concatenation was never exercised. **Do not read that as evidence the other sites are fine.** Server routes are also bundled differently from the client chunk where this was measured, so the server-side sites need their own check.

## Recommended next step

1. **Verify, do not assume.** Pick 2–3 of the 28 whose output is observable (the wallet-page `<meta>`/JSON-LD is the cheapest, on an address that actually has loan rows so the branch runs) and grep the rendered output for the at-risk tail.
2. If it reproduces, the cheap blanket fix is a lint rule banning `+`-joined template literals in favour of one literal — **and every one of the 28 needs re-checking, including alert copy that goes to users**.
3. If it does not reproduce, narrow the trigger before writing any rule; a ban justified by one unreproduced instance is the "cost stated with no number in it" shape.

⚠ **Whatever the outcome, the durable lesson stands on its own: a green `tsc`, a green unit suite and a READY deploy together do not establish that the string a user reads is the string in the repo.** Only rendering production does.

---

## RESOLVED 2026-08-22 ~23:1xZ — THE GENERALIZATION DOES NOT HOLD. Do not write the lint rule.

**Answered by step 3, not step 1.** Production could not be rendered from this sandbox at all (the egress
proxy 403s CONNECT to `www.rippackscity.com` as well as to `*.supabase.co`, so `curl` returns `000` for a
healthy and a broken page alike — a null instrument). So the trigger was narrowed analytically instead, and
that turned out to be **decisive rather than second-best**.

### The precondition the at-risk list never applied

The bundler dropped a quasi while **CONSTANT-FOLDING**. Folding a `+`-joined chain into a single literal
requires **every** interpolation in the chain to be a compile-time constant. The D12b site qualified — both
`TS_LISTINGS_RETIRED_ON` and `TS_LISTINGS_LAST_ROW_ON` are module-level **string-literal `const`s**, which
is exactly why the served chunk showed the dates **inlined**. ⚠ **A template carrying a runtime
interpolation cannot be folded at all**, so it cannot lose a quasi to this mechanism.

### Measured across `app`, `components`, `lib`, `workers` (tests excluded)

- **42** at-risk-*shaped* concatenations (a template with text after its final `${}`, `+`-joined to another).
  This walk finds more than the original 28 — a looser regex over the same roots, **not a disagreement**.
- **CONSTANT-FOLDABLE: 0.** Every one carries at least one runtime interpolation.
- The 8 whose interpolations are *all* bare identifiers (the only shape that could fold via an imported
  const) were then checked individually: each mixes in a runtime local — `inserted`, `id`, `startHeight`,
  `staleMinutes`, `parTotal`, `processed`, `fromBlock`. **One runtime value blocks the fold.**

### ⚠ The positive control, because a null result without one is worthless

The same detector was run against the **pre-fix** source recovered from git (`e0f3186dc:lib/analytics/
ts-listings-retired.ts`). It flags that site as **CONSTANT-FOLDABLE**, naming both interpolated constants.
**So "0 foldable sites today" is a measurement, not a broken detector.**

### What this means for the recommendations above

- ⛔ **Do NOT ship the blanket lint rule (step 2).** It would be justified by exactly the shape this repo
  warns about — a cost with no number in it — and it would ban 42 sites to prevent a defect that **none**
  of them can exhibit.
- ✅ **The named worries are specifically clear**, and this is the reassuring half: `alerts-send/route.ts:113`
  (outbound alert copy), the wallet-page `description` and JSON-LD, `stale-fmv-monitor`, `data-integrity`,
  `pinnacle-events-ingest` — all interpolate runtime values, so **no user-facing string among them can lose
  its tail this way.** The INCONCLUSIVE wallet-page probe no longer needs re-running.
- ⚠ **What is NOT established:** that turbopack's constant-fold is correct in general. **One real fold, one
  dropped quasi** — the bug is real, and the only reason it is contained is that nothing else in the tree
  currently meets its precondition. **A future constant-only `+`-joined template would hit it again**, which
  is why the guard below is a ban at population zero rather than a cleanup.
- ⚠ **Scope of the sweep:** `app`, `components`, `lib`, `workers`. `supabase/functions/**` and `scripts/**`
  were **not** walked — unmeasured, not clean.

**The durable lesson at the bottom of this filing stands unchanged and is the part worth keeping:** a green
`tsc`, a green unit suite and a READY deploy do not establish that the string a user reads is the string in
the repo.

## ADDENDUM 2026-08-22 19:58 PT (2026-08-23 02:58Z) — the at-risk population re-derived, and it is **0**, not 28

**Re-derived rather than quoted, per this file's own "Recommended next step".** Walked `app`,
`components`, `lib`, `workers` (tests excluded) for `+`-joined template chains:

| population | count |
|---|---|
| `+`-joined template **chains** | **60** |
| …whose first template carries text **after its last `${}`** (the shape that lost text) | **51** |
| …whose interpolations are **all bare identifiers** | **9** |
| …where every such identifier resolves to a **module-level string literal or an import** | **0** |

**The narrowing hypothesis, stated so it can be falsified.** The confirmed instance was
`` `…switched off on ${TS_LISTINGS_RETIRED_ON} and its last row was ` + … ``, where **both**
interpolations were module-level `const … = "2026-05-26"` string literals. The filing itself records
that "the date constants are **inlined as literals**, so the bundler constant-folded the
concatenation — and dropped one quasi while folding." **Constant folding is the step that dropped the
text; a chain with even one runtime interpolation is never folded, so it never enters that code
path.** On that hypothesis the at-risk precondition is *all interpolations compile-time constant*,
and **no site in the repo currently satisfies it** — the only one that did is the one already fixed.

⚠ **This narrows the population; it does NOT confirm the mechanism.** The hypothesis is inferred from
one instance plus how folding works in general, not from a reproduction. Two things would overturn it:

- a site with a **runtime** interpolation observed losing its tail in a served chunk;
- a folding path that fires on **partially** constant chains.

⚠ **And the scan has a known blind spot, stated rather than left implicit:** it only recognises *bare
identifiers* as constants. `${CONFIG.name}` or `${A + B}` over constant operands would be foldable
and my scan classifies them as runtime. The 9 all-bare-identifier chains were checked individually
and none resolve to literals; the remaining 51 were **not** hand-audited for constant member
expressions.

**Consequence for the recommended next step:** step 2's "cheap blanket fix — a lint rule banning
`+`-joined template literals" would today rewrite **51 sites to prevent 0 measured instances**. That
is the "cost stated with no number in it" shape this file warns about, pointed at itself. Better
targeting, if a rule is wanted at all: ban the `+`-join **only where every interpolation is a
compile-time constant** — a rule that is satisfiable at a population of zero and fires exactly on the
precondition that produced the one real defect.

⚠ **The file's durable lesson is untouched by any of this** and remains the reason to keep it: a
green `tsc`, a green unit suite and a READY deploy do not establish that the string a user reads is
the string in the repo. Only rendering production does.
