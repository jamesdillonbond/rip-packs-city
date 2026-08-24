# Handoff — Panini enumeration follow-ups (2026-08-15)

**From:** Cowork session. **To:** Claude Code on Trevor's Windows box.
**Last updated 2026-08-16 07:50 PT. Items 1, 2 and 5 are ALL SHIPPED — do not redo them.** ⚠ **The live blocker is now none of the numbered items: the runner box hibernated overnight and lost 3 of 6 walks — see the 🚨 section below, and plug the laptop in.**

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

## 🚨 THE REAL CEILING IS THE BOX SLEEPING — 3 of 6 walks were lost overnight (measured 2026-08-16 07:50 PT)

**This supersedes the walk-budget framing below for anything overnight, and it blocks the measurement plan as written.** Panini ingest was **DOWN 12.8 h**: `panini-ingest` last ran **2026-08-15 18:58 PT**, and the **22:00, 02:00 and 06:00 walks never fired at all** — zero `pipeline_runs` rows, not slow rows. **2026-08-16 is currently a ZERO-DAY.**

**Mechanism, measured end to end on the box — the task is innocent and its settings are all correct:**

| layer | value | verdict |
|---|---|---|
| Task `RPC Panini Ingest` | `WakeToRun: True`, `StartWhenAvailable: True`, battery-permissive, `LastTaskResult: 0` | ✅ correctly configured |
| Power event log | **`S4 Doze to Hibernate` at 21:26 PT**, resumed **07:41 PT** (`Wake Source: Unknown`, i.e. a human) | the outage window |
| `SUB_SLEEP HIBERNATEIDLE` | AC **never** · DC **45 min** | box hibernates on battery |
| `SUB_SLEEP RTCWAKE` ("Allow wake timers") | AC **enabled** · DC **DISABLED** | ⚠ **this is what defeats `WakeToRun`** |
| Current power source | **battery** | the DC column is the one in force |

⚠ **So `WakeToRun: True` on the task is INERT on battery** — a task-level setting cannot override the power plan's DC wake-timer policy. Once the box doze-hibernates to S4 with DC wake timers off, nothing resumes it until someone opens the lid. **Checking the task's own settings will tell you everything is fine; the defeat is one layer down in the power plan.**

⚠ **Cost is large and it dwarfs every lever discussed below.** At the measured post-fix yield of ~418 editions/walk, three lost walks ≈ **1,250 editions ≈ 27% of the 4,589-edition catalogue**, in one night. Tuning `PANINI_WALK_BUDGET_MIN` or per-card cost cannot recover a walk that never started.

⚠ **It is INTERMITTENT, not constant — which is exactly why it has been invisible.** 08-15 fired `02,06,10,14,18` and 08-14 fired at `22`, so on other nights the box happened to be awake. **Overnight availability is the dominant uncontrolled variable in Panini throughput**, and it is not on any instrument: the runner is on Trevor's laptop, so a missed walk writes nothing anywhere and looks identical to "the pipeline is idle".

**The fix is an operator decision (it trades laptop battery), and the cheapest option needs NO setting change at all:**

- **B — keep the laptop plugged in overnight. Recommended, zero-risk, zero-config.** The **AC** profile is already correct: hibernate-after `never` and wake timers `enabled`, so the task's `WakeToRun` works as intended on AC. Nothing to change.
- **A — allow wake timers on battery:** `powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1` then `powercfg /S SCHEME_CURRENT`. ⚠ **May not be sufficient on its own** — RTC wake out of **S4 hibernate** is unreliable on Modern-Standby laptops, and it will wake the machine every 4 h on battery. Not taken here: it changes Trevor's laptop power behaviour, which is his call.
- **C — raise the DC hibernate timeout past the 4 h walk gap:** impractical on battery.

⚠ **Immediate, for whoever reads this first:** the box is on **battery** right now and the next walk is **10:00 PT**. If it sleeps before then, that walk dies too. **Plug it in.**

⚠ **CONSEQUENCE FOR THE MEASUREMENT PLAN: "measure one full clean day — six walks firing" is not achievable on an unplugged laptop**, and 08-16 has already lost three walks, so it cannot be the clean day either. **Sequence it: plug the box in FIRST, confirm six walks land, and only then read the daily total.** Otherwise the next clean-day reading will again be a mixed day misread as a throughput ceiling — the same error corrected directly below.

---

## ⚠ THE BOTTLENECK HAS MOVED — do not pull the enumeration levers (measured 2026-08-15 ~20:00 PT)

The 18:00 walk is the first full post-fix walk, and it reframes everything below. Measured:

- Enumeration: **7.93 min**, stopped at `max_iters` (200 iters), **124 pages / 3,720 items / 840 WC pskus**.
- Card walk: `18:00:04 → 18:58:31` = **58.5 min total**, i.e. the walk phase hit its **50-minute `WALK_BUDGET_MS` exactly**.
- It walked **394 of the 840 pskus it enumerated — 47%** — at **8.9 s/edition**.

**Enumeration is fixed and is no longer the constraint. The 50-minute walk budget is.** Three plausible next moves are therefore wrong:

1. ⚠ **Do NOT raise `ENUM_MAX_ITERS` or `PANINI_ENUM_BUDGET_MIN`.** They would enumerate more pskus the walk already cannot reach. `max_iters` as the steady state is *correct behaviour*, not a defect to fix — and note the budget had 2.07 min spare (475,885 ms of 600,000), so the clock was never the binding term anyway.
2. ⚠ **Item 3 demotes again.** The cardset filter saves ~5 min of *enumeration* wall-clock, which is on a separate clock from the walk (`tWalk` starts after enumeration). **It does not increase editions/day at all.** It is now a marginal tidiness win, not a throughput lever.
3. **If throughput ever genuinely needs a lever**, the real ones are `PANINI_WALK_BUDGET_MIN` (50 min, and walks are 4 h apart so there is headroom) or the 8.9 s/edition per-card cost (`PANINI_SALES_HISTORY=0` removes the sales-tab click). **Neither is warranted yet — see below.**

⚠ **THE "498 vs 223" HEADLINE IS A MIXED DAY AND UNDERSTATES THE FIX — corrected 2026-08-15 20:40 PT.** The enum fix `75647b8e` shipped at **14:35 PT**, so of today's five walks **only the 18:00 one ran post-fix**. Per-walk, measured off `panini_fmv_snapshots`:

| walk (PT) | unique editions | wall-clock |
|---|---|---|
| 02:00 | 2 | 58 s |
| 06:00 | 52 | 10.0 min |
| 10:00 | 95 | 11.6 min |
| 14:00 | 5 | 39 s (the deploy-window probe) |
| **18:00** | **418** | **50.0 min — the full `WALK_BUDGET_MS`** |

So today's 498 is **154 from four crippled walks + 418 from one healthy walk**, and quoting it against yesterday's 223 compares a mixed day to a broken one. **The honest unit is 418 editions per post-fix walk.** ⚠ **Six such walks project to ~2,500/day — not 498, and 2.6–3.1× the 08-08→08-11 healthy era's 795–965/day**, so the fix has already cleared the old ceiling rather than merely recovering toward it.

⚠ **And the pre-fix walks were dying in MINUTES, which is the defect's real signature.** 02:00 ran 58 s and 14:00 ran 39 s; the two that got going stopped at 10–12 min against a 50-min budget. That is the dilution stall ending walks early — exactly what `75647b8e` ("stop enumeration on grid exhaustion, not on WC-subset stalls") was written to fix, and it is stronger evidence for the fix than any daily total.

⚠ **CONSEQUENCE FOR THE MEASUREMENT PLAN: today can NEVER be the clean day.** Four of its walks predate the fix. **The first all-post-fix day is 2026-08-16.** Read the clean-day number then — do not close this out on tonight's total.

⚠ **The walk CADENCE was never the problem, which kills the obvious rival explanation.** Active walk-hours are **identical** on 08-11 and 08-15 (both `02,06,10,14,18`), yet 08-11 took **1,135** ingest batches against today's **254**. Same number of walks, no runner commit in between — so the collapse was per-walk work, not missed walks or laptop sleep. ⚠ Anyone re-deriving this should note `pipeline_runs` retains only ~73 h, so the 08-11 batch count must come from `pipeline_runs_daily`.

⚠ **The `1.1 vs 3.5 writes/unique` figures are from `pipeline_runs_daily.rows_written`, NOT from `panini_fmv_snapshots` — the two disagree and the trap is cross-instrument.** Snapshot rows give **1.15** today and **1.46** on 08-11; `rows_written` gives **1.02** and **3.15**. Both are defensible, they answer different questions (edition upserts vs priced snapshots), and mixing them silently halves the apparent gain. **State which table any ratio came from.** ⚠ Also, within each individual walk today writes/unique is exactly **1.00** — the 1.15 is entirely **74 editions re-touched across different walks**, not re-walking inside one.

⚠ `pipeline_runs_daily` for the CURRENT day is refreshed by pg_cron `11 */6 * * *`, so it lags: it read `rows_written` **508** at 20:40 PT against **550** measured live 40 min earlier. **A current-day rollup row can read LOWER than an earlier live count** — that is staleness, not a decrease.

**Recommendation unchanged, and now better grounded: pull nothing.** The 18:00 walk reached **418 of the 840 pskus it enumerated (50%)** using its entire budget, so the walk budget really is the binding term — but at ~2,500/day projected it is not yet binding on anything that matters. **Measure 2026-08-16 (the first all-post-fix day), then decide.**

---

## Item 3 — Cardset filter param (BLOCKED on an operator action; now narrowed to two fields)

**Status: demoted TWICE — see the bottleneck section above; this is no longer on the throughput path.** The composite progress signal in `scripts/panini-enum-progress.mjs` (`enumProgress = wcPskus + gridItems`) already fixes the dilution defect **structurally** — a non-WC stretch advances progress, so dilution can no longer end the walk. The filter is now an **efficiency optimisation**, and an optimisation does not justify guessing a parameter in production ingest.

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

## Expected end state (updated 2026-08-16 07:50 PT)

**All three code/doc items are shipped and verified.** Query 4b fires on a zero-day instead of going quiet (and ⚠ **08-16 is a live zero-day, so it should fire today — that is the fix working, not a new defect**); the enum fix is confirmed by a genuine `panini-ingest-enum` row at **124 pages / 840 pskus**, well past the ≥82 floor; and the post-fix walk yield is **418 editions**, ~2.6–3.1× the pre-collapse era per walk.

**What is actually left, in order:**

1. 🚨 **Plug the laptop in** (or take option A), then confirm six walks land. Until overnight availability is fixed, every throughput number is a mixed-day artifact and 3 of 6 walks are lost on any night the box is unplugged. **This is the only thing on the critical path.**
2. **Then** read the first genuinely clean day's editions/day. Expect roughly 2,500 at six post-fix walks; treat anything much lower as a real finding rather than re-deriving the walk budget.
3. Item 3 (cardset filter) stays parked — it is an efficiency win on a separate clock, not a throughput lever, and it needs a **captured** `applied_filters` / `attribute_code`, never a guessed one.

