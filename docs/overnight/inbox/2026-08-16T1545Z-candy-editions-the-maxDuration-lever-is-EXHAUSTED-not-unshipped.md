# `candy-editions-ingest`: the `maxDuration` lever is EXHAUSTED, not unshipped — and the route is not the defect

Claude Code, interactive, 2026-08-16 15:45Z / 08:45 PT. Read-only measurement; nothing shipped.

## The correction first

Both the 14:46Z and 15:25Z daytime monitors point at
`docs/handoff-2026-08-04-candy-editions-timeout.md` as the *"existing fix path: route `maxDuration`
300 → up to 800 on Pro"*, and the 08-16 handoff carries it as QUEUED *"maxDuration bump"*.

**That bump already shipped on 2026-08-05.** Verified in the tree right now —
[`app/api/ingest/candy-editions/route.ts:44`](../../../app/api/ingest/candy-editions/route.ts#L44)
reads `export const maxDuration = 800`, and the handoff carries a `✅ DRAINED — do NOT re-execute`
banner. **There is no bump left to make: 800 is the Vercel Pro HARD CAP**, and anything above it
sends the deploy to ERROR invisibly. So the recurrence is happening *with the fix in place*, and the
queued action is a no-op that would burn a session.

## What the data actually says — the work is constant, the duration is not

`pipeline_runs_daily`, 2026-07-31 → 2026-08-16. **Every single day: 1 run, ok, `rows_found`
27,876 / `rows_written` 28,483 — byte-identical for sixteen consecutive days.**

| day | duration | | day | duration |
|---|---:|---|---|---:|
| 07-31 | 61.4 s | | 08-10 | 216.9 s |
| 08-01 | 71.4 s | | **08-11** | **475.0 s** |
| 08-02 | 197.4 s | | 08-12 | 73.4 s |
| 08-03 | **(killed at the old 300 s)** | | 08-13 | 84.0 s |
| 08-04 | 89.3 s | | **08-14** | **461.6 s** |
| 08-05 | 280.6 s | | **08-15** | **507.6 s** |
| 08-06 | 227.4 s | | **08-16** | **(no row — killed)** |
| 08-09 | 87.5 s | | | |

Two things follow, and they point in opposite directions from the framing in the queue:

1. **This is not a route regression.** Identical input, identical output, sixteen days running. A
   route that had genuinely slowed down would not return to **73.4 s on 08-12** and **84.0 s on
   08-13**. The duration swings 73 s ↔ 508 s — a **7× spread on constant work** — and the slow days
   (08-11, 08-14, 08-15, 08-16) are exactly the documented disk-IO saturation days. **Fold this into
   the saturation root cause; do not open a route investigation.**
2. **But the headroom is now gone.** 507.6 s on 08-15 is **63 % of the 800 s cap**, and 08-16 wrote
   no row at all. The handoff's own deferral condition for Item 2 — *"Revisit only if a run
   approaches the 800 s wall"* — **is now met.**

## So the only remaining lever is Item 2, and it is a real piece of work

`paginateGroup` walks the entire Metaplex collection in **one request with no resumable cursor** —
the same unbounded-single-pass shape that bit `fmv-recalc`. Because the ceiling is exhausted, a
resumable cursor is the *only* thing left that can make this survive a saturated day.

**Deliberately NOT shipped in this session, for reasons that are about verification, not caution:**

- It is an **ingest-route refactor with data-correctness implications** (a partial walk must not be
  mistaken for a complete one — the exact conflation class this repo keeps paying for).
- Its verification tick is **daily at 08:40 Z**. Shipping it now yields **no feedback for ~17 hours**,
  and shipping an ingest refactor you cannot observe is how a silent partial-write ships.
- The instance is in an **acute saturation spell** (trailing-60-min pipeline failure rate 13.8 %),
  which is both the cause of the symptom and the worst condition under which to judge a fix.

## User-facing impact — bounded, and worth stating plainly

`candy_mlb` is **LIVE and public** (`/insights/candy-mlb`), so this is real staleness on a public
surface. It is bounded by the same fact that makes the route innocent: **the editions catalogue is
static** — 27,876 rows found and 28,483 written, unchanged for sixteen days. A missed daily refresh
of an unchanging catalogue costs approximately nothing today. **That is a reason to schedule the fix
properly, not a reason to call it harmless** — the moment Candy prints a new drop, a missed tick
becomes a missing set on a public board.

## Durable

**"An existing fix path" in a monitor candidate is a claim about the past, and it decays.** Two
monitor ticks and one handoff queue all pointed at a bump that had shipped eleven days earlier,
because each read the handoff's *Item 1* and none read its **`✅ DRAINED` banner or the route file**.
The check that settles it is one `grep` of the route — cheaper than the session it would have cost.
Same shape as the `:13` stagger refuted the same day: **re-derive the current state before executing
a queued action, especially one described as ready.**
