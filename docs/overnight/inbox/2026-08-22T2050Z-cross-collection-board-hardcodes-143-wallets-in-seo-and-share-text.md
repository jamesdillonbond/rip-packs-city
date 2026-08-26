# The cross-collection board hardcodes "143 wallets" in its SEO description and in the text users share — the true count is 221

**Filed 2026-08-22 ~20:50Z (13:50 PT), Claude Code interactive.** Found while closing R22.

## What

Four hardcoded occurrences of the cohort size, none of them read from the data:

- `app/insights/cross-collection/layout.tsx` — `description`, `openGraph.description`, `twitter.description` (3 sites)
- `app/insights/cross-collection/CrossCollectionBoardClient.tsx` — the **share string** the user copies/tweets

All four say **"143 wallets hold 3+ Flow collections"**.

## Why it is wrong, and by how much

Measured directly after the R22 refresh, `select count(*) from cross_collection_cohort_mat` = **221**. Before the refresh it was **179**. So the published figure is **35% low** against today's data, and it was already 20% low against the frozen 08-17 data. The cohort is a live population that grew 42 wallets in the five days the board was stale — a hardcoded count cannot track it and will drift further every week.

⚠ Note the number is **not** merely stale-by-a-refresh: 143 does not match 179 (08-17) or 221 (today), so it predates both and has been wrong for an unknown but long period.

## Why it is worth fixing rather than filing and forgetting

- The three metadata sites are in the **indexed** SEO description — the claim is what search engines carry.
- ⚠ **The share string is the worst of the four.** The board's whole funnel purpose is that a collector broadcasts it; the product hands them a false number and they publish it **under their own name**. That is the same class as the honesty canon's "a false claim about the reader's own account", one step removed.
- The rendered board itself is honest — it reads `cohort_total` from the mat and stamps its own age. So the page and its own metadata disagree, which is the "fix per PANEL, not per page" shape again: the board was hardened, its metadata was not.

## Recommended fix — and the trap in the obvious one

⚠ **Do NOT simply re-bake the current number.** 221 will be wrong next week for exactly the reason 143 is wrong now. Two honest options:

1. **Make it dynamic** via `generateMetadata()` reading `count(*)` from `cross_collection_cohort_mat` (221 rows — a trivial read). ⚠ It must degrade honestly: if the read fails, emit the **count-free** phrasing, never `?? 0` and never a baked fallback. A failed read publishing "0 wallets hold 3+ Flow collections" would be a new instance of the top defect class.
2. **Drop the count** from all four strings ("Wallets that hold 3+ Flow collections — cohort distribution, top wallets, TS set overlap"). Cannot go stale, loses a little SEO specificity. **Cheapest correct fix; prefer this if (1) is not wanted.**

Whichever is chosen, the share string and the metadata must be changed **together** — the copy-paste spread is already 4 sites from 1, which is the documented pattern.

## Refuted if

A dynamic source already exists and these strings are dead code. **Checked: they are not** — `layout.tsx` is the live route layout and the share string is rendered by the board client.

## Sweep the class, do not fix the row

⚠ **Grep the EXPRESSION, not the file.** Other `/insights/*` layouts may bake live population counts into metadata the same way. This filing covers only the cross-collection board because that is where it was found; the class check has **not** been run.

---

## ✅ SHIPPED 2026-08-25 (Claude Code, interactive) — option 1, plus the class sweep this filing asked for

All four sites now READ the cohort size. `readCrossCollectionCohortSize()` returns `number | null`
and every consumer **drops the number** when it is null — never `?? 0`, which would publish
*"0 wallets hold 3+ Flow collections"* into an indexed description off a read that never happened.
Live count at ship time: **220**.

⭐ **The last section — *"Sweep the class, do not fix the row… the class check has NOT been run"* — is
the part that paid.** Run through the SHARED `strip-comments` module over 246 files it found a **fifth
site on an unrelated board**: `SqueezeBoardClient`'s Methodology read *"this affects 10 of the 8,859
editions that carry a live ask"*. Live: **12 of 2,944** — both numbers wrong, **denominator ~3× too
large**. It now counts the rows in hand and says so, and renders nothing when no row carries an ask.

⚠ **Five of six raw grep hits were COMMENTS** (prose about a measurement is documentation, not a
published claim), which is why the sweep strips first.

✅ **And a ratchet so the class cannot regrow**, since this spread 1 site → 4 by copy-paste:
`__tests__/insights-copy-has-no-baked-population-counts.test.ts` bans the shape at zero across
`app/insights` + `components`, with **suppression as the curated list** — exactly one exemption,
`/insights/page.tsx`'s *"all 125 editions"* of a **closed** print run, verified live at 125.
