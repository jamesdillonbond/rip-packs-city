# RPC monthly deep audit — 2026-09-18 (run 5)

**Window:** 2026-09-18, 08:20 AM – 2:30 PM PT, in two halves. **Shipped: NOTHING** — by *capability* in Part One (§0), by *judgement* in Part Two (§14).

🚨 **The database was in a total outage for the first half (~05:48 AM – ~12:01 PM PT, ≈6h15m) and recovered mid-audit.** Part One (§0–§7) is what could be learned without it — including a P0 that *only* a live outage can surface. **Part Two (§8–§14) is everything that was blocked**: sweeps B and C in full, the DB half of sweep A, and a positive control that settles the outage's cause. **Read §8 and §13 first.**

Prior runs: [run 4](deep-audit-2026-08-27.md) · [run 3](deep-audit-2026-08-22.md) · [run 1](deep-audit-2026-08-09.md). Register: [deep-audit-register.md](deep-audit-register.md).

---

## §0 — WHAT THIS PASS COULD NOT DO, STATED FIRST

Three capabilities were absent. None of them is a finding about the platform; all three bound every claim below.

| capability | state | consequence |
|---|---|---|
| **Supabase database** | 🚨 **LIVE OUTAGE** since ~05:48 AM PT, still down at 11:44 AM PT (≈5h50m) | Sweeps **B (pipelines)**, **C (data integrity at population scale)** and the **DB half of A (security)** and **F (traction)** are **UNVERIFIABLE-THIS-PASS**. Not attempted, not simulated. |
| **Supabase MCP tools** | Declined — *"no one was available to approve it during this scheduled run"* | Even had the DB been up, `execute_sql` / `get_advisors` / `apply_migration` were unavailable. **This is a scheduled-run approval setting, and it is the one thing Trevor could change to make the next run far more useful.** |
| **Vercel MCP tools** | Declined, same reason | `get_runtime_errors` unavailable — the error-cluster half of the outage analysis had to be rebuilt from direct HTTP probes. |
| **git push** | No credential (`fatal: could not read Username for 'https://github.com'`, exit 128 — **no credential at all, not a 403**) | **Nothing can be committed.** Per CLAUDE.md the push question is conditional and must be tested; it was. |

⛔ **So "ship the safe fixes" was not available this run.** Everything below is a report plus a handoff. The findings are deliberately written so the fixer does not have to re-derive them.

✅ **POSTSCRIPT, same day.** A push-capable session picked this report and handoff off the mount, committed them (`2120128c0`), and **shipped the §2 P0 at 13:04 PM PT — `e79a38d42 fix(insights): KPI strips render the unavailable dash per-VALUE instead of fabricating zeros`.** Its commit message confirms the diagnosis and sharpens it: `top` is null when nothing is priced so `fmtPrice` already rendered the dash, while `count`, `total` and `named` reduce to `0` and print as measurements — **the honest form was on the same LINE as the fabricated ones.** ⭐ **The handoff being specific enough to act on without re-derivation is what made that possible in under two hours.**

**What was still possible, and was done in full:** sweep **D** (rendered-DOM QA of the live site), sweep **E** (codebase/backlog reconciliation), the **code and credential half of sweep A**, the SEO half of **F**, and the register's non-DB probes.

---

## §1 — THE OUTAGE: one prior conclusion CORRECTED, one lead added

The 2026-09-18 ledger entry `#122` concluded the event is **"(b), platform-side"**, resting on: *"a CF 522 means Cloudflare could not OPEN a connection to the origin."*

**That mechanism is wrong, and one probe shows it.** VERIFIED 10:30 AM PT, all four through the same hostname, service-role key:

| endpoint | result |
|---|---|
| `/rest/v1/` (edge, no table) | **522** after 19.4 s — Cloudflare's own error page |
| `/auth/v1/health` | **522** after 19.4 s |
| `/rest/v1/collections?select=slug&limit=1` | **522** after 19.6 s |
| **`/storage/v1/bucket`** | **544** after **5.1 s** — `{"statusCode":"544","error":"DatabaseTimeout","message":"The connection to the database timed out"}` |

⭐ **The Storage API answered.** A real Supabase service returned its own JSON error through the same hostname in 5.1 s. **Cloudflare therefore CAN reach the origin.** The correct reading of the 522s is not "no connection to origin" but **"every Supabase service that needs Postgres is hanging, and Cloudflare cuts them off at ~19.5 s"** — Storage merely has a shorter internal DB timeout, so it gets its own answer out first and names the failure explicitly.

⚠ **This also weakens #122's own control, and the entry half-anticipated it.** #122 uses `/auth/v1/*` as the control that *"GoTrue does not read our tables"*. True — but GoTrue reads the `auth.*` schema **in the same Postgres instance**. So the control excludes *our query load on our tables*; it does **not** exclude a Postgres- or instance-level failure. #122 named exactly this as *"the one alternative my probes alone do not exclude."* **The Storage 544 moves that alternative from unexcluded to positively supported.**

✅ **What does NOT change:** the actionable half of #122 stands. `max_connections` exhaustion is still excluded (it returns *"sorry, too many clients already"* fast from a reachable origin). **Do not throttle pipelines, re-tune `fmv-recalc`, or chase the wallet-backfill back-pressure gap for this event.**

### A correlation worth one email, explicitly NOT asserted as cause

VERIFIED from `status.supabase.com/api/v2/summary.json` at 11:15 AM PT: overall **"Partially Degraded Service"**; the single non-operational component is **API Gateway = `degraded_performance`**; the one open incident is *"401 errors due to JWT rejections"* (opened 2026-08-14), whose latest update reads: *"our fleet requires a change to our deploy process … we will be implementing them throughout this weekend, **starting on Friday, September 18**."*

**That is today.** ⚠ **INFERRED, correlational only — a fleet deploy landing the same day as a 6-hour gateway degradation is a coincidence worth naming to support, not a cause.** *Refuted if:* Supabase's own post-incident report names an unrelated cause, or the degradation began before their change window.

👉 **This is Trevor's action and it is off-estate:** report to Supabase support with the 522 + `cf-ray` + **the Storage 544**, which is the most diagnostic artifact anyone has produced on this event.

---

## §2 — 🚨 THE HEADLINE FINDING (P0)

> **Nine public boards print fabricated zeros directly beneath their own banner telling the reader not to read zero.**

This is only observable during a real outage, and there is one running. It is CLAUDE.md's **"Fix per PANEL, not per page"** rule failing in production — and at a granularity finer than the rule is usually stated at: **it fails WITHIN a single KPI strip.**

**VERIFIED BY SCREENSHOT (the arbiter for numbers on this site), 11:32 AM PT — `/insights/top-sales`:**

- Banner: *"PARTIAL DATA — 1 of 1 section could not be loaded (Top sales). This is a temporary database-load failure, not an empty result — **treat the affected sections as unknown rather than zero**, and reload shortly."*
- Immediately below: `SALES SHOWN **0**` · `TOP SALE **—**` · `COMBINED **$0.00**` · `NAMED PARTIES **0**`
- Below that, correctly: *"TOP SALES COULDN'T BE LOADED — REFRESH TO TRY AGAIN."*

⭐ **The sharpest detail in the whole audit: `TOP SALE` renders `—` while its three neighbours in the same strip fabricate.** The honest form exists, in that component, on that line of the page. Three of four values do not use it. That is a copy-paste defect, not a design gap — and it means the fix is per-VALUE, not per-panel.

**VERIFIED BY SCREENSHOT, 11:41 AM PT — `/insights/squeeze`:** same banner; strip reads `EDITIONS 0` · `MEDIAN SQUEEZE 0%` · `MEDIAN BUYABLE 0` · `TOTAL LOCKED 0`; empty state reads *"NO EDITIONS MATCH THOSE FILTERS."*

**Blast radius — 9 of 24 public boards** (2 confirmed by screenshot above; the other 7 measured by sweep D from SSR text, labelled accordingly): `squeeze`, `offer-spread`, `candy-mlb`, `panini-squeeze`, `deals`, `top-sales`, `rookie-board`, `serial-premiums`, `cross-collection`.

**Worst single string, `/insights/candy-mlb`** — a fabricated zero inside declarative prose, which a reader cannot discount the way they can discount a KPI: *"FMV is auto-computed off live sales. **All 0 editions have now traded**, but most prices come off no more than a handful of sales."*

⚠ **Outage-EXPOSED, not outage-CAUSED.** The unwrapper is in the component and fires on any failed read. **Refutation test after recovery:** if these strips render `—`, the code is still wrong — it merely has no failure to expose. Test a **COLD** pass (per #33), never "is the page OK now".

### §2a — the aggravating factor (P0)

**`/insights/top-sales` prints `UPDATED SEP 18, 2026, 11:32 AM PDT` between the banner and the zeros** — VERIFIED by screenshot; 11:32 AM PT was the moment I loaded it. **The stamp is the RENDER time, not the DATA time, so it actively certifies the zeros as current.** Same shape on `/insights/rookie-board` and `/insights/serial-premiums`.

⚠ **CORRECTION TO MY OWN SWEEP D, recorded so it is not inherited:** sweep D reported these as *"the only user-facing surfaces printing a raw `UTC` clock"* (`Updated Sep 18, 2026, 18:32 UTC`). **That is REFUTED by screenshot — the rendered value is `11:32 AM PDT`.** Sweep D read pre-hydration SSR text. The *stamp-certifies-a-failed-read* half stands and is the real defect; the *raw-UTC-leak* half does not exist. `/insights/squeeze` renders `UPDATED —` correctly, so the honest form is already in the codebase.

### §2b — concluding empty states (P1)

**8 boards state a conclusion where a failed read belongs.** Sharpest, `/insights/deals`: **"No editions listed below a trustworthy FMV match."** — a claim about *market quality* manufactured from a 503. Others: `squeeze`, `offer-spread`, `candy-mlb` (*"Showing all 0 matching editions"*), `panini-squeeze`, `rookies`, `set-squeeze`, `allday-scarcity`, `pinnacle-scarcity`.

### §2c — what is working, and is the template

Credit where the canon held, all VERIFIED:

- **`/insights/pack-reality` is the gold standard** — *"THIS BOARD COULDN'T BE LOADED (HTTP 503). THE FIGURES BELOW ARE UNAVAILABLE — THEY ARE NOT A READING OF THE MARKET."* All six KPIs render `—`. **Copy this page.**
- **All five collection overviews: zero fabricated zeros.** KPI strip blank, *"Couldn't load collection stats right now."*, marketplace-status notice honest.
- **The API layer is clean** — `boardUnavailable()` is doing its job: `/api/public/insights/{squeeze,rookies,offer-spread,pack-reality}` and `/api/search` and `/api/collection-series` all return 503 with honest prose.
- **The OG card layer is exemplary** — `/api/og/insights/squeeze` → 200 PNG reading *"Couldn't load the live board — open the page for current data."* No numbers invented.
- **Detail pages are honest** once they render: *"Moment unavailable"*, *"Set unavailable"*, *"Player unavailable"*, *"Team unavailable"*.
- **SEO clean across 20 pages checked**: titles carry ` | Rip Packs City` **exactly once**; canonical present and self-referential on home, `/insights`, 7 boards, 5 overviews; `og:site_name`/`og:type`/`og:locale`/`twitter:card` each present exactly once — **no shallow-merge loss**.
- **ISR was NOT masking stale numbers.** The prerenders regenerated *during* the outage, so the **degraded** state is what got cached. Yesterday's lead is resolved and inverted. ⚠ The risk moved to the **recovery** side — see §5.

---

## §3 — SECURITY (code/credential half only; DB half unverifiable)

### R96 · P1 — `/api/allday-pack-ev` POST is completely ungated and performs SERVICE-ROLE writes

> 🚨 **CORRECTED SAME DAY BY ANOTHER SESSION, AND THE CORRECTION IS RIGHT — recorded here rather than quietly amended.** A push-capable Claude Code session read R96 at ~12:58 PM PT and **declined to ship it, for a reason that overturns my central framing.** R24's gate is `callerInfluencedPrice && !persistAuthorized(req)` — it gates persistence of a **caller-influenced price** and deliberately leaves data-derived writes anonymous (its own no-change control warns that over-flagging is *"an availability regression that would look like nothing at all"*). **The child's two writes are upstream-GraphQL-derived, not caller-influenced, so mirroring R24 literally would gate nothing.** ⭐ **"R24 recurring on the copy-pasted sibling" is the wrong label.** What this row actually describes is **anonymous WRITE AMPLIFICATION** — a different rule, and a product call, since hydrate-at-insert exists precisely so an anonymous pack view fills the catalogue. My "narrower than R24" caveat was pointing at this and did not go far enough. ✅ **What survived:** the ungated-write mechanism, and the forward-header trap — that session verified the `/api/pack-ev` forward is the only in-repo caller (0 hits in `vercel.json`, GHA or `cron.job`) and named passing the `authorization` header through it as the cheapest safe first step, exactly as handed off. ⚠ Two of the eight caller sources (cron-job.org, the box's Task Scheduler) remain invisible from a sandbox.


**VERIFIED.** `app/api/allday-pack-ev/route.ts` builds its own service-role client inline (lines 10–13, `createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`) rather than importing `@/lib/supabase`, so it sits outside any centralised client guard. `POST` (line 360) takes `packListingId` from the body and performs **zero** auth checks — grep for `requireUser|requireOwnedKey|INGEST_SECRET|CRON_SECRET|RPC_ADMIN_TOKEN|verifyBearer` over the file returns **0**. It then service-role `upsert`s `editions` (line 627) and `insert`s `pipeline_runs` (line 640).

⭐ **This is R24 recurring on the copy-pasted sibling.** The parent `/api/pack-ev` carries `persistAuthorized()` (lines ~432–440, gating on `CRON_SECRET` / `INGEST_SECRET_TOKEN`) — that was the R24 fix. The AllDay parallel, whose own header comment says *"NFL All Day parallel of /api/pack-ev"*, never got it. **CLAUDE.md: "grep for the EXPRESSION, not the file — it has spread by copy-paste five times now."**

**Severity is genuinely narrower than R24, stated so nobody over-fixes:** `packPrice` is **NOT persisted** here (grep confirms it is only used to compute the returned EV at lines 378/503/680); `editions` row content comes from AllDay GraphQL, not from the request body. What an anonymous caller gets is **service-role upserts into the core catalogue table and unbounded inserts into `pipeline_runs`** — the estate's own health instrument, which the sentinel and the daily rollup read. Ceiling is `proxy.ts`'s 60 req/min anon bucket.

🚨 **TRAP FOR WHOEVER FIXES THIS — VERIFIED, and it is exactly CLAUDE.md's "enumerate EVERY caller before gating a route":** `/api/pack-ev` **forwards** to `/api/allday-pack-ev` for `collectionId === "nfl-all-day"` with `headers: { "Content-Type": "application/json" }` — **no Authorization passthrough.** Gate the child without fixing the forward and the AllDay pack-EV path breaks for authorised callers. Fix both in one change.

⚠ Checked before filing: the file's own header gives no rationale; `allday-pack-ev` in the register is an unrelated `tierBreakdown` note; the 4 hits in `known-issues.md` are about the `compute-allday-pack-ev` **edge function**. **Unrecorded.**

### R97 · P1 — `no-env-secret-in-fetch-url` declares a root it structurally cannot read; 2 live offenders sit in it

**VERIFIED.** `__tests__/no-env-secret-in-fetch-url.test.ts` sets `ROOTS = ["app","lib","scripts"]`, which reads as coverage. Its `walk()` ends `else if (/\.(ts|tsx)$/.test(e)) out.push(p)`. **`scripts/` at `origin/main` holds 116 non-TS files — 93 `.mjs`, 7 `.ps1`, 6 `.sh`, 5 `.py`, 2 `.js`, 2 `.bat`, 1 `.awk` — every one invisible to the guard.** A second mechanism compounds it: `envBackedNames()` matches only `const|let|var X = process.env.…`, so no shell or PowerShell variable could be recognised even if the file were read.

Two offenders repo-wide:
- `scripts/run-bulk-classify.sh:15` — `INGEST_SECRET_TOKEN` in a query string, **in a loop**, writing the token into our own Vercel access logs on every iteration. ⚠ **Not fixable caller-side:** `app/api/bulk-classify/route.ts:89–92` reads the token **only** from `url.searchParams` — there is no header branch.
- `scripts/atlas-pool-harvest.ps1:34` — same shape, lands in Supabase edge-function logs.

⭐ This is the register's own *"ask what a passing guard is structurally SILENT about"* shape. The guard is rigorous in-corpus, which is precisely what makes the silent root read as coverage. **The corpus gap appears in no register row and none of the 925 audit/handoff/inbox docs scanned.**

### R98 · P2 — `/api/cache-refresh` — unauthenticated service-role write whose stated cap does not bound the stated risk

**VERIFIED.** `app/api/cache-refresh/route.ts:219` `GET` takes `?wallet=`, then service-role `upsert`s `wallet_moments` (344) and `update`s (304/474/548/658), every write `.eq("wallet_address", wallet)` on the raw query param. Lines 228–230 document the decision: *"no auth required (public for own-wallet refresh) … but cap enrichment to 50 moments per call to prevent abuse."*

**The cap is real and governs the wrong thing.** Line 391 `const toEnrich = newIds.slice(0,50)` bounds **step 6, enrichment only**. Steps 2–5 page `onChainIds` in 500-row chunks with **no ceiling**, and the `wallet_moments` upsert at 344 writes all of `rows`. Naming a whale wallet drives unbounded service-role writes and unbounded FCL fetches against an IO-bound Small instance. Not a confidentiality IDOR (public chain state, public address key) — an **unauthenticated write-and-IO amplifier**. ⚠ The comment is CLAUDE.md's *"decision not to act whose cost is stated with no number in it"* shape exactly.

### R98 · P2 — `/api/admin/announcements` accepts the admin token in a query string

**VERIFIED.** `route.ts:22–27` `verifyBearer()` checks the `Authorization` header **and falls back to** `searchParams.get("token") === expected`. The gate is real; the fallback path puts `RPC_ADMIN_TOKEN` into Vercel access logs. Same leak class D2b documents for pg_cron, and the identical fallback was explicitly removed from `app/api/cron/sales-serial-backfill/route.ts:18–22`. Cheap fix: delete the fallback once callers are confirmed header-only.

### Security — VERIFIED CLEAN today (re-run, not relayed)

Corpus `HEAD == origin/main == 52228549a`, worktree clean — **not** the 134-behind failure mode of run 3.

- **Credential grep over `origin/main`** (`eyJhbGciOiJ`, `sb_secret_`, `sb_publishable_`, `sk-ant-`, `AKIA…`, `ghp_…`, `github_pat_`, `re_…`, Telegram shape, `rpc_pls_`, `service_role`): **0 real hits.** Every hit is prose in `docs/**` describing the probe, or `__tests__/redact-secrets.test.ts` synthetics. `git remote -v` was never run.
- `Object.fromEntries(req.headers)` / `JSON.stringify(process.env)` / echoed `Bearer` in a `console.*`: **0**.
- **R40 (routes logging a key's LENGTH): confirmed still closed** — 0 sites, no new ones.
- **Driver-message leak**, all 10 spellings over 501 route files: 92 files / 160 sites, **54 under `app/api/admin|cron`, 38 behind an operator secret, 0 session-gated, 0 ungated** — every leak reaches an operator holding a token, never a visitor.
- **GitHub Actions: 62 `secrets.*` refs across 22 of 24 workflows** — all `Bearer ${{ secrets.X }}`, `env:` bindings or `with: token:`. **0 in a URL, 0 echoed.** ⚠ The register says 33 refs / 20 workflows (08-22); re-derived today it is **62 / 22 — nearly doubled and still clean**. Update the row.
- **IDOR over all 151 write routes** (not just `/api/profile/**`): 109 operator-secret-gated · 22 session-gated · 5 both · 2 RLS-only · 13 hand-reviewed → 6 legitimately anonymous and correctly bounded (`stripe/webhook` signature-verified, `bots/telegram` secret-token-compared, `auth/callback`, `track-click`, `track-funnel`, `pack-pulls` keyed by own `ip_hash`), 3 token-as-bearer email flows, 1 regex false positive, **3 genuine findings = R96/R98/R99**. `app/api/teams/follow` and all of `app/api/profile/**` derive the target from `user.id`, never a param. ⚠ Aliased imports were resolved (`supabaseAdmin as supabase` in `mcp/keys`, `rewards/summary`, `alerts/subscriptions`) rather than trusting the identifier name.
- **Edge functions at HEAD: 38 dirs + `_shared` committed, 36 distinct `Deno.env.get()` names, 0 hardcoded literals.** ⚠ **Bounded to the committed set** — R21 records ~67 deployed, 11 deliberately withheld because their deployed builds carry hardcoded credentials (5 unrotated `rpc_pls_`, 3 of them invoked 350–460×/day). Outside every guard and outside today's grep by construction. Unchanged, owner Trevor.

### ⚠ The credential result is clean over ONE corpus of six

The register's standing caution applies verbatim: on 2026-09-02 this probe returned its expected *"0 real hits"* while **14 live `rpc_pls_` gate keys sat in `cron.job.command`**, which lives only in the database.

| corpus | holds credentials | checkable today |
|---|---|---|
| `origin/main` | historically | ✅ **checked — 0 real hits** |
| `cron.job.command` (~14 HTTP jobs, `?key=` in URL) | **yes — 14 live keys** | ❌ DB down |
| Deployed edge source not in repo (~11 of ~67) | **yes — R21** | ❌ DB/MCP down |
| Vercel env | yes | ⚠ reachable, **deliberately not read** — never decrypt env values absent an explicit ask |
| GH Actions secret *values* | yes | ❌ write-only by design; refs verified clean instead |
| cron-job.org job URLs | yes | ❌ needs Trevor's console |
| Supabase/Vercel access **logs** | **yes** | ⛔ deliberately not read — *reading them is the leak* |

Plus **git history**: #22's credential-purge residue is unchanged — the deleted branch's blob stays fetchable by SHA until GitHub GCs it. Still Trevor's.

### Security invariants NOT re-run this pass — run these first when the DB returns

`check_public_security_invariants()` → 0 rows · `check_anon_write_surface()` → 0 rows · `jsonb_array_length(check_secdef_anon_exec_drift())` → **0** (⚠ read the LENGTH, not `count(*)` — a jsonb-array return reads clean at `count(*)=1`) · `rls_off_tables` → 0 · anon-readable views lacking `security_invoker` → 0 · anon/auth-readable matviews → 0 · foreign tables in `public` → 0 · extensions in `public` → 0 · trivially-true write policies reachable by anon/authenticated/PUBLIC → 0 · `has_table_privilege('anon',…)` set (last: 20 objects, 4 insertable) · `has_function_privilege('anon',…)` set (last: 81 of 659) · PII regex over anon-SELECT objects resolved against each SELECT policy · staged Panini/Candy anon-readability → 0 · **`cron.job.command` credential scan** (the known-blind one — use `regexp_replace(command,'key=[^& '']+','key=REDACTED','g')`, never select `command` raw).

---

## §4 — CODEBASE / BACKLOG (sweep E)

**Scope correction to the standing brief:** there are **73** root-level `docs/handoff-*.md`, not ~111 (another 430 are under `docs/archive/handoffs/`, frozen). **All 73 were read in full, no sampling.** The ledger has **no live Queued section** — `## Queued — ARCHIVE (frozen 2026-07-01)` is explicitly not the live queue; `## Declined — do not re-suggest` holds exactly 3 entries, none re-suggested here.

**Headline: the large majority of code-verifiable open items are already shipped and the handoffs simply went unreconciled.** Closed-in-source but still written as open across the older docs: `isTransient` 57014, all four AllDay-resolver items, sentinel 5a–5d, `PANINI_PUBLIC` wiring, Recent Sales nulls, `sync-sales-ingest-dune` retirement, candy-offers route, wallet capability 17/18, D1/D1b/D2/D7/D22/D27/D29/D30, R1/R2/R3, `/share` canonical, telemetry 405, home canonical, pack-sniper SSR, candy-mlb SPREAD panel, D12b, R24/R26/R28/R31/R32/R33/R35/R37/R38, funnel bot flag, and more.

### R99 · P1 — `lib/chains/flow/alldayGraphql.ts` is a dead duplicate pointing at a DIFFERENT endpoint

**VERIFIED** by resolved-module-path detection (the D30 method — resolve every specifier, never grep the identifier), with four positive controls that all fired.

| file | endpoint | production importers |
|---|---|---|
| `lib/chains/flow/allday.ts::alldayGraphql` | `https://public-api.nflallday.com/graphql` | **live** (3 routes) |
| `lib/chains/flow/alldayGraphql.ts::alldayGraphql` | `https://nflallday.com/consumer/graphql` | **0** |

⭐ **Strict D30-class instance: the file survives because the live SYMBOL shares its BASENAME, so a name grep reports it live.** `docs/handoff-phase-d-lib-chains-flow-reorg.md:74` flagged it at 0 callers on 2026-05-30 with *"confirm it's truly unused"* — that confirmation is now done and negative, 3.5 months later. Zero mentions in the register. *Refuted if:* a dynamic `import()` reference exists — both specifier forms were checked, none found.

### R99 · P2 — six production-dead modules kept alive only by their own tests

`prodImporters = 0, testImporters = 1` for each: `components/PaywallModal.tsx`, `components/UpgradePrompt.tsx`, `components/profile/PriceAlertsCard.tsx`, `lib/logger.ts`, `lib/observability/sentry-quota-guard.ts`, `lib/chains/flow/cadence/purchase-moment-flow-wallet.ts` (zero importers at all). Plus four Cadence templates test-only (`gift-moment`, `make-offer-flowty`, `make-offer-topshot`, `purchase-moment`) — **dead by standing policy** (read-only product; `lib/cart/` is already gone).

⚠ **`PaywallModal.tsx` and `UpgradePrompt.tsx` are both on `scripts/check-brand-tokens.mjs`'s `PROTECTED` list** — the brand guard is spending curated-list budget protecting components nothing renders. **None of the 11 carries a "deliberately retained" comment** (every header read). `PriceAlertsCard` is the odd one: alerts ARE live at `app/dashboard/alerts/`, so there is no policy reason for it.

### Other P2s, verified

- **Brand-token guard, logic + scope.** `scripts/check-brand-tokens.mjs:96` `LITERAL` regex matches **single-quoted only** — `fontFamily: "Barlow Condensed"` is invisible. Current exposure **zero** (the only double-quoted hits are the token module itself); latent. Scope: the guard hard-fails only for its curated `PROTECTED` list and prints *"Phase-2 debt … tracked separately"* **with no number**; tree-wide re-derivation gives **56 files / 136 un-excepted lines**, mostly OG/satori (a documented exception) and email HTML. ⭐ **The guard prints its two SCANNED counts and goes silent on the one that matters — cheap fix: print the number.** ⚠ Latent trap: `components/visual/ConsoleGreeting.tsx` has its `brand-exception` marker **4** lines above the hit; the window is 3.
- **⚠ Two public `/insights` surfaces are in Phase-2 brand debt and NOT on `PROTECTED`:** `app/insights/candy-mlb/CandyBoardClient.tsx` and `app/insights/panini-squeeze/PaniniSqueezeClient.tsx` carry `"Barlow Condensed"` literals.
- **`TIER_ORDER` — D23 is at 3 residual arrays, not closed.** `app/api/profile/tier-breakdown/route.ts:47` uses **TitleCase** `["Common","Fandom","Rare","Legendary","Ultimate"]` — the exact casing that caused D23's FMV-dashboard collapse (softer here: unmatched keys fall into `extras` and still render, unordered). Whether the backing RPC returns TitleCase or the UPPERCASE `tier_type` enum is **DB-only, UNVERIFIABLE-THIS-PASS** — that gates the severity. Also `lib/trophy-picker-format.ts:22` omits UFC's `CONTENDER`/`CHALLENGER`/`CHAMPION`, so `indexOf` returns `-1` for a UFC trophy.
- **`components/HomePageMarketing.tsx:144` publishes serial-premium multipliers 12× / 4.5× / 3×** against a handoff-recorded live model of 9.89× / 1.50× / 5.00×. ⚠ **Both are dated samples and the DB is down — re-derive before touching.** But they disagree, and this is public marketing copy.
  - ⛔ **CORRECTION 2026-09-18 PM (Claude Code cloud): DO NOT ACT ON THIS — it was already REFUTED on 2026-08-15 and the refutation is in the register** (known-issues, item 8's sub-bullet: *"the audit's 'homepage publishes multipliers the live model does not produce' P2 is WRONG"*). The homepage states `lib/fmv/serial-multiplier.ts` **verbatim** — the model the public `/api/fmv` actually calls; 9.89/1.50/5.00 are `serial_fmv_multipliers` ALL/ALL roll-ups from a **different subsystem**, and one scalar cannot stand in for that matrix. The real open finding is that two models disagree ~3× under one name, and that is recorded there. This run re-derived the same numbers and reached the refuted recommendation again — the register's *"a filed finding is a hypothesis; re-derive what it measured"* applies to audit findings too.
- **Ten sites report `ok:true` for a tick that did no work** — the nine `*-sales-history-backfill|*-unmapped-drain` cron routes plus `lib/studio-sales-history.ts:429`, each `logRun(..., true, 0,0,0, null, {skipped:"saturation"})`. Narrower than "invisible": `extra.skipped` **is** recorded, so an observer following the `extra`/`last_error` rule can discriminate. Missing is a distinct pipeline name or a sustained-throttle arm. Matches run-3 §5, still open as written.
- **`Math.random()` as a React key**, `app/insights/squeeze-check/page.tsx:206` and `app/insights/tc-report/page.tsx:271`.
- **Two stale test titles** (`api-candy-sales-indexer-deep.test.ts:127`, `api-ingest-candy-offers-deep.test.ts:112`) still say *"while the ME symbol is a TODO"*; the symbol was ARMED 2026-07-19 and the tests actually drive a different property. Assertions correct; only the names lie — **and CLAUDE.md says the tell is the TITLE**.

### Still open on `main`, verified, beyond the above

`supabase/functions/` holds **41** committed dirs vs ~67 deployed (blocks R21) · **84 references to `public-api.nbatopshot.com` across 68 files**, paused by DB suppression (renewed `20260914144523`), never ported · `lib/pipeline/upstream-breaker.ts:48` names a target that does not import it · **`mv_pack_ev_latest` DISTINCT-ON rewrite — ⚠ `handoff-2026-09-05` marks it DECLINED while `handoff-2026-08-31` lists it QUEUED; the two disagree and Trevor should settle it** · sentinel Detector Health still keys on the GHA run conclusion, not on `edge-fn-drift-report.json` presence · `snapshot-institutional-wallets/index.ts:255` still OFFSET-pages (ordered, so correct; cost is the item) · edge `_shared` convergence never applied · Dune item 7c `source` never populated (0 hits) · `stampLastRefreshed` hoist (~11 call sites) · Q-SCB claimable partial indexes unbuilt · `app/api/candy-listings-indexer/route.ts:37 maxDuration = 300` against measured 344–391 s sweeps · **`.github/workflows/pipeline-sentinel.yml:5` — the master alarm still rides GHA at `'34 * * * *'`, which was measured to deliver ~1 tick per 3h** (R61's class).

### Guards and CI — all green

**TODO/FIXME tree-wide: 6 hits, 0 real open work** (4 are prose describing resolved items; 2 are the stale test titles above). **Sixth independent confirmation the backlog is drained** — the register row says 6 and should be re-stamped.

All nine documented CLAUDE.md rules already have a repo guard and **every one is green**: PostgREST cap / `fmv_snapshots` DESC+dedup, unchunked `.in(`, `rows.length` as a total, batch-insert 23505, `.ilike` on an enum, brand tokens, `.range()` without `.order()` (BUDGET=0), fabricated divisor (ban at zero, 6 roots contributing). Corroborating guards also green: `check-unbounded-server-reads` (183 files, 0), `check-unhandled-third-state` (1361, 0), `check-driver-message-leaks` (601 handlers, 0 ungated), `check-register-integrity` (130 rows), `check-retired-rules`, `check-memory-doc-links` (214), `check-responsive-flex-basis` (1281), `check-lane-egress` (11), `guards-use-the-shared-comment-stripper` (7/7).

⚠ **Two guards failed for the outage, not for content** — `check-badge-art-registry-drift` (exit 2) and `detect-duplicate-cron-pipelines` (exit 1), both handed a Cloudflare HTML page. **Expected under the outage; do not read as drift.**

**CI: `ci.yml` has 19 jobs** (register says 10 — it has grown: `changes`, `memory-docs`, `docs-tests`, `inherited-status`, `typecheck`, `eslint-ratchet`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests-shard` ×2, `unit-tests`, `component-tests`, `worker-tests`, `workers-typecheck`, `db-tests`, `ledger-guard`, `register-guard`, `inbox-guard`, `tree-corruption`, `edge-deno`). **`continue-on-error` in `ci.yml`: ZERO** — the three occurrences are comments recording how to revert a promotion.

**`bash -e` fallible-assignment sweep:** 86 command-substitution assignments, 26 without a `||` fallback → 11 are `$((arith))` (regex false positives), 11 end in an infallible builtin whose status is the pipeline's last, leaving 4 candidates, **all of which resolve safe** (GitHub's default `run:` shell is `bash -e {0}` *without* `pipefail`). The one genuinely fallible bare assignment, `ci.yml:680 FD=$(node "$FUTD" "$LEDGER")`, **fails loudly, which is the script's stated intent** — not a defect. ⚠ Recorded because two shapes *read* wrong and are right: `workers-typecheck` puts its fallible `tsc` inside an `if` condition (where `-e` is suspended, so the tally is live), and six blocks write `set -uo pipefail`, which **does not clear the `-e` already set** by the invocation.

**Four GHA backstop workflows are 100% `continue-on-error` with no terminal gate** (`dead-lane-backstop`, `sales-indexers-backstop`, `snapshot-institutional-wallets-backstop`, `wallet-backfill-backstop`) — **deliberate and documented** (`dead-lane-backstop.yml:99–101`: *"a red badge here would compete with the real alarm … whether the lanes actually ran is read from `pipeline_runs`"*). ⚠ **That is an exclusion justified by another instrument, which CLAUDE.md says must itself be checked.** The check — do those ten lanes have `pipeline_cadence_watchlist` arms that fire on silence? — is **DB-only, UNVERIFIABLE-THIS-PASS**, and it is live-relevant (inbox 08-17 measured 62/149 pipelines unwatched; handoff 09-14 #102 says suppressions name `is_active=false` rows as active). **Do not file it as a workflow defect until that is derived.**

---

## §5 — MONITORING (P2, mine)

**`/api/ready` returns `504 FUNCTION_INVOCATION_TIMEOUT` with a raw, unbranded Vercel HTML error page** — VERIFIED 10:30 AM PT, 10.4 s.

The route sets `maxDuration = 10` and its own header comment records that *"the 24,523 ms run BEAT a `SET LOCAL statement_timeout = '8s'`"* under IO pressure. So during exactly the condition a readiness probe exists to report, the lambda is killed before the route can return its honest `status:"error"` JSON.

**Both sides, stated:** consumers reading the **status code** (which the route's own comment says is what the monitoring consumers read) still get a non-200, so the contract is not fully broken. Consumers reading the **body** get HTML. Not P1 — but the probe cannot say "not ready", it can only die, and the page a human lands on is unbranded.

---

## §6 — VOID PROBES (recorded so nobody re-chases them)

1. **Mine.** `/api/collection-series?collection=nba_top_shot` → `400 {"error":"Unknown collection"}` looked like a failed read rendering as a caller error. **It is my own probe error** — the param takes the URL slug (`nba-top-shot`), not the long-form DB convention. With the correct slug all three collections return an honest `503`. ⭐ Same class as the ledger's `movers` note: **a 400 from a param you invented is not a finding.** The route's source, incidentally, is a model of the three-state rule and carries 20 lines of comment explaining why `.single()` → `.maybeSingle()` was load-bearing.
2. **Sweep D's "raw UTC clock" on three boards** — REFUTED by screenshot; the rendered value is `11:32 AM PDT`. Pre-hydration SSR text was read. (The stamp defect itself is real — §2a.)
3. **Sweep D's `/insights/pack-market` → 404** — that route does not exist; the real ones are `/insights/topshot-pack-market` and `/insights/allday-pack-market`. No broken inbound link found.
4. **`/api/market-pulse` → 307 → `/login`** — correct gating, not a defect.
5. **`snapshot-institutional-wallets` `.range(from,to)`** — carries a deterministic `.order()`; this is an OFFSET-cost item, not a correctness one, and the ban-at-zero guard is green.
6. **`/api/best-offers` truncation** — refuted by the filing's own author: `CHUNK = 500` vs the one caller's `CHUNK_SIZE = 200`, so the loop body runs once and `break ≡ continue`. `__tests__/best-offers-chunking-cannot-truncate.test.ts` pins the inequality and passes. (The *failed-read-renders-as-"no bid"* half is separately open and already filed.)
7. **`(count ?? 0) > SATURATION_FAIL_THRESHOLD` × 10** — fully explained by a 10-line comment at every site and gated by `if (throttleErr) throw` one line above; `saturation-throttle-reads-its-error.test.ts` passes 5/5.

---

## §7 — PRIORITIES

**For Trevor, in order:**

1. **Approve Supabase + Vercel MCP for scheduled runs.** This pass lost sweeps B, C, most of A and all of F to a tool-approval setting, not to the outage. The outage would have blocked the DB sweeps anyway *today* — but it will not next month, and the approval will still be missing.
2. **The Supabase outage is off-estate and needs you** — report to support with the 522, the `cf-ray`, and **the Storage `544 DatabaseTimeout`**, which is the sharpest artifact anyone has produced on this event. Note the JWT-incident fleet change scheduled to begin today (§1) — as a question, not an accusation.
3. **Settle the `mv_pack_ev_latest` DISTINCT-ON contradiction** — two handoffs disagree (DECLINED vs QUEUED) and no session can resolve it.
4. **#22 credential-purge residue** — unchanged, still needs GitHub GC + rotation regardless.

**For the next code-capable session, in order:** R96 (with the forward-header trap) → the §2 KPI-value fix → §2a stamps → §2b empty states → R97 → R98 → R99.

**For the first DB-capable session:** the 15 security invariants in §3 · watchlist arms for the ten `dead-lane-backstop` lanes · the tier-breakdown RPC's casing · live serial-premium multipliers vs the homepage's 12×/4.5×/3× · deployed-vs-committed edge set · **and a COLD-pass re-test of the nine boards after recovery** (per #33 — never "is the page OK now").

⚠ **One recovery-side risk, noted because it is easy to miss:** the degraded renders are now cached `HIT`. When the DB returns, those pages keep serving *"temporary database-load failure"* until `revalidate` expires.

---

---

# PART TWO — 12:55 PM PT onward: the DB recovered mid-audit

**The outage ended.** First successful read **12:55:37 PM PT** (200 in 0.2 s). Sweep B pinned recovery tighter from `pipeline_runs`: last pre-recovery minute **11:58**, then 12:01 (3 pipelines) → 12:03 (12) → 12:11 (30 distinct). **Reads resumed ~12:00–12:03 PM PT; total outage ≈ 6h15m** (05:48 → ~12:01).

The Supabase MCP also became available (Trevor present to approve). **Sweeps B and C were then run in full, and the DB half of sweep A was completed.** Push remained unavailable throughout — re-tested, same `fatal: could not read Username`, exit 128. **So this pass still shipped nothing, and that remains a capability limit, not a judgement.**

## §8 — THE OUTAGE: the positive control nobody had, and it is decisive

⭐ **Postgres served its own scheduler continuously through the entire outage.** VERIFIED from `cron.job_run_details`, split on the outage boundary:

| window | ok | statement timeout | startup timeout | fail rate |
|---|---:|---:|---:|---:|
| pre (09-17 12:00 → 09-18 05:48 PT) | 5,973 | 627 | 102 | **10.9%** |
| **in-outage (05:48 → 12:01)** | **2,313** | **0** | **0** | **0.0%** |
| post (12:01 → 12:57) | 380 | 2 | — | 0.5% |

`pipeline_runs` agrees: **49 distinct pipelines logged runs during the outage**, 163–168 runs/hr against a 103–151/hr baseline.

🚨 **This is the control both #122 and Part One said could not be taken, and it settles the question.** pg_cron's success rate did not merely hold — it **improved to 100%** while external reads were refused. An instance starved badly enough to refuse TCP does not run its own scheduler flawlessly for six hours. **"Our query load pinned the database" is now positively excluded, not merely unsupported.** Combined with the Storage `544` (§1), the failure was **edge/reachability only**.

⚠ **This also corrects Part One's own §1 inference.** I wrote that the Storage 544 *"moves the instance-level alternative from unexcluded to positively supported."* **That was too strong.** The pg_cron control excludes instance-level starvation outright. The accurate statement: **Cloudflare reached the origin, Postgres was healthy and serving internal work, and the layer between them — Kong/PostgREST/GoTrue reachability — is where the failure sat.** I am recording my own over-reach rather than quietly dropping it.

**Egress was broken too** (new, and it is the only in-outage failure signal): exactly two pg_net lanes account for every in-outage failure — `atlas-market-feed` 169/172 (98%, vs 0.6% pre) and `atlas-editions-refresh` 170/170 (100%, vs 0.2% pre). **Both fully recovered.** NOT-A-FINDING — but a 2-day pooled rate for either reads ~33% and is meaningless today.

**Nothing identifies a pinning reader**, and the in-outage profile is *cleaner* than baseline — the opposite of a saturation signature. ⛔ No cause asserted beyond the layer.

## §9 — ✅ THE RECOVERY-SIDE RISK I FLAGGED DID NOT MATERIALISE

Part One warned the degraded renders were cached `HIT` and would keep serving *"temporary database-load failure"* past recovery. **VERIFIED false — all 10 boards serve real data, no degraded copy:**

`squeeze` HIT age 206 · `offer-spread` PRERENDER · `candy-mlb` HIT 154 · `panini-squeeze` HIT 234 · `deals` HIT 133 · `top-sales` PRERENDER · `rookie-board` HIT 376 · `serial-premiums` PRERENDER · `cross-collection` PRERENDER · `pack-reality` HIT 1608 — **all 200, none containing degraded copy.** Public APIs 200 with fresh `fetched_at` (19:56Z). **A flagged risk that did not happen, recorded as such.**

⚠ **This does NOT clear §2.** The fabricated-zero code is unchanged; it simply has no failure to expose now. §2 stands exactly as written and its refutation test is still owed on the next failure.

## §10 — SECURITY: the DB half, now complete

**Every invariant clean** (VERIFIED 12:55 PM PT): `rls_off_tables` **0** · `check_public_security_invariants()` **0 rows** · `check_anon_write_surface()` **0 rows** · `jsonb_array_length(check_secdef_anon_exec_drift())` **0** · anon-readable views lacking `security_invoker` **0** · anon/auth-readable matviews **0** · foreign tables in `public` **0** · extensions in `public` **0** · trivially-true write policies reachable by anon/authenticated/PUBLIC **0** · anon-readable staged Panini/Candy **0**.

**Two counts moved — diffed as SETS, not counts:**
- **anon EXECUTE: 82 of 761** (register: 81 of 659). Total functions grew **+102**; anon-exec grew **+1**. Resolved by enumerating the set: **every anon-executable function carries a pinned `search_path`, and exactly one writes — `trim_recent_searches`, `search_path=public`, SECURITY INVOKER.** That matches the register's recorded disposition ("the 1 writer is a trigger fn, INVOKER") exactly. **No drift.**
- **anon write-grant objects: 5** (register: 20 objects, 4 genuinely insertable). A large SHRINK. ⚠ Not re-derived to the object level this pass — **flagged for the next pass to diff the membership**, since a shrink is as much a set change as a growth and the register's row is now wrong either way.

## §11 — PIPELINES (sweep B) — findings

### R100 · P1 — `price-snapshots` writes 1–6 of 24 hourly buckets a day, and its alarm was calibrated FROM the broken lane

**VERIFIED by the OUTCOME table, 9 days** (`count(distinct bucket)` per PT day, out of 24):
`09-10 → 3 · 09-11 → 4 · 09-12 → 5 · 09-13 → 3 · 09-14 → 4 · 09-15 → 6 · 09-16 → 6 · 09-17 → 1 · 09-18 → 1`

⚠ **Correction to sweep B's headline, which said "1 bucket/day for ≥5 days":** the true shape is **never more than 6 of 24, usually 3–6, and 1 on each of the last two days.** Chronic, not new — and worse lately.

**Two causes, both verified, neither outage-related:**
1. **Driver starvation.** Its only caller is `.github/workflows/rpc-pipeline.yml` (`cron: "5,25,45 * * * *"` = 72 ticks/day). Nothing in `vercel.json` or `cron.job` calls it. GitHub delivered **5 ticks in the 17.8 h pre-outage window** — the ~5/day ceiling, re-measured and still binding.
2. **4 of those 5 failed:** `ok=false, duration_ms=30191, error="populate_price_snapshots_hourly: canceling statement due to statement timeout", extra={"stage":"rpc"}`. The one success wrote 14 rows for one bucket.

⭐ **THE SHARP PART, and it is why sweep B's recommended fix is wrong.** Sweep B proposed tightening the watchlist arm from 1800 min to ~120. **Reading the arm's own `notes` field first — the cheap check — refutes that:**

> *"Hourly OHLC bucket writer … a 504 under pooler saturation (the documented failure for this endpoint, **which had already cost 7 of 24 hourly buckets**) was indistinguishable from a healthy hour … **| [NO-SUCCESS ARM seeded 2026-09-04 from the pipeline's own ok-gap over ~73 h: max ok-gap 317 min -> GREATEST(3x, 2x max_silent)]**"*

Two things follow. **(a) The bucket loss was already known and quantified on 2026-08-30 at 7 of 24 — it has since roughly tripled to 18–23 of 24, and nothing noticed.** **(b) The arm is not loose by oversight; it was DERIVED FROM THE SICK LANE'S OWN OBSERVED GAP.** That is CLAUDE.md's named anti-pattern verbatim: ⛔ *"A pin RE-DERIVED FROM THE OBSERVED STATE can never disagree with reality: assert the DELTA it stood in for."*

**So the correct fix is not a tighter silence arm** — the lane can run, write one bucket, and look perfectly healthy. **Watch the OUTCOME: buckets-written-per-day against 24.** A silence arm structurally cannot see this defect at any threshold.

⛔ **I did NOT change the arm.** Tightening it would have produced constant alarm noise against a known-starved driver while still not detecting bucket loss — the weak-fix-crowding-out-the-strong-one trap. **Handed off instead.**

`fmv-backfill` shares the driver, the starvation and the identical 1800/3600 arm seeded the same minute, but its one success read `{"stage":"caught_up"}` with 0/0 rows — **wasteful, not losing data. P2.**

### R101 · P1 — `rpc-ts-listings-atlas-sync` loses 58.6% of ticks invisibly, and the register's diagnosis is now WRONG

**VERIFIED, 09-17 12:00 → 09-18 05:48 PT (outage excluded):** 519 ticks, 304 failed (58.6%). ⚠ **Only ONE was a `job startup timeout`** — the other 303 are `canceling statement due to statement timeout` inside `atlas_listing_verify_tick` at four sites. **Known-issues records this lane under the startup-timeout framing (#774); do not carry that forward.**

The invisibility is exact: **519 − 304 = 215, and `pipeline_runs` holds exactly 215 rows with 0 failures.** The lane reports 100% health while losing 3 of every 5 ticks; its arm (`max_silent_minutes = 20`) cannot see it because surviving ticks average 5 min apart.

12-day trend: **load-correlated, not constant** (0.3%–47% by day; 0% on 09-06/07 at creation). Same shape on `rpc-allday-unmapped-atlas-resolver` (122/207 = 59%). ⚠ Distinct sub-case: `rpc-atlas-market-drain` (119/517) times out **inside `SELECT public.log_pipeline_run(...)`** — the work may have completed and only the *logging* died, a silent-loss shape `rows_written`/`ok` cannot represent.

### R102 · P2 — the cadence-collapse detector reports `last_run_at: null` for lanes whose last run it knows

`check_pipeline_cadence_collapse()` lists 8 lanes as `"stopped"` with `"last_run_at": null`. **`wallet-backfill` last ran 09-18 00:51 PT — inside `pipeline_runs`' 73 h retention and plainly readable.** The null comes from the detector's 12 h scan window; the field name claims otherwise. **That is CLAUDE.md's mirror defect (#80, "an `unknown` that is actually KNOWN") inside a safety instrument.**

⭐ **And the 7 `wallet-backfill*` lanes are not stopped at all** — raw read: `12:27:14 PT seed-wallet-refresh ok extra={"reason":"12h_cadence_gate", …}`. They ran post-recovery and **deliberately declined to dispatch, inside a designed 12 h gate.** This is exactly the trap the brief warned about: "did not resume after recovery" would have been a false P0 here. **NOT-A-FINDING as a lane; P2 as a detector defect.**

### ✅ The DB-gated question this pass owed — ANSWERED, and it refutes a prior claim

**Do the lanes covered by the four 100%-`continue-on-error` backstops have watchlist arms that fire on silence? YES — every one, `is_active = true`, with both a silence arm and a no-success arm.** The documented exclusion ("whether the lanes actually ran is read from `pipeline_runs`, not this workflow's badge") **is justified.** `ufc-sales-indexer` is the sole inactive arm and its workflow step was deliberately removed to match.

**Two controls on the instrument itself:**
- `active_arm_but_unseen_72h` = **0**. ⚠ **This REFUTES handoff 2026-09-14 item #102's claim that suppressions name `is_active=false` rows as active** — no such row exists today.
- `seen_but_arm_inactive` = 4, all deliberate.

**The residual gap is coverage, not correctness.** Re-measuring the inbox 08-17 figure: **212 pipelines seen in 72 h, 135 active arms, 73 with no arm — of which 45 are `*-heartbeat` paired with an armed parent, leaving 28 PRIMARY lanes unarmed. 34.4% unwatched, improved from 41.6%, but the absolute count grew.** Most are from the 08-31 / 09-07 Atlas and observability waves — **arms were not added with the lanes.** Notably `atlas-editions-refresh` (503 runs/17.8 h) and `seed-wallet-refresh` (driver for 7 high-severity armed lanes) are unwatched, and **`sentinel` — the thing that reads the arms — has no arm on itself.**

### Standing pipeline claims, re-measured

| standing claim | re-measured (09-17 12:00 → 09-18 05:48 PT) | verdict |
|---|---|---|
| `job startup timeout` = 67–80% of pg_cron failures | **102 / 729 = 14%**; statement timeouts now 86% | 🚨 **SHIFTED — stop quoting 67–80%.** The *writes-nothing* half holds exactly |
| GitHub honours ~5 scheduled runs/workflow/day | `dead-lane-backstop-heartbeat` 09-11→09-17: 8,9,7,5,6,7,6 vs 96 scheduled = **7.2% delivery** | **HOLDS.** Every GHA cron above ~5/day is a false document |
| `pipeline-sentinel.yml` delivers ~1 tick per 3 h | 09-14→09-17: **29, 29, 30, 29**/day vs 24 scheduled | **REFUTED as of ~09-14** — now ≥hourly. ⚠ INFERRED: counts include `workflow_dispatch` |

⚠ **One instrument defect found in the watchdog:** `gha-schedule-watchdog` published *"github actions has delivered no schedule-tagged tick in 418 min … 61 cadence lane(s) breaching"* during the outage. **Its verdict is unfalsifiable while reads are down** — it measures "did a GHA tick WRITE to our DB", so it reported a Cloudflare outage as a GitHub failure and counted 60+ outage-blocked lanes as breaching, with `instrument_broken: false` throughout. Self-cleared 12:38 PM PT.

⚠ **`v_pipeline_failure_rates` could not see the outage** — it is fed by the six-hourly `pipeline_runs_daily`, whose `refreshed_at` read 11:11 AM PT, mid-outage. Correct by construction, stale by design; **not the instrument for an in-flight incident.** Worth a caveat wherever it is quoted.

⚠ **Five days' notice:** `rpc-dune-free-tier-sunset` is a one-shot self-pause scheduled `0 12 23 9 *` that `UPDATE`s `dune_budget_state`. **It fires 2026-09-23.**

## §12 — DATA INTEGRITY (sweep C) — the headline metric did NOT fall

✅ **Reproduced against the production definition** (`get_collection_stats`, migrations `20260902054902` + `20260906174049`), hand query matching the live RPC exactly:

| collection | editions | priced | FMV % | **HIGH/MED %** |
|---|---:|---:|---:|---:|
| nba_top_shot | 14,016 | 13,689 | 97.7 | **52.0** |
| nfl_all_day | 6,190 | 5,383 | 87.0 | **27.5** |
| candy_mlb | 125 | 125 | 100.0 | **59.2** |
| disney_pinnacle *(render grain)* | 2,600 | 2,445 | 94.0 | **28.0** |
| laliga_golazos | 575 | 503 | 87.5 | 0.7 *(settled)* |
| ufc_strike | 518 | 381 | 73.6 | 0.0 *(settled)* |

🚨 **The 09-14 figures of "TS 58.1 / AD 29.9" were the TOP of the range, not a level that has since been lost.** `rpc_trust_health_history`, 10 days, n=27: **TS 44.8–59.2 (mean 53.1)**, **AD 24.3–31.7 (mean 28.7)**. The sweep identity reproduces exactly — TS 79.1% swept × 65.3% fresh-cohort = 51.7; AD 56.7% × 46.9% = 26.6 — and the fresh-cohort ceiling is essentially unchanged vs 09-10 (TS 65.3 vs 68.1, AD 46.9 vs 46.7). ⭐ **Sweep position moved; pricing quality did not.** This is exactly the trap CLAUDE.md records about this metric, caught before anyone read a 6-point "drop" as a regression.

**Invariants still at zero** (VERIFIED): `v_fmv_sanity_flags` 0 · `edition_fmv_current fmv_usd <= 0` 0 · `pinnacle_catalog fmv_usd <= 0` 0 · `editions.circulation_count = 0` 0 and NULL 0 · `topshot_impossible_parallel_serials` 0 · `sales_serial_supply_worst_pct` 0.0033%.

**Pack EV honesty: CLEAN, re-derived.** TS `edition_count=0` → 291 rows, 291 NULL `gross_ev`, 291 NULL `pack_ev`, 0 `is_positive_ev`. **No stale EV published as live** — every `is_positive_ev AND available` row is in the 0–30 d bucket; `stale30 AND primary_available` = **0** in all four collections. **No fabricated zero when price is missing** — 2,626 AllDay + 176 Golazos rows with NULL `pack_price` carry `gross_ev` and **NULL** `pack_ev`/`value_ratio`/`is_positive_ev`. That is the correct shape.

**Parallels/subeditions clean:** 4,477 TS parallel keys (was 3,805), **0** missing `subedition_id`, **0** missing `subedition_name`, **0** subedition ids on a base key, **0** orphan parallel-keyed offers, **0** zero/negative offers or asks.

### R103 · P2 — Top Shot ask freshness has degraded 26× against the gate that consumes it

**VERIFIED:** `edition_offers` — **4,500 of 13,101 TS asks (34.4%) are older than `MAX_ASK_AGE_HOURS_CORROBORATION` (7 d)**, median ask age 103.8 h. The in-code measurement that SET that threshold (`lib/fmv-confidence.ts`, 08-29) recorded **155 (1.3%)**.

A cadence effect, not a stall: ~2,900 rows/24 h on 13,310 → a **~4.6-day refresh cycle**, with only 56 rows >14 d and 7 >30 d. **Consequence:** ask-corroboration (LOW→MEDIUM at 3 sales) is structurally unavailable for about a third of the catalogue at any instant — **a second sweep-position term in the headline metric, alongside the FMV sweep.**

⚠ **ELIGIBILITY IS NOT GAIN, and the sign is not one-way:** 1,565 LOW TS editions hold an ask past the bound; at the recorded 31% realisation rate that is ≈300–500 editions, ≈**+2 to +3.5 pts** — but **1,454 MEDIUM editions also sit past the bound and can DEMOTE** on their next recalc. *Refuted if* the 08-29 1.3% sample was itself taken at a sweep peak.

### R104 · P3→P1 — `editions.badges` is a universally empty column

**VERIFIED: `editions.badges` is an empty `text[]` on all 14,016 TS and all 6,190 AllDay rows.** Canonical display is `get_edition_badges_unified` ← `badge_editions`, which is healthy (13,915 TS keys = 99.3% coverage, median age 43 min, 0 orphans). **Any future reader of `editions.badges` renders zero badges silently** — a dead denormalised column that is a landmine, not a current defect.

### Two false findings sweep C killed on grain — recorded so nobody re-derives them

1. **"400 TS `pack_ev` rows with no distribution row"** — artifact. Those rows carry a **NULL `dist_id`** (the known TS no-dist-at-event-time property); **0 of 810 real TS `dist_id`s are unmatched.**
2. **"3,465 TS editions hold a `player_name` with a NULL `player_id`"** — reads like "we hold it and render nothing", but the player RPC matches `(player_id = p.id OR player_name = p.name)` and `app/api/cron/data-integrity` already tracks the NULL-FK population. **Would become a defect only if a surface joined on `player_id` alone.**

**Drift noted on already-settled items, not re-filed:** Golazos badge median age **54.98 d** (register 27.85 d) · AllDay `edition_offers` bid median **7.8 d** (was 6.06 d; still 0 of 2,267 carrying `low_ask`, so D21's cross-contamination condition remains unmet) · TS editions with NULL `player_name` down to **153** from 548, and **0 of the 43 `::` parallels have a named base edition** — nothing recoverable from what we hold, so an honest gap, not a defect.

## §13 — 🚨 R105 · P1 — THE HOMEPAGE DESCRIBES A PRICING MODEL THE PRODUCT DOES NOT IMPLEMENT

`components/HomePageMarketing.tsx:144`, a `DEPTH_BULLETS` entry on the highest-traffic public page:

> *"Serial premium multipliers — **1-of-1 = 12×, low serials = 4.5×, last mint = 3×**."*

I checked it **both ways** — against the market, and against our own code — because the copy is ambiguous about which it describes. **VERIFIED, `lib/market-compute.ts`:**

| claim | our model | live market (90 d, n=108,058 TS sales) | verdict |
|---|---|---|---|
| **1-of-1 = 12×** | ✅ `SPECIAL_SERIAL_MULTIPLIERS["#1 Serial"] = 12` | serial #1 median **7.50×**, mean 20.36× | **ACCURATE as a model description** |
| **low serials = 4.5×** | ❌ **no such constant.** Low serials go through the continuous power law `max(1.0, (serial/medianSerial)^exponent)`; a #10 of 100 Common yields ≈**2.3×** | median **1.00×**, p90 2.58× (n=13,215, production `lowSerialThreshold`) | **UNSUPPORTED both ways** |
| **last mint = 3×** | ❌ **the model returns exactly `1.0`** — `market-compute.ts:212`, `if (serialNumber >= medianSerial) return 1.0`. Last mint is the maximum serial, so it can never receive a premium | median **2.60×** | **FLATLY CONTRADICTED BY OUR OWN CODE** |

⭐ **One of three claims is accurate; one is unsupported; one describes a feature the code explicitly refuses to provide.** A no-change control (typical serials, n=93,837) came in at **0.97×**, so the market denominator is unbiased.

**This is the "never claim what the product lacks" rule** — which CLAUDE.md states binds *every* surface, not just the concierge — failing on the homepage. ⚠ Note the market data says the model **under**-prices last mint (2.60× observed vs 1.0× applied); that is a separate, genuine FMV question and must **not** be fixed by autonomous retuning.

⚠ Both the copy's 12×/4.5×/3× and the handoff's 9.89/1.50/5.00 are **dated samples**; neither reproduces today's data. **Re-derive before editing, do not quote either.**

---

## §14 — WHAT I DELIBERATELY DID NOT SHIP, AND WHY

I had DB write access for the second half and used **none** of it. Stated plainly so it does not read as an omission:

1. **The `price-snapshots` arm** — tightening it was sweep B's recommendation and it is the wrong fix (§11/R100). It would have generated constant noise against a known-starved driver while still being blind to bucket loss.
2. **Arming the 28 unwatched lanes** — correct work, but 28 new alarm arms landing unannounced on Trevor is not a change to make unsupervised, and their thresholds need each lane's real cadence.
3. **Any migration.** CLAUDE.md is explicit: a no-push session that runs `apply_migration` **reds `migration-parity` until the file is committed**, and I cannot commit. Every DB fix here needs a migration. **Applying one would have broken CI to ship a monitoring improvement.**

**Everything is in the handoff with its evidence, its trap, and its revert path.**

## §16 — QA OF THE SHIPPED P0 FIX: it covers 2 of the 9 boards

`e79a38d42` landed at 13:04 PT off this handoff. **The fix itself is well built** — SSR-asserted via `renderToString` (the trap this report named), asserting the ABSENCE of the false value, and — the part worth copying — **carrying a no-change control**: *"a genuinely empty board still prints real zeros … without this arm the fix could be 'render — always', which would destroy a true reading to hide a false one."* It is also honest that it could not be verified end-to-end (the DB recovered, so no failure was left to expose) and defers to a COLD pass under a forced failure, per #33. Gate: `tsc` 0, lint ratchet at baseline 715, 17,400 tests passed.

⚠ **But it touched `top-sales` and `squeeze` only.** The finding was **9 boards**, and the handoff said *"grep for the EXPRESSION, not the file."*

⚠ **AND MY FIRST QA INSTRUMENT WAS WRONG — recorded because it is the more useful half.** I grepped for `initialFailed`/`seedFailed` and read `squeeze` as **unfixed**, because the two boards were fixed by **two different mechanisms**: `top-sales` threads `initialFailed`, while `squeeze` gates on a server-provided `degraded?.failed?.length`. ⭐ **A proxy population that coincides with the property today expires the moment someone fixes the same defect a second way.** The honest instrument is "does the KPI computation consult ANY failure provenance", not "does it contain this identifier".

**Re-run with the corrected instrument:**

| board | provenance present in client | verdict |
|---|---|---|
| `top-sales`, `squeeze` | ✅ `initialFailed` / `degraded.failed` | **FIXED** |
| `candy-mlb` | `degraded.failed` ×2 | likely covered — needs a read |
| `rookie-board`, `serial-premiums`, `cross-collection` | `initialFailed` present | ⚠ flag exists; **whether it GATES the KPI strip needs a read** — my grep cannot tell, and I am not filing a verdict it cannot support |
| **`offer-spread`, `panini-squeeze`, `deals`** | ❌ **no failure flag anywhere in the client** | ⚠ **strongest candidates to still fabricate** |

### `deals` — confirmed still fabricating, and the flag is already in its props

**VERIFIED by reading it.** The server page **already computes and passes the provenance**: `app/insights/deals/page.tsx:52` → `initialDegraded={degradedFromSource(source, "Below FMV board")}`. But `DealsBoardClient`'s `kpis` useMemo (line 319) branches on **`if (rows.length === 0)`** and returns zeros, then `count: rows.length` — **it never reads `initialDegraded`.** Its only `error` state (line 220, rendered line 520 as *"Failed to load: …"*) covers its **own refetch** (line 283 `if (!r.ok) throw`), not the seed.

⭐ **That is the server-seeded-prop trap verbatim** — a component that distinguishes failure for its own fetch and still concludes on the seed — and it is the sharpest instance in the catalogue, because `deals` is the board whose empty state reads **"No editions listed below a trustworthy FMV match"**: a claim about market quality manufactured from a 503, with the flag that would prevent it sitting unused in its props. **The fix is a few lines.**

Filed as **R106**.

---

## §15 — TRACTION (sweep F), reported because it is bad

VERIFIED 2026-09-18 ~2:20 PM PT. Stated plainly, with no feature proposed as the answer.

| measure | value |
|---|---|
| `auth.users` all-time | **28** |
| new in 30 d | **7** |
| **signed in within 7 d — the WAU number** | **3** |
| `wallet_paste`, human (`bot_ua = false`), all-time | **99** |
| `wallet_paste`, human, last 30 d | **68** |
| `email_subscribers` | **0** |
| `support_conversations` (⚠ `WHERE NOT is_smoke_test`) | **65** |

**WAU is 3.** The monetization gate is 50+ weekly actives, so it is not close, and nothing here suggests it is about to be.

⭐ **The one number that is actually moving: ~2/day human `wallet_paste`, and I ran my own refutation test on it — it SURVIVED.** I said the finding should be discarded if the events came from a handful of sessions. Decomposed: **66 events across 47 distinct sessions and 51 distinct inputs, max 3 in any one session, mean 1.70.** Not a handful of sessions. (66 vs the 68 above is the rolling `now()` window, not a discrepancy.)

🚨 **AND THE FUNNEL IS THE REAL FINDING — the anonymous path WORKS and the account wall is where everything dies.** Of the 47 sessions that pasted a wallet, in the same 30 days:

| step | sessions |
|---|---:|
| `wallet_paste` | **47** |
| `share_view` (the Top Collector Report) | **36 — 77% of pasters** |
| `insights_view` | 24 |
| `collection_view` | 23 |
| `home_view` | 13 |
| **`signin_click`** | **1** |

**77% of people who paste a wallet get to the report. 2% click sign in.** The product delivers its value anonymously and converts essentially nobody to an account — which is also why `auth.users` reads 28 while the tool is used daily. ⚠ **INFERRED** that `share_view` is the report render; *refuted if* it counts inbound visits to a shared `/share/[wallet]` link instead, which would make it an acquisition channel rather than a conversion step. **That one definition is worth pinning before any decision rests on this table.**

⚠ **A probe of mine that could NOT discriminate, stated rather than dressed up:** only **8 of the 51 distinct inputs are Flow-shaped (`0x…`), and 43 are usernames** — and `wallet_moments_cache` is keyed by address, so "only 8 resolve" is **not** evidence that 43 failed. The username→address path is separate and my query cannot see it. The funnel table above is the answer that probe was reaching for.

⚠ **Do NOT read `human_sessions_30d = 18,007` as 18,007 people.** Register item R59 records that `bot_ua` under-catches and that session-level funnel counts remain roughly 99% machine. The two counts in this table I would defend are `auth.users` and `wallet_paste`; the session counts are not instruments yet.

⚠ `email_subscribers = 0` is unchanged from the run-4 sweep and was source-verified then (component + proxy, 08-28) — **not re-derived today.**

---

---

*Run 5, both halves. Part One 08:20–12:00 PM PT (no DB, no MCP, no push). Part Two 12:55–14:30 PM PT (DB recovered, MCP approved, still no push). Sweeps A, B, C, D, E complete; F-traction not run. Shipped: nothing — by capability in Part One, by judgement in Part Two. All timestamps Pacific.*
