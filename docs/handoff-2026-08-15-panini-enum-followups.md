# Handoff — Panini enumeration follow-ups (2026-08-15)

**From:** Cowork session. **To:** Claude Code on Trevor's Windows box.
**Last updated ~16:45 PT — items 1 and 2 are SHIPPED; do not redo them.** One NEW item (5) was found and its fix is verified but unshipped.

## Context

The Panini throughput investigation is largely **already shipped** — see ledger entries dated 2026-08-15: the enum telemetry + marker-pipeline separation (`d5919b6b`), the composite progress signal that fixes the dilution defect, and the `Query 4b` backstops in the freshness-check prompt. Items 1 and 2 below were then shipped by Claude Code in `b5f77a6d` → `2ac8aaba`.

**What is actually left: item 5 (new, verified fix in hand), item 3 (blocked on Trevor at the keyboard), item 4 (blocked on real data).** Nothing is urgent.

---

## ✅ Item 1 — SHIPPED. `SKILL.md` healthy-era contradiction

Line 118 of `C:/Users/TDill/Claude/Scheduled/panini-freshness-check/SKILL.md` replaced with the 629–965 → 299/224/153 series labelled as a **shape, not a target**, pointing at `baseline_8_28d`. **Verified: `grep 800 SKILL.md` returns zero hits.**

⚠ Fresh backup is `SKILL.md.bak2` (18,990 B). **Reverting via the older `SKILL.md.bak` would also roll back the Query 4b block** — use `.bak2`.

**The transferable lesson** (worth more than the fix): the prior session grepped for the *instance* it had already found rather than the *class*. `grep 800` was the check that would have caught it at the time. **When you fix a documented instance of a copy-paste defect, grep the class before claiming it's gone** — same shape as the 15 OG cards and the 5 sales indexers.

## ✅ Item 2 — SHIPPED. Inbox filings committed

Both filings are on `main`. Ledger heading count moved 1423 → 1424, then 1426 → 1427 after rebasing onto three concurrent-session commits; ledger line 14's stripped path repaired to forward-slash form.

**Independently re-verified from Cowork at ~16:35 PT:** heading count reads **1428** (one above, i.e. another concurrent session landed an entry after the push — *up* is the safe direction). Mid-line `### 2026-` splices: raw grep finds 4, but line 14000 is preceded by a backtick opening a closed code span (a deliberate citation, the refinement the naive rule misses), and the other three are the known un-repaired 2026-08-11 splices — 2607 still shows its tell, `sales-derived.95,489 +`. **Reconciles to the baseline of 3. No new damage.**

⚠ **Two things this handoff previously got wrong**, corrected for the record: the 1830Z filing's §9 STATUS section was **present, not reverted** (its header already read "At filing time nothing had been changed", so the false claim was already gone, and the `…1830Z…§9` cross-reference resolves); and the 2140Z filing was **already committed** — only 1830Z was dirty.

---

## ✅ Item 5 — SHIPPED. `Query 4b` went SILENT on a zero-day

Shipped 2026-08-15 18:4x PT. `coalesce(..., 0)` on the three NUMERATOR positions; the `nullif()` on the baseline DENOMINATOR left alone (it guards division — a different failure). **Verified in both directions, then re-run VERBATIM from the file** rather than from a separately-typed query: zero-day → `yesterday 0 · pct_of_catalogue 0.0 · gate TRUE`; today → `yesterday 223 · catalogue 4589 · pct_of_catalogue 4.9 · baseline_8_28d 901 · baseline_days 21 · pct_of_baseline 25`, unchanged. The `yesterday = 0` reporting distinction was taken too. **Revert: `cp SKILL.md.bak3 SKILL.md` (19,119 B) — NOT `.bak` or `.bak2`, which would roll back shipped work.**

<details><summary>Original filing (kept for the reasoning)</summary>


**File:** `C:/Users/TDill/Claude/Scheduled/panini-freshness-check/SKILL.md`, the Query 4b block (~lines 73–95).

**The defect.** `Query 4b` derives `yesterday` from a CTE that only contains rows for days that produced snapshots. On a **zero-day there is no row at all**, so `yesterday` is NULL, both percentages are NULL, and `pct_of_catalogue < 8` / `pct_of_baseline < 55` evaluate to **NULL — not TRUE**. Escalation 2 therefore does **not** fire on the single worst input it could receive: total ingest failure.

**Verified live** by simulating the check running on 2026-08-13 (so yesterday = 08-12, a confirmed zero-day):

```
yesterday: null · pct_of_catalogue: null · pct_of_baseline: null
catalogue_gate_fires: null · baseline_gate_fires: null
```

**Severity: low-to-moderate — it is defence-in-depth, not an unguarded hole.** A zero-day where the runner never fires is caught by Escalation 1 (the `pipeline_runs_daily` gap check) and by Cases B/C/D. ⚠ **But there is one reachable combination where everything stays quiet:** the walker fires normally and writes `panini_editions`, while `panini_fmv_snapshots` gets nothing (FMV recompute dead, walker healthy). Then Escalation 1 sees no gap, Case A reports `✅ Panini fresh`, and Queries 4 and 4b are both silent because that day is simply *absent* from their CTE rather than zero. **The FMV pipeline could be dead for days behind a green check.**

**The fix** — `coalesce` the missing day to 0, in both the `yesterday` select and the two percentage expressions:

```sql
coalesce((SELECT editions FROM d WHERE day_pt = <asof> - 1), 0)
```

**Verified in both directions** (zero-day fires, normal day unchanged):

```
simulated 2026-08-13 → yesterday 0   · pct_of_catalogue 0.0 · gate fires TRUE
simulated 2026-08-15 → yesterday 223 · pct_of_catalogue 4.9 · gate fires TRUE
```

⚠ Apply the same `coalesce` to `pct_of_baseline`'s numerator. Leave the existing `nullif(...,0)` on the denominator alone — that guards division, which is a different failure.

⚠ Consider also having Escalation 2 report **`yesterday = 0` explicitly as a distinct message** ("no editions priced at all yesterday") rather than as "0% of catalogue" — a zero-day and a 0.1% day warrant different first moves, and this file's own history is full of instruments that collapsed two states into one reading.

**Revert:** `cp SKILL.md.bak2 SKILL.md`. Take a fresh `.bak3` first.

**Verification:** re-run the block against prod and confirm it returns `yesterday 223 · pct_of_catalogue 4.9 · baseline_8_28d 901 · baseline_days 21 · pct_of_baseline 25` today, unchanged.

---

</details>

## Item 3 — Cardset filter param (BLOCKED on an operator action; now narrowed to two fields)

**Status: demoted.** The composite progress signal in `scripts/panini-enum-progress.mjs` (`enumProgress = wcPskus + gridItems`) already fixes the dilution defect **structurally** — a non-WC stretch advances progress, so dilution can no longer end the walk. The filter is now an **efficiency optimisation**, and an optimisation does not justify guessing a parameter in production ingest.

Still worth having: the 08-15 walk spent its whole enumeration budget on a grid measured at **21.8% WC-Prizm walk-wide** (vs 48% on page 1), so ~78% of that budget scrolls product we discard.

**Verified negative result — not recoverable from data on disk**, checked directly in `panini-ops-capture.jsonl`:
- `applied_filters` is literally the page URL query string (`marketplace-nfts?sport=Soccer&p=N`), present on all **180** grid requests;
- `attribute_code` is a structured array, **empty on all 180** — the filter mechanism was never once exercised;
- all 2,429 `cardset` hits are GraphQL **response field selections**, not filter arguments.

**So those two fields — `applied_filters` and `attribute_code` — are exactly what to read when the filter is applied.** That is the difference between a capture session that yields an answer and one that yields another investigation.

**Procedure:**
1. Set `PANINI_DISCOVERY_HOLD_MIN` (e.g. `10`) and run the runner; it parks and captures every `/onepanini` request body.
2. Trevor, in the CDP Chrome, applies a **cardset filter for 2026 Prizm World Cup** on the Soccer marketplace grid.
3. Read the resulting `applied_filters` / `attribute_code` values out of `panini-ops-capture.jsonl`.
4. Scope the grid URL in `scripts/ingest-panini-runner.mjs` (the `page.goto` at the ENUMERATE step, currently `marketplace/nfts.html?sport=Soccer`).

⚠ **Crafted GraphQL against `/onepanini` returns HTTP 426** — a documented dead end in `docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md`. Cowork re-derived it this session by accident. Do not repeat it.

**Revert:** `git revert <sha>` on the runner change; the capture itself changes nothing.

---

## ✅ Item 4 — LARGELY CLOSED (the prediction in it was wrong)

⚠ **The predicted steady state was `budget`. It is `max_iters`** — and the tree branched on `budget` and `stable` only, so the observed case fell through both. `enumStopReason()` (`scripts/panini-enum-progress.mjs:44-48`) returns exactly three values; a `max_iters` branch is now documented. ⚠ **And `PANINI_ENUM_BUDGET_MIN`, the lever the tree named, is INERT here**: the 18:08 walk stopped at `max_iters` after **7.9 min of a 10-min budget**, so raising the clock buys nothing while `PANINI_ENUM_MAX_ITERS` (200) binds first. The tree now says read `enum_ms` before pulling any lever. Nothing left to recalibrate until several more genuine rows exist.

<details><summary>Original filing</summary>


Post-fix, **`enum_stop = "budget"` becomes the EXPECTED steady state**, not a warning: the walk now pushes through non-WC stretches instead of stopping early, so it will run to its 10-minute clock until the grid is exhausted. Escalation 2's tree still reads `budget` as a lever-pull, which remains accurate (it only fires when throughput is *also* low) — **no edit yet**, but re-word it once several genuine rows exist so a routine `budget` stop isn't read as a fault.

---

</details>

## ✅ The open verification — ANSWERED (18:08 PT walk, beat both floors)

`grid_pages` **124** (floor 82) · `wc_pskus` **840** (floor 536) · `wc_share_pct` 22.6 · `enum_ms` 475,885 · `enum_stop` `max_iters`. **The runner→route path is proven.** Read in the prescribed order — `panini-ingest` confirmed writing cards first (18:19–18:22, `rows_found` 75–102, `rows_written` 2–3/batch) — so the enum fields are trustworthy rather than assumed.
⚠ `wc_share_pct` 22.6 corroborates the 21.8% walk-wide figure, so ~77% of the enumeration budget still scrolls product we discard: **item 3 stays correctly parked**, an efficiency win not a correctness one.
⚠ **Throughput has NOT recovered.** 4.9% of catalogue vs an 8% gate — Escalation 2 fires today. Today 263 by 18:22 vs yesterday's full-day 223 (08-13 299; ~800 on 08-10/11): improving, but **partial days are context only**.

<details><summary>Original filing (query + benchmarks)</summary>


As of **16:35 PT**: `panini-ingest-enum` holds **2 rows, both probes, 0 genuine**; last ingest batch 14:39 PT. The 14:00 walk is the one whose genuine enum row the pre-deploy route destroyed. **The 18:00 PT walk is the first that can prove the runner→route path.**

```sql
SELECT to_char(started_at AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI') AS pt,
       extra->'enum'->>'enum_stop'               AS enum_stop,
       (extra->'enum'->>'grid_pages')::int       AS grid_pages,
       (extra->'enum'->>'wc_pskus')::int         AS wc_pskus,
       (extra->'enum'->>'wc_share_pct')::numeric AS wc_share_pct
FROM pipeline_runs
WHERE pipeline='panini-ingest-enum'
  AND extra->'enum'->>'enum_stop' NOT IN ('probe','postdeploy-probe')
ORDER BY started_at DESC LIMIT 5;
```

⚠ **Read order matters.** Confirm the walk produced cards at all (Query 2 in `SKILL.md`) *before* reading any enum field. Preflight rows with no cards following supersede every enum reading.

**Benchmarks:** `grid_pages` vs **82**, `wc_pskus` vs **536** — ⚠ both floors *twice over*: that walk stopped on its clock, and on a **6-minute** clock (`enum_ms` 360,553 against a committed default of 10 min, almost certainly a manual test run in the 14:23–14:42 window). A scheduled walk gets the full 10 minutes and should go deeper.

Then `panini_fmv_snapshots` editions/day over the next day or two — read it from Query 4 / 4b, never from a remembered figure.

---

</details>

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md, non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify with `git rev-list --count origin/main..HEAD` (expect `0`).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s**; higher sends the deploy to ERROR invisibly.
- Docs-only commits: `vercel.json`'s `ignoreCommand` skips the build. **Expected, not a failed deploy.**
- ⚠ **The Bash layer strips backslashes even inside a quoted heredoc** — it ate the separators in a Windows path (reproducing the very ledger-line-14 bug being fixed) and turned an escaped regex into a `SyntaxError`. Parse with `indexOf` + `String.fromCharCode(92)`, and **prefer forward slashes in any path you write**. (Already recorded in memory under tooling-that-corrupts; it was paid for twice anyway.)
- ⚠ `sed`/`perl` corrupt the `⚠` and `—` characters in `SKILL.md`. Use a node stdin splice or a full-file write.
- **CRLF:** don't string-replace-patch on Windows — full-file writes, or `findIndex` on split lines.
- **Timestamps:** the only trustworthy clock on the box is PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"`.
- ⚠ **Do not hand-edit `scripts/ingest-panini-runner.mjs` without `node --check`.** A syntax error there is total Panini ingest loss.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## Expected end state (updated 2026-08-15 18:4x PT)

Query 4b fires on a zero-day instead of going quiet; the cardset filter either parked or shipped from a **captured** `applied_filters` / `attribute_code` value rather than a guessed one; and the first genuine `panini-ingest-enum` row confirming `grid_pages` ≥ 82, with `panini_fmv_snapshots` editions/day climbing back off 153.
