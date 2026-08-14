# Search players by college — a real collector hook RPC cannot answer today

**Filed** 2026-08-14 03:30Z (2026-08-13 20:30 PT) by Claude Code (interactive).
**Requested by Trevor**, from the Weber State result in the narrative-search investigation: *"It would be
sick to be able to search for players based upon their college. I went to Central Michigan and would love
to collect more Central Michigan players — Top Shot has only 1, there's a lot more on the NFL All Day side."*
**Status** QUEUED — needs an operator probe (one curl) before any build decision.

## Why this is worth doing

"Show me everyone from my school" is an identity hook, not a stat. It gives a collector a reason to browse
a catalog they otherwise filter by price, and it is durable — a school affiliation never changes, so the
collection thesis it creates is permanent. It also maps naturally onto surfaces RPC already has (a player
index, a Team-Hub-style checklist, a `/insights` board).

It is also a genuinely cross-collection feature, which almost nothing else on RPC is: a CMU fan wants their
NFL All Day players and their one Top Shot player in the same view.

## ⚠ It is NOT buildable from the data RPC holds. Measured, not assumed.

**There is no college field anywhere.** `information_schema.columns` across the whole `public` schema
returns ZERO columns matching college / school / alma / draft / hometown / birth.

The only college text RPC holds is incidental prose inside `editions.description`:

| collection | editions | with prose | usable college data |
|---|---|---|---|
| nba_top_shot | 19,764 | 9,128 | **incidental only** — see below |
| nfl_all_day | 6,190 | **0** | **none** |
| laliga_golazos | 575 | 0 | none |
| ufc_strike | 518 | 0 | none |
| candy_mlb | 125 | 0 | none |

⚠ **A first pass suggested "519 Top Shot editions mention a school". That number is wrong and I am
recording it so nobody repeats it.** The regex included `out of [A-Z]`, which matches ordinary prose — a
sampled hit was Brook Lopez *"ripping the ball out of **G**reen's hands"*. The same naive-matching mistake
the narrative-search ranking makes. The real systematic coverage is far lower and is not a usable index.

**The decisive fact for this request: `"Central Michigan"` appears ZERO times in any description in any
collection.** And All Day — where Trevor says most CMU players are — has **no description text at all**
(6,190 editions, 1,520 distinct players, 0 prose; that ingest is WAF-blocked). So there is nothing to mine
on the half that matters most, and prose-derived college would be a Top-Shot-only feature with arbitrary
coverage even there.

## Next step: settle feasibility with ONE operator call

`app/api/admin/discover-moment-descriptors` already exists (admin-gated POST, read-only, writes nothing) and
does error-based GraphQL field probing — asking for a candidate field and reading the upstream error, since
GraphQL answers `Cannot query field X on type Y` for an unknown field, so the error IS the schema.

It probed `draftYear` / `birthplace` for Top Shot but **no college field at all**, and its **All Day arm
probed no player bio whatsoever** — making it structurally unable to answer this question for the collection
that matters most. Both arms now carry college candidates (`college`, `school`, `collegeName`, `schoolName`,
`university`, `lastAffiliation`, `fromSchool`, `playerCollege`), and the All Day arm additionally probes
`height` / `weight` / `birthplace` / `draft*` / `jerseyNumber`.

**Operator action — one call:**

    curl -X POST https://www.rippackscity.com/api/admin/discover-moment-descriptors \
      -H "Authorization: Bearer $RPC_ADMIN_TOKEN"

It returns sample VALUES, not just field names, because "field missing" and "field exists but empty" imply
opposite next steps. ⚠ Read the `status` field: a transport failure reports `unknown`, never `no` — the probe
refuses to answer rather than reporting an absence it did not establish (that guard exists because an earlier
version rendered two transport failures as schema facts).

## The three routes, depending on what the probe says

1. **Upstream field exists on both** → cleanest. Add `players.college` (nullable), capture it in the Top Shot
   catalog walker and the All Day hydrate, backfill, index, and extend `rpc_search_catalog` with a college arm.
   ⚠ Do the ranking fix first (`inbox/2026-08-14T0310Z-…`) or college queries will be outranked by set names
   exactly as narrative queries are today.
2. **Upstream field exists on All Day only** → still worth it. All Day is 1,520 players and the side with the
   demand; ship it there and label Top Shot honestly as uncovered rather than implying a cross-collection view
   that isn't real.
3. **Neither exposes it** → an external player→college mapping is the remaining route. College is stable,
   public, well-covered data, and this is the ONLY option that covers All Day given its zero prose. Join risk
   is name collision, manageable when scoped by `collection_id` + name, but it is a new ingest with its own
   freshness and provenance story — a real project, not a query change.

## Honesty constraint that travels with the feature

Whatever the source, **coverage must be disclosed per collection**, the same rule the description-coverage
work already established. A collector searching their school and getting nothing must be told whether that
means "no players from your school" or "we have no college data for this collection" — completely different
statements, and with a partial backfill both will be true somewhere. Do not ship a college filter that renders
a coverage gap as an empty roster.
