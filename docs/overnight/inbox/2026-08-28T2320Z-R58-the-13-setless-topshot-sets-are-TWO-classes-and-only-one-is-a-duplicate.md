# R58 — the 13 setless Top Shot sets are TWO classes, and the register's "could be honest pre-seeds" is wrong for both

**2026-08-28 ~23:20Z · Claude Code · sampling R58 explicitly asked for before treating it as a defect**

R58 was filed **count-only** ("13 TS `sets` rows have zero backing editions … Could be honest pre-seeds;
sample the 13 before treating as defect"). Sampled. **Neither reading in the register survives**: they are
not pre-seeds, and they are not one phenomenon.

## Class A — 4 EXACT duplicates of a populated set (same name AND same series)

| setless row | `external_id` | series | populated twin's editions |
|---|---|---:|---:|
| Base Set | `set:base-set-s2` | 2 | **658** |
| Hustle and Show | `set:hustle-and-show-s2` | 2 | 23 |
| Rookie Revelation | `185` | 7 | 30 |
| WNBA Skyline | `auto_onchain_254` | 8 | 9 |

⚠ **THE SERIES QUALIFIER IS LOAD-BEARING AND MY FIRST QUERY GOT THIS WRONG.** Matching on NAME alone
reported *seven* populated "Base Set" rows and six "Hustle and Show" — because **Top Shot ships a Base Set
per series, so repeated names are CORRECT**. Only when `series` is included does the real claim appear:
exactly one populated twin each. **Do not re-derive this on name alone; it manufactures duplicates.**

## Class B — 9 rows whose names are PARSE ARTIFACTS, with no populated twin at all

Six are truncated mid-date-range — `Archive Set 1986-` · `Archive Set 2014-` · `Run It Back 1986-` ·
`Run It Back 2005-` · `Run It Back: Legacies 2014-` · `Run It Back: Origins 2014-` — every one ending on a
bare hyphen. Three carry **trailing whitespace** — `The Champion's Path ` · `WNBA ` · `WNBA Archive Set `.

⭐ **All nine share one signature: `external_id = auto_<md5>`, `series` NULL, `set_id_onchain` NULL, and
`created_at` = 2026-04-17 — one batch, one day.** The md5 is over the NAME, so a name that was mis-parsed
produced a *stable but wrong* key, and the row can never reconcile against an on-chain set. `The Champion's
Path ` is the proof: a populated `The Champion's Path` (48 editions) exists and differs **only by the
trailing space**.

## What is and is not established

- ✅ These are **not** honest pre-seeds. A pre-seed would carry a real key; these carry a hash of a broken
  string, and 4 of 13 duplicate a set we already hold populated.
- ✅ The **SEO exposure is smaller than R58 implies.** `lib/sitemap-data.ts` emits no `/set/` URLs at all
  (checked), so these pages are not advertised to crawlers; reachability is via the sets index only.
- ✅ The set page itself is **already honest** — `app/(collections)/[collection]/set/[slug]/page.tsx`
  separates "read failed" from "genuinely empty", omits `collectionEntityJsonLd` when the editions read
  failed rather than publishing `numberOfItems: 0`, and gates the tier-mix on `editionsOk`. **Whatever is
  wrong here, it is not the honesty canon** — do not re-file it as such.
- ⛔ **NOT established: what produced the 04-17 batch.** Nothing in this sample identifies the writer. The
  hyphen truncation and trailing spaces are consistent with a name-splitting step, but that is a
  HYPOTHESIS, not a measurement — find the writer before designing a fix.
- ⛔ **NOT established: that the count is stable at 13.** This is one dated sample; nothing watches it.

## Why nothing was shipped

**The fix is destructive SQL (deleting or merging `sets` rows), which is on the autonomous-pass
off-limits list.** It also needs a decision the data cannot make: a legitimately-new on-chain set with no
editions yet is INDISTINGUISHABLE from Class A by row shape alone, so a blanket "delete setless sets"
rule would eventually delete a real one the day it is created.

⛔ **And do NOT reach for the tempting page-level mitigation** ("404 / noindex a setless set"): it would
have made `WNBA Skyline` a 404 on the day it was minted. Suppression must key on the Class-B signature
(`auto_<md5>` + NULL series + NULL `set_id_onchain`), not on emptiness.

**Suggested next step, in order:** (1) find the 04-17 writer; (2) merge Class A into its twin and delete
the 9 Class-B rows in one reviewed migration; (3) only then add a guard — and note that a DB-invariant pin
is push-gated, and that this session could not verify one because `db:pins:check` needs a service-role key
absent from the sandbox. **An unverifiable guard is worse than none.**
