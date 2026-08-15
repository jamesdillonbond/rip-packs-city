# Handoff — Panini enumeration follow-ups (2026-08-15)

**From:** Cowork session, ~15:50 PT. **To:** Claude Code on Trevor's Windows box.

## Context

The Panini throughput investigation is largely **already shipped** by Claude Code sessions today — see ledger entries dated 2026-08-15: the enum telemetry + marker-pipeline separation (`d5919b6b`), the composite progress signal that fixes the dilution defect, and the `Query 4b` backstops in the freshness-check prompt. **This handoff covers only the residue Cowork could not do**, plus one measurement that is now blocked on an operator action.

Nothing in here is urgent. Items 1 and 2 are small; item 3 needs Trevor at the keyboard.

⚠ Cowork could not run `git` at all this session — the sandbox was down with the documented `/sessions` disk-full (`useradd: cannot create directory`, failed identically on two attempts). So **the commit state of the docs below is unverified** — check `git status` before assuming anything is uncommitted.

---

## Item 1 — `SKILL.md` still contradicts itself on the healthy-era figure

**File:** `C:\Users\TDill\Claude\Scheduled\panini-freshness-check\SKILL.md` (NOT in this repo — it is the scheduled-task prompt).

**What's wrong.** Two lines give opposite instructions:

- **line 118** (MEASURED BASELINE section): *"Treat ~800 as the healthy-era figure and the trailing-7 in Query 4 as the live one."*
- **line 144** (Escalation 2 reporting block): *"⚠ Never quote a healthy-era figure from memory or from this file. Take it from `baseline_8_28d`…"*

Line 118 instructs exactly what line 144 forbids, and `~800` is the hardcoded absolute that line 69 of the same file explicitly bans. This is residue from the Cowork edit that added Escalation 2; the 21:40Z filing removed the *other* instance of the `~800` prose but not this one.

**Severity: low.** Line 144 sits at the point of use, so a reader following the reporting block gets it right. It is a correctness-of-documentation fix, not a live misread.

**The edit** — replace line 118 with:

```
- Daily editions ran 629–965 through 08-11, then collapsed: 299 (08-13), 224 (08-14), 153 (08-15). ⚠ That is a DATED SAMPLE showing the SHAPE of the collapse — it is NOT a target and must not be quoted as the healthy-era figure. Read that live from `baseline_8_28d` (Query 4b), per the rule in Escalation 2.
```

⚠ **Do a two-anchor targeted edit, NOT `update_scheduled_task`.** That tool replaces the entire prompt and would clobber the Query 4b block another session added. (Cowork could not edit this file at all — it is read-only there, which is exactly the constraint the 21:40Z filing documented; from Claude Code it is an ordinary local file.)

⚠ `sed`/`perl` corrupt the `⚠` and `—` characters in this file. Use a node stdin splice or a full-file write.

**Revert:** `cp SKILL.md.bak SKILL.md` in that directory (a pre-edit backup at 15,253 bytes was taken by the earlier session). Take a fresh `.bak` first if you overwrite it.

**Verification:** re-grep for `~800` and confirm the only remaining hits are historical prose, not instructions.

---

## Item 2 — Commit the two Panini inbox filings (if still uncommitted)

**Files:**
- `docs/overnight/inbox/2026-08-15T1830Z-panini-enumeration-stops-early-and-the-freshness-gate-is-blind-to-it.md`
- `docs/overnight/inbox/2026-08-15T2140Z-panini-throughput-gate-self-silences.md`

Both exist on disk (verified by read). Docs-only, so `vercel.json`'s `ignoreCommand` will correctly skip a build — **that is expected, not a failed deploy.**

⚠ **Check §9 of the 1830Z file before committing.** A Cowork edit adding a STATUS section to it was reverted at some point during the session, so its header may still read *"Nothing was changed. No code, no DB, no cron"* — which is now false (the enum telemetry, the composite progress fix and the gate backstops all shipped). The 2140Z file cross-references *"…1830Z…§9"*, so if the section numbering moved, that pointer needs re-checking. **Read both files as they are on disk rather than trusting this description.**

**Ledger:** if you commit these, splice an entry. Follow the file's own rules exactly — re-read the ledger from disk immediately before writing, splice at a **line-start `^### `** (never a substring match on `### `), confirm `grep -c '^### ' docs/overnight/ledger.md` goes **UP by exactly the number of entries added**, and run `scripts/find-swallowed-ledger-headings.awk` comparing the **printed number** against its baseline of **3** — ⚠ it prints a count, so `| wc -l` always reads 1 and tells you nothing.

⚠ Minor, unrelated: ledger line 14 has a path with its backslashes stripped (`C:UsersTDillClaudeScheduled…`). Cosmetic; fix opportunistically if you are already editing nearby, but **do not rewrite the whole file to do it.**

**Revert:** `git revert <sha>` — docs only, nothing to unwind on prod or in the DB.

---

## Item 3 — Establish the cardset filter param (BLOCKED on an operator action)

**Status: demoted, and this is the important part.** The composite progress signal in `scripts/panini-enum-progress.mjs` (`enumProgress = wcPskus + gridItems`) already fixes the dilution defect **structurally** — a non-WC stretch advances progress, so dilution can no longer end the walk. The cardset filter is therefore **no longer a correctness fix**; it is an efficiency optimisation, and an optimisation does not justify guessing a parameter in production ingest.

It is still worth having: the 08-15 walk spent its whole enumeration budget on a grid measured at **21.8% WC-Prizm walk-wide** (vs 48% on page 1), so ~78% of that budget is scrolling product we discard.

**Verified negative result — the param is NOT recoverable from data already on disk.** I checked `panini-ops-capture.jsonl` directly:
- every `products` request carries `attribute_code: []` — **zero** non-empty matches, so the filter mechanism was never exercised in the captured window;
- all 2,429 `cardset` hits are GraphQL **response field selections**, not filter arguments.

So it cannot be derived from the capture, and it must not be guessed.

**The safe way to get it** — the runner already has the instrument:

1. Set `PANINI_DISCOVERY_HOLD_MIN` (e.g. `10`) and run the runner. It parks and captures every `/onepanini` request body.
2. Trevor, in the CDP Chrome, applies a **cardset filter for 2026 Prizm World Cup** on the Soccer marketplace grid.
3. The real `applied_filters` / `attribute_code` values land in `panini-ops-capture.jsonl`.
4. Read them out, then scope the grid URL in `scripts/ingest-panini-runner.mjs` (the `page.goto` at the ENUMERATE step, currently `marketplace/nfts.html?sport=Soccer`).

⚠ **Crafted GraphQL against `/onepanini` returns HTTP 426** — a documented dead end in `docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md`. Cowork re-derived it this session by accident. Do not repeat it.

**Revert:** `git revert <sha>` on the runner change; the discovery-hold capture itself changes nothing.

---

## Item 4 — Recalibrate Escalation 2 once real walks have landed

Post-fix, **`enum_stop = "budget"` becomes the EXPECTED steady state**, not a warning: the walk now pushes through non-WC stretches instead of stopping early, so it will run to its 10-minute clock until the whole Soccer grid is exhausted.

Escalation 2's decision tree in `SKILL.md` currently reads `budget` as "enumeration ran out of wall-clock before the grid was exhausted → the lever is `PANINI_ENUM_BUDGET_MIN`". That is still accurate and still actionable (it only fires when throughput is *also* low), so **no edit is needed yet** — but after a few genuine walks it should be re-worded so a future reader does not treat a routine `budget` stop as a fault.

**Do this only with real data in hand**, i.e. after several `panini-ingest-enum` rows whose `enum_stop` is not `probe`/`postdeploy-probe`.

---

## What to check at the next walk (the open verification)

As of 15:48 PT there were **2 rows in `panini-ingest-enum`, both probes, 0 genuine**. The first genuine row is the real proof.

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

⚠ **Read order matters.** Before reading any enum field, first confirm the walk produced cards at all (Query 2 in `SKILL.md`). If a walk shows preflight rows with no cards following, that supersedes every enum reading.

**Benchmarks:** `grid_pages` against **82**, `wc_pskus` against **536**. ⚠ Both are floors twice over — that walk stopped on its clock, and on a **6-minute** clock (`enum_ms` 360,553 against a committed default of 10 min; almost certainly a manual test run during the 14:23–14:42 testing window). A scheduled walk gets the full 10 minutes and should go deeper.

Then `panini_fmv_snapshots` editions/day over the following day or two — read it from `Query 4` / `Query 4b`, not from a remembered figure.

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md, non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify with `git rev-list --count origin/main..HEAD` (expect `0`).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s**; higher sends the deploy to ERROR invisibly.
- **CRLF:** don't string-replace-patch on Windows — full-file writes, or `findIndex` on split lines.
- **Timestamps:** the only trustworthy clock on the box is PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"`. Both Git Bash forms return UTC while looking local.
- ⚠ **Do not hand-edit `scripts/ingest-panini-runner.mjs` without `node --check`.** A syntax error there is total Panini ingest loss.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## Expected end state

Line 118 of `SKILL.md` no longer contradicts line 144; both inbox filings committed on `main` with a spliced ledger entry and an unchanged swallowed-heading count of 3; the cardset filter either parked or shipped from a **captured** `applied_filters` value rather than a guessed one; and the first genuine `panini-ingest-enum` row confirming `grid_pages` ≥ 82 with `panini_fmv_snapshots` editions/day climbing back off 153.
