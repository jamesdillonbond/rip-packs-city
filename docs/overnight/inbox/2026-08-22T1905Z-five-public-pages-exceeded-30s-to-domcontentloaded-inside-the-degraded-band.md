# Five public pages exceeded 30s to `domcontentloaded` in the 13:15Z e2e run — and the same pages were clean at 07:16Z and 18:58Z

**Filed 2026-08-22 12:05 PT (19:05Z), Claude Code interactive. OBSERVED from CI logs, nothing shipped
for it.** Surfaced incidentally while verifying an unrelated layout change against production.

---

## 1. What happened

`.github/workflows/e2e-smoke.yml` run **32575256192** (scheduled, 13:15Z) failed. Five tests, one cause,
all `TimeoutError: page.goto: Timeout 30000ms exceeded` waiting for **`domcontentloaded`** — not for
content, not for networkidle:

* `/nba-top-shot/overview`
* `/nfl-all-day/overview`
* `/laliga-golazos/overview`
* `/ufc-strike/overview`
* `/insights/underpriced-serials`

`/disney-pinnacle/overview` failed once and passed on retry (reported flaky). Run duration **6.4 min**.

The **07:16Z** run was `success`. I dispatched a fresh run at **18:58Z** (32592337927): `success`,
**97 passed, 1 pre-existing flaky, 2.4 min** — the same pages, clean, fast.

## 2. Why this is worth a filing rather than a shrug

⚠ **`domcontentloaded` is the cheap milestone.** Exceeding 30s to reach it is not "a board is slow to
fill" — it is the document itself not arriving. Whatever a real visitor on a phone experienced at 13:15Z,
it was not a slow chart; it was a page that had not started.

**13:15Z sits inside the 01:00–19:00Z degraded band CLAUDE.md already documents**, and 07:16Z sits inside
it too and was fine — so the band is a *risk window*, not a schedule. ⚠ **Do not read this as a new
subsystem.** The honest statement is narrower and more useful: **the disk-IO saturation this repo already
tracks has a measured USER-FACING expression, and these five pages are where it lands first.** That is the
part no existing filing states.

⚠ **Two readings, and I did not distinguish them.** Both fit the evidence and they have different fixes:
(a) the pages' own server-side reads block the document during saturation, or (b) Vercel lambda cold
starts collide with it. Nothing here separates them. Read `get_runtime_logs` for that window before acting
— and note CLAUDE.md's warning that `get_runtime_errors` route attribution is SMEARED, so re-group on
`requestPath`.

## 3. Why the overview pages specifically

Four of the five are `/[collection]/overview` — one route file, five collections, so this is very likely
**one page's data path**, not five. `/insights/underpriced-serials` is a prerendered board and may be a
separate instance of the same saturation rather than the same code.

**A cheap next step that needs no deploy:** compare the overview page's server reads against the
`withBoardBudget` treatment the `/insights` pages already have. If the overview page has no read budget,
that asymmetry is the hypothesis to test first — but ⚠ **test it, do not assume it**; this is a plausible
mechanism, which this repo has repeatedly recorded as not being a measurement.

## 4. What I already did about it (and did NOT)

**Did:** kept `/[collection]/overview` OUT of the new `e2e/mobile-layout.spec.ts` route list, with the
reason written at the list. A navigation timeout there would raise a LAYOUT alarm for a slowness cause,
and a monitor that cries wolf stops being read. `smoke.spec.ts` already reports this class properly.

**Did NOT:** touch the overview page, raise any timeout, or add a retry. Raising the 30s navigation
timeout would make the monitor stop reporting the thing it just caught correctly — the instrument is
working; the page is the problem.

## 5. Re-derivation

* Failing run: `32575256192` job `97036547301`. Clean control: `32592337927` job `97077990420`.
* The monitor is `workflow_dispatch`-enabled — re-run it inside the band (say 14:00Z) and outside it to
  reproduce the split, rather than reasoning from these two samples.
* ⚠ Two samples on either side of a threshold is not a distribution. This repo has three recorded
  characterizations that were retracted for exactly that. Treat the band boundary as unmeasured here.
