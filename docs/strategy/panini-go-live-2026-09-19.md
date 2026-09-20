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

⛔ **CORRECTION TO MY OWN FRAMING, same day.** The `pct_trustworthy` row above sits in this table
next to the staleness figures, which invites the reading that the walk fix will reverse it. **That
is not what it measures.** `pct_trustworthy` is the share of editions whose SET carries
`coverage_flag = 'broad'`, and that flag is banded purely on `sum(for_sale_count) /
sum(pulled_count)` (read live from `panini_coverage_audit`) — **listing bias, not freshness**. It
falls as discovery reaches into more listing-gated sets, which is what has been happening. It is a
DISCOVERY-completeness measure belonging to a different problem: Panini publishes no checklist, so
an edition is indexed only once it has been listed.

⚠ **A first draft of this very correction overstated it.** I wrote that walking a set more often
"does not move it by a single point" — wrong. `for_sale_count` and `pulled_count` are themselves
refreshed BY the walk, so clearing the stale backlog WILL update the band's inputs and can move
`pct_trustworthy` — **in an unpredictable direction**, since a refreshed set may land in any band.
The honest statement is the narrow one: **a move in `pct_trustworthy` is not evidence for or
against the walk fix, either way.**

👉 **So tomorrow's falsifier reads `pct_editions_stale_45d`, NOT `pct_trustworthy`** — and if
anyone quotes the latter as evidence for or against the walk fix, they have crossed two measures.
⭐ The general form: two numbers that both trend downward on the same dashboard are not thereby
the same finding.

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

1. ✅ **The walk fix is proven on its falsifier — day 1 of the 7-day hold.** Measured 2026-09-20
   ~8:2x AM PT, one day after the fix:

   | reading | 09-19 | 09-20 | |
   |---|---|---|---|
   | editions 45+ days stale | **1,265 (24.9%)** | **3 (0.1%)** | ⬇ |
   | edition age p50 | 276 h | **61.6 h** | ⬇ |
   | edition age p90 | 1,384 h | **470.1 h** | ⬇ |
   | walked ≤7 days | 1,671 (32.9%) | **3,182 (62.7%)** | ⬆ |

   **The falsifier is discharged** — it said "if it does not fall, the walk fix did not work". It
   fell by 99.8% of its value in one tick cycle. ⏳ **The HOLD is not: this is 1 of 7 days**, and
   the week matters because the failure mode being ruled out is a walk that drains the backlog once
   and then stops reaching the tail again. **Re-read daily** with
   `select edition_age_p50_h, edition_age_p90_h, pct_editions_stale_45d, pct_editions_walked_7d from panini_coverage_summary`.
   **Exit: `pct_editions_stale_45d` ≤ 1% every day through 2026-09-26.**

   📏 **Re-read 2026-09-20 ~11:3x AM PT, later the same day — still falling:** `pct_editions_stale_45d`
   **0.0%** (1 edition), age p50 **56.9 h**, walked ≤7 d **64.9%**. ⚠ **That last 1 is not a walk
   problem and must not be read as one:** it is register **R120**'s residual — one edition
   (`packcard-2332_486965_12679054_413`, Khuliso Mudau) that the walk is not reaching at all, for a
   cause distinct from the FK defect that froze the other two. **Judge step 1 on the other 5,073.**

   ⚠ **`pct_trustworthy` did NOT move (36.2% → 35.2%) and that is not a counter-result** — §1's
   correction says exactly this: it bands on listing bias, not freshness. Do not read it either way.
2. **Then the P1 bridge.** The mapping is settled and executable (§5). It is ~2 days of work, not
   1–2 weeks, now that the enum and null questions are measured.

   ⭐ **UPDATE 2026-09-20 — the executable already existed, and reading it found two defects this
   document did not know about.** `sync_panini_editions_to_shared(p_dry_run boolean)` has been
   shipped-but-inert since 2026-07-19. **(a) Its accuracy gate was a `note` STRING, not a gate** —
   the only `blocked` condition was slug collisions, so a live call on 09-19 would have written all
   1,265 stale editions into the shared plane, precisely what the ⛔ below forbids. **(b) It mapped
   `panini_editions.nation` into `team_name`**, contradicting gap 3 — and that column holds host
   cities ("Dallas", "Vancouver", "San Francisco Bay Area"), "FIFA" and doubled values
   ("Brazil | Brazil"), so it would have minted team pages for a city and for FIFA. ⭐ **Gap 3 was
   written about the read-only candidate VIEW and never checked the function that actually writes.**

   ✅ Both fixed in migration `20260920155903`: the threshold is enforced (and **fails closed** on
   an unreadable coverage row), and `team_name` is NULL. Live dry run after the fix:
   `would_insert_editions` 5,074 · `would_upsert_sets` 62 · `would_upsert_players` 552 ·
   collisions 0/0 · `blocked` **false**.

   🚨 **DO NOT TIGHTEN `MAX_STALE_PCT` TO 0.0 — it would deadlock the bridge permanently.** R120
   (filed the same morning) proves `editions_stale_45d` **cannot reach a true zero**: three rows of
   5,074 have `id = external_id` instead of the `__<span>_<cap>` convention, so the `last_seen_at`
   write never lands on them even though they are walked every four hours (113 serials captured
   09-20 6:05 AM PT, all `is_listed`). **1.0 is load-bearing precisely because it clears that
   3-row artifact** — 0.0 would be a permanently-closed gate held shut by a metric defect, which is
   this repo's "a permanently-red instrument is indistinguishable from a broken one". ✅ Once R120
   is fixed and the metric can reach 0, tightening is safe — and *that* is the moment to do it.

   ⛔ **`blocked: false` IS NOT A GO.** The gate answers staleness only. **Two things still stand
   between here and a live run**, and neither is code: the **7-day hold** (step 1), and the
   **2026-07-19 parity assessment's editorial objection** — bridging makes a listing-gated index
   (`pct_trustworthy` **35.2%**) a full citizen of shared surfaces that have nowhere to disclose
   partial coverage. ⚠ **That objection is NOT addressed anywhere in this document's ordering**, and
   it is the one that needs Trevor, not a threshold.
3. **Then the flips**, in the 09-06 audit's order: `published` → `proxy.ts` → `is_active` LAST.
   ⚠ **The `published` flip is not cosmetic** — measured 2026-09-20, it rewrites the site-wide
   provenance badge. That specific defect is fixed (§5 gap 1) and pinned, but re-read the pin before
   flipping.

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

1. ⛔ **RETRACTED AND REPLACED 2026-09-20 — I had the mechanism wrong, and it pointed the fix at
   the wrong file.** The original text read: *"`collections.chain` for `panini_blockchain` reads
   `ethereum` … `collection_chains` is the canonical chain join, so every bridged row would be
   labelled Ethereum on every surface. Fix the registry row in the same migration that writes the
   first edition."*

   **Measured instead of asserted (2026-09-20 ~8:1x AM PT): `collection_chains` has ZERO consumers,
   and so does `collections.chain`.** 0 of **176** public views/matviews reference it
   (`pg_get_viewdef` over `pg_class` — ⚠ `information_schema.views.view_definition` is NULL for
   views you do not own, and my first pass through it returned a clean `[]` that measured *nothing*);
   0 `pg_proc` bodies; 0 hits in `app/ lib/ components/ scripts/ workers/`. **A bridged row reaches
   no chain label through the DB at all, so no migration fixes this and the DB row gates nothing.**
   That half of the 2026-07-19 retraction (parity-assessment) was right and I re-broke it.

   🚨 **But there IS a real Ethereum falsehood, in code, and it is WIDER than this doc claimed.**
   The user-visible chain label comes from the hardcoded `dbChain` in **`lib/collections.ts`**, not
   from the DB. `publishedChainsBadge()` renders the **site-wide** footer + default-OG provenance
   claim from the `dbChain` of every `published` collection — so the flip in **step 3, not the
   bridge in step 2**, was going to change *every page on the site* from `BUILT ON FLOW + SOLANA` to
   **`BUILT ON FLOW + ETHEREUM + SOLANA`**. Measured by flipping the flag in a probe, not predicted.
   RPC would have claimed Ethereum provenance on the strength of a bridge plane it holds **zero rows
   from** and #64 deliberately never ingested.

   ✅ **FIXED 2026-09-20:** `dbChain: "ethereum"` → `null` (the established "not established" value,
   as on `rwa`), which corrects three consumers at once — badge skips Panini, the `CollectionBanner`
   pill falls back to "Panini Chain", and `chainKindForDbChain(null)` stops Panini accepting a `0x`
   wallet it has no concept of. **Zero user-visible change today** (Panini is unpublished; its static
   route dirs mount no `CollectionBanner`). Pinned by
   `__tests__/published-flip-cannot-widen-the-site-wide-chain-claim.test.ts` — a ban at zero, not an
   allowlist, with a positive control and a three-way planted-defect check.

   ⭐ **The lesson, and it is the one this file keeps re-learning: I inferred a blast radius from a
   view's NAME ("canonical join point", per chain-strategy.md) instead of counting its callers.**
   It has none. *Nothing in the 09-06 audit named any of this.*
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
  ⭐ **That precondition has now largely cleared** (see the §4 step-1 table), so this is live again
  as soon as the 7-day hold completes. ⚠ §8a still stands: the "~15% of ticks dropped by design"
  premise it rests on **cannot be measured** with this estate's instruments, so decide it on the
  cost of a missed page, not on that number.
- **#58 (`OPENSEA_API_KEY`) stays moot** under #64 unless the bridge plane is revisited.
- The `published` / `is_active` flips themselves. ⚠ **The `published` flip is not cosmetic** — it
  rewrites the site-wide provenance badge (§5 gap 1); that specific defect is fixed and pinned, but
  re-read the pin before flipping.
- 🆕 **2026-09-20 — THE SQUEEZE BOARD'S HEADLINE TILE.** The ask-only disclosure's denominator
  defect is FIXED (migration `20260920175228`: the footnote now shares the KPI's population). The
  source filing ALSO proposed **promoting the sale-backed figure to the primary tile** — primary
  `$923k` sale-backed, `$2.27M incl. ask-derived` demoted to the existing `psq-alt` line. **That was
  deliberately NOT shipped: it is a decision about what a public board LEADS with, not a defect.**
  The measurement that motivates it: within the lower-bias subset, **ASK_ONLY is 364 of 4,053
  editions (9.0%) but 53.8% of the value** — a ninth of the editions carries over half the headline.
  The columns exist, so it is a one-line client change either way. **Same question, same owner, for
  `app/api/og/insights/panini-squeeze/route.tsx`**, which reports the all-sets population for both
  its figures (internally consistent, so not a defect — just a different choice from the page).

---

## 7. Is this anywhere else? No — and the control is worth keeping

Added 2026-09-19 ~11:2x PT. The natural next worry after §1 is that other collections are decaying
the same way behind green pipelines. **They are not, and the reason is structural.**

Measured over `edition_fmv_current` joined to `editions` (Top Shot filtered to the canonical
`^[0-9]+:[0-9]+(::[0-9]+)?$` predicate):

| collection | editions | with a price row | refreshed ≤7d | 30d+ stale | oldest |
|---|---|---|---|---|---|
| nba_top_shot | 14,016 | **100%** | **100%** | 0 | 7.0 d |
| nfl_all_day | 6,190 | **100%** | **100%** | 0 | 7.1 d |
| laliga_golazos | 575 | **100%** | 99.7% | 0 | 7.0 d |
| ufc_strike | 518 | **100%** | **100%** | 0 | 4.8 d |
| candy_mlb | 125 | **100%** | **100%** | 0 | 6.1 d |
| **panini (side tables)** | **5,072** | 99.9% | **32.9%** | **1,264 at 45d+** | **65.1 d** |

⭐ **The difference is not diligence, it is where the refresh TARGETS come from.** The five live
collections are swept by `fmv-recalc` over our own `editions` table — an enumeration that is
complete by construction. Panini was the only lane whose targets came from a **scraped grid**,
which is a discovery mechanism that was silently doing double duty as the refresh list. So this
morning's fix did not invent a pattern; it brought Panini in line with how every other collection
already works.

⚠ **Both halves of the control matter.** "Refreshed ≤7d" alone would be satisfied by a lane that
refreshes a small subset forever, so the `with a price row` column is what closes it: there is no
cohort sitting outside the priced population either. A freshness percentage over an unstated
denominator is the same trap as §3's family MAX.

**Consequence for the roadmap:** §4's ordering stands unchanged, and this is now a positive reason
to believe step 2 is reachable — once Panini's targets come from its own catalogue, it has the same
shape as five lanes that already hold 100%/100%.

---

## 8. Two second-order consequences of the fix, measured 2026-09-19 ~11:5x PT

### 8a. `panini-ingest` severity — the premise for keeping it at `info` cannot be measured

The open item (P3 in the 09-06 audit, and the route header) parks the watchlist severity at `info`
because *"the box drops ~15% of ticks by design and a chronically-red arm trains operators to skim
past it."* That premise is **not measurable with the instruments this estate has**, in either
direction:

- **`pipeline_runs` retains ~73 h.** Over the only window it can see: **16 walks against ~17.4
  expected (92%)**, with all six scheduled hours (01/05/09/13/17/21 UTC) represented. That neither
  confirms nor refutes ~15% — the difference is 1–2 ticks, which is noise at this sample size, and
  it is all the instrument will ever hold.
- **`panini_editions.last_seen_at` is last-write-wins**, so it cannot serve as the long-horizon
  substitute. Proof, taken live: **645 editions have their latest walk today and ZERO have theirs
  on 2026-09-10** — not because no walk ran that day, but because everything walked then has since
  been re-walked.

👉 **So the severity decision is currently resting on a number nobody can check.** If it should be
decided on evidence, something has to record tick ARRIVALS durably — a tiny append-only table, or a
retention bump on this one pipeline. Until then, the honest framing for Trevor is "we do not know
the drop rate", not "~15%".

### 8b. ⚠ The stalest-first walk BREAKS the zero-day escalation, and that is my change's doing

There is (or was) a `panini-freshness-check` task carrying a **zero-day escalation** that reads
`panini_editions.last_seen_at` day by day, on the stated logic that *"a zero day shows as a MISSING
ROW, not a 0."*

**That arm is already unable to do what it claims**, and the fix makes it worse:

1. **It cannot distinguish the two cases it must.** A day with no walk and a day where every
   walked edition was later re-walked BOTH read as zero. Under the old ~2–3× re-walk regime those
   were routinely the same reading.
2. **Today it mostly survives by accident** — 64 of the ~66 days since 2026-07-16 still have at
   least one edition whose latest walk falls on them, and the reason is precisely the **stale tail**
   this fix is designed to eliminate. The backlog was leaving fingerprints on old dates.
3. 🚨 **So once every edition is walked every ~3 days, no edition will retain a latest-walk older
   than ~3 days, and EVERY older day will read zero.** An arm that fires on "zero editions dated
   that day" will then fire on essentially every historical day — the cry-wolf failure this repo
   has already paid for twice (`ufc_fmv_stale_hours`, and the ≥800/day Panini gate retired
   2026-08-13 for exactly this).

👉 **The arm must gate on TICKS, not on dated editions** — `pipeline_runs` walk-grouping inside its
retention, or the durable tick record 8a asks for. ⓘ **I could not fix it from here: that task is
not in the server-side scheduled-task list** (6 tasks, `has_more: false`), so it is either retired
or held in the desktop app's local store. **If it still runs, it needs this change before the
backlog clears.**

⭐ Both halves are the same lesson as §3 in a different costume: an instrument that answers a
question it was never able to answer, and a change to the SYSTEM silently changing what the
INSTRUMENT's output means.
