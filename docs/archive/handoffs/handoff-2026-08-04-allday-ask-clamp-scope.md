# Handoff — the disconnected-ask clamp is hardcoded to Top Shot

> ## ✅ DRAINED — do NOT re-execute (banner added 2026-08-05)
> Shipped exactly as prescribed; ledger entry 2026-08-03 (PT) *"the disconnected-ASK clamp ran for ONE collection out of five — All Day was publishing $24.75 against a $0.37 order book"*.
> **Verified live 2026-08-05 ~14:00Z:** `fmv_clamp_disconnected_ask(uuid, boolean)` exists, the hardcoded `fmv_clamp_disconnected_ask_topshot(boolean)` overload is **gone**, and the grant trap this doc warned about was handled — `has_function_privilege('anon', …, 'EXECUTE')` = **false**, `service_role` = **true**.
> ⚠ One knock-on the doc did not anticipate: a later `CREATE OR REPLACE` on an adjacent function reset this ACL and dropped `cron_heavy`'s EXECUTE, silently killing the daily backstop. Re-granted in `a9960e16`; `proacl` now `{postgres=X, service_role=X, cron_heavy=X}`. **If you ever replace a neighbouring function, re-check this grant.**

**Date:** 2026-08-04 · **For:** Claude Code
**Follows:** `docs/handoff-2026-08-03-fmv-sweep-cursor-stall.md` (shipped `484d08d7`, verified)

---

## Context

Found while characterising the residual over-2× editions after the sweep fix completed its first full pass. This is **pricing logic**, so per the standing restraint (`fmv-pipeline-patch-restraint`: data fixes OK, pricing logic hands off) Cowork measured it and did not ship it. No migration has been applied.

**One-line version:** `fmv_clamp_disconnected_ask_topshot` does exactly what it should — for one collection out of five. Two All Day COMMON base moments are publishing **$14.30** and **$24.75** against tight real order books at **$0.25** and **$0.37**.

---

## The finding

`public.fmv_clamp_disconnected_ask_topshot(p_dry_run boolean)` hardcodes the collection in **both** CTEs:

```sql
c_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
...
WHERE fs.collection_id = c_ts     -- the `latest` CTE
...
WHERE s.collection_id = c_ts      -- the `s90` CTE
```

Everything else about it is sound. It targets `confidence IN ('LOW','ASK_ONLY')` with `n_real >= 5` real sales (>$0.10) in 90 days, requires `fmv > med*3 AND fmv > p90*1.5`, and clamps to `GREATEST(p90*1.5, med)`.

Running that **exact predicate, thresholds unchanged**, against every non-Top-Shot collection returns **5 editions, all All Day, $48.24 of published FMV removed**:

| player | tier | circ | sales (90d) | realised med | **published FMV** | would clamp to |
|---|---|---|---|---|---|---|
| Landon Collins | COMMON | 10,000 | 10 | $0.37 | **$24.75** | $0.81 |
| Jared Goff | COMMON | 10,000 | 19 | $0.25 | **$14.30** | $0.66 |
| David Montgomery | RARE | 262 | 5 | $2.00 | $9.90 | $3.00 |
| Kalif Raymond | RARE | 499 | 9 | $1.00 | $3.60 | $1.94 |
| Brock Purdy | UNCOMMON | 500 | 10 | $1.00 | $3.60 | $1.50 |

**No scarcity story anywhere in that list** — circulation 262 to 10,000, five to nineteen real sales in 90 days, tight books. Goff's 19 sales all landed between $0.20 and $0.30. These are precisely the population the clamp was written for; they escape only because of the hardcoded UUID.

Golazos, UFC, Candy and Pinnacle return **zero** under the same predicate, so the change is All-Day-only in practice.

## The change

Generalise the collection scope. **Do not touch a single threshold** — they are calibrated and they are correct.

Preferred shape: `fmv_clamp_disconnected_ask(p_collection_id uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)`, where NULL means all collections, and drop the two `collection_id = c_ts` predicates (keep a `<> PINNACLE_COLLECTION_ID` exclusion — Pinnacle FMV is render-keyed and lives on `pinnacle_catalog`, not `fmv_snapshots`).

⚠ **`CREATE OR REPLACE FUNCTION` with a changed signature creates a NEW overload at default `PUBLIC EXECUTE`.** Per `create-or-replace-new-signature-resets-grants` — and this bit again yesterday in `a4105fc6`. After applying:

```sql
REVOKE EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask(uuid, boolean) TO postgres, service_role;
DROP FUNCTION IF EXISTS public.fmv_clamp_disconnected_ask_topshot(boolean);
```

The ACL carries both the `PUBLIC` default and explicit role rows — **either revoke alone leaves the privilege true.** Confirm with `SELECT check_secdef_anon_execute_violations();` (expect `[]`).

Then update the caller that currently invokes `..._topshot` (the `fmv-clamp-disconnected-ask` pipeline runs ~50×/24h, so grep for the call site before dropping the old overload).

## Revert path

The clamp **overwrites `fmv_usd` in place** and tags `algo_version` with `_p90clamp`; the prior value is not retained. Baseline the 5 rows first:

```sql
CREATE TABLE audit_20260804_ask_clamp_baseline AS
SELECT id, edition_id, fmv_usd, algo_version, computed_at
FROM fmv_snapshots WHERE id IN (<the 5 snapshot ids from the dry run>);
```

It is self-healing regardless: the next `fmv-recalc` recomputes the ASK_ONLY price and the clamp re-applies, so a bad clamp cannot compound. Run with `p_dry_run => true` first and confirm it returns 5 rows / $48.24 before writing.

## Verification

- `SELECT * FROM fmv_clamp_disconnected_ask(NULL, true);` → expect `(5, 5, 48.24)`.
- After the live run, the two named editions should read $0.81 and $0.66.
- `check_secdef_anon_execute_violations()` = `[]`.
- Re-run the over-2× ratio split — All Day's `over_2x` should drop by 2 and its p90 should fall off 1.369.

---

## NOT recommended — and this is the more important half

The same scan surfaced **237 editions (113 TS + 124 All Day) publishing an ASK_ONLY/LOW FMV more than 3× their own 90-day realised median**, totalling ~$81,430, all excluded by the clamp's `n_real >= 5` gate. **Do not widen that gate to reach them.**

I checked what they actually are before recommending anything, and they are not the same class:

| player | tier | circ | sales (90d) | last sale | realised med | published |
|---|---|---|---|---|---|---|
| Nikola Jokić | LEGENDARY | 49 | 2 | 05-21 | $2,299 | $9,000 |
| Russell Westbrook | ULTIMATE | 10 | 1 | 06-08 | $1,250 | $4,499 |
| LeBron James | LEGENDARY | **5** | 1 | 05-15 | $650 | $3,999 |
| Dylan Cardwell | ULTIMATE | **1** | 1 | 07-22 | $364 | $2,250 |

One to four sales in ninety days is **normal** for a circ-5 or circ-1 moment, and an ask several multiples above a months-old last sale is ordinary behaviour in an illiquid grail market. Clamping a circ-5 LeBron from $3,999 to ~$975 would not be a correction — it would **fabricate a low price**, which is the same defect class as the troll ask, pointed the other way. The `n_real >= 5` gate is a deliberate liquidity threshold, not an oversight.

The honest answer for that population is **disclosure, not arithmetic**, and it is a product call for Trevor rather than a pipeline change:

> Asking **$3,999** · last sold **$650** on May 15 · 1 sale in 90 days

That satisfies the roadmap's §1 rule ("a number we cannot stand behind must not render as a number") without inventing a value for a market that genuinely has not priced the asset recently.

---

## Guardrails

- Direct to `main`, no branches, no PRs. PowerShell `git`; re-verify with `git rev-list --count origin/main..HEAD` (expect 0).
- Log to `docs/overnight/ledger.md` with the revert path, ledger committed **before** the code.
- ⚠ Git history was rewritten 2026-08-03 — find pre-purge commits by message, not SHA.

**Claude Code's direct inspection wins over this doc on any disagreement — adapt to the actual file shape.**

## Expected end state

One migration + the caller update on `main`, `check_secdef_anon_execute_violations()` clean, 5 All Day editions repriced off troll asks, and the 237-edition grail population deliberately untouched pending Trevor's call on disclosure.
