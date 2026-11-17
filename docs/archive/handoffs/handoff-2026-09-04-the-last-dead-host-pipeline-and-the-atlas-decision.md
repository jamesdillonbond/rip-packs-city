# The last dead-host Top Shot pipeline is retired, and the "Atlas decision" is decided

**2026-09-04 (PT) · Cowork (cloud) · DB live via MCP + code pushed to `main` (`6046ea5`, `8481c72`, `13e5601`)**

## What this closes

`topshot-catalog-backfill` was the last Top Shot pipeline still calling the decommissioned
`public-api.nbatopshot.com`. It is now **unscheduled**, and the decision it had been parked
behind since 2026-09-03 — *"tier, media and new-edition creation are not on chain; that is the
Atlas decision"* — is **answered**, not deferred again.

## How it was found, and why the denominator mattered

A failures-only sweep named two pipelines. `atlas-editions-refresh` read 4 failures — **against
600 runs, 0.67%, its own baseline.** `topshot-catalog-backfill` read 4 failures **against 4
runs.** From `pipeline_runs_daily` (the ~73 h retention on `pipeline_runs` would have shown only
the tail): **last success 2026-08-28, then 7 of 7 daily ticks failed**, every one
`page 0: HTTP 530: error code: 1033`.

⚠ **I grepped `docs/` before filing anything, and that was the point.** It was already filed
(inbox `2026-09-04T0220Z §1`) as *pause-or-port, a decision, not a chore*, with a standing ⛔
against re-filing it as a circulation gap. The work owed was never *discover it* — it was
*decide it*.

## Why it was retired for redundancy, not for being red

"It fails every day" is not on its own a reason to remove an arm; it is a reason to find out who
is doing the work. All three of its jobs were checked against live data **first**:

| job | owner now | evidence |
|---|---|---|
| circulation | `topshot-circulation-onchain` (Vercel `5 4 * * *`) | shipped + verified 2026-09-03/04 |
| tier + badges | the Atlas edition walk (pg_cron) | **0 of 13,436** canonical TS editions have a NULL tier; **13,312** carry a `topshot_atlas_edition_map` row |
| prose + media | **nobody** → built this pass | `editions.description` froze on 08-28 at 9,199 / 13,436 (**68.5%**), 4,237 NULL |

## The third owner (migration `20260905024630`)

Atlas's `SearchEditions` carries the identical prose at
`editionTemplate.metadata.Description` and the CDN media at `assets[]` (`hero` image/jpeg,
`video-square` video/mp4).

⭐ **Verified against production before a line was written.** On a live 100-row page of set 90:
84 rows matched our catalog, Atlas had a Description for all 100, and **64 would be FILLED with
0 CHANGED** — which is simultaneously the proof it is the same field and the proof the write is
not a churn engine.

The migration splices an `editions` enrichment into `atlas_editions_drain` under three rules:

1. **Prose REFRESHES** (`IS DISTINCT FROM`, so steady state costs zero writes); **media only
   FILLS a NULL** — 2,323 thumbnails point at IPFS via the on-chain resolver, and overwriting a
   resolved CID with a CDN URL would quietly undo the permanence work.
2. It **rides inside the page loop the walk already pays for** — no new HTTP call, no new cron,
   no new lambda.
3. It **cannot take down the lane it rides on** — its own `BEGIN/EXCEPTION` records into
   `atlas_set_refresh_state.last_error`, placed *after* the success path clears that column so
   the record survives the tick, and lets the badge upsert stand.

Triggers were checked rather than assumed: `zzz_topshot_normalize_base_club_circulation` is
`UPDATE OF circulation_count` and does not fire; `editions_block_topshot_uuid_dupe`
short-circuits on int-keyed `external_id`s, the only shape this join can match.

**Live:** first tick `editions_enriched: 141`, 0 errors, 0 `editions-enrich:` failures in
`atlas_set_refresh_state`. Description coverage **68.5% → 71.4% within eleven minutes**
(~100–160 rows per 2-min tick); video NULLs 66 → 63.

## Then, and only then, the cron came out

`vercel.json` **36 → 35** (the second dead-host retirement of the day, after
`backfill-badges-from-sets`). The route is **kept** and still works by hand; its header carries
the measurement, the three inheriting lanes by name, and the exact one-line restore.

Guard: `__tests__/topshot-catalog-backfill-schedule-is-retired.test.ts`. ⚠ **It pins five things,
not one** — "the entry is absent" would pass just as well against an emptied `vercel.json` or a
deleted route, so the cron list must still be real, the route must survive, the restore line must
still be printed, the inheritors must still be named, and the on-chain lane must still be
scheduled.

## ⚠ The one job nothing inherited — sized, and it inverted

**I deferred this, then measured it properly, and the measurement turned a chore into a live defect.**
Against the full walk rather than one sampled page: Atlas knows **13,921** Top Shot editions,
`editions` carried **13,436**, and of the **579** Atlas rows we lacked, **563 are parallels — and 16
are BASE rows.** Every one of the 16 is `tier = ULTIMATE, circulation_count = 1`: one-of-one trophy
Moments, the most valuable class on the platform.

🚨 **Five were held in `wallet_moments_cache` and rendered as blank tiles** — NULL player, set, tier,
image, mint and FMV — including `140:5141`, **Victor Wembanyama's 1/1 2023 Rookie Ultimate, Atlas ask
$150,000**. (Also Chet Holmgren, Jovana Nogic, Madina Okot, Kiki Rice.)

⚠ **Not caused by the retirement**, though the timing invites that reading: `searchMarketplaceEditions`
never surfaced Ultimate 1/1s — the documented reason `backfill-badges-from-sets` was written. And
`ensure_topshot_edition_stub()` could not have closed it either: it returns NULL when `sets` has no
row for the set, and sets 140 and 253 have none. ⓘ Separately checked, because that function's comment
names the retired walker as its hydrator: **all 195 editions created in the trailing 14 days — 120 of
them after the walker died — are fully hydrated.** The comment is stale; nothing was stranded.

**Shipped `20260905061815`** — the 16 rows, built from `badge_editions` with `series`/`play_type`
copied from a sibling in the same set (checked against Atlas first: `PlayType` reads `Reel` for all 18
base rows in both sets). Scope is a **predicate with a count assertion**, not a hand-typed id list: it
RAISES rather than creating a population it did not measure.

**Shipped `20260905062040`** — the half that is easy to skip. After the rows existed the five tiles were
**still blank**: `reconcile_wmc_metadata_from_editions` is a **cursor rotation**, not a change feed, and
its cursor had already swept past these keys lexically. The propagation applies the reconciler's own
rules verbatim, so it is a no-op on re-run. **All five now read player, team, set, `ULTIMATE`, `#1 / 1`,
and `/nba-top-shot/edition/140:5141` renders live with Atlas CDN media.**

⛔ **The 563 parallels are still not created** — subedition keying, circulation ladders, series rollups
and the sitemap all move. ⓘ Also measured and left alone: 100 editions we hold that Atlas no longer
lists, and 15 sets where our count exceeds Atlas's. Both need their own read.

⭐ **The lesson is about judgement, not data: "left open on purpose" is only honest if the thing was
SIZED first.** I deferred this on a sampled-page number and a plausible ripple argument. The full
measurement took one query.

## Enrichment result, four and a half hours in

Description coverage **68.5% (frozen since 08-28) → 95.9%**; NULLs **4,237 → 554**; zero
`editions-enrich:` errors across the whole walk. ⭐ **And the 16 new rows were their own positive
control:** created with NULL media and prose on purpose, the enrichment then filled **16/16 thumbnails,
16/16 videos and 14/16 descriptions** unaided — the two without prose being exactly the two Atlas itself
has none for (`253:8864`, `253:8865`), an upstream absence rather than a defect.


**New-edition creation.** Atlas knows editions we do not carry: **16 of 100** on that same page,
all parallels (`90:4046::1` "Explosion", `::2` "Torn", …). This is **not** a regression from the
retirement — the walker has created nothing since 08-28, and 195 Top Shot editions were still
created in the trailing 14 days by the Cadence stub path, so the lane is not dark. It is left
open because creating `editions` rows ripples into circulation, the sitemap and every entity
surface. **That is a decision for Trevor, not a chore to slip into a retirement commit.**

## ⚠ Correction to this document's own title, made the same hour

**"The last dead-host Top Shot pipeline" is wrong — there is a fourth, `ingest-topshot-challenges`.**
Identical shape (`Top Shot GQL HTTP 530: error code: 1033`, last success 2026-08-28, then 7 of 7
daily ticks failed); I missed it only because the filing I worked from listed three.

⭐ **Its disposition is the opposite of the other three, which is why finding it matters rather
than merely embarrassing.** `lib/challenges/hub-fetchers.ts` reads *this pipeline's own
`pipeline_runs` history* to decide whether `/challenges` may keep promising that new challenges
will appear (`CHALLENGE_FEED_STALE_DAYS = 3`). **The dead cron is the instrument that makes that
page honest** — unscheduling it would freeze `lastOkDay` and remove the only thing that could ever
notice the host coming back. One run a day. **It stays.**

ⓘ Two Atlas service names were probed as a possible replacement
(`ChallengeService/SearchChallenges`, `/ListChallenges`); both returned **404 page not found**.
That is two guesses, not a survey — the Atlas service catalog is not known to us, so the honest
statement is *"not found on two probed names"*, never *"Atlas has no challenges"*.

## ⚠ A high-severity alert that needs no action

`get_pipeline_alerts()` reads `allday-pack-opens-backfill` at **64/113 runs failed (56.6%),
severity high**. It is a **window artifact of a deliberate decision, not a regression**: pg_cron
jobid 55 was unscheduled earlier the same day (AllDay is sunset; its ticks were dying at pg_net's
90 s wall and queueing every other pg_net request behind them). Its last run — 2026-09-03 21:56 PT
— was `ok=true` with 104 rows written, and every failure in the arm's 2-day window predates the
unschedule. **The arm self-clears around 2026-09-05 22:00 PT.** ⛔ Do not re-file it and do not
"fix" it. One grep of the ledger answered it, which is the second time in this pass that grepping
before filing was the entire job.

## 🚨 I shipped an RLS-off audit table, and the smoke gate caught it in seven minutes

The catalog push went red on GHA `smoke` — the only red in ten consecutive smoke runs —
at `rpc:check_public_security_invariants`: two audit tables created with a bare
`CREATE TABLE IF NOT EXISTS` landed with `relrowsecurity = false` and `anon` holding SELECT.
Closed by `20260905062849` (RLS on, anon/authenticated revoked); invariants re-read **0 rows**,
and smoke on the fix commit is green.

⚠ **My first write-up of this was wrong in both directions and is corrected in the ledger.**
Chasing why an earlier audit table the same night was compliant turned up a standing mechanism I
did not know existed: **`public.selfheal_audit_table_rls()`, pg_cron jobid 232, `47 * * * *`** —
it enables RLS and revokes `anon` on every `public.audit_%` table, hourly.

- The window was **~10 minutes**, not the "roughly two hours" I first wrote: created 06:18Z/06:20Z,
  closed by hand 06:28Z, and the healer would have closed them at 06:47Z anyway.
- It was **not** a convention I broke. **13 other migrations** create a public table with no inline
  RLS statement and are compliant *because the healer runs* — which is exactly why my
  sibling-table comparison read like a house style I had missed.

⭐ **The estate is better designed than my write-up credited it:** a self-healer bounds the window to
≤1 h unattended, and a hard smoke check names the offending objects the moment a deploy lands inside
it. Documented in `docs/reference/database.md` so the next reader does not re-derive it from a red
check. ⓘ I drafted a repo guard requiring inline RLS on every migration `CREATE TABLE` and **did not
ship it** — the scanner was still mis-parsing dynamic `format('CREATE TABLE … %I')` DDL, and shipping
an unvalidated guard in the same hour as this entry would have been the same mistake twice.

## Instrument trap found this pass — record it before it misleads someone

`select count(*) from public.check_secdef_anon_execute_violations()` returns **1** on a clean
estate, because the function returns a **single row containing an empty JSON array**. The same
holds for `detect_stalled_pipelines()`. **Read the value, never the row count** — a `count(*)`
here manufactures a violation out of a clean answer. Both read `[]` at close.

⚠ **And its sibling has the OPPOSITE empty shape.** `check_public_security_invariants()` is
**set-returning**: clean is **zero rows**, so a scalar subquery over it reads `NULL`, not `[]`.
Two security checks that look interchangeable disagree about what "clean" looks like — read each
one's shape before believing either. Both were clean at close (0 rows / `[]`).

## Post-ship watch

✅ **CLOSED before this session ended — `topshot-badge-set-backfill`.** Its former Vercel slot
`15 3,9,15,21` UTC = 20:15 PT fell inside this session. At 20:18 PT its newest `pipeline_runs` row
was still **14:15 PT** (the 21:15Z slot, which predates the deploy) — **no new row at the retired
slot**, so that retirement is confirmed deployed and effective, not merely committed.

⏳ **Still owed — `topshot-catalog-backfill`.** Its former slot is 02:12Z = 19:12 PT; the last row
is 19:12 PT **today**, which predates this deploy, so the first real test is **2026-09-05 19:12
PT**. A row there means the `vercel.json` edit did not deploy.

- `atlas-editions-refresh` `extra.editions_enriched` should trend **down toward single digits**
  as the backlog drains, and `atlas_set_refresh_state.last_error` must never carry an
  `editions-enrich:` prefix. One appearing is a bug in the spliced block, not an upstream fault.
- Description coverage is a **moving number** — re-measure it, never quote a figure from this document. It read 68.5% frozen, 71.4% eleven minutes after the splice, and **77.9% (2,973 NULL) ninety minutes later**; `/api/search`'s live `meta.note` had already picked it up at 72.3%.

## Housekeeping note for Trevor's box

The mount clone `C:\Users\TDill\rip-packs-city` is at `612e68767` and **cannot fast-forward from
this session** — `git merge` there fails with `unable to unlink old 'vercel.json': Operation not
permitted` (this session's shell has no delete permission on the mount). It also carries five
untracked `__tests__/*.test.ts` files that now exist in `origin/main` and will block a pull.
**On your box: delete those five untracked files (or `git checkout -- .` after `git stash -u`),
then `git pull`.** All work above was pushed from a separate clone, so nothing is lost.

**Revert:** `git revert 8481c72` restores the cron entry; the DB half re-splices the block out,
or restores the prior body from `public.audit_20260904_atlas_drain_prior_src`.
