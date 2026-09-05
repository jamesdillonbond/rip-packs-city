# The upstream cause of the fabricated-empty is now COUNTED — 197 sites, of which 28 can reach a reader, and the hit rate inside those is about 1 in 9

**Filed 2026-09-05 05:55Z (2026-09-04 22:50 PT) · Claude Code on Trevor's box, interactive · MEASUREMENT, nothing shipped from it — ⛔ the population is NOT bulk-fixable and the spot-check is what shows why**

Filed after fixing a live instance (`/api/market-analytics`, ledger 2026-09-04: eight panels rendered "No data" for a query that had failed). CLAUDE.md's rule for this class is *"when you find one, grep for the EXPRESSION, not the file — it has spread by copy-paste five times now."* This is that grep, with denominators.

## The expression, and the two spellings

`?? []` on a supabase result is the shape CLAUDE.md names. But the wrapper form is only half of it, and it turns out to be the drained half:

**Spelling A — `<x>.data ?? []` where `<x>.error` is never read anywhere in the file: 5 sites.**
Four are the OG entity cards (`d.data ?? null` in `og/player|series|set|team`), which fall through to a **generic card** — understating, the safe direction. The fifth is an admin route resolving to `null`. ⭐ **This spelling is effectively drained**, which is what the fix above closed.

**Spelling B — `const { data } = await <supabase read>`, destructuring `data` and NOT `error`: 197 sites across 86 files.**
This is the upstream cause: supabase-js **RETURNS** errors, so this discards the only failure signal *at the point it is produced*. Everything downstream then works from a `null` that cannot be told from an empty result.

## ⛔ 197 is not a defect count, and the narrowing matters more than the number

Most of those are writes, backfills, cron and indexers, where a discarded error does not become a claim to a reader. Restricting to **GET-only, non-job API routes** — the surface where a null can be rendered — gives **17 routes / 28 sites**:

```
 6  app/api/support-chat/context        1  app/api/analytics/top-buyers
 3  app/api/profile/trophy-case/pdf     1  app/api/badges
 2  app/api/analytics/insider/signals   1  app/api/edition-stats
 2  app/api/analytics                   1  app/api/fast-break/uses
 2  app/api/golazos-sniper-feed         1  app/api/og/edition
 2  app/api/recent-sales                1  app/api/pack-listings/historical-pulls
 1  app/api/acquisition-stats           1  app/api/profile/collection-breakdown
 1  app/api/profile/market-pulse        1  app/api/public/special-serial-owners
 1  app/api/rewards/summary
```

## 🚨 And even THAT list is not a to-do list — the spot-check is the point

Three sites read at filing time, and they land in three different places:

| site | what a failed read actually does | verdict |
|---|---|---|
| `recent-sales:55` — `const { data: editionRow } = await q.maybeSingle()` | the edition-slug filter is silently **not applied**, so the panel returns **UNFILTERED recent sales** in place of the requested edition's | 🚨 **worse than an empty list** — it is the wrong data, presented as the right data |
| `recent-sales:95` — `fmvRows` hydration | prices are simply absent from the rows | ⚠ understates; honest by omission |
| `badges:200` — `syncData` last-synced stamp | the freshness stamp is absent | ⚠ understates; honest by omission |

**⚠ CORRECTED after a larger sample the same evening — it is closer to 1 in 9, and that STRENGTHENS the conclusion.** The three sites above gave "1 in 3"; reading the whole of `app/api/support-chat/context` (the largest single entry on the list, 6 sites) added **six more with ZERO defects**. That file is honest *by construction*: every branch that makes a claim requires a POSITIVE value to fire, so a failed read produces **silence**, not a false statement —

```ts
const { deals_below_20, deals_below_30, total_tracked } = pulse?.[0] ?? {};
if (deals_below_30 && deals_below_30 > 0) { … }        // a failed read fires nothing
```

⭐ **That is the pattern worth copying, and it is why the destructure alone is not the defect.** Discarding `error` is only dangerous where a null can still REACH a claim. Sample so far: **9 sites read, 1 real false claim** — and the severities are not comparable, since that one produced a *wrong* answer while the others produce a *quieter* one. ⛔ **So this cannot be swept.** A mechanical "add `error` to every destructure" pass would touch 197 sites to fix perhaps a third of 28, and would have to invent an error policy per call site to do it — exactly the shape that ships a defect while reading as hardening. The same argument the complement ratchet's header already makes about bounding.

⚠ ~~**`recent-sales:55` is the one worth doing next**~~ — ✅ **FIXED the same evening (ledger 2026-09-04), and my framing here was WRONG.** I called it an undecided behaviour question. It was already decided: the SAME FILE, ten lines above, forbids exactly this shape for the sibling `collectionId` parameter (*"the response looks authoritative. That is a fabricated-data shape. Return empty instead."*). I had read past that comment while writing this filing. A failed lookup now returns an honest error; a lookup that succeeded and matched nothing returns an empty list, matching that precedent.

## Why this is filed rather than ratcheted

A ratchet on spelling B would freeze a 197-number whose defect rate is ~1-in-3 **inside a hand-picked subset** — it would read as 197 outstanding defects and drive exactly the sweep this filing argues against. The honest instrument here is the per-surface guards that already exist (`collection-analytics-failed-vs-empty-guard`, the server-page error-vs-absent guard, the OG ban), each of which pins the CLAIM a surface makes rather than the spelling upstream of it.

## Re-derive

```bash
# spelling B, whole tree
rg -n 'const \{\s*data(\s*:\s*\w+)?\s*\} = await' app lib components --type ts --type tsx | wc -l
```
⚠ Strip comments first — several files quote this exact shape in prose explaining why they do NOT use it.
