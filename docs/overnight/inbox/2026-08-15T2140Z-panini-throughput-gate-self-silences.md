# The Panini throughput gate will self-silence on the collapse it is currently catching

Filed 2026-08-15 ~14:40 PT (21:40Z) by the monthly deep audit (run 2).
**STATUS: SHIPPED 2026-08-15 ~15:10 PT — see §Shipped. The "why this was filed rather than
shipped" section was wrong about its own blocker, and the SQL it proposed did not run.**

**That earlier flag was STALE — the throughput check was added to `panini-freshness-check` earlier
the same day** (refactor `d5919b6b` era). Verified by reading the prompt, not the description:
Escalation 2 exists at line 101 and gates on `pct_of_trailing7 < 55` judged on yesterday's row. It
fires today on 28%. **The gate works today.** This filing is about what happens next.

## The finding — CONFIRMED live 2026-08-15 14:56 PT

Measured on the gate's own metric (Query 4: `count(DISTINCT edition_id)` from
`panini_fmv_snapshots` by PT `computed_at` date):

| day PT | editions | trailing7 | pct_of_trailing7 |
|---|---|---|---|
| 08-07 | 952 | 743 | 128 |
| 08-08 | 934 | 793 | 118 |
| 08-09 | 965 | 826 | 117 |
| 08-10 | 803 | 852 | 94 |
| 08-11 | 795 | 877 | 91 |
| **08-12** | *no row* | — | — (zero-day, 37.3h gap — already documented) |
| 08-13 | 299 | 854 | 35 |
| 08-14 | 223 | 789 | 28 |
| 08-15 | 154 | 710 | 22 |

⚠ The 08-07/08/09 percentages in the original filing (149/135/133) were wrong; live reads
128/118/117. The direction and every recent figure hold, and `trailing7` really is eroding
**877 → 854 → 789 → 710** across four days.

**A relative gate divides by a window the collapse is itself dragging down.** Quantified by holding
throughput flat at today's 154/day and projecting the same window forward:

| PT day | editions | trailing7 | pct | Query-4 gate |
|---|---|---|---|---|
| 08-16 | 154 | 596 | 26 | fires |
| 08-17 | 154 | 485 | 32 | fires |
| 08-18 | 154 | 369 | 42 | fires |
| **08-19** | 154 | 276 | **56** | **SILENT** |
| 08-20 | 154 | 185 | 83 | silent |
| 08-22 | 154 | 154 | **100** | silent |

**Four days, not "about a week"** — and by 08-22 the board reads a perfect 100% with the outage
completely unchanged. A permanently-GREEN arm on a live failure is the mirror image of the
permanently-red arm this repo already paid for with `ufc_fmv_stale_hours`, and it is worse: nobody
investigates a green board.

## Why the previous mitigation was not enough

The prompt anticipated this in prose at line 109 — *"a collapse that has persisted a week makes its
own baseline look normal … compare against the ~800 healthy-era figure."* Two problems:

1. It was an instruction to the reader, not a check. Nothing computed it, so it depended on whoever
   read the output that morning noticing.
2. **`~800` is a hardcoded absolute, which line 69 of the same prompt explicitly forbids** — *"Never
   hardcode an absolute target here. The catalogue grows … so any fixed number goes stale."* The two
   notes contradicted each other.

## Shipped — `Query 4b`, two backstops, in `panini-freshness-check/SKILL.md`

Edited in place on Trevor's box (the file is local and writable; the "Cowork read-only /
`update_scheduled_task` replaces the whole prompt" blocker recorded below does not apply here).
Both edits verified present, the old `~800` prose removed, and the query **extracted back out of the
file and executed against prod** — reading `yesterday 223 · catalogue 4586 · pct_of_catalogue 4.9 ·
baseline_8_28d 901 · baseline_days 21 · pct_of_baseline 25`. Both backstops fire today, consistent
with Query 4's 28%.

⚠ **The SQL originally proposed in this filing DOES NOT RUN.** `round(avg(editions)) FILTER (…)`
raises `42809: FILTER specified, but round is not an aggregate function` — the FILTER must attach to
the aggregate, not the wrapper. Shipping it unrun would have put a hard error into the morning check.
The corrected form is what landed.

**1. `pct_of_catalogue` — the gate that CANNOT self-silence.** Yesterday's editions as a share of the
Panini catalogue. The outage cannot depress a catalogue count, so this denominator never erodes, and
it stays self-updating as the catalogue grows (so it does not violate the no-absolutes rule).
Measured over 29 observed days: median **17.5%**, max 27.9%, healthy era **13.2–21.0%**, the current
collapse **3.4–6.5%**. **Threshold 8%** — it separates the two populations with no overlap, and fired
on 5 of 29 days, all of which warrant a look.

**2. `pct_of_baseline` — yesterday vs days 8–28 back.** A window a recent collapse has not reached.
Buys about **18 extra days** over Query 4 (projected silent 09-06 vs 08-19) and frames the loss
against the healthy era rather than against the decline. Same 55% threshold as Escalation 2.

Escalation 2 now fires if **any** of the three reads low, and its ⚠ note names the 08-19 / 100%-by-
08-22 projection so a future reader cannot mistake a recovering percentage for a recovering runner.

⚠ **The second backstop eventually self-silences too, and the prompt now says so with numbers.**
Projected flat-154, `pct_of_baseline` stops firing **09-06** and reads 100% from **09-12**, once the
8–28d window is itself mostly collapse. `baseline_days` is the honesty check; when it is small or the
outage predates the window, the instruction is to **report the raw Query 4 series, not a ratio** —
a reassuring percentage from a depressed denominator is the exact failure being fixed.
`pct_of_catalogue` remains valid in that case, which is why it is the primary of the two.

**Revert:** `cp SKILL.md.bak SKILL.md` in `C:\Users\TDill\Claude\Scheduled\panini-freshness-check\`
(backup taken pre-edit, 15,253 bytes).

## Why it was originally filed rather than shipped (kept for the record — the reasoning was wrong)

`SKILL.md` for a scheduled task is read-only in a **Cowork** session, and `update_scheduled_task`
replaces the entire prompt, so a wholesale rewrite risked the clobber hazard the ledger rules warn
about. **That is a Cowork constraint, not a property of the file.** From Claude Code on Trevor's
Windows box the path is an ordinary local file and a two-anchor targeted edit is safe. Worth
recording as its own small lesson: *a blocker inherited from a different execution environment is a
hypothesis about THIS one.*

## Not addressed here

**The underlying collapse itself is unfixed and still deepening** (35% → 28% → 22% over three days).
These gates are detection, not remediation; the runner is the residential Windows box and the lever
is `enum_stop` / `PANINI_ENUM_BUDGET_MIN` / the cardset filter per Escalation 2's own decision tree.
The 08-15 walk enumerated 82 grid pages at `wc_share_pct` **21.8%** against a 48% page-1 scan, so the
cardset filter is now justified on evidence — see
`2026-08-15T1830Z-panini-enumeration-stops-early-and-the-freshness-gate-is-blind-to-it.md` §9.
Operator territory.
