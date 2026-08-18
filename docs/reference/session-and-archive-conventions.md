# Session + archive conventions

<!-- Preserved verbatim from CLAUDE.md during the 2026-08-17 restructure. The date-stamping
rule below governs every `### <date>` heading in docs/overnight/ledger.md and docs/sessions/*. -->

## Rolling session entries

Keep only the last ~3 days here. On each refresh, move older `### <date>` entries into `docs/sessions/YYYY-MM.md` (prepend, newest-first) — verbatim, so nothing is lost. Busy days run several entries, so this section may hold a dozen-ish; if it's carrying more than ~3 calendar days, roll the tail.

(Superseded in form by the restructure — session entries now go straight to `docs/sessions/`
and are never kept inline in CLAUDE.md — but the prepend-newest-first, verbatim rule stands.)

## Stamping a date — the full history

**DATES ARE PACIFIC (Trevor operates in PT). The sandbox/CI clock is UTC — ~7h ahead in summer (PDT), 8h in winter (PST) — so `date -u` on the 29th at 02:54 UTC is still the 28th (19:54) in PT. ALWAYS convert to PT before stamping a `### <date>` here or in `docs/overnight/ledger.md`.** ⚠ **On Trevor's Windows box, run plain `date` (or PowerShell `Get-Date`) — NOT `TZ=America/Los_Angeles date`.** That Git Bash has no `/usr/share/zoneinfo`, so `TZ=<anything> date` silently returns **UTC labelled `GMT`** for every zone (verified 2026-07-31: `America/Los_Angeles`, `America/New_York`, `Asia/Tokyo` and `UTC` all print the same time). It fails silently — you get a plausible timestamp that is 7h ahead — which is exactly how the 07-29→07-30 boundary slip below happened. ⚠ **CORRECTED 2026-08-10 — plain `date` in Git Bash does NOT reliably return local time either; use PowerShell `Get-Date`.** This file used to claim plain `date` "returns the box's real local time and correctly prints `PDT`". Measured the same minute on Trevor's box: Git Bash `date` → `Tue, Aug 11, 2026 5:25:28 AM` with **no zone label**, matching UTC, while PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` → `2026-08-10 22:25 -07:00` (`[TimeZoneInfo]::Local.Id` = `Pacific Standard Time`). So Git Bash was a full calendar DAY ahead — the same silent-plausible-timestamp failure as the `TZ=` trap, and the third recorded instance of this class (07-29→07-30 slip, the M3b/D34 08-11→08-10 mis-stamp). **The single trustworthy command is `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` — it prints the offset, so it cannot lie silently.** ⚠ **CORRECTED 2026-08-12 — "the sandbox clock is UTC" is NOT universally true, and assuming it mis-stamped five ledger headings by a full day.** The Claude Code WEB sandbox reads **PDT**: measured in the same minute, `date` → `2026-08-12 07:15 PDT` and `date -u` → `2026-08-12 14:15`, the SAME calendar day. Applying the "subtract 7h from `date -u`" reflex there lands you a day EARLY. This is the fourth instance of one class — a plausible timestamp produced by a clock whose zone was assumed rather than read. **Read the zone before converting:** `date '+%Z'`, or `python3 -c "import datetime,zoneinfo; print(datetime.datetime.now(datetime.timezone.utc).astimezone(zoneinfo.ZoneInfo('America/Los_Angeles')))"`, which is correct in every environment because it converts rather than trusting the local zone. Only where the sandbox really is UTC does subtracting 7h (PDT) / 8h (PST) from `date -u` by hand apply. The overnight-pass entries already show the `HH:MMZ / HH:MM PDT` convention; interactive entries must follow the same PT calendar day.

## Older-session archive map

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-08.md` — August 14 → August 1 (rolled from Recent sessions; more August entries append here as days roll off).
- `docs/sessions/2026-07.md` — July 31 → July 1 (overnight passes + daytime CC; Candy MLB + Panini go-lives, FMV 1000-row-cap fix + proxy-auth-wall/edge-Deno CI coverage, Candy chain-two productization/parity, sales-counterparty/Panini readiness, Pack-EV accuracy program, IOPS read-diet, Trophy-case PDF, test-coverage infra, platform audits).
- `docs/sessions/2026-06.md` — June 30 → June 1 (overnight passes + daytime CC; parallel-conflation program, pack-EV, FMV hardening, Candy/Solana onboarding).
- `docs/sessions/2026-05.md` — May 31 → May 2 (entity pages, ops/QA pass, FMV recovery, V1 Dapper indexer, multi-collection enrichment).
- `docs/sessions/2026-04.md` — April 26 / 21 / 10.

**Doc archive layout:** shipped dated handoffs/audits live under `docs/archive/handoffs/` + `docs/archive/audits/`; weekly health snapshots (`PROJECT_HEALTH_*.md`) under `docs/health/`. Links inside `docs/archive/**`, `docs/health/**`, `docs/sessions/**` are frozen history — don't rewrite them.
