# The Panini "what this total is made of" disclosure annotates a DIFFERENT population than the KPI above it

**Filed:** 2026-09-20 ~10:09 AM PT (Cowork cloud, Trevor-directed pass). **READ-ONLY — nothing shipped.**
**Why filed rather than shipped:** the fix is a view change + a `.tsx` change and must land as ONE
migration burst (every `apply_migration` costs a ~10–20 s `PGRST002` window). Cowork cannot push
`.tsx`. Two concurrent sessions are committing to this tree every ~15 min — this is a proposal, not a
claim on the lane.

## 1. The defect — a denominator mismatch inside a published honesty disclosure

`PaniniSqueezeClient.tsx:329` headlines **`sealed_fmv_exposure_usd_hc`** (the broad+partial subset),
with the all-sets blend as the labelled secondary line. Correct, and deliberate.

`PaniniSqueezeClient.tsx:367-376` then prints *"**X%** of the sealed value above comes from **N**
editions priced from a single seller's asking price"* using **`pct_sealed_usd_from_asks_only`** and
**`editions_ask_only`**.

⛔ **Those two columns are computed over ALL SETS** (`panini_squeeze_totals`, migration
`20260919181331` — the `FILTER (WHERE fmv_confidence = 'ASK_ONLY')` carries no `coverage_flag`
predicate), while **"the sealed value above" is the hc subset.** The footnote describes a population
the number it annotates does not have.

**Measured live 2026-09-20 10:0x AM PT** (`panini_squeeze_board`, `fmv_usd IS NOT NULL`):

| figure | all sets (what the disclosure says) | **hc / broad+partial (what the KPI is)** |
|---|---:|---:|
| sealed exposure | $2,417,452 | **$2,272,222** |
| editions | 5,074 | **4,053** |
| ASK_ONLY exposure | $1,248,355 | **$1,221,349** |
| ASK_ONLY editions | 747 | **674** |
| **% from asks** | **51.6 %** | **53.8 %** |
| sale-backed (HIGH+MEDIUM) exposure | — | **$923,258** (3,379 editions) |
| **% sale-backed** | 40.4 % (published live today; the 39.5 % in the 09-19 code comment is stale) | **40.6 %** |

The error is small in magnitude (51.6 → 53.8) and **in the flattering direction**, which is the
reason to fix it rather than the reason not to: this is the board's honesty disclosure, and it
currently understates its own subject. Same class as the `pct_trustworthy` correction already
recorded in `route.ts:23-27` (a composition share read as a coverage percentage).

## 2. The proposal — finish the pattern the board already uses

The headline KPI is **53.8 % ask-derived**: $1,221,349 of $2,272,222 stands on one seller's unsold ask.
A KPI is read without its footnote. The board **already has the right pattern** for exactly this
situation — `:329-330` shows the honest subset as the big number and the blend as a labelled `psq-alt`
line. Extend it one more level rather than inventing anything:

- **primary** `$923,258` — sale-backed (HIGH+MEDIUM) within broad+partial
- **`psq-alt`** `$2,272,222 incl. ask-derived prices`

**Not proposed:** deleting ask-derived rows from the board, or clamping the price. Ask-derived is the
only signal that exists on those 674 editions and the per-row "from asks" marker
(`lib/fmv-basis.ts`) already tells a reader which is which. This is about what the *aggregate* asserts.

## 3. The change, complete

**DB — append two columns** (`CREATE OR REPLACE VIEW` appends only; it cannot rename or reorder, and
it **strips `security_invoker`** unless the `WITH` clause is carried — this view currently reads
`{security_invoker=true}` and must still read that afterwards):

```sql
-- panini_squeeze_totals gains the hc-scoped split. Body = the live definition
-- (pg_get_viewdef) plus the two trailing columns; no existing column is touched.
CREATE OR REPLACE VIEW public.panini_squeeze_totals
  WITH (security_invoker = on) AS
SELECT
  ... every existing column, verbatim, in order ...,
  round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (
    WHERE coverage_flag = ANY (ARRAY['broad','partial'])
      AND fmv_confidence = ANY (ARRAY['HIGH','MEDIUM']::fmv_confidence[])), 0))
    AS sealed_fmv_exposure_usd_hc_sale_backed,
  count(*) FILTER (
    WHERE coverage_flag = ANY (ARRAY['broad','partial'])
      AND fmv_confidence = ANY (ARRAY['HIGH','MEDIUM']::fmv_confidence[]))
    AS editions_hc_sale_backed
FROM panini_squeeze_board
WHERE fmv_usd IS NOT NULL;
```

⚠ **`pct_sealed_usd_from_asks_only` / `pct_sealed_usd_sale_backed` are deliberately LEFT as all-sets
figures** — other consumers may already read them, and silently changing a published percentage's
population is the defect this note is about. The client should compute the hc percentage from the hc
dollar columns instead, so the number and its denominator travel together.

**Code:**
- `lib/insights/panini-board.ts:107` — add both column names to the `fetchTotals` select.
- `PaniniSqueezeClient.tsx:38-58` — add both to `Totals` as optional (`?: number | null`), same
  fail-soft convention as the 09-19 additions, so a payload predating the migration still renders.
- `PaniniSqueezeClient.tsx:329-330` — primary/alt swap as above, gated on the new column being
  non-null (fall back to today's render when it is absent).
- `:367-376` — derive the percentage from `sealed_fmv_exposure_usd_hc_ask_only`-equivalent arithmetic
  (`hc − hc_sale_backed − hc_low`) or, simpler and preferred, print the two dollar figures and let the
  percentage follow from them.
- `__tests__/component-PaniniSqueezeClient.test.tsx` — it already names `panini_squeeze_totals`; add a
  case asserting the primary tile reads the sale-backed figure when present and falls back when null.
- `app/api/og/insights/panini-squeeze/route.tsx` also reads these totals — check the OG card does not
  keep publishing the blended figure after the page stops.

**Revert:** `CREATE OR REPLACE VIEW` back to the md5-pinned prior body (capture
`md5(trim(regexp_replace(pg_get_viewdef(...),'\s+',' ','g')))` BEFORE applying), then
`ALTER VIEW public.panini_squeeze_totals SET (security_invoker = on)`; `git revert` the code half.

**Exit:** the page's primary sealed figure reads ~$923k with ~$2.27M on the alt line, and the
disclosure percentage matches the tile's own denominator.
**Falsifier:** if `sealed_fmv_exposure_usd_hc_sale_backed` lands within a few percent of
`sealed_fmv_exposure_usd_hc`, the ASK_ONLY concentration is not where this note says and the change is
not worth the burst — re-measure before shipping.

## 4. Context — what is ALREADY done, so it is not rebuilt

⭐ Checked before proposing (the grep-first rule): **per-row ask marking is DONE**
(`lib/fmv-basis.ts`, plain-English "from asks", `route.ts:29-32` keeps the enum off the UI), and the
**aggregate composition disclosure is DONE** (`20260919181331` + `:367-376`). The only genuinely
missing piece is the hc scoping and the tile promotion. An earlier draft of this note proposed
building the disclosure from scratch; it already existed.

## Drained 2026-09-22 — RESOLVED — migration `20260920175228` + `PaniniSqueezeClient.tsx` now reads the `_hc` fields (verified in the file 2026-09-22).

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
