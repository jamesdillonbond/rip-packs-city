# CLAUDE.md — verbatim originals of the sections that were CONDENSED

## 2026-08-26 — condensed to make room for the 08-26 refresh (VERBATIM originals)

The 2026-08-26 memory-file refresh added four things CLAUDE.md did not carry (the client-side
capture blind spot, `atlas-proxy` becoming the binding half of the listings ingest, the
re-read `fmv-recalc` figures, and four re-verification dates). The file was at **39,980 / 40,000
characters**, so each addition displaced text. **Every fragment shortened in CLAUDE.md that day is
reproduced verbatim below, keyed by what it was.** Nothing here was deleted — if a detail seems
missing from CLAUDE.md, it is in this block or in the reference file the compressed line points to.

⚠ **These are the OLD texts. Where one carries a number or a status, CLAUDE.md's current line is the
live one** — several of these were compressed precisely because their numbers had gone stale
(`9 of 40` listing-ingest fails, `72.7%` wall-kills, the `08-24` purge re-verification).

⚠ **One deviation from verbatim, and it is mechanical:** relative links inside these fragments
carry CLAUDE.md's repo-root prefix, which is dead from `docs/reference/` — `scripts/check-memory-doc-links.mjs`
reds on exactly that. **The `](` prefixes below are rewritten to `../../docs/reference/…`; no other
character was changed.**

### paged-read-#28
(`/sitemap/3.xml`: **24,000 of 27,246** editions under a **200**). No copy exists to grep — the tell is the control-flow keyword. Throw, or carry `complete:false`. **FIXED #28** (prod-vs-DB set match, 08-24).

### offlimits
Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth & lockdown (`proxy.ts`), destructive SQL, FMV/ingest/pricing/pack-EV/concierge/sniper route logic, gated work.

### recent-sessions
Session entries live in `docs/sessions/`, one file per month — none is needed to start work. **Write new ones into

### npm-ci
# ⚠ RUN FIRST in a fresh sandbox (no node_modules); without it `npx vitest`/`npx
                         #   tsc` die on `MODULE_NOT_FOUND … vitest.config.ts` — reads like a broken config.

### rebase-traps
Three traps, each drawn blood: **anchor the marker check to line start**, **gate the `git add` on the resolver's exit code**, **measure a check's baseline before asserting on it**. Full recipe: [ledger-discipline.md](../../docs/reference/ledger-discipline.md).

### distribution
(`fmv-recalc`: three failed characterizations in two days from one-instant reads)

### header-instruments
(4 instruments: [tooling-gotchas.md](../../docs/reference/tooling-gotchas.md); the full case, incl. why size is ANTI-correlated with displaceability: `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`)

### new-bullet-trim
 (#37). Read that badge; nothing alerts on it.

### no-push
- ⚠ **A no-push session's DB reach is narrower than `apply_migration` suggests: a PINNED SQL function is PUSH-GATED** (its `supabase/tests/` copy reds `db-pin-staleness`), and **every `apply_migration` reds the ENFORCING `migration-parity`** until its file is committed. **Real no-push levers: pg_cron schedules, indexes, new objects.** `execute_sql` for SCRATCH DDL — no version row, no parity debt.

### daytime
- **`rpc-daytime-monitor`** — READ-ONLY, every ~3h. Sweeps health, files candidates to `docs/overnight/inbox/`. Ships nothing.

### shared-state
Shared state in `docs/overnight/`: `ledger.md` (its **"Declined — do not re-suggest"** heading is Trevor's), `inbox/` (⚠ `INDEX.md` has **4 CI assertions, TWO of them COUNTS** — **archiving one deletes its entry too**), `metrics-latest.json`, `focus.md`, `.lock`. **Skim `ledger.md` before a session**; the night pass will not edit files committed in the last 24–48h.

### idx-trust
- **`trust-board-and-safety.md`** — trust board (⚠ the arm count drifts, and the view still times out at 60 s — read the sentinel's `Trust Health` check, never this file's number), precompute 8-way split, destructive-op circuit breaker, cross-session coordination.

### idx-honesty
- **`key-files-and-honesty.md`** — largest and most-read. Key modules + the full **"a failed read must not render as an answer"** canon, leak guards, fabricated-number shapes, OG cards, Workers table.

### idx-testing
- **`testing-and-ci.md`** — vitest layers, the 3 coverage gates + ratchets, DB-invariant SQL pins, mutation-testing categories, CI jobs (incl. the `bash -e` abort class), Playwright.

### idx-cron
- **`cron-and-schedulers.md`** — the 4 schedulers, pg_cron mechanics, `pipeline_runs` retention + rollup traps, saturation findings.

### idx-db
- **`database.md`** — `editions` · `wmc` · `fmv_snapshots` · `sales`, role timeouts, PostgREST caps, `apply_migration` cost, full **Security posture**.

### tagline
**Tagline** stays "Flow blockchain digital collectibles intelligence platform" until chain two ships visible product. No tweets / Reddit / TC DMs about multi-chain pre-launch.

### client-bullet
- 🚨 **A CLIENT-ONLY failure is captured by NOTHING right now** — Sentry has dropped every event since 08-18 (quota, #34, and Trevor's call is not to pay), Vercel sees only server execution, and there is no `window.onerror` in the repo. **The scheduled `E2E DOM Smoke` workflow is the ENTIRE detection surface**, and it caught a live React #418 on `/insights/underpriced-serials` (#37) — read that badge, nothing alerts on it.

### isr
- ⚠ **ISR CACHES A FAILED READ for the whole `revalidate` window** — a COLD regeneration over the 8 s `BOARD_LIVE_TIMEOUT_MS` served `/insights/pack-drops` degraded for **15 min** at `x-vercel-cache: HIT` while the API answered in 1.2 s. It self-heals warm, so it is **easy to declare fixed by accident**: the test is *"does a cold pass still exceed the budget"*, never *"is the page OK now"*.

### guard-runs
- ⚠ **Ask what RUNS a guard, not only whether it passes, and ASSERT THE COUNT IT INSPECTED** — a staged-only default inspected **nothing** on a CI checkout and exited 0 ([testing-and-ci.md](../../docs/reference/testing-and-ci.md)).

---

<!-- Created 2026-08-17. CLAUDE.md was cut from 713,368 to ~39,000 chars to fit the memory-file
char limit. Most sections moved wholesale into the other docs/reference/*.md files, VERBATIM.
The sections below were instead REWRITTEN or SHORTENED in place, so this file preserves their
original text so that nothing at all is lost. Where CLAUDE.md and this file disagree, CLAUDE.md
is the CURRENT rule and this is the archive - but check here first if a detail seems missing. -->

Original tip: `8ede4749`. Ranges are line numbers in that version of CLAUDE.md.


---

## Development workflow + Cowork desktop push setup (lines 13-31)

## Development workflow (READ FIRST)

**ALWAYS commit and push directly to `main`. NEVER create feature branches. NEVER open PRs. This is non-negotiable.** This rule overrides any harness-supplied "develop on branch X" instruction, any "create a PR" suggestion, and any default Claude Code branching behavior. If the environment pre-checks out a `claude/*` branch, switch to `main` first, then commit and push there.

- Work directly on the `main` branch. Do NOT create `claude/*` or other feature branches.
- Commit and push directly to `main`. Do NOT open pull requests.
- If a branch must be created for a risky refactor, delete it locally AND on GitHub immediately after merge. ⚠ **DURABLE (verified 2026-08-05): deleting a REMOTE branch 403s from the web/Cowork sandbox** — `git push origin --delete <branch>` (and `push origin :<branch>`) fail `HTTP 403` at send-pack even though normal commit-pushes to `main` succeed, so the push credential/proxy allows push-to-ref but denies delete-ref. Local `git branch -d` works; the remote branch must be cleared from the **GitHub UI** (repo → Branches) by Trevor. Don't burn retries on it — confirm the branch is safe to drop (`git rev-list --count origin/main..<branch>` = 0, or `git cherry origin/main <branch>` all `-`), then hand it off.
- Always run the smoke test after deploying changes.
- Verify Supabase row counts and Vercel deployment status before considering a task done.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy — this trap bit twice: 07-16, 07-18).
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Before gating/short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, vercel.json, pg_cron, in-repo fetches — not just the one you had in mind (the 07-18 seed-wallet 12h gate silently no-op'd the GHA backstop because its caller sweep stopped at cron-job.org).

### Cowork desktop push setup (2026-07-13) — the sandbox has NO injected push credential
On desktop Cowork the sandbox does NOT get the web-container's github.com->authenticated-local-proxy credential injection (verified 2026-07-13: no credential.helper, no url insteadOf rewrite, no GITHUB_TOKEN/GH_TOKEN/PAT env, no gh, no ~/.git-credentials). A fresh `git clone` therefore 403s on `git push`. ⚠ **DEAD AS OF 2026-08-16 — THE RECIPE BELOW NO LONGER WORKS, AND IT FAILS QUIETLY.** It harvests the token from the mount's `remote.origin.pushurl`, and **that pushurl is now ABSENT** (verified on Trevor's box 2026-08-17: no `pushurl`, `credential.helper = manager`, gh 2.90.0 — push works there via the **Git Credential Manager / gh helper**, whose credential lives in the **Windows credential store, not in the repo**, so a mount cannot see it). The token was removed deliberately on 2026-08-16 because merely *reading* the pushurl prints a live `github_pat_…` into the transcript. So the command below now substitutes an **empty string** and produces a broken remote rather than an error. ⛔ **Do NOT "fix" this by re-embedding a PAT** — that reverts the security fix and loses the `workflow` scope gh provides. ⚠ **Note both sandbox paths are now dead for DIFFERENT reasons: desktop = this harvest source is gone; CLOUD = the git proxy 403s at the repository-authorization layer *before any credential is evaluated* (an embedded PAT gets the identical 403 — upstream `anthropics/claude-code#76248`, open), so no credential fix exists there at all.** The routes that do restore push: **`/web-setup` in a REAL TERMINAL `claude` session** (built-in CLI command — it does NOT fire in a VSCode-extension session; authorizes cloud sessions **at creation**), **creating the session with the repo as its source** (`claude --cloud` from inside the repo, or claude.ai/code with the repo selected — not addable mid-session), **running the task on the computer**, or **shipping a `git format-patch`**. Historical recipe kept below for context only:

    git -C <fresh-clone> remote set-url --push origin "$(git -C /sessions/<sess>/mnt/rip-packs-city config --get remote.origin.pushurl)"

This is INDEPENDENT of the bash/useradd sandbox-disk failure — bash-green does NOT imply push-green. Still never commit from the mount itself; always a fresh clone (deploy-split rule).

---

## Project overview (lines 100-111)

## Project overview

Rip Packs City (RPC) is a production-grade Flow blockchain digital collectibles intelligence platform. It targets serious collectors with analytics, deal-finding, sniper tools, FMV pricing, and badge tracking across all 5 currently published Flow collections (NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike). Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

Stack: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, @onflow/fcl, Supabase (Pro, Small compute), Vercel Pro.

Live: https://www.rippackscity.com
Repo: github.com/jamesdillonbond/rip-packs-city (public)
LLC: Oregon, filed May 3 2026.

---

---

## Recent sessions intro (rolling rule + full date-stamping history) (lines 148-153)

## Recent sessions

> Keep only the last ~3 days here. On each refresh, move older `### <date>` entries into `docs/sessions/YYYY-MM.md` (prepend, newest-first) — verbatim, so nothing is lost. Busy days run several entries, so this section may hold a dozen-ish; if it's carrying more than ~3 calendar days, roll the tail.
>
> **DATES ARE PACIFIC (Trevor operates in PT). The sandbox/CI clock is UTC — ~7h ahead in summer (PDT), 8h in winter (PST) — so `date -u` on the 29th at 02:54 UTC is still the 28th (19:54) in PT. ALWAYS convert to PT before stamping a `### <date>` here or in `docs/overnight/ledger.md`.** ⚠ **On Trevor's Windows box, run plain `date` (or PowerShell `Get-Date`) — NOT `TZ=America/Los_Angeles date`.** That Git Bash has no `/usr/share/zoneinfo`, so `TZ=<anything> date` silently returns **UTC labelled `GMT`** for every zone (verified 2026-07-31: `America/Los_Angeles`, `America/New_York`, `Asia/Tokyo` and `UTC` all print the same time). It fails silently — you get a plausible timestamp that is 7h ahead — which is exactly how the 07-29→07-30 boundary slip below happened. ⚠ **CORRECTED 2026-08-10 — plain `date` in Git Bash does NOT reliably return local time either; use PowerShell `Get-Date`.** This file used to claim plain `date` "returns the box's real local time and correctly prints `PDT`". Measured the same minute on Trevor's box: Git Bash `date` → `Tue, Aug 11, 2026 5:25:28 AM` with **no zone label**, matching UTC, while PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` → `2026-08-10 22:25 -07:00` (`[TimeZoneInfo]::Local.Id` = `Pacific Standard Time`). So Git Bash was a full calendar DAY ahead — the same silent-plausible-timestamp failure as the `TZ=` trap, and the third recorded instance of this class (07-29→07-30 slip, the M3b/D34 08-11→08-10 mis-stamp). **The single trustworthy command is `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` — it prints the offset, so it cannot lie silently.** ⚠ **CORRECTED 2026-08-12 — "the sandbox clock is UTC" is NOT universally true, and assuming it mis-stamped five ledger headings by a full day.** The Claude Code WEB sandbox reads **PDT**: measured in the same minute, `date` → `2026-08-12 07:15 PDT` and `date -u` → `2026-08-12 14:15`, the SAME calendar day. Applying the "subtract 7h from `date -u`" reflex there lands you a day EARLY. This is the fourth instance of one class — a plausible timestamp produced by a clock whose zone was assumed rather than read. **Read the zone before converting:** `date '+%Z'`, or `python3 -c "import datetime,zoneinfo; print(datetime.datetime.now(datetime.timezone.utc).astimezone(zoneinfo.ZoneInfo('America/Los_Angeles')))"`, which is correct in every environment because it converts rather than trusting the local zone. Only where the sandbox really is UTC does subtracting 7h (PDT) / 8h (PST) from `date -u` by hand apply. The overnight-pass entries already show the `HH:MMZ / HH:MM PDT` convention; interactive entries must follow the same PT calendar day.

---

## Older sessions + doc archive layout (lines 567-580)

### Older sessions

Archived to `docs/sessions/` (newest-first within each file):

- `docs/sessions/2026-08.md` — August 14 → August 1 (rolled from Recent sessions; more August entries append here as days roll off).
- `docs/sessions/2026-07.md` — July 31 → July 1 (overnight passes + daytime CC; Candy MLB + Panini go-lives, FMV 1000-row-cap fix + proxy-auth-wall/edge-Deno CI coverage, Candy chain-two productization/parity, sales-counterparty/Panini readiness, Pack-EV accuracy program, IOPS read-diet, Trophy-case PDF, test-coverage infra, platform audits).
- `docs/sessions/2026-06.md` — June 30 → June 1 (overnight passes + daytime CC; parallel-conflation program, pack-EV, FMV hardening, Candy/Solana onboarding).
- `docs/sessions/2026-05.md` — May 31 → May 2 (entity pages, ops/QA pass, FMV recovery, V1 Dapper indexer, multi-collection enrichment).
- `docs/sessions/2026-04.md` — April 26 / 21 / 10.

**Doc archive layout:** shipped dated handoffs/audits live under `docs/archive/handoffs/` + `docs/archive/audits/`; weekly health snapshots (`PROJECT_HEALTH_*.md`) under `docs/health/`. Links inside `docs/archive/**`, `docs/health/**`, `docs/sessions/**` are frozen history — don't rewrite them.

---

---

## Infrastructure IDs (lines 581-591)

## Infrastructure IDs (required on every tool call)

- Supabase project ID: `bxcqstmqfzmuolpuynti` (Pro plan $25/mo base; **compute = SMALL** — 2 GB RAM / 2-core, `max_connections`=90, verified live 2026-08-08; the old "Micro" label was stale). ⚠ Disk-IO-budget (burst-credit) model → throttles to a **22 MB/s** baseline when depleted; the platform's intermittent saturation is disk-IO-bound, NOT compute-bound — fix expensive queries, don't upgrade the tier (Medium is the same 2 cores for 4×). See the 2026-08-08 Recent-sessions entry.
- Vercel project ID: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- Vercel team ID: `team_YWGCVToPBJSS60NgVh8jiCFV`
- GitHub repo ID: `1188272071`

Both Vercel IDs are required on every single Vercel API or MCP tool call — never omit teamId.

---

---

## Frequently used commands (lines 631-672)

## Frequently used commands

```bash
# Development
npm run dev

# ⚠ A FRESH web/cloud sandbox clones with NO node_modules — run this FIRST.
# Without it `npx vitest` silently fetches its own vite and dies on
# `MODULE_NOT_FOUND ... vitest.config.ts`, which reads like a broken config
# rather than a missing install. `npx tsc` fails the same way.
npm ci

# TypeScript health check (use before deploying when Vercel rate-limited)
npx tsc --noEmit

# Tests (see "Testing & CI coverage" for details)
npm test                 # vitest run — route + lib unit/integration suites
npx vitest run __tests__/some-file.test.ts   # run a single test file
npm run test:coverage    # same suites + coverage ratchet (what CI gates on)
npm run test:cadence     # extract inline Cadence + `flow cadence lint` the fixtures
npm run test:cadence:escrow  # RPCTradeEscrow `flow test` suite (fetches deps first; NOT in CI)

# Git — always use Git Bash (MINGW64) on Windows
git status
git add -A && git commit -m "feat: ..."
git push origin main

# Vercel redeploy via REST (use PowerShell Invoke-WebRequest — curl fails silently in Git Bash)
# POST https://api.vercel.com/v13/deployments
# body: {"name":"rip-packs-city","gitSource":{"type":"github","repoId":"1188272071","ref":"main"}}

# Env var writes also require PowerShell Invoke-WebRequest
# POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId}

# Wallet backfill ad-hoc (force full re-walk)
# curl -X POST 'https://www.rippackscity.com/api/wallet-backfill?force=true' \
#   -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
#   -d '{"wallet":"0x..."}'
```

---

---

## Supabase schema facts + the two collection vocabularies + collection UUIDs (lines 800-825)

## Supabase schema facts (critical — verify before writing queries)

**Volatile facts (table existence, FMV home per collection, enum values, RLS-on count) are generated from the live DB into [docs/reference/schema-truth.md](../../docs/reference/schema-truth.md) — that file wins on any disagreement with the prose below.** It is regenerated by the weekly `rpc-data-quality-sweep` (drift → ledger Queued). The conventions below (the two collection vocabularies, partitioning, UUIDs) are stable; the per-table/enum/count specifics can drift, so confirm against schema-truth.md (or re-query) before relying on them.

### Two collection-string conventions (CRITICAL footgun)

The DB uses **two distinct vocabularies** for identifying collections, and they are not interchangeable. Mixing them up will fail INSERTs against CHECK constraints.

| Vocabulary | Used by | Values |
|---|---|---|
| **Long-form** | `sales`, `editions`, `collections.slug` | `nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike` |
| **Short-form** | `flowty_transactions`, `flowty_loans`, `flowty_loan_events` | `topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, `unknown` (the CHECK whitelists exactly these six — NOT `other`, verified live 2026-07-16) |

`flowty_transactions` has a CHECK constraint whitelisting short-form only (live def: `collection IS NULL OR collection = ANY('topshot','allday','golazos','ufc','pinnacle','unknown')`). Writing `'ufc_strike'` to a flowty_* table fails at INSERT — any code writing these tables MUST use short-form (`'ufc'` not `'ufc_strike'`). NOTE: `lib/flowty-tx-classifier.ts` was **removed** in the Flowty-teardown Phase 2 (`36aabf28`, 2026-05-23); the short-form rule still binds any new writer.

The bridge between the two is `analytics_sales` view, which translates long → short via CASE.

### Collection UUIDs

- TopShot: `95f28a17-224a-4025-96ad-adf8a4c63bfd`
- AllDay: `dee28451-5d62-409e-a1ad-a83f763ac070`
- Golazos: `06248cc4-b85f-47cd-af67-1855d14acd75`
- UFC: `9b4824a8-736d-4a96-b450-8dcc0c46b023`
- Pinnacle: `7dd9dd11-e8b6-45c4-ac99-71331f959714`
- Candy MLB (`candy_mlb`, unpublished/`is_active=false`): `209ade70-32c5-4470-bc7c-4793d660f713`

---

## Series map (lines 1145-1161)

## Series map (on-chain UInt32 → display name)

- 0 = Series 1 (S1)
- 2 = Series 2 (S2)
- 3 = Summer 2021 (Sum 21)
- 4 = Series 3 (S3)
- 5 = Series 4 (S4)
- 6 = Series 2023-24 (23-24)
- 7 = Series 2024-25 (24-25)
- 8 = Series 2025-26 (25-26)

There is NO series=1 on-chain. Series 0 IS Series 1. There is NO "Beta".

⚠ **This 0↔1 collision is TOP-SHOT-SPECIFIC — NEVER blanket-remap `1 → 0` across collections.** Two encodings coexist and disagree: `wmc.series_number` is ON-CHAIN (Top Shot Series 1 = `0`) and `editions.series` is DISPLAY (`1` = Series 1). Per live `collection_series`: `nba_top_shot` has NO series 1 (0 = 'Series 1'), but `nfl_all_day` / `laliga_golazos` / `disney_pinnacle` use `1` legitimately and **`ufc_strike` has BOTH 0 and 1** — so a blanket remap corrupts four collections. This footgun caused a real 2026-08-05 incident: `get_wallet_moments_with_fmv` unioned the two encodings via `COALESCE(wmc.series_number, e.series)`, mislabeling same-edition moments AND silently dropping 385,734 TS rows when a "Series 1" filter sent the on-chain `p_series=0`. Fixed by scoping the `1 → 0` fallback remap to the Top Shot uuid only (`audit_20260806_get_wallet_moments_series_topshot_convention`); `wmc.series_number`, when present, still wins. Check `collection_series` for the true per-collection mapping before touching any series logic.

---

---

## Concierge non-negotiable rules (lines 1193-1203)

### Concierge non-negotiable rules

1. **Pinnacle FMV**: NEVER join by `edition_key` alone — always triple (`character_name`, `set_name`, `variant_type`) per `92aab30`. Cadence uses `Int` not `UInt64`.
2. Memory-FMV banned (`a910745`) — must tool-call same turn.
3. `get_fmv` reads `editions + fmv_snapshots` primary; returns `p10/p50/p90` + sample shape.
4. Tier filter: `.eq` not `.ilike` per `f55e022 + e9c90e5`.
5. `trg_support_conv_updated_at` OWNS `shipped_at / updated_at` — never set manually.
6. `/api/admin/feedback` GET MUST filter `feedback_type IS NOT NULL`.

---

---

## Code patterns and conventions + Hot wallet & secrets (lines 1346-1367)

## Code patterns and conventions

- Full file replacements only — never snippets or diffs.
- ⛔ **RETIRED 2026-07-25 — the verbatim line below is HISTORY, not a rule.** Handoffs and Claude Code
  prompts are read and pasted on **desktop** (PowerShell / Git Bash); normal markdown including fenced
  code blocks is fine. ⚠ **This file is verbatim history, but CLAUDE.md's index points readers here with
  *"check here first if a detail seems missing"* — so an unmarked retired rule in it is handed out as a
  live answer.** Superseded by `RPC_DESIGN_SYSTEM.md` §10 and the `rpc-handoff` skill.
  <!-- retired-rule:allow handoffs-are-iphone-pasteable -->
  - *(verbatim, superseded)* Claude Code prompts: plain text, no markdown code blocks (optimized for iPhone copy-paste).
- `proxy.ts` is the correct Next.js 16 convention (renamed from middleware.ts).
- Supabase client must be typed as `any` to avoid TypeScript errors in API routes.
- `generateMetadata` cannot be exported from client components (`"use client"`) — belongs in server-component `layout.tsx`.
- `useSearchParams` requires a Suspense wrapper — any page using it must be wrapped.
- Branch fragmentation is a recurring issue — consolidate with cherry-pick onto one canonical branch before merging.
- Fire-and-forget >30s: `import { after } from 'next/server'`, `after(runX())`, return `{status: accepted}`.
- `project_knowledge_search` is NOT authoritative against live repo — Claude Code's direct file inspection wins every disagreement; prompts should allow Claude Code to correct false premises.

---

## Hot wallet & secrets

- Flow CLI hot wallet: `0x3aa11c84d776838f` (Key 0, ECDSA_secp256k1, SHA2_256 — BOTH keys re-verified on-chain 2026-07-19 via Flow REST `?expand=keys`). NOT account-linked. `flow.json` gitignored. NEVER use a HybridCustody / linked wallet as the hot wallet. Any code signing as this wallet MUST use secp256k1 + SHA2-256 — `lib/breaks/server-authz.ts` silently used p256 + SHA3-256 until `3b5e62d8` (2026-07-19); tests for signing code must verify signatures cryptographically, never just assert output shape/length.
- Cadence service payer wallet: `0x73f55c4450b8d466` — the account designated as `payer` (gas) for backend-submitted Cadence transactions; distinct from the hot wallet above (Flow allows a separate proposer/authorizer vs. payer). Monitored every 30min by `/api/cron/cadence-payer-balance-check`, which alerts below 0.05 FLOW. If it runs dry, every Cadence transaction fails pre-execution with `INSUFFICIENT_GAS_FUNDS` (Flow error 1118).
- Key env vars: `INGEST_SECRET_TOKEN`, `CRON_SECRET`, `FLOWTY_PROXY_TOKEN`, `TS_PROXY_SECRET`, `RPC_ADMIN_TOKEN`, `SPORTS_PROXY_URL`, `SPORTS_PROXY_SECRET`, `ANTHROPIC_API_KEY`.

---

---

## Beta users (lines 1536-1548)

## Beta users (current)

- jamesdillonbond — `0xbd94cade097e50ac` (Trevor)
- RipPacksCity — `0xb5053ef95e702657`
- samwise222 — `0xa3d67b29e104e701`
- Mike Levy — `0x11859edcf2f53edd`

Watch wallets at `priority=3` in `seeded_wallets`:
- roham — `0x01d7e57aa5598e47`
- rybaguy — `0xbe9c633840e40df3`

---

## Displaced 2026-08-23 — the "a recorded correction has a shelf life" examples (verbatim)

CLAUDE.md's header keeps the rule and points here for the two shapes that taught it:

> a documented "over-counts by one" is a fixed offset that silently absorbs real growth; a "committed
> but UNAPPLIED" note goes stale the moment someone applies it

## Displaced 2026-08-23 — the "a recorded correction has a shelf life" examples (verbatim)

CLAUDE.md keeps the rule and points here for the two shapes that taught it:

> a documented "over-counts by one" is a fixed offset that silently absorbs real growth; a "committed but UNAPPLIED" note goes stale the moment someone applies it
