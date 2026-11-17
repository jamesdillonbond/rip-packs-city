# Answering the open question on #8: restoring ESPN alone will NOT refill `nba_players` — the roster fetch is SLATE-GATED, and the season is over

Filed 2026-08-18 01:20Z (Claude Code, interactive). **Direct answer to the question left open by the
residential decisive test** (*"check whether restoring ESPN alone feeds `nba_players` before touching the NBA
lane — that may make the hard lane unnecessary"*). **It does not, and the reason is structural, not an
outage.**

## The gate

`supabase/functions/sync-nba-projections/index.ts` builds `teamPlan` **from the scoreboard's events** — it
iterates `[home, away]` per event and adds those team IDs. `fetchEspnRoster(teamId)` is then called **only
for teams in `teamPlan`**, with the comment *"~16 teams worst-case on a full slate"*.

**No games today ⇒ empty `teamPlan` ⇒ zero roster fetches ⇒ zero `nba_players` growth**, no matter how
healthy the ESPN lane is.

## The season is over, measured

| fact | value |
|---|---|
| newest row in `nba_games` | **2026-08-04** (14 days ago) |
| games in the last 30 days | **4** |
| `nba_players` | **174 players, 19 of 30 teams** |
| newest `last_synced_at` | **102.2 days ago** |

So the slate is empty essentially every day right now.

## What this means for the fix order

1. ⚠ **Restoring ESPN egress (the easy lane — a Worker route, no secret) restores the MECHANISM but produces
   NOTHING until games resume (~October preseason).** Do it — it is cheap and correct — but **do not expect
   the 102-day-stale catalogue to move**, and do not read a still-flat `nba_players` afterwards as the fix
   having failed.
2. ⚠ **Even once games resume, the catalogue fills only with teams that PLAY that day.** At ~16 teams on a
   full slate it would take several days of real schedule to touch all 30, and a team's roster is only
   refreshed on days it plays. **That is a slow, partial repair of a catalogue that is currently missing 11
   of 30 teams.**
3. ✅ **The cheap fix nobody has proposed: a slate-INDEPENDENT roster sweep.** `fetchEspnRoster(teamId)`
   already accepts an arbitrary team ID and does not depend on the scoreboard at all. A one-shot (or weekly)
   pass over the 30 known NBA team IDs would repopulate `nba_players` **immediately once ESPN egress works**,
   in season or out. This is a small addition beside the existing function, not a redesign — and it decouples
   the player catalogue from the game schedule, which is the actual defect: **a reference catalogue was made
   a side effect of a per-day projections job.**
4. ⚠ **Therefore the NBA/`cdn.nba.com` lane may well be unnecessary for `nba_players`**, which was the hope
   behind the original question — but only if #3 is built. Without it, ESPN alone leaves the catalogue frozen
   until October and partial thereafter.

## Caveat

⚠ I did **not** verify that ESPN's roster payload alone carries everything `nba_players` needs
(`nba_stats_id`, `bref_id`, `headshot_url` are columns that may come from the NBA lane). **Check the insert
path's field sources before assuming #3 is sufficient** — it may repopulate names/teams while leaving
ID-join columns null, which would matter for `match-topshot-players`.
