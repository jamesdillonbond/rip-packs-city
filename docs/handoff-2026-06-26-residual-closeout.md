# Residual closeout — 2026-06-26 audit follow-ups (post-CC-drain)

Companion to [docs/handoff-2026-06-26-audit-followups.md](handoff-2026-06-26-audit-followups.md) and the audit [docs/audits/full-platform-audit-2026-06-26.md](audits/full-platform-audit-2026-06-26.md). Records the genuinely-residual state after Claude Code drained the handoff (6 shipped: items 1/2/4/9/10/11; prod `219a34a` READY, independently verified). Read on desktop.

## Re-framed: AllDay badge parity (item 3) — NOT infra-blocked

The prior handoff framed AllDay badges as blocked on a consumer-GQL egress decision (residential proxy vs Vercel egress). Direct investigation **disproves that** — there is no Top-Shot-equivalent per-moment tag source in any reachable AllDay data:

- `editions.badges` = **0/6,191** populated for AllDay; `reward_indicators` = **0/6,191** (the TS `editions.badges` column is also 0 — TS badges come from `badge_editions` via the GQL `play.tags`/`setPlay.tags` sweep, which AllDay has no analog for).
- The on-chain AllDay edition/play resolver ([lib/chains/flow/allday-edition-onchain.ts](../lib/chains/flow/allday-edition-onchain.ts)) carries **no** badge/tag/reward/achievement field — only editionID / serialNumber / mintingDate.
- Our AllDay GQL ([lib/chains/flow/alldayGraphql.ts](../lib/chains/flow/alldayGraphql.ts) `GET_ALLDAY_EDITIONS`) references no tag/badge field, and the consumer GQL is WAF-403'd from worker/edge egress regardless.

**AllDay's achievement axis is the SET NAME itself** (unlike TS, where independent tags overlay any set). AllDay set names are rich and achievement-encoding — e.g. "Conference Championship", "Defensive Gems", "2 Minute Drill", "Ball Hawk", "Against the Clock", "Career Chronicles", "Banner Year", "Afterburners", "Draw it Up", "Class of 2022". The existing heuristic ([lib/allday-badges.ts](../lib/allday-badges.ts) `classifyAlldayBadges`, 7 rules) already mines this; 4 fire on the live data (Rookie 728 / Playoffs 705 / Super Bowl 110 / Pro Bowl 29).

**Therefore the realistic path is NOT an egress fix — it's widening the set-name heuristic, which is a product + content task, not infra:**
1. **Product call (Trevor):** decide which AllDay set themes are "badges" worth surfacing (e.g. is "Defensive Gems" / "2 Minute Drill" / "Career Chronicles" a badge, or just a set?). The current 4 are the defensible high-confidence achievement subset; this is a curation/taxonomy decision, not a data-availability one.
2. **Then a bounded code task:** extend `ALLDAY_BADGE_RULES` + `ALLDAY_BADGE_COLORS` in [lib/allday-badges.ts](../lib/allday-badges.ts), mirror the patterns in the DB `derive_badges_from_set_name` function, and re-run `/api/seed-allday-badges` to repopulate `badge_editions.set_play_tags`.
3. **Art:** NFL badge SVGs for `badge_taxonomy.icon_url` (TS `nbatopshot.com` badge art won't match NFL badges; until art exists they correctly render as colored text pills — which is honest and fine).

Net: the current AllDay badge behavior is reasonable for the data that exists. "Parity with TS authoritative tags" is not achievable because the equivalent data does not exist on AllDay — it's the wrong target. The improvement is a curated set-name expansion, gated on Trevor's taxonomy call.

## Operator / infra (not code; Trevor or operator)

- **`allday-fmv-populate` cron** — CC flagged as an optional retire ("no-op"). **Do NOT disable casually:** it writes the `allday-gql-v1` FMV leg, and item 5 (the dual-writer "race") was disproven, so confirm `fmv-recalc` fully covers AllDay FMV (HIGH+MED + ASK_ONLY) before retiring a pricing writer. Low urgency; verify-then-disable.
- **`NIGHTPASS-0626-NOCLOSE`** — the daytime monitor flagged that last night's autonomous pass took its lock but wrote no digest/closeout and left the inbox undrained (lock ~10h stale). Self-recovering per the monitor; if tomorrow's morning digest is missing again, check the scheduled-task trigger.

## Wait-for-data (monitored, no action)

- **Serial / #1 / perfect-serial FMV for AllDay + Pinnacle** — data-gated: needs enough #1/perfect-serial *sales* to fit the power model (the same gate TS cleared). AllDay exposes serialOne/lastMint/jersey and Pinnacle has per-render circulation, so the inputs exist; the sale density doesn't yet. Re-evaluate once AllDay #1/perfect-serial sale counts approach the TS fit threshold.

## Closed — no action (recorded for completeness)

- AllDay FMV dual-writer race (item 5) — disproven (not an actual race).
- Golazos/UFC ASK fallback (item 7) — no live-ask source for those collections → no-op.
- Pinnacle FMV → shared consumers (item 8) — already done.
- Pack `total_minted/total_opened/total_sealed` columns — vestigial 0s, unused by the UI (reads `metadata`); leave unless a future consumer needs them.
- Entity-page "SCANNING THE MARKETPLACE…" perceived load — the server RPCs stream the heavy sections via `<Suspense>` (hero+FMV paint after ~1 RPC); the few-second delay is the client-side live-marketplace fetch, which is acceptable. Item 4 (eager hero/montage images) already addressed the black-during-load symptom.

## Monitor (re-check in a few days)

- Sentry smoke timeouts on `/disney-pinnacle/overview` (NEXTJS-W) and `/laliga-golazos/analytics` (NEXTJS-X) — both pages verified healthy live; the failures are heavy-page smoke-deadline timeouts. Item 4's eager-image change may reduce them. If they persist, bump the smoke per-page fetch budget rather than chasing a non-bug.
