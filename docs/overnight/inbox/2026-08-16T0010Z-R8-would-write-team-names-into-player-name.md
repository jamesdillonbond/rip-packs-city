# R8's heal would write TEAM NAMES into `editions.player_name` — do not run it

**Measured 2026-08-15 ~17:05 PT (2026-08-16 00:10Z) by Claude Code. The finding is REFUTED as
filed and re-pointed; nothing was written.**

## The prescription being refuted

`docs/audits/deep-audit-register.md` R8:

> **512 canonical TS editions have NO player; 482 render the SET NAME in the name slot** …
> **357 of 512 healable** from modal non-null `wmc.player_name` (COALESCE fill-only)

Running that heal would have copied a **team name** into `editions.player_name` for essentially
every row it touched.

## What the 512 actually are

The `no player` count is real and reproduces: **512** canonical Top Shot editions
(`external_id ~ '^[0-9]+:[0-9]+'`, unanchored) have `player_name IS NULL`, and 481 have
`name = set_name`. But the reason is not a coverage gap — **they are TEAM MOMENTS, and a team
moment correctly has no player.**

Breaking the 512 down by what `wmc` would supply:

| bucket | count | what it would write |
|---|---|---|
| exactly one distinct `wmc.player_name` | **273** | see below — essentially all team names |
| **conflicting** names (>1 distinct) | **71** | e.g. `{"Phoenix Suns", "Team Moment"}` |
| no `wmc` name at all | 168 | nothing |

⚠ The register's **357** is close to `273 + 71 = 344` — i.e. it appears to have counted
*has any wmc name* and did not separate the conflicting set. Those 71 have **no single value to
COALESCE**, so a `min()`/modal pick writes an arbitrary one of two wrong answers.

## The values are teams, not players

Top single values across the healable set, in order:

```
Atlanta Hawks 6 · LA Clippers 5 · Golden State Warriors 5 · Cleveland Cavaliers 5
Chicago Bulls 5 · Indiana Pacers 4 · Houston Rockets 4 · Milwaukee Bucks 4
Utah Jazz 4 · Brooklyn Nets 3 · Detroit Pistons 3 · Denver Nuggets 3
```

Scoped to a 170-edition chunk, of the 83 healable there:

- **82 have `wmc.player_name` exactly equal to the edition's OWN `team_name`**
- 1 is `"Unknown (error loading)"`
- 0 are a person

The conflicting bucket is the same story with the label attached — every sample pairs a franchise
with the literal string `"Team Moment"`:

```
98:3148::6  Clamps               {Phoenix Suns, Team Moment}
85:2910     Dynamic Duos         {Detroit Pistons, Team Moment}
104:3668    The Champion's Path  {New York Knicks, Team Moment}
76:3322     The Tour             {Portland Trail Blazers, Team Moment}
```

**Not one candidate value is a player name.** The heal would fabricate players ("Atlanta Hawks"),
make them findable in player-name search as people, and put an error string on one edition.

## The register's own evidence, re-read

R8 cites as a consequence: *"the same moment shows a player in the wmc-backed collection table vs a
set name on the editions-backed entity page."* That divergence is real — but it is evidence of the
**opposite** conclusion. The collection table is the surface that is WRONG: it is showing a team (or
`"Team Moment"`, or an error string) in a column labelled player. `editions` is right to be null.

## The real defect underneath: `wmc.player_name` holds non-names

Counted across all of `wallet_moments_cache`:

| `player_name` | rows | distinct editions |
|---|---|---|
| `Team Moment` | 3,973 | 69 |
| `Unknown` | 2,944 | 164 |
| `Unknown Play` | 98 | 2 |
| **`Unknown (error loading)`** | **75** | **3** |

⚠ **`"Unknown (error loading)"` is the failed-read-renders-as-data class, persisted to the
portfolio store and shown to a collector as the player's name in their own collection table.** An
enrichment call failed and the writer stored the error text instead of leaving the column NULL.

That last one is small (75 rows / 3 editions) and worth fixing on its own merits, and the fix is
better than cosmetic: `rpc_wmc_metadata_selfheal` is COALESCE **fill-only**, so a sentinel string
*blocks* it forever. Normalising these to NULL both stops the error text rendering and unblocks the
existing self-heal. Not taken here — it is an UPDATE on the portfolio store during a documented
saturation episode, and it is not what this handoff item asked for.

## Re-pointed, not closed

Closing R8 would bury two things that are real:

1. **481 editions render `name = set_name`** ("Skyline", "Fit Check", `"Unknown — Clamps"`). A
   genuine display defect, but the repair is a better upstream NAME, **not** a player. Team moments
   need a team-moment title, and nothing in `wmc` supplies one.
2. **`wmc.player_name` is carrying teams, labels and an error string.** Every consumer treating that
   column as a person is affected — player-name search, and the concierge quirk tools.

## What NOT to do

- ⚠ **Do not run the COALESCE fill.** It is the corrupting direction.
- ⚠ **Do not "fix" the 71 conflicting rows by picking the non-`"Team Moment"` value** — that leaves
  the franchise name, which is the wrong answer in a player column.
- ⚠ **Do not treat `player_name IS NULL` on a team moment as a gap to close.** It is the correct
  value, and a metric counting it as missing coverage will keep re-filing this.
