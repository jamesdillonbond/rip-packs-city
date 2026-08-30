# ⛔ R58 REFUTED — the 13 setless sets do not "render empty", they 404, and the real finding is 8 truncation artifacts

**Filed 2026-08-29 ~18:30 PT (2026-08-30 01:30Z). Status: MEASURED, PREMISE REFUTED, NO CODE
CHANGE WARRANTED. R58 was assigned to Claude Code and said "sample the 13 before treating as
defect" — this is that sample, and the sample overturned the row.**

## What R58 claimed

> **13 TS `sets` rows have zero backing editions** — their set pages render empty.
> Candidate fix: suppress/noindex setless set pages.

## What is actually true

⛔ **There are no such pages.** `get_set_detail` resolves a slug against **`sets_summary`**, and
`sets_summary` is built **entirely from `editions_unified`** — it never reads the `sets` table:

```
WITH slug_grouped AS (
  SELECT ... regexp_replace(lower(set_name), '[^a-z0-9]+', '-', 'g') AS set_slug ...
  FROM editions_unified WHERE set_name IS NOT NULL AND set_name <> ALL (ARRAY['Unknown',''])
) SELECT ... GROUP BY collection_id, set_slug;
```

So a `sets` row with zero editions **cannot produce a `sets_summary` row**, `get_set_detail`
returns NULL, and the route `notFound()`s.

**Verified by the real caller, with controls in both directions:**

| probe | result |
|---|---|
| `GET /nba-top-shot/set/archive-set-1986-` (setless) | **404**, `robots: noindex`, branded 404 page |
| `GET /nba-top-shot/set/wnba-skyline` (POSITIVE CONTROL) | **200**, real set page |
| `get_set_detail(ts,'archive-set-1986-')` · `'wnba'` | **NULL**, 0 `sets_summary` rows |
| `get_set_detail(ts,'base-set')` · `'the-champion-s-path'` (CONTROLS) | non-NULL, 1 summary row each |

⚠ **A trap in reading the fetch: the string "Bingo Bango Bongo" (the 404 copy) appears TWICE in
the 200 response too** — it ships in every page's RSC payload as the `notFound` fallback. Counting
it is not a 404 test; the HTTP status is.

✅ **Search already excludes them too**, and by construction rather than luck: `rpc_search_catalog`
computes `n` as editions matching **`e.set_id = s.id OR e.set_name = s.name`** and then filters
`WHERE n > 0`. These 13 have zero on both legs.

✅ **Referentially isolated:** the only FK to `public.sets` in the whole schema is
`editions.set_id`, and they have no editions.

## 🚨 The finding that IS there, and R58 did not name it: the names are CORRUPT

Splitting the 13 by provenance is what makes them legible:

**8 name-TRUNCATION artifacts** (no canonical counterpart, `auto_<md5>` external_id, all created
2026-04-17): `Archive Set 1986-` · `Archive Set 2014-` · `Run It Back 1986-` · `Run It Back 2005-` ·
`Run It Back: Legacies 2014-` · `Run It Back: Origins 2014-` · `WNBA ` · `WNBA Archive Set `.
⭐ **The season range is cut mid-string** — the real sets are "Archive Set 1986-87", "Run It Back
2005-06". Something split on a delimiter and kept the left half. These names appear **nowhere else
in the database**: zero rows in `editions.set_name` match them.

**5 DUPLICATES of a canonical set that has editions** — and the page is unharmed because
`sets_summary` groups by slug and matches editions by NAME:

| setless row | canonical rows sharing its slug | their editions |
|---|---|---|
| `Base Set` / `set:base-set-s2` | 7 | 236–1,218 each |
| `Hustle and Show` / `set:hustle-and-show-s2` | 6 | 20–69 |
| `Rookie Revelation` / `185` | 4 | 15–84 |
| `The Champion's Path ` (trailing space) / `auto_<md5>` | 1 | 48 |
| `WNBA Skyline` / `auto_onchain_254` | 1 | 9 |

⭐ **`Rookie Revelation`'s external_id is `185` and one canonical row has `set_id_onchain = 185`** —
it is a pre-canonical stub keyed by the on-chain id as a string.

## The ONE residual defect, and it is small

`get_set_detail`'s D20 rollup counts underlying `sets` rows by name **without requiring they have
editions**. For `wnba-skyline` that yields `underlying_set_count = 2` when only **1** underlying set
has editions — and the register records that the page "keys a merged-set banner on it being > 1".

⛔ **NOT ESTABLISHED: whether that banner actually renders.** A keyword scan of the live 200 response
for "merged" / "underlying" found nothing. Do not quote this as a visible defect until someone reads
the branch in `app/(collections)/[collection]/set/[slug]/page.tsx`.

⚠ **`the-champion-s-path` is NOT inflated (checked: `underlying_set_count = 1`)** — I expected it to
be, because the trailing-space row shares the slug. It is not, because D20 matches
`s.name = ANY(set_name_variants)` and the variants come from `editions.set_name`, which has no
trailing space. **The hypothesis was wrong and the control caught it.**

## ⛔ Why no code change was shipped

The only code fix is a one-predicate change to `get_set_detail` (count underlying sets **that have
editions**). That function is **pinned and registered**, so it is the three-file discipline —
pin + migration + the guard's registration row — and every `apply_migration` costs a ~10-20 s
window of user-facing `PGRST002` 500s. **Paying that for one cosmetic banner on a 9-edition page,
during a shared-CI window with a concurrent session shipping, is a bad trade on its own.** Batch it
into the next migration that has to happen anyway.

## 👉 What Trevor decides: the rows themselves

Deleting 13 referentially-isolated rows is destructive SQL, so it is not shipped autonomously.
⭐ **It would be durable, and that is measured, not assumed: no `auto_*` set row has been created in
60 days** (newest `auto_*` 2026-06-08; newest set overall **2026-08-28**), so the artifact-producing
path is dormant while ordinary set creation continues.

```sql
-- Exact, reviewable, and safe: only rows with zero editions, only the 13.
DELETE FROM public.sets s
 WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.set_id = s.id);
-- Revert: none needed for the 8 artifacts (they are unreachable). For the 5 duplicates the
-- canonical rows are untouched, so nothing user-facing changes either way.
```

⚠ **Also worth one line: 3 TS `sets` rows have `name <> btrim(name)`.** The ingest does not trim.
That is what created a second "The Champion's Path" row, and it will do it again.

## Three more facts from an independent code trace, two of them NEW

A subagent traced the reachability from the code side while I measured from the DB side. It
reached the same conclusion by a different route — `sets_summary` is a **materialized view** over
`editions_unified`, `layout.tsx:40` `notFound()`s before the first flush, and `generateStaticParams`
returns `[]` so every slug is ISR-on-demand. Three things it added:

1. ✅ **Set pages ARE in the sitemap — segment 3 — and that makes the refutation STRONGER, not weaker.**
   `lib/sitemap-data.ts:545-603` builds the `/set/` list from `slugifyName(editions.set_name)` over
   `getEditionRows()`, which reads only `editions`. **A `sets` row with zero editions can never
   produce a sitemap URL.** I had not established this either way; it is now established.
2. 🚨 **A LATENT honesty gap, unreachable for these 13 but real:** the set page's JSON-LD guard
   (`page.tsx:192-197`) omits the block when the editions read FAILED — its comment says exactly why
   (*"a failed read would hand a crawler a machine-readable 'this set holds no editions'"*) — but a
   **successful read returning zero rows still publishes `numberOfItems: 0`**. That is the third
   state again: failed · empty · ok. It cannot fire for these rows (the detail 404s first), but it
   can on any set that legitimately empties. **Filed here rather than fixed; it is not R58.**
3. ⚠ **`sets_summary` has NO `CREATE MATERIALIZED VIEW` anywhere in `supabase/migrations/`** — only
   `refresh_sets_summary()` (cron `50 7 * * *`). The definition quoted above was read live from
   `pg_matviews`. A load-bearing object for every set page exists only in the database.

⚠ **One number to correct before anyone quotes it:** the trace's prose says *"9 of the 13 hard-404"*
while its own table lists **8** non-resolving and 5 resolving. **8 + 5 = 13 is the right split**, and
it matches the DB-side count independently. The 9 is a slip.
## Register

R58 should move to **REFUTED (premise) / P3 residual**, with the exit condition restated: not
"suppress setless set pages" (they already 404) but "**`underlying_set_count` counts only sets with
editions**", batched. **Falsifier for the refutation:** any setless slug returning a 200.
