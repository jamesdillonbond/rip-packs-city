# Claude Code handoff — 2026-09-18 monthly deep audit (run 5)

Full report: [docs/audits/deep-audit-2026-09-18.md](audits/deep-audit-2026-09-18.md). Nothing was shipped — the audit session had **no git push credential** (`fatal: could not read Username`, exit 128 — no credential at all, not a 403) and **no database** (live Supabase outage, ~05:48 AM PT onward). Every item below is unshipped and carries its own verification and revert path.

⚠ **Register IDs R94–R99 were claimed against `origin/main == 52228549a` at 11:21 AM PT but NOT pushed.** Per the register's rule 11, re-check them against `origin/main` at the moment you push; if another session took one, the row pushed FIRST keeps the number and you renumber.

⚠ **The register rows and the audit report are UNCOMMITTED on the mount.** Commit the docs BEFORE any code so the code commit is the tip and auto-deploys.

---

## 1 · R96 — gate `/api/allday-pack-ev` POST (P1, security) — **and fix the forward in the same change**

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
