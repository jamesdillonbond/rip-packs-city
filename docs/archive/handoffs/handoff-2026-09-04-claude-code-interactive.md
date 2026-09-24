# Handoff — 2026-09-03 evening → 2026-09-04 midday PT · Claude Code, Trevor's box (interactive)

**Ask:** "get this session caught up, work through all the handoffs and pending docs until we have a clean tree, then find additional things to work on" → "keep going, don't stop" → **"use your best judgement on decisions, considering RPC long term and our users."** The last sentence is why several items below are DECISIONS taken rather than findings filed.

**Tree is clean. Everything below is on `main` and CI-green.** Three rebases over the concurrent Cowork sessions, all resolved with `scripts/resolve-ledger-rebase-conflict.mjs`.

---

## The finding that matters most

⭐ **A sweep's `ok` means it COMPLETED, not that its LANES worked.** `sales-serial-backfill` logged `ok=true` on 36 of 36 runs while its Top Shot lane failed **100% for a month** — 3,071 rows under `failure_reason='unknown'`, which was Cloudflare 530/1033 from the decommissioned `public-api.nbatopshot.com`. Three layers each said "not my job" and each was individually right: per-target failures correctly are not sweep failures; the pipeline was on **no watchlist arm at all**; and the bucket was named `unknown`, which reads as "miscellaneous". **The tell was not a red anything** — it was `SELECT failure_reason, count(*), max(last_failed_at) … GROUP BY 1`. Promoted to CLAUDE.md's honesty section as the ninth shape; full case in `docs/reference/key-files-and-honesty.md`.

## Shipped (chronological, each with a ledger entry)

| what | where |
|---|---|
| Deal alerts state the ask's age on all three channels, flagged past the boards' own 12 h marker | `1067665b6` |
| Five dialogs gain Escape / Tab trap / focus restore (the #17 remainder) | `55b3e1762` |
| **Top Shot serial lane ported ON-CHAIN** + strict header-only Bearer auth (register steps (a)+(c)) | `5fbc95ea6`, edge fn v38 |
| The sweep flips `ok=false` when a lane fails EVERY target on transport | `627bb68bd`, v39 |
| `pipelines:kills` reads each tick against its route's OWN wall (`wallClipped`, UNMAPPABLE at 1.2×) | `e051a9203` |
| `pipeline_gap_hourly` — the calibration series the correlated-skip arm needs (pg_cron 443) | `1a822f68d` |
| `wallet-preflight` body-read timeout → 502, not an uncaught 500 | `9ecae40dd` |
| **Top Shot BASE circulation from the chain**, daily (replaces the dead walker's one live field) | `d6c7b3572` + `7df740cae` |
| **#54 decided:** `match-topshot-players` gates its walk behind its inputs | `aa8cb8eab`, v30 |
| **40 `info` watchlist arms** seeded, each derived from its own gap profile | `20260904044417` |
| `%5C` paths 404; `/trophy-case/<u>` aliases; no-success arm gains grace + a lower bound | `fc20c2f06` |
| Dashboard: failed hero read → panel not "pick a hero Moment"; just-added wallet → INDEXING not $0 | `1f23b3e00` |

## Verified, not predicted (all read back before this handoff)

- **Circulation sweep, 13:20Z:** `ok=true`, **9,523 pairs · 239 script calls · 0 script errors · 25 changed · 89.7 s**, `complete: true`; 8 of 8 sampled changed rows were BASE rows, **0 parallels touched**.
- **#54 gate, 08:00Z tick:** `ok=true`, `gated: true`, **990 ms** against 16,687 ms the day before.
- **Drift parity, 11:46Z:** 6 content-drifted, the same known set — **neither** function I deployed appears.
- **Top Shot `unknown` bucket:** newest failure still `2026-09-04 00:40:49Z` — nothing new since the port.
- **Both detectors:** `detect_stalled_pipelines()` 0, `detect_pipelines_without_success()` 0.
- **Gap rollup:** 34 rows / 14 hours, newest 12:00Z, 18 skipped ticks total — accumulating on schedule.

## Owed reads (nothing else outstanding)

1. **2026-09-11** — `match-topshot-players` must do a FULL run again (the 7-day ceiling). If it stays gated past that date the ceiling is broken.
2. **First weeks** — the sentinel's WARN list for any of the 40 seeded `info` arms that trips repeatedly: that is either a real gap (promote it) or a cadence the 73 h window under-sampled (widen it; each row's `notes` says what it was sized from). ⛔ Do not bulk-promote.
3. **Weeks** — `pipeline_gap_hourly` needs enough events (and at least one real correlated dip) before the arm from inbox `2026-09-03T0300Z` can be written. Do not place the threshold on the first days.
4. **Standing** — R61's `scheduler-liveness` reads, the rwfc ≥24 h flow (#36), the Sunday `wmc-reindex-verify` row (2026-09-06 03:23Z).

## Two mistakes, both recorded rather than tidied away

- **I pushed a red suite.** `grep <log> && git push` gates on grep FINDING a line, not on the run passing. Fixed in the next commit, ledgered, promoted to CLAUDE.md's pipe-exit rule and `tooling-gotchas.md`, and saved as a memory.
- **The first circulation tick shipped at 250 pairs per Cadence script** and lost 38 of 39 calls to the execution node's computation limit. It failed *honestly* (`ok=false`, `script_errors: 38`) because the transport rule was built in from the start; the ceiling is now measured (250/100 fail, 50/25 pass; ships at 40) and in `apis-and-cadence.md`.

## Still Trevor's

- **#22** defeated credential purge · **#58** `OPENSEA_API_KEY` · **#34** Sentry · **INGEST_SECRET_TOKEN rotation** (now the only step left on the serial-backfill hardening item).
- **Two product calls from Cowork's walk:** the front-door vs dashboard headline (`/share` sums raw FMV; the profile shows total − stale), and whether the All Day deep-history backfill is worth keeping now that its edge function is gate-key deploy-blocked.
- **Pause-or-port** for `topshot-badge-set-backfill` (badges are not on chain) — the other two dead-host callers are now either ported (circulation) or measured near-empty (`topshot_misattrib_drain_targets` returns 215).
- **`query_sql` is the database's #1 reader** (2,171 calls / 12.1M blocks per 24 h) and `fmv-recalc`'s seven inline scans own it — filed as inbox `2026-09-04T0500Z` with the remedy shape (named functions per scan, then a scoped index measured by BUFFERS). Not a night-pass job.
