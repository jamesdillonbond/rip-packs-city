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
