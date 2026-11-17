# `refresh_atlas_pack_ev()` writes a fabricated `total_unopened = 0`, and `pack_ev_latest` reads that as SOLD OUT — so **no row this function writes can ever be published as +EV**

*Claude Code on Trevor's box, 2026-09-07 14:35 PT. READ-ONLY diagnosis; **deliberately not shipped**, with the cost of shipping it measured below. Found while diagnosing the empty pack-reality board (`2026-09-07T1603Z`).*


> ✅ **RESOLVED 2026-09-07 ~17:4x PT — SHIPPED as migration `20260908003056` (Claude Code on Trevor's box). Read this box before acting on anything below it.**
>
> This filing said to take it with #65's pool repopulation because that was another session's live lane. **That lane shipped overnight 09-06/07**, the estate had no `.lock` and no `FREEZE.md`, so the coordination reason had lapsed and the fix was taken exactly as specified below.
>
> ⚠ **The numbers here were STALE BY THREE HOURS AND THE DEFECT WAS GROWING** — re-derived before shipping: **573** rows at `total_unopened = 0`, not 333, still zero of them positive. The rest of the diagnosis held exactly, including that `pd` is already joined and carries real supply on 57 of 57.
>
> **Verified on the PRODUCTION writer, split on the change point** rather than by re-reading a total: the 23:25Z and 00:25Z pg_cron ticks each wrote **42 fabricated `(0, NULL)` pairs**; the post-fix run wrote **0**, with 42 rows carrying real supply and the 15 failure-branch rows still on their documented `0 / 100` sentinel.
>
> ⚠ **One trap this filing could not have predicted, recorded so the next reader does not re-open it:** `pack_ev_latest` still shows **15** atlas rows at `total_unopened = 0` with `depletion_pct` NULL, which reads exactly like the defect surviving. It is not — the view NULLs `gross_ev` / `depletion_pct` / `fmv_coverage_pct` when `gross_ev = 0 AND edition_count = 0` (the sentinel shape) while passing `total_unopened` through RAW. **That apparent defect signature is an artifact of reading a masked column beside an unmasked one.**
>
> **The cheap-pickup spec here was accurate and its cost estimate was right** — the pin work was the bulk of it. Its closing ⭐ recommendation, that the repoint must ADD a `total_unopened` assertion or the fix ships with the same silence that hid the defect, was followed: four assertions running in opposite directions, two new fixtures (`D-SOLDOUT`, `D-NOSUPPLY`), and a negative control proving **all four RED on the old body** while both must-not-move controls stay green. Register: **#65**. Ledger: 2026-09-07.

---

## The defect

`refresh_atlas_pack_ev()` (pg_cron jobid 217 `rpc-atlas-pack-ev`, hourly) carefully computes `is_positive_ev` — the snapshot migration `20260816050000` documents **eight** honesty properties protecting that one boolean, because it is *"the single boolean a collector reads as 'buying this pack is worth it'"*.

Then its **success-branch** `INSERT` hardcodes two supply columns:

```sql
… fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
VALUES (…,  (ev->>'fmv_coverage_pct')::smallint,
            LEAST((ev->>'edition_count')::int, 32767),
            0,      -- total_unopened   ← fabricated
            NULL,   -- depletion_pct    ← unknown
            v_now);
```

`pack_ev_latest` then overrides the flag the function just computed:

```sql
WHEN h.total_unopened IS NOT NULL AND h.total_unopened <= 0
     OR h.depletion_pct IS NOT NULL AND h.depletion_pct >= 100  THEN false
ELSE h.is_positive_ev
```

The view's rule is correct — *a sold-out pack cannot be +EV*. The writer feeds it a **fabricated `0` meaning "I did not compute this"**, and the view reads it as **"sold out"**. This is the `?? 0` shape CLAUDE.md names, one table apart: an unknown published as a measured zero, with a downstream consumer acting on it.

⚠ **The eight documented honesty properties do NOT cover this.** Property 4 documents `depletion_pct = 100` on the **failure** branch and that is deliberate. The success branch's `total_unopened = 0` is undocumented, and it defeats properties 1–3 for every row.

## Measured, live

| | |
|---|---|
| Top Shot rows in `pack_ev_latest` | 1,210 |
| rows with `total_unopened = 0` (this writer's) | **333** |
| …of those, `is_positive_ev = true` | **0** |
| rows with `total_unopened IS NULL` (other writers) | 100 |
| …of those, `is_positive_ev = true` | **12** |

**333 rows, zero of them ever publishable as +EV.** The 12 that are come from writers that leave the column NULL.

**The data is already in the row the function joins.** `pack_distributions` (joined as `pd` in the cursor) carries `total_minted / total_opened / total_sealed / depletion_pct`, and for all **57/57** Atlas-walked dists every one is populated and fresh (`updated_at` 2026-09-07 12:13Z). `total_sealed > 0` for **57 of 57** — so the fabricated `0` is not merely unknown, it is *wrong* on every row.

## ⛔ Why this is filed and not shipped — the counterfactual is ZERO

Substituting the real supply and re-running the MV's full predicate over the 57 Atlas dists:

| clause | surviving |
|---|---|
| walked dists with history | 57 |
| fresh < 48 h | 57 |
| priced | 56 |
| **`gross_ev > pack_price`** | **0** |
| real `total_sealed > 0` | 57 |
| real `depletion_pct < 90` | 8 |
| `fmv_coverage_pct >= 40` | 42 |
| **would appear on the board** | **0** |

**Not one Atlas-walked pack currently has `gross_ev > pack_price`, so fixing this changes nothing a user sees today.** It is a *latent* correctness bug: it guarantees the +EV board stays empty for this lane **even when a genuinely +EV pack appears**. It bites exactly when the pack pool is repopulated — see `2026-09-07T1603Z`, where the `atlas` pool is a 57-distribution seed last refreshed 2026-07-17 against 767 + 1,161 frozen `gql` dists.

➡ **The right time to take this is as part of the pool repopulation (#65), which is another session's live lane** — the two changes are only worth verifying together, because that is when the flag can first be true.

## The fix, specified so it is a cheap pickup

Two columns in the **success branch only** (leave the failure branch's `0 / 100` exactly as property 4 documents):

```sql
-- add to the cursor SELECT (pd is ALREADY joined):
       pd.total_sealed, pd.depletion_pct
-- then in the success INSERT, replace the literals:
       r.total_sealed,            -- was 0
       r.depletion_pct            -- was NULL
```

⚠ **Cost of shipping it, measured — this is not a two-line change:**

- `supabase/tests/refresh_atlas_pack_ev.sql` (455 lines) embeds the function **byte-identical** under a `>>> BEGIN verbatim … >>>` banner, referenced by md5 `acbe79769403d75542bf17f1550959a9`, and `__tests__/db-invariants-drift-guard.test.ts` **fails CI on drift**. The embedded copy and the md5 must move in lockstep.
- The snapshot migration `20260816050000` carries the same verbatim body and its own md5 line.
- ⚠ The pin's fixture (`public.__ev_fixture`, and its `pack_distributions` rows) must gain `total_sealed` / `depletion_pct` values or the new reads resolve to NULL and the test proves nothing — **a column-level fixture audit, per the repo's own rule for repointing a DB pin.**
- `total_unopened` is currently asserted **nowhere** in that pin; `depletion_pct` is asserted only on the failure branch (`D-FAIL` → `0/NULL/false/100`), which this change does not touch. ⭐ **So the repoint should ADD an assertion that the success branch carries real supply** — otherwise the fix ships with the same silence that hid the defect.

## Falsifier

If a row written by `refresh_atlas_pack_ev()` is ever observed with `is_positive_ev = true` in `pack_ev_latest` while `total_unopened = 0`, the mechanism described here is wrong. (Measured today: 333 such rows, 0 positive.)
