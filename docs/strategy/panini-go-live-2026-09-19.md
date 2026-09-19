> Amends [go-live-2026-09.md](go-live-2026-09.md) §5 and the Panini half of
> [audit-2026-09-06-candy-and-panini-go-live-readiness.md](../audits/audit-2026-09-06-candy-and-panini-go-live-readiness.md).
> Every number is a live sample taken 2026-09-19 ~10:1x–10:4x PT on `bxcqstmqfzmuolpuynti`, Trevor present.
> Re-measure before quoting; the SQL is next to each figure.

# Panini go-live — the blocker was never the bridge

## 0. What changed today, in one line

The 09-06 audit gated Panini on **P0, a product decision**, and then on **P1, a 1–2 week bridge**.
P0 was answered the same day (#64: the WC Prizm plane IS the collection). So the next thing was
assumed to be the bridge. **It is not.** The catalogue the bridge would copy is decaying, and
nothing measured that it was decaying, because the pipeline that feeds it has never failed.

## 1. The finding

`panini-ingest`: **2,103 runs, 0 failures, over 72 h**, last tick minutes before this was written.
By every instrument the lane is healthy. And yet:

| reading | value | how |
|---|---|---|
| editions | **5,072** | `select count(*) from panini_editions` |
| walked in the last 7 days | **1,671 (32.9%)** | `last_seen_at > now()-'7 days'` |
| **not walked in 45+ days** | **1,265 (24.9%)** | `last_seen_at <= now()-'45 days'` |
| edition age p50 / p90 / max | **276 h · 1,384 h · 1,562 h** | `percentile_cont` over `now()-last_seen_at` |
| trustworthy coverage | **35.3%**, from 36.2% (09-06) and 37.9% (08-04) | `panini_coverage_summary` |

`last_seen_at` is stamped unconditionally on every edition a walk touches
(`lib/chains/panini/ingest-normalize.ts`), so it genuinely means *walked*, not *changed*.

**A quarter of the catalogue had not been re-priced in a month and a half, while the lane reported
zero failures for three days.** That is this repo's documented silent-failure shape: green
external signals over work that silently never happens.

## 2. The mechanism — two defects, and I got the first one wrong before I measured it

My first reading was "the runner shuffles, so there is a coupon-collector tail". That is half of
it. The `panini-ingest-enum` markers refuted the other half:

```
select extra->'enum'->>'wc_pskus', extra->'enum'->>'enum_stop'
from pipeline_runs where pipeline='panini-ingest-enum' order by started_at desc limit 10
```

**163 to 1,109 WC pskus enumerated per walk**, against a 5,072-edition catalogue, stopping on
`stable` (the grid scroll ran out of NEW cards) or `budget`.

1. **The enumeration ceiling.** Refresh targets came *only* from the grid scroll. The grid is a
   DISCOVERY mechanism, and it was also — wrongly — the only source of re-pricing targets. An
   edition the grid stopped surfacing could never be re-priced again, no matter how long the
   runner ran.
2. **The shuffle tail.** The runner then Fisher-Yates shuffled that already-small slice, making
   every walk an independent uniform sample. Editions that lost the draw kept losing it.

⭐ **The fix turns on a fact that was already in the data:** a psku is a *recorded* identifier
(`panini_editions.external_id`), not a constructed one, and the walk navigates straight to
`/marketplace-details/<psku>.html`. **It never needed the grid to have surfaced that card in this
run.** The grid keeps discovery; our own catalogue supplies refresh.

## 3. Shipped today

| # | what | where | revert |
|---|---|---|---|
| 1 | **GET arm on the ingest route** returning our catalogue stalest-first (`last_seen_at asc nulls first`, capped at PostgREST's real 1,000) | `app/api/cron/panini-ingest/route.ts` | delete the export; the runner falls back to the shuffle |
| 2 | **Runner walks new discoveries → stalest known → the rest**, shuffle kept only as the fallback when the endpoint is unreachable | `scripts/ingest-panini-runner.mjs` | same |
| 3 | **`panini_coverage_summary` publishes the per-EDITION age distribution** | migration `20260919172027` | header carries the exact statement |
| 4 | **The public board's freshness copy is now per-edition** | squeeze route + SSR reader + client, pinned in two test files | header |
| 5 | **P1 bridge mapping as read-only views** — writes nothing, publishes nothing | migration `20260919173527` | `drop view` ×2 |
| 6 | **Self-correction: `security_invoker` restored on three views** | migration `20260919173610` | header |

### Why (4) matters on a board that is already public

`/insights/panini-squeeze` has been public since 2026-08-01 and disclosed freshness as
`oldest_family_refresh_h` / `newest_family_refresh_h`. **Both are a MAX PER SET, and a max cannot
see the distribution under it.** Measured today:

| set | family reads | actually 45+ days stale |
|---|---|---|
| `Base Prizms Aguila` | **0.0 h** | **211 of 340 (62.1%)** |
| `Base Prizms White Sparkle` | **3.3 h** | **121 of 184 (65.8%)** |
| `Base Choice Prizms Zebra` | 3.4 h | 151 of 291 (51.9%) |

And the headline at the other end — "the least recently refreshed parallel is **64 days** old" —
came from `Aces Prizms Gold` with **`discovered_editions = 1`**. A single card.

**So both ends of that sentence were wrong, in opposite directions**, and the instrument was
structurally incapable of being right. The banner now says what a price board's reader needs:
*the typical row was last checked 12 days ago*, the oldest tenth 58 days, and **25% (1,265
editions) have not been re-checked in over 45 days**. ⭐ The class is the R109 lesson again — a
whole-group statistic used as a proxy for a per-slice property.

## 4. The corrected go-live order

1. ⏳ **Prove the walk fix.** Next runner tick 21:00Z (14:00 PT). **Exit condition:**
   `pct_editions_stale_45d` falls toward 0 and holds for a week. **Falsifier:** if it does not
   fall, the walk fix did not work and everything below is premature. Read it with
   `select edition_age_p50_h, pct_editions_stale_45d from panini_coverage_summary`.
2. **Then the P1 bridge.** The mapping is settled and executable (§5). It is ~2 days of work, not
   1–2 weeks, now that the enum and null questions are measured.
3. **Then the flips**, in the 09-06 audit's order: `published` → `proxy.ts` → `is_active` LAST.

⛔ **Do not reorder 1 and 2.** Bridging today writes 1,265 month-and-a-half-old prices into
`editions` / `fmv_snapshots`, where every cross-collection rollup renders them indistinguishable
from live ones. Trevor's standing gate (roadmap-2026-08-03.md) is accuracy before exposure, and
this is exactly the case it was written for.

## 5. What the bridge mapping settled (so nobody re-derives it)

- **`tier` and `confidence` are ALREADY the shared enums** — `panini_editions.tier` is `tier_type`
  and `panini_fmv_snapshots.confidence` is `fmv_confidence`. No mapping table is needed; the
  1–2 week estimate assumed one.
- **The psku is unique across all 5,072 rows**, so it is a sound natural `external_id`. It does
  not match Top Shot's `^[0-9]+:[0-9]+(::[0-9]+)?$` canonical predicate — correct, that predicate
  is Top-Shot-scoped, but check before reusing one.
- **Source completeness is total where it matters:** 0 nulls in `player_name`, `set_name`, `tier`,
  `mint_cap`. 32 rows lack `nation`, 4 lack a thumbnail.
- **All 58,246 FMV rows are in 2026** — one partition, no partition work.

### Four pre-flip gaps, none of them papered over

1. 🚨 **`collections.chain` for `panini_blockchain` reads `ethereum`.** That describes the OpenSea
   bridge plane, which #64 did **not** choose; the WC Prizm plane is a private Sawtooth chain.
   `collection_chains` is the canonical chain join, so **every bridged row would be labelled
   Ethereum on every surface**. Fix the registry row in the same migration that writes the first
   edition, or not at all. *Nothing in the 09-06 audit named this.*
2. **No `sets` / `players` rows** exist for Panini's 62 sets and 657 players, so `set_id` /
   `player_id` stay NULL and shared set/player surfaces render empty — which reads as "no cards".
3. **A nation is not a team.** `panini_editions.nation` is populated and `team_name` stays NULL
   deliberately: mapping it would put "Brazil" in a column every other collection fills with a
   club, under a header that says *Team*.
4. **`edition_kind` falls to its `LE` default.** Every WC Prizm card carries a `mint_cap`, so LE
   is right — recorded as a decision rather than an accident of the default.

## 6. Still Trevor's

- **`panini-ingest` severity `info` → `medium`** at go-live (P3 in the 09-06 audit, missed on
  08-01). It pages his own residential box, so it is his call, and it should wait for §4 step 1 —
  raising it while a quarter of the catalogue is stale trains him to skim past it.
- **#58 (`OPENSEA_API_KEY`) stays moot** under #64 unless the bridge plane is revisited.
- The `published` / `is_active` flips themselves.
