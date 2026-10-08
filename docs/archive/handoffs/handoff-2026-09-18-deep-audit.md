# Claude Code handoff — 2026-09-18 monthly deep audit (run 5)

Full report: [docs/audits/deep-audit-2026-09-18.md](audits/deep-audit-2026-09-18.md). **Nothing was shipped.** The session had **no git push credential** throughout (`fatal: could not read Username`, exit 128 — no credential at all, not a 403; re-tested after recovery, unchanged). It also had **no database** for the first half (live Supabase outage ~05:48 AM – ~12:01 PM PT). **The DB recovered mid-audit**, so items 11–18 below come from sweeps B and C, which then ran in full — see PART TWO. Every item is unshipped and carries its own verification and revert path.

⚠ **Items 1–10 were written while the DB was down; items 11–18 after it returned.** Nothing in 1–10 was invalidated by the recovery — §9 of the report records the one risk I flagged that did *not* materialise, and §2's fabricated-zero P0 explicitly still stands.

⚠ **Register IDs R94–R99 were claimed against `origin/main == 52228549a` at 11:21 AM PT but NOT pushed.** Per the register's rule 11, re-check them against `origin/main` at the moment you push; if another session took one, the row pushed FIRST keeps the number and you renumber.

⚠ **The register rows and the audit report are UNCOMMITTED on the mount.** Commit the docs BEFORE any code so the code commit is the tip and auto-deploys.

---

## 1 · R96 — gate `/api/allday-pack-ev` POST (P1, security) — **and fix the forward in the same change**

> 🚨 **SUPERSEDED IN PART — READ THIS BEFORE ACTING.** A push-capable session analysed R96 at ~12:58 PM PT on 2026-09-18 and **correctly declined to ship it.** R24's gate is `callerInfluencedPrice && !persistAuthorized(req)`: it gates a **caller-influenced price**, and leaves data-derived writes anonymous *by design*. The child's writes are upstream-GraphQL-derived, so **mirroring R24 here would gate nothing** — my "R24 recurring on the copy-pasted sibling" label was wrong. The real issue is **anonymous write amplification**, which is a product call (hydrate-at-insert exists so an anonymous pack view fills the catalogue). ✅ **Still valid and still the first step: pass the `authorization` header through the `/api/pack-ev` forward** — no behaviour change until the child reads it. That session verified the forward is the **only in-repo caller** (0 hits in `vercel.json`, GHA, `cron.job`); cron-job.org and the box's Task Scheduler remain unenumerable from a sandbox. **Full analysis is on the R96 register row — do not re-derive it.**

**The defect.** `app/api/allday-pack-ev/route.ts` `POST` (line 360) has **zero** auth checks (`grep -cE 'requireUser|requireOwnedKey|INGEST_SECRET|CRON_SECRET|RPC_ADMIN_TOKEN|verifyBearer'` → **0**) and performs service-role writes: `editions` upsert (line 627) and `pipeline_runs` insert (line 640). It builds its own service-role client inline at lines 10–13 rather than importing `@/lib/supabase`, so it is outside any centralised client guard.

This is **R24 recurring on the copy-pasted sibling**. The parent `/api/pack-ev` already carries the fix — `persistAuthorized(req)` at ~line 432, gating on `CRON_SECRET` / `INGEST_SECRET_TOKEN`.

**Severity is narrower than R24 — do not over-fix.** `packPrice` is NOT persisted here (only used to compute the returned EV at lines 378/503/680), and `editions` row content comes from AllDay GraphQL, not the request body. The exposure is: an anonymous caller drives service-role upserts into the core catalogue and unbounded inserts into `pipeline_runs`, the estate's own health instrument.

🚨 **THE TRAP — VERIFIED, and it will break the AllDay pack-EV path if you miss it.** `/api/pack-ev` forwards to `/api/allday-pack-ev` when `collectionId === "nfl-all-day"`:

```ts
const forwardRes = await fetch(forwardUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },   // ← no Authorization passthrough
  body: JSON.stringify({ packListingId, packPrice: requestedPrice, packName }),
  cache: "no-store",
})
```

Gate the child and this authorised call starts 401ing. **Fix both halves in one commit.**

**Do.** Lift `persistAuthorized()` into a shared helper (or import it), apply it to the AllDay `POST`'s **write path** — matching the parent's shape, where the gate governs persistence rather than the whole handler, so the read/EV response still works for the UI — and forward the incoming `Authorization` header from `/api/pack-ev`.

**Before you gate anything, enumerate EVERY caller** (CLAUDE.md, and it has bitten twice): `/api/pack-ev`'s forward · any in-repo `fetch` of `allday-pack-ev` · `vercel.json` crons · GHA workflows · cron-job.org (invisible from a sandbox — check Trevor's console) · pg_cron (`cron.job.command`, DB-gated).

**Test.** Pin the property, not the spelling: an unauthenticated POST must not reach the `editions` upsert, AND an authorised forward from `/api/pack-ev` must still reach it. Assert the ABSENCE of the write, not the presence of a 401 message.

**Revert:** `git revert <sha>`. No DB change.

---

## 2 · The §2 headline — nine boards print fabricated zeros under their own "treat as unknown" banner (P0)

> ✅ **SHIPPED 2026-09-18 13:04 PM PT — `e79a38d42 fix(insights): KPI strips render the unavailable dash per-VALUE instead of fabricating zeros`.** Left here for the record and for the items it does *not* cover: §3 (the render-time stamps) and §4 (the concluding empty states) are still open. ⚠ **Its refutation test is still owed** — verify on a COLD pass during the next real failure, not warm.

**This is the most valuable finding of the pass and it is only observable while the DB is down.** Read §2 of the report for the screenshots and exact strings.

⭐ **The fix is per-VALUE, not per-panel.** On `/insights/top-sales`, inside ONE KPI strip: `TOP SALE` renders `—` correctly while `SALES SHOWN 0`, `COMBINED $0.00` and `NAMED PARTIES 0` fabricate. The honest form is already in that component, on that line of the page.

**Do.**
1. One shared KPI-value helper that renders `—` plus provenance when its source failed. `/insights/pack-reality` is the gold standard — copy its behaviour (*"THE FIGURES BELOW ARE UNAVAILABLE — THEY ARE NOT A READING OF THE MARKET"*, all six KPIs `—`).
2. **Grep for the EXPRESSION, not the file** (`?? 0`, `|| 0`, `$0.00` KPI defaults) — nine boards share this by copy-paste: `squeeze`, `offer-spread`, `candy-mlb`, `panini-squeeze`, `deals`, `top-sales`, `rookie-board`, `serial-premiums`, `cross-collection`.
3. ⚠ **The server-seeded-prop trap applies here** — `initial={rows}` arrives as `[]` with no provenance. Pass `initialFailed` and **assert it by SSR (`renderToString`)**; a mount effect corrects the state before jsdom looks, so two opposite mutations pass every client test.
4. Worst single string, fix first — `/insights/candy-mlb`: *"All 0 editions have now traded"* is a fabricated zero inside declarative prose, which a reader cannot discount the way they discount a KPI.

**Verify.** The DB is the only way to produce the failure naturally. Either re-test during the next outage, or force the failure in a test. ⚠ **Test a COLD pass** (#33) — ISR self-heals warm, so "is the page OK now" will pass while the defect stands.

---

## 3 · §2a — three boards certify their fabricated zeros with a live render-time stamp (P0)

`/insights/top-sales`, `/insights/rookie-board`, `/insights/serial-premiums` print `UPDATED SEP 18, 2026, 11:32 AM PDT` between the honest banner and the zeros. **The stamp is the RENDER time, not the DATA time.**

**Do.** Bind the stamp to the data's own timestamp, or render `—` when the read failed. `/insights/squeeze` already renders `UPDATED —` correctly — copy it.

⚠ **Do NOT chase "these print raw UTC to users."** My sweep D reported that and it is **REFUTED by screenshot** — the rendered value is PDT. Sweep D read pre-hydration SSR text.

---

## 4 · §2b — eight concluding empty states (P1)

Convert to the three-state form. Priority is `/insights/deals`: **"No editions listed below a trustworthy FMV match."** — a claim about *market quality* manufactured from a 503. Others: `squeeze`, `offer-spread`, `candy-mlb` (*"Showing all 0 matching editions"*), `panini-squeeze`, `rookies`, `set-squeeze`, `allday-scarcity`, `pinnacle-scarcity`.

**`/insights/market` is the proof case** — two panels on one page, opposite behaviour. Panel 1: *"Market index temporarily unavailable … This is not a quiet market; please retry shortly."* Panel 2: *"No volume in range."*

---

## 5 · R97 — widen `no-env-secret-in-fetch-url`'s walker; fix two secret-in-URL sites (P1)

**The guard's own root is silent.** `__tests__/no-env-secret-in-fetch-url.test.ts` sets `ROOTS = ["app","lib","scripts"]` but its `walk()` ends `else if (/\.(ts|tsx)$/.test(e))`. **`scripts/` holds 116 non-TS files** (93 `.mjs`, 7 `.ps1`, 6 `.sh`, 5 `.py`, 2 `.js`, 2 `.bat`, 1 `.awk`) — all invisible. `envBackedNames()` also matches only `const|let|var X = process.env.…`, so no shell/PS variable could be recognised even if read.

**Two live offenders:**
- `scripts/run-bulk-classify.sh:15` — `INGEST_SECRET_TOKEN` in a query string **inside a loop**, writing the token into our own Vercel access logs every iteration. ⚠ **Not fixable caller-side:** `app/api/bulk-classify/route.ts:89–92` reads the token **only** from `url.searchParams`; there is no header branch. Either add one (and move the script to a header) or retire the script.
- `scripts/atlas-pool-harvest.ps1:34` — same shape, into Supabase edge-function logs.

**Do.** Widen the extension filter; add a shell/PS detector (`[?&][A-Za-z_]+=\$[A-Za-z_]`). ⚠ **A not-vacuous check must be satisfiable at a population of zero** — assert the count it inspected and fail on zero inspected, not on zero found.

⚠ **`INGEST_SECRET_TOKEN` is shared across ~15 edge functions** (the repo's own comment). Rotation is already an open project; do not rotate as part of this.

---

## 6 · R98 — two smaller auth items (P2)

- **`/api/cache-refresh`** (`route.ts:219`) — unauthenticated `GET ?wallet=` drives service-role `upsert`/`update` on `wallet_moments` keyed by the raw param. Its comment claims a 50-moment cap; **line 391 `newIds.slice(0,50)` bounds step 6 (enrichment) only** — steps 2–5 page in 500-row chunks with no ceiling and the upsert at 344 writes all of `rows`. Not a confidentiality IDOR; an **unauthenticated write-and-IO amplifier** on an IO-bound Small instance. Bound the whole path, or gate it.
- **`/api/admin/announcements`** (`route.ts:22–27`) — `verifyBearer()` falls back to `?token=`, putting `RPC_ADMIN_TOKEN` into Vercel access logs. The identical fallback was already removed from `app/api/cron/sales-serial-backfill/route.ts:18–22`. **Confirm callers are header-only, then delete the fallback.**

---

## 7 · R99 — dead code (P1 / P2)

- **`lib/chains/flow/alldayGraphql.ts`** — 0 production importers, and it points at a **different endpoint** (`nflallday.com/consumer/graphql`) than the live `lib/chains/flow/allday.ts::alldayGraphql` (`public-api.nflallday.com/graphql`). It survives greps because the live symbol shares its basename. Flagged at 0 callers on 2026-05-30 in `docs/handoff-phase-d-lib-chains-flow-reorg.md:74` with *"confirm it's truly unused"* — confirmed now, negative. **Delete.**
- **Six test-only modules + four Cadence templates** — `components/PaywallModal.tsx`, `components/UpgradePrompt.tsx`, `components/profile/PriceAlertsCard.tsx`, `lib/logger.ts`, `lib/observability/sentry-quota-guard.ts`, `lib/chains/flow/cadence/purchase-moment-flow-wallet.ts` (zero importers at all), plus `gift-moment` / `make-offer-flowty` / `make-offer-topshot` / `purchase-moment` (dead by the read-only-product policy; `lib/cart/` is already gone). ⚠ **`PaywallModal` and `UpgradePrompt` are on `check-brand-tokens.mjs`'s `PROTECTED` list** — remove them from it in the same change. ⚠ **Deleting a module deletes its test, which moves the coverage ratchets** — take a baseline first.

---

## 8 · Cheap hygiene, all verified

- **`scripts/check-brand-tokens.mjs`** — (a) `LITERAL` at line 96 matches **single-quoted only**; a `fontFamily: "Barlow Condensed"` is invisible (current exposure zero, so this is latent). (b) The guard prints its two *scanned* counts and goes **silent on the debt count** — tree-wide it is **56 files / 136 un-excepted lines**. ⭐ *Print the number.* (c) `components/visual/ConsoleGreeting.tsx` has its `brand-exception` marker **4** lines above the hit; the window is 3 — harmless until the file is promoted to `PROTECTED`.
- **Two public `/insights` surfaces carry `"Barlow Condensed"` and are NOT on `PROTECTED`:** `app/insights/candy-mlb/CandyBoardClient.tsx`, `app/insights/panini-squeeze/PaniniSqueezeClient.tsx`.
- **Two stale test titles** — `__tests__/api-candy-sales-indexer-deep.test.ts:127` and `api-ingest-candy-offers-deep.test.ts:112` still say *"while the ME symbol is a TODO"*; it was ARMED 2026-07-19 and the tests drive a different property. Rename; assertions are correct.
- **`Math.random()` as a React key** — `app/insights/squeeze-check/page.tsx:206`, `app/insights/tc-report/page.tsx:271`.
- **`/api/ready` 504s with a raw unbranded Vercel page** during exactly the condition it exists to report (`maxDuration = 10`; its own comment records a 24,523 ms run beating an 8 s statement timeout). Status-code consumers still see a non-200; body consumers get HTML.
- **Register row corrections found while re-probing:** GH Actions is **62 `secrets.*` refs across 22 of 24 workflows** (row says 33 / 20) · `ci.yml` has **19** jobs (row says 10) · TODO/FIXME is at **6 hits, 0 real work** — sixth independent confirmation.

---

## 9 · Blocked on the DB — do these first when it returns

1. **The 15 security invariants** listed in §3 of the report. ⚠ `jsonb_array_length(check_secdef_anon_exec_drift())` → expect **0**; never `count(*)`, which reads clean at 1.
2. **`cron.job.command` credential scan** — the known-blind corpus (14 live `rpc_pls_` keys). Use `regexp_replace(command,'key=[^& '']+','key=REDACTED','g')`; **never select `command` raw** — it has burned a key into a transcript.
3. **Watchlist arms for the ten `dead-lane-backstop` lanes.** Those four backstop workflows are 100% `continue-on-error` *by documented design*, justified by *"whether the lanes actually ran is read from `pipeline_runs`"*. **That is an exclusion justified by another instrument — check that instrument can see the property.** Inbox 08-17 measured 62/149 pipelines unwatched; handoff 09-14 #102 says suppressions name `is_active=false` rows as active. **Do not file it as a workflow defect until this is derived.**
4. **The tier-breakdown RPC's casing** — gates the severity of `app/api/profile/tier-breakdown/route.ts:47`'s TitleCase `TIER_ORDER`, the exact shape that caused D23.
5. **Live serial-premium multipliers vs `components/HomePageMarketing.tsx:144`'s 12× / 4.5× / 3×.** Both figures in circulation are dated samples; they disagree; it is public marketing copy. **Re-derive, do not quote.**
6. **Deployed-vs-committed edge-function set** — 41 committed vs ~67 deployed; gates R21.
7. **A COLD-pass re-test of the nine boards** (#33) — never "is the page OK now".
8. **Sweeps B and C in full** — pipelines/schedulers and data integrity at population scale were not attempted this pass.

⚠ **Two guards failed for the outage, not for content:** `check-badge-art-registry-drift` (exit 2) and `detect-duplicate-cron-pipelines` (exit 1), both handed a Cloudflare HTML page. Re-run before reading either as drift.

---

## 10 · Needs Trevor, not code

1. **Approve Supabase + Vercel MCP for scheduled runs.** This pass lost sweeps B, C, most of A and all of F to a tool-approval setting. The outage would have blocked the DB sweeps today anyway — it will not next month, and the approval will still be missing.
2. **Report the outage to Supabase support** with the 522, the `cf-ray`, and **the `/storage/v1/bucket` → `544 DatabaseTimeout` in 5.1 s**, which is the sharpest artifact produced on this event and is what corrects the prior "Cloudflare could not reach origin" reading.
3. **Settle `mv_pack_ev_latest`** — `handoff-2026-09-05` marks the DISTINCT-ON rewrite DECLINED, `handoff-2026-08-31` lists it QUEUED. No session can resolve a contradiction between two of your own decisions.
4. **#22 credential-purge residue** — unchanged; GitHub GC request + rotate regardless.
5. **`.github/workflows/pipeline-sentinel.yml:5`** — the master alarm still rides GHA at `'34 * * * *'`, measured to deliver ~1 tick per 3h (R61's class). Moving it off GHA is a real decision, not a code cleanup.

---

# PART TWO — items found after the DB recovered (12:55 PM PT onward)

Sweeps B and C ran in full once the database came back. **Still nothing shipped: push was re-tested and still absent.** In part two I also had DB write access and deliberately used none — §11 below says why, and the reasoning matters more than the items.

## 11 · R105 — the homepage describes a pricing model we do not implement (P1, public copy)

`components/HomePageMarketing.tsx:144`, a `DEPTH_BULLETS` entry on the highest-traffic public page:

> *"Serial premium multipliers — 1-of-1 = 12×, low serials = 4.5×, last mint = 3×."*

The copy is ambiguous about whether it describes the market or our model, so **check it both ways — I did, and the answer differs per claim:**

| claim | our model (`lib/market-compute.ts`) | live market (90 d, n=108,058 TS sales) | verdict |
|---|---|---|---|
| 1-of-1 = 12× | ✅ `SPECIAL_SERIAL_MULTIPLIERS["#1 Serial"] = 12` (line 162) | #1 median 7.50×, mean 20.36× | **accurate as a model description — leave it** |
| low serials = 4.5× | ❌ no such constant; continuous power law `max(1.0,(serial/medianSerial)^exponent)`, ≈2.3× for a #10 of 100 Common | median **1.00×**, p90 2.58× (n=13,215) | **unsupported both ways** |
| last mint = 3× | ❌ **line 212 `if (serialNumber >= medianSerial) return 1.0`** — last mint is the maximum serial, so it can NEVER be premiumed. Model gives exactly **1.0×** | median 2.60× | **contradicted by our own code** |

**Do.** Rewrite the bullet to describe what the model actually does — a tier-exponent power law with edition-size dampening, plus named special-serial multipliers — or drop the numbers. ⚠ **Do not "fix" it by editing the constants to match the copy.**

⚠ **Separate and genuine, do NOT bundle it:** the market says the model **under**-prices last mint (2.60× observed vs 1.0× applied). That is a real FMV question and **autonomous pricing retunes are off-limits** — it needs Trevor.

⚠ Both the copy's 12/4.5/3 and the handoff's 9.89/1.50/5.00 are dated samples; neither reproduces today's data. **Re-derive; quote neither.**

## 12 · R100 — `price-snapshots` writes 1–6 of 24 hourly buckets a day, and the obvious fix is wrong

**Outcome table, 9 days** (`count(distinct bucket)` per PT day, of 24): `09-10 → 3 · 09-11 → 4 · 09-12 → 5 · 09-13 → 3 · 09-14 → 4 · 09-15 → 6 · 09-16 → 6 · 09-17 → 1 · 09-18 → 1`. Chronic, not new, not outage-related.

**Two causes.** (1) Its only caller is `.github/workflows/rpc-pipeline.yml` (`5,25,45 * * * *` = 72 ticks/day); GitHub delivered **5 ticks in 17.8 h** — the ~5/day ceiling. Nothing in `vercel.json` or `cron.job` calls it. (2) **4 of those 5 failed** on `populate_price_snapshots_hourly: canceling statement due to statement timeout` (30,191 ms).

🚨 **Do NOT just tighten the watchlist arm from 1800 min — that was the sweep's recommendation and reading the arm's own `notes` refutes it.** The note records that the loss was **already known and quantified on 2026-08-30 at 7 of 24** (now 18–23 of 24 — roughly tripled, unnoticed), and that the no-success arm was *"seeded 2026-09-04 from the pipeline's own ok-gap over ~73 h: max ok-gap 317 min"*.

⛔ **That is CLAUDE.md's named anti-pattern verbatim: a pin RE-DERIVED FROM THE OBSERVED STATE can never disagree with reality. Assert the DELTA it stood in for.**

**Do.** (a) Give it a real driver — a pg_cron lane like its peers, not the starved GHA path. (b) **Watch the OUTCOME: buckets-written-per-day against 24.** A silence arm is structurally blind to this at *any* threshold, because the lane can run, write one bucket, and look perfectly healthy.

`fmv-backfill` shares the driver, the starvation and an identical arm seeded the same minute — but its success reads `{"stage":"caught_up"}` 0/0, so it is **wasteful, not losing data (P2)**.

## 13 · R101 — `ts-listings-atlas-sync` loses 58.6% of ticks invisibly, and the register's diagnosis is now wrong

**09-17 12:00 → 09-18 05:48 PT (outage excluded):** 519 ticks, 304 failed. ⚠ **Only 1 was a `job startup timeout`** — the other 303 are statement timeouts inside `atlas_listing_verify_tick` at four sites (`count(*)` over `topshot_atlas_market_events` ×108 and ×40, `CREATE TEMP TABLE _tsl_want` ×58, `_cl_want` ×38). **known-issues #774 files this lane under the startup-timeout framing — correct that when you touch it.**

Invisibility is exact: **519 − 304 = 215 = the number of `pipeline_runs` rows, all `ok`.** Arm is `max_silent_minutes = 20`; surviving ticks average 5 min apart, so it can never fire. Load-correlated (0.3%–47% by day), not constant. Same shape on `rpc-allday-unmapped-atlas-resolver` (59%).

⚠ **Separate sub-case, different fix:** `rpc-atlas-market-drain` (119/517) times out **inside `SELECT public.log_pipeline_run(...)`** — the work may have completed and only the *logging* died. `rows_written`/`ok` cannot represent that.

## 14 · R102 — the cadence-collapse detector publishes a null it can fill

`check_pipeline_cadence_collapse()` lists 8 lanes `"stopped"` with `"last_run_at": null`, but `wallet-backfill` last ran **09-18 00:51 PT** — inside `pipeline_runs`' 73 h retention. The null is an artifact of the detector's 12 h scan window; the field name claims otherwise. **The #80 mirror defect inside a safety instrument.**

⭐ And the 7 `wallet-backfill*` lanes are **not stopped** — raw `extra` reads `{"reason":"12h_cadence_gate"}`; they ran post-recovery and correctly declined to dispatch. **Fix: emit the true `last_run_at` (or rename the field), and exempt `12h_cadence_gate` lanes from `stopped`.**

## 15 · R103 / R104 — two data items

- **R103 (P2):** **4,500 of 13,101 TS asks (34.4%) are older than `MAX_ASK_AGE_HOURS_CORROBORATION` (7 d)**; the measurement that set that threshold recorded **1.3%**. ~4.6-day refresh cycle. Ask-corroboration is structurally unavailable for a third of the catalogue. ⚠ **Eligibility is not gain and the sign is not one-way** — 1,565 LOW editions could promote (≈+2 to +3.5 pts at the 31% realisation rate) but **1,454 MEDIUM editions past the same bound can demote.**
- **R104 (P3 now, P1 on first read):** **`editions.badges` is an empty `text[]` on all 20,206 TS + AllDay rows.** Canonical display is `get_edition_badges_unified` ← `badge_editions` (healthy, 99.3% coverage). A column that is typed, never NULL and always empty returns "no badges" instead of an error. **Drop it, or comment it at the site as non-canonical.**

## 16 · Monitoring coverage — the answer to the question this pass owed

✅ **Every lane covered by the four 100%-`continue-on-error` backstops HAS an active watchlist arm with both a silence and a no-success arm. The documented exclusion is justified — do not file it as a workflow defect.** Two controls on the instrument: `active_arm_but_unseen_72h` = **0** (⚠ this **refutes handoff 2026-09-14 item #102**), `seen_but_arm_inactive` = 4, all deliberate.

**The residual is coverage: 28 primary lanes with no arm at all** (212 seen / 135 armed / 73 unarmed, of which 45 are heartbeats paired with an armed parent). 34.4%, improved from 41.6%, but the absolute count grew — **arms were not added alongside the 08-31 and 09-07 Atlas/observability waves**. Start with `atlas-editions-refresh` (503 runs/17.8 h) and `seed-wallet-refresh` (driver for 7 high-severity armed lanes). ⚠ **`sentinel` — the thing that reads the arms — has no arm on itself.**

**Also correct these standing claims when you touch the docs:** `job startup timeout` is **14%** of pg_cron failures, not 67–80% (statement timeouts are now 86%); **`pipeline-sentinel` at ~1 tick/3h is refuted** as of ~09-14 (29–30/day). The **~5-runs-per-workflow-per-day GHA ceiling HOLDS** (7.2% delivery).

⚠ **`gha-schedule-watchdog` is unfalsifiable during a DB outage** — it measures "did a GHA tick WRITE to our DB", so it reported today's Cloudflare outage as a GitHub failure and counted 60+ outage-blocked lanes as breaching, with `instrument_broken: false`. Give it a way to say "I cannot tell".

⚠ **`v_pipeline_failure_rates` cannot see an in-flight incident** — fed by the six-hourly `pipeline_runs_daily`. Correct by construction, stale by design. Caveat it wherever quoted.

## 17 · 👉 Fires in 5 days

`rpc-dune-free-tier-sunset` is a one-shot self-pause scheduled `0 12 23 9 *` that `UPDATE`s `dune_budget_state`. **2026-09-23.** Confirm that is still wanted.

## 18 · Why part two shipped nothing despite having DB write access

Stated so it does not read as an omission:

1. **The `price-snapshots` arm** — the obvious fix is the wrong fix (§12). Tightening it produces constant noise against a known-starved driver and is still blind to bucket loss.
2. **Arming the 28 lanes** — correct work, but 28 alarms appearing unannounced, with thresholds that each need the lane's real cadence, is not an unsupervised change.
3. **Any migration.** CLAUDE.md: a no-push session that runs `apply_migration` **reds `migration-parity` until the file is committed**. Every fix above needs a migration. **Breaking CI to ship a monitoring improvement is not a trade worth making.**

---

# PART THREE — QA of the fix that shipped, and the traction funnel

## 19 · R106 — 🚨 the P0 fix is 2 of 9 boards; `deals` still fabricates with the flag already in its props

`e79a38d42` fixed **`top-sales` and `squeeze`**. The finding was **nine boards**. **The fix itself is the right template** — SSR-asserted, asserts the ABSENCE of the false value, and carries a **no-change control** so it cannot degrade into "render — always" and destroy a true zero. Copy its shape.

⚠ **My first QA instrument was wrong, and that is the useful part.** I grepped `initialFailed`/`seedFailed` and read `squeeze` as unfixed — because the two boards were fixed **two different ways**: `top-sales` threads `initialFailed`, `squeeze` gates on `degraded?.failed?.length`. **Do not grep for an identifier. Ask whether the KPI computation consults ANY failure provenance.**

| board | state |
|---|---|
| `top-sales`, `squeeze` | ✅ fixed |
| `candy-mlb` | `degraded.failed` present — likely covered, confirm with a read |
| `rookie-board`, `serial-premiums`, `cross-collection` | `initialFailed` present; **whether it gates the KPI strip needs a read** — I am not filing a verdict a grep cannot support |
| **`offer-spread`, `panini-squeeze`, `deals`** | ❌ **no failure flag anywhere in the client** |

### Start with `deals` — smallest fix, sharpest defect

**VERIFIED.** `app/insights/deals/page.tsx:52` **already** passes `initialDegraded={degradedFromSource(source, "Below FMV board")}`. `DealsBoardClient`'s `kpis` useMemo (**line 319**) branches on `if (rows.length === 0)` → zeros, then `count: rows.length`. **It never reads `initialDegraded`.** Its `error` state (line 220 → rendered 520) covers only its **own refetch** (line 283), not the seed — **the server-seeded-prop trap verbatim.**

And `deals` is the board whose empty state says **"No editions listed below a trustworthy FMV match"** — a claim about *market quality* manufactured from a 503, with the flag that would prevent it sitting unused in its props. **A few lines.** Same SSR + no-change-control test shape as `e79a38d42`.

## 20 · The traction funnel — the sharpest business fact of the audit

47 sessions pasted a wallet in 30 days (66 events, 51 distinct inputs, max 3 per session — **not a handful of sessions**; I ran that refutation test and it survived). Same sessions, same window:

| step | sessions |
|---|---:|
| `wallet_paste` | **47** |
| `share_view` (the Top Collector Report) | **36 — 77%** |
| `insights_view` | 24 |
| `collection_view` | 23 |
| **`signin_click`** | **1** |

**77% of pasters reach the report. 2% click sign in.** The anonymous path works; the account wall converts essentially nobody. That is why `auth.users` is 28 and WAU is 3 while the tool gets used daily.

⚠ **Pin one definition before any decision rests on this:** is `share_view` the report render, or an inbound visit to a shared `/share/[wallet]` link? If the latter, it is an **acquisition** channel, not a conversion step, and the table means something different. **That is the single cheapest high-value thing to check.**

⚠ **A probe of mine that could not discriminate:** 8 of 51 inputs are Flow-shaped, 43 are usernames; `wallet_moments_cache` is keyed by address, so "only 8 resolve" is **not** evidence that 43 failed. The funnel table is the answer that probe was reaching for. **Do not quote the 8/51.**

## 21 · Resolved from Part Two — no action needed

- **The anon write-grant set is NOT drifting.** Enumerated: **5 objects, all INSERT-only except `portfolios`** (`email_subscribers`, `funnel_events`, `outbound_clicks`, `support_conversations`, `portfolios`). `portfolios` carries anon INSERT/UPDATE/DELETE but its `own_portfolio` policy is `ALL` USING `wallet_address = current_setting('request.jwt.claims')::json->>'wallet'` — **NULL for an anon request with no JWT, so the row is denied.** The register's "4 genuinely anon-insertable" is **unchanged**; the 20→5 move is in the GRANT count, i.e. revokes landed. ✅ **Close the "diff the membership next pass" flag — done.**
  ⚠ Residual, worth one line in a future pass: `portfolios`' safety rests entirely on nothing being able to mint a `wallet` claim. Worth confirming when someone next touches auth.
