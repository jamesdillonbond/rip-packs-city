# Handoff — 2026-07-26 · DB saturation, the retry amplifier, and the All Day resolver

## Context

A sweep session (Cowork) audited Supabase, Sentry, Vercel, GitHub Actions, pg_cron and the pipeline tables. Repo HEAD at the time: `d752f9ea`.

**Already shipped live from Cowork — no action needed, listed so you don't redo it.** Four migrations, all applied and verified against production:

| Migration | What |
|---|---|
| `audit_20260726_get_edition_offers_union_all` | `get_edition_offers` OR → UNION ALL. Verified 70/70 identical payloads across offer-heavy / `::`-parallel / zero-offer editions. Measured live after apply: **8.3 ms / 1,033 buffers** on a parallel edition (was 22,729 buffers, mean 518.6 ms, max 7,989.6 ms = its own 8 s timeout). |
| `audit_20260726_get_pack_lifecycle_row_perf` | `UNION` → `UNION ALL` + carry columns through the union instead of re-joining `pack_rips` by PK. Equivalence is structural, not sampled: branches are disjoint (`dist_id = X` vs `dist_id IS NULL`) and `topshot_pack_rip_attribution` is `PRIMARY KEY (rip_id)` — verified 37,323 rows = 37,323 distinct rip_ids, so neither the `UNION` dedup nor the `LEFT JOIN` could ever change cardinality. |
| `audit_20260726_revoke_anon_refresh_seeded_wallet_stats` | `REVOKE EXECUTE ... FROM anon, authenticated`. It is SECURITY INVOKER but calls SECDEF `holdings_summary()` **first**, so an anon POST could burn up to 21 s of DB time per request. Both callers verified to use `supabaseAdmin`. **This one was incomplete — see the next row.** |
| `audit_20260726_revoke_public_refresh_seeded_wallet_stats` | Post-verification showed the grants still read `PUBLIC, postgres, service_role`. Revoking anon and authenticated achieved **nothing**, because the function also carried the default `GRANT EXECUTE TO PUBLIC` and anon is a member of PUBLIC — the hole was exactly where it started. Now `postgres, service_role` only, re-verified. Worth knowing: `check_secdef_anon_execute_violations()` reported `0` throughout, because it only covers SECURITY **DEFINER** functions and this one is INVOKER. No existing invariant covers the "INVOKER wrapper around a SECDEF callee" shape. |
| `audit_20260726_pipeline_alerts_unmapped_backlog_arm` | Wires `check_unmapped_backlog_growth()` into `get_pipeline_alerts()`. Spliced via `pg_get_functiondef()` + `replace()` so no existing arm was retyped. |

**Heads-up:** that last one means `get_pipeline_alerts()` now returns a **`high`** alert, which pages via `/api/check-alerts`:

```
unmapped_backlog_growth · unmapped-sales-nfl_all_day · high
45611 open unmapped rows for nfl_all_day — inflow 4615/24h vs outflow 976/24h
(drain ratio 0.2115, net +3639/day). Oldest open sale 2026-02-04.
```

That is a true condition, not a false positive. It will keep firing until the All Day resolver is fixed (item 3 below). If the noise is worse than the signal in the meantime, insert a row into `pipeline_alert_suppression` for pipeline `unmapped-sales-nfl_all_day` with an `expires_at` — do not delete the arm.

This handoff covers the four things Cowork could not push, in priority order.

---

## 1. `lib/analytics/rpc-with-retry.ts` — the retry amplifier (do this first)

**Root cause.** `isTransient()` has no case for SQLSTATE **57014**. 57014 is not in `TRANSIENT_CODES`, is not `08xxx`, and is not `42xxx` — so it falls through to the message test on line 49, `msg.includes("timeout")`. Postgres' message for 57014 is *"canceling statement due to statement timeout"*, which contains the substring `timeout`. **Every statement timeout is therefore classified transient and retried 3×.**

Why it matters now: `d752f9ea` (shipped 2026-07-26) routed the entity-page section fetchers through `sectionRows` → `rpcWithRetry`. Vercel logged **272 `[edition] offers error canceling statement due to statement timeout` events in 24h** on `/[collection]/edition/[slug]` — and `edition/*` is **51.4% of collection page views**. Each of those now costs 3 × 8 s = **24 s** of database work instead of 8 s, on an instance that is already the binding constraint. The retry cannot succeed: the statement will hit the same ceiling every attempt.

`53300` and `57P01` stay transient — those are genuine pool problems. Only 57014 changes.

**Verified:** the only reference to `TRANSIENT_CODES` is inside this file (`grep -rn "TRANSIENT_CODES" --include=*.ts .` → 2 hits, both here). No caller depends on 57014 being retried.

Full file replacement for `lib/analytics/rpc-with-retry.ts`:

```ts
// Small wrapper around Supabase RPC calls that retries connection-class
// errors with exponential backoff. Used by every /api/analytics/* route.
//
// Why: when Vercel cold-starts a batch of analytics functions in parallel
// (e.g. a fresh deploy + a user opening /analytics/loans/topshot which
// fans out to 7 RPCs), a few of them race against Supabase's pgbouncer
// connection limit and surface as 500s. The errors self-heal within
// seconds; we just need to retry rather than failing the whole route.
//
// Logic-class errors (42xxx — undefined function, syntax errors, etc.)
// are *never* retried — they will fail every attempt and burning the
// retry budget just delays the user-visible failure.
//
// Neither is 57014 (query_canceled / "canceling statement due to statement
// timeout"). ADDED 2026-07-26: the message test below matches the substring
// "timeout", and Postgres' 57014 message *contains* it, so every statement
// timeout was being retried 3x. A statement that exceeded its timeout will
// exceed it again on attempt 2 and 3 — the retry is pure amplification, and
// it was tripling load on the product's highest-traffic surface
// (/[collection]/edition/[slug], 51.4% of collection page views, 272 such
// timeouts in 24h). 53300 and 57P01 remain transient: those are pool
// problems, not statement problems.

import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js"

// Postgres SQLSTATE codes we treat as transient connection problems.
// 08006 — connection failure
// 08001 — sqlclient unable to establish sqlconnection
// 08000 — connection exception
// 53300 — too many connections
// 57P01 — admin shutdown / pgbouncer pool exhaustion
const TRANSIENT_CODES = new Set(["08006", "08001", "08000", "53300", "57P01"])

// SQLSTATEs that look transient by message but are not. Checked before the
// message heuristics below, which are deliberately broad.
// 57014 — query_canceled ("canceling statement due to statement timeout")
const NEVER_RETRY_CODES = new Set(["57014"])

interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
}

function isTransient(err: PostgrestError | null | undefined): boolean {
  if (!err) return false
  // Postgrest exposes the SQLSTATE on .code; also accept connection-error
  // shapes whose code starts with "08" (any 08xxx is connection-class).
  const code = (err as any)?.code
  if (typeof code === "string") {
    // Checked first: these carry a message the heuristics below would match.
    if (NEVER_RETRY_CODES.has(code)) return false
    if (TRANSIENT_CODES.has(code)) return true
    if (/^08\d{3}$/.test(code)) return true
    // 42xxx — explicit logic class. Never retry these.
    if (/^42\d{3}$/.test(code)) return false
  }
  // Network-y messages from the JS client (fetch failures, AbortError) are
  // transient as well. Postgrest sometimes folds them into a string-only
  // error with no SQLSTATE.
  const msg = (err.message || "").toLowerCase()
  // Guard the SQLSTATE-less form of the same thing: a 57014 that arrives with
  // no .code still must not be retried.
  if (msg.includes("canceling statement due to statement timeout")) return false
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    // Supavisor/pgbouncer pool exhaustion surfaces as a plain-message error
    // (often no SQLSTATE): "Timed out acquiring connection from connection
    // pool." Note "timed out" (two words) is NOT caught by "timeout" above.
    msg.includes("timed out") ||
    msg.includes("connection pool") ||
    msg.includes("acquiring connection")
  ) {
    return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function rpcWithRetry<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  opts: RetryOptions = {}
): Promise<{ data: T | null; error: PostgrestError | null }> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = Math.max(1, opts.baseDelayMs ?? 50)

  let lastErr: PostgrestError | null = null
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await (client.rpc as any)(fn, args)
    if (!error) return { data: (data as T | null) ?? null, error: null }
    lastErr = error
    if (i === attempts - 1) break
    if (!isTransient(error)) break
    // Exponential backoff: 50ms, 200ms, 800ms (with the default base of 50).
    const delay = base * Math.pow(4, i)
    console.log(
      `[rpc-with-retry] transient error on ${fn} attempt ${i + 1}/${attempts}: ${error.message || (error as any)?.code || "unknown"} — retrying in ${delay}ms`
    )
    await sleep(delay)
  }
  return { data: null, error: lastErr }
}
```

Worth adding a unit test asserting `{ code: "57014", message: "canceling statement due to statement timeout" }` performs exactly **one** attempt — that is the regression that would silently come back.

**Revert:** `git revert` the commit. The only behaviour change is one fewer retry class.

---

## 2. `.github/workflows/topshot-listing-cache.yml` — an exact cron collision

**Root cause.** `rpc-pipeline.yml` and `topshot-listing-cache.yml` both schedule `5,25,45 * * * *`. That is **72 simultaneous firings a day, every hour**, against a database that is the binding constraint. Four times a day (`hours 02/08/14/20`) `badge-sync.yml`'s catalog sweep (`45 2,8,14,20`, the `--max-time 600` long route) lands on the same minute, making it a 3-way.

This directly contradicts the deliberate stagger recorded in `docs/operations/cron-schedule.md` and in memory ("cron start-minutes were staggered off :00/:20/:40 on 2026-06-07").

**Fix:** change the `schedule.cron` in `.github/workflows/topshot-listing-cache.yml` from `'5,25,45 * * * *'` to `'11,31,51 * * * *'`.

I enumerated every cron minute in `.github/workflows/*.yml`. Minutes already in use: 5, 6, 7, 9, 10, 13, 14, 15, 18, 22, 24, 25, 26, 30, 34, 37, 38, 39, 41, 43, 45, 46, 48, 50, 52, 54. **11 / 31 / 51 are free**, keep the 20-minute cadence, and avoid `:47`, which pg_cron uses for `rpc-selfheal-audit-table-rls`.

Two smaller collisions worth the same one-line treatment, lower priority:

- `ops-monitor.yml` (`13,43`) collides with `topshot-active-listings-ingest.yml` (`13 */3`) on 8 hours a day. Move the listings ingest to `16 */3 * * *`.
- `snapshot-institutional-wallets-backstop.yml` (`7 7 * * *`) collides with `topshot-sales-history-backfill.yml` (`:07`) daily at 07:07 UTC / 00:07 PT. Move the backstop to `2 7 * * *`.

**Revert:** restore the original cron strings. Nothing else depends on the minute.

---

## 3. `app/api/cron/allday-resolve-unmapped/route.ts` (+ `-tail`) and `lib/chains/flow/allday-edition-onchain.ts` — a resolver that runs 95×/day and reports `ok`

**The numbers, measured.** `unmapped_sales` by collection:

| collection | ingested 24h | resolved 24h | unresolved |
|---|---|---|---|
| `nfl_all_day` | 3,674 | 976 | **44,392** |
| `nba_top_shot` | 2,120 | 2,120 | **0** |
| `ufc_strike` | 33 | 0 | 938 |
| `laliga_golazos` | 0 | 0 | 109 |

Top Shot resolves 100% same-day. All Day nets **+2,698/day** and the backlog is 44,392 with the oldest open sale dating to 2026-02-04. Over 24h the resolver processed **35,424 candidates** (plus 4,482 in `-tail`) and promoted **172** — and `resolved_via_scan` was **0 across the entire day**, on 20,808 Flow REST range requests.

Four independent defects, in the order I'd fix them:

**3a — the tripwire cannot fire.** `route.ts:373`:

```ts
const degraded = attempted >= 5 && resolved === 0 && promoted === 0 && errs >= Math.ceil(attempted / 2)
```

`errs` counts only *thrown transport* errors. A borrow that returns `nil` increments `onchain_nil`, never `onchain_err`. `onchain_err` was **0 on all 95 runs**, so `degraded` is unreachable by construction — it can only fire when Flow itself is down, which is the case that was already visible. Replace with a productivity test:

```ts
const nils = summary.onchain_nil as number
const degraded =
  (attempted >= 5 && resolved === 0 && promoted === 0 && errs >= Math.ceil(attempted / 2)) ||
  (attempted >= 20 && resolved === 0 && promoted === 0 && nils === attempted) ||
  ((summary.scan_chunks as number) >= 100 && (summary.resolved_via_scan as number) === 0)
```

Mirror at `app/api/cron/allday-resolve-unmapped-tail/route.ts:310`.

**3b — one bad stored address suppresses the leg that works.** `route.ts:209` gates the tx-decode fallback on `if (buyers.length === 0 && row.transaction_hash)`. Every one of the 13 freshest stuck rows carries `buyer_address = 0xe4cf4bdc1751c65d` — **the All Day contract address, not a wallet** — and it is not in `EXCLUDED_ADDRESSES` (`lib/chains/flow/allday-edition-onchain.ts:29-33`, currently three entries: Flowty escrow, Flowty fee payer, Dapper DUC co-signer). Because `buyers` is non-empty, `decodeV1SaleTx` and `fetchTxBuyers` never run. Add the contract address to `EXCLUDED_ADDRESSES`, and change the gate so the tx-decode runs whenever the borrow produced no edition — not only when `buyers` is empty. **This is the leg that actually works: 178 of 178 of the day's on-chain resolutions came through it.**

**3c — the scan strategy is structurally impossible here.** Its premise is that `buyer_address` is a Dapper intermediate that re-deposits to the real wallet 160–440 blocks later. Checked against four stuck rows on `rest-mainnet.onflow.org`: the only in-window `AllDay.Deposit` recipient **is the already-tried buyer**, so `route.ts:267`'s `if (triedBuyers.has(holder)) continue` skips it and the run returns nil. Every time. For nft 7801331, a `Withdraw` fires 157 blocks after purchase with **no matching `Deposited` anywhere** — the moment went into storefront escrow, which is a `Listing` resource, not a `Collection`, so there is nothing to borrow. Compounding it: only **36** price-certain All Day rows in the whole table were sold inside `SCAN_MAX_AGE_DAYS = 7`, so the same ~25 rows are re-scanned on all 95 runs. Either gate the scan on `buyer_address` being a *known* Dapper intermediate, or drop the strategy. Cheapest first cut at `route.ts:258` — require `buyers.length > 0` — plus have `scanAllDayDepositsForNft` (`lib/chains/flow/allday-edition-onchain.ts:174`) return a `sawNonBuyerRecipient` flag so "found nothing new" is counted separately from "found a new holder".

**3d — a latent swallow, worth fixing while you're in the file.** `lib/chains/flow/allday-edition-onchain.ts:190-195` does `if (res.ok) blocks = ...` inside an empty `catch {}` with no error counter. `runAllDayScript` correctly throws on `!res.ok` (line 150), but the scan helper does not — so if Flow REST `/v1/events` ever starts returning 403, every scan silently returns `[]` and counts as `onchain_nil`, reproducing exactly the failure mode above with a genuinely broken transport. Add an `onchain_err` increment there.

**Two things this is NOT.** (i) The `[sniper-feed] AD GQL FAILED: HTTP 403` errors are unrelated — that group's `firstSeen` is **2026-06-16**, not today; the "27 events, all in 24h" reading was the query window, not the group lifetime. It is the long-standing consumer-GQL WAF block the resolver was built in June to route around, and `/api/cron/allday-resolve-unmapped` has **zero** error groups over 7 days. (ii) The backlog growth is **backfill-driven**, not live-resolution failure: of the 24h intake, 2,990 `onchain_dapper_v1` + 530 `onchain` rows carry `sold_at` reaching back to 2026-02-04, versus only 154 genuinely fresh `onchain_dapper_v2` — and only 136 of 44,392 unresolved rows were sold in the last 7 days. The historical backfills inject old sales faster than any on-chain leg can drain them, and old rows are precisely what the 7-day scan gate excludes.

**Also stalled, same wall.** `allday-price-recover` (`app/api/admin/recover-v1-budget-exhausted/route.ts`) is the *real* drain — 575 of the day's 976 promotions — and its last three runs read `rows_found: 470, promoted: 0, fail_reasons: {multi_nft_tx_total_unsplittable: 470}` while reporting `ok: true`. Cause: `sales_2026_transaction_hash_unique_idx` is UNIQUE on `transaction_hash` **alone**, so a multi-moment transaction can contribute exactly one `sales` row. 4,257 of 24,915 open price-certain rows sit in 1,530 multi-moment txs. Widening that index to `(transaction_hash, nft_id)` would unblock them — **but that is a partitioned-`sales` index change on the FMV-feeding table and is your call, not a handoff item.**

**Revert:** each of 3a–3d is an independent commit; revert individually.

---

## 4. `refresh_seeded_wallet_stats` is called ~11×/wallet/day for a cross-collection aggregate

**Root cause.** The function is a thin wrapper over `holdings_summary(wallet)`, which aggregates **every collection the wallet holds**. But it is called from `stampLastRefreshed` at the end of **each per-collection backfill** — `app/api/wallet-backfill/route.ts:158` (Top Shot) and `lib/chains/flow/wallet-backfill-helpers.ts:417` (the other four). Measured over 24h: 2,781 backfill runs across 253 distinct wallets = **10.99 calls per wallet per day**, of which at least 4 in 5 are byte-identical duplicate work.

It was the **single largest consumer of database time** in `pg_stat_statements`: 17,465 calls, 164,847 s total. **Read that number carefully** — the stats window is 9.59 days (reset 2026-07-16 15:40 UTC) and the `holdings_summary` rewrite landed 2026-07-25, so ~94% of those calls predate the fix and the 9,439 ms mean is stale. Measured live today: **290 ms** on a 58-moment wallet, **21,279 ms** on a 152,806-moment whale. The whale path reads **31,697 blocks (247 MB) from disk per call at ~90% cache miss**, against `shared_buffers = 512 MB` and an 803 MB `wallet_moments_cache` heap — so each whale refresh evicts roughly half the buffer pool. That is the mechanism connecting this to the ~1,090 public-page statement timeouts a day.

**The fix I recommend is caller-side, not a SQL debounce.** A debounce inside the function is first-wins: whichever collection's backfill finishes first would claim the refresh and compute the cross-collection aggregate *before* the other four collections' data lands, so the cached stats would reflect a partially-updated wallet until the next tick. Today's behaviour is last-wins and therefore complete. **Move the `stampLastRefreshed` call out of the per-collection path and into whatever orchestrates the five backfills, so it runs once after all of them.** That is ~11 → ~2 calls per wallet per day with no correctness loss.

Two tests assert the current shape and will need updating: `__tests__/api-wallet-backfill-deep.test.ts:219,279` and `__tests__/wallet-backfill-helpers.test.ts:315`.

**Considered and rejected for now:** a covering index `ON wallet_moments_cache (wallet_address, collection_id) INCLUDE (edition_key, tier, fmv_usd)` would take the whale's 247 MB heap read down to roughly 15 MB. I did not apply it because `wallet_moments_cache` **already carries 13 indexes** (803 MB heap → 2,170 MB total) and is a hot write path — `upsert_wmc_batch` is itself 39,601 s of DB time in the same window. A 14th index is a real write-amplification decision, and per the memory note on covering indexes it also needs a fresh visibility map to pay off. Worth doing only if item 4's call-count fix isn't enough. Re-`EXPLAIN` before claiming the win either way.

**Revert:** move the call back into the per-collection path.

---

## Also worth your attention (no code change proposed)

**Both Dune lanes have been dead for ~46 hours.** `sales-ingest-dune` last succeeded **2026-07-24 06:11 UTC**, `sales-seller-recovery-dune` at **04:47 UTC**; since then every tick fails in ~650 ms with `windows_done: 0`, cursor parked (ingest at `2021-12-30..2022-01-01`, recovery at `2025-10-22..2025-10-24`). 24h: 11/11 and 23/23 failed. That signature — fast fail, nothing partial written, cursor parked — matches the documented HTTP 402 *"would exceed your configured datapoint limit per billing cycle"* exactly, but **I did not confirm it from logs** (the Vercel runtime-log API timed out on every window I tried), so treat the 402 as the leading hypothesis, not a finding. Either way the two lanes are burning 34 invocations a day for zero rows. Nothing about this contradicts the 07-26 correction that the *ingest* lane earns its keep — 125,024 rows recovered 07-19→07-24 is still true; the lane just stopped on 07-24.

**Vercel Web Analytics is not enabled** (`get_web_analytics` → `404 Web Analytics not found`). Given traction is the only gate and a channel test is the next move, this is worth turning on **before** publishing anything: it collects no backfill, so referrer attribution for a channel test only exists if it is on beforehand. That is a dashboard toggle, not code.

**`badge-sync.yml`'s catalog sweep looks dead.** Pipeline `topshot-badge-catalog`: 2 runs in 7 days against a `45 2,8,14,20` schedule (28 expected), 0 in the last 24h, last run `2026-07-24 05:36:44Z` — a timestamp matching none of the four scheduled slots. It is GHA-exclusive by its own comment. I could not confirm from the Actions API (see below).

**I could not read GitHub Actions run history.** `gh` is not installed in the Cowork container and every repo-scoped GitHub API call returned 403 (`GitHub access to this repository is not enabled for this session`). Everything above about workflows comes from reading `.github/workflows/*.yml` in a fresh clone plus `pipeline_runs` as a proxy. **Per-workflow pass/fail rates are unverified.** Worth one `gh run list --limit 60` on your machine.

**`ci.yml` now has 7 jobs** (`typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `db-tests`, `ledger-guard`); `CLAUDE.md` still documents 6 — `component-tests` is undocumented. No deprecated action versions anywhere (all `checkout@v4` / `setup-node@v4`).

---

## Guardrails

- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, `git switch main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify with `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash** for Vercel REST — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800 s** — anything higher sends the deploy to ERROR invisibly.
- **CRLF:** don't string-replace-patch on Windows. Use full-file writes, or `findIndex` on split lines.
- **Ledger-first, code-last is necessary but not sufficient.** Before pushing, confirm the tip commit isn't docs-only: `git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md'; echo $?` must print `1`.
- **Pull before you start.** The checkout was two days behind at the last session's start, and four migrations have landed on the DB since this doc was written.
- Log each item in `CLAUDE.md` "Recent sessions" and `docs/overnight/ledger.md` with its revert command.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## Expected end state

Four commits on `main`, deploy READY, `npx tsc --noEmit` clean, smoke green. The measurable outcomes: `[edition] offers` timeout events fall by roughly two thirds immediately (item 1 removes the 3× amplification) on top of the ~22× buffer reduction already shipped in `audit_20260726_get_edition_offers_union_all`; the `5,25,45` triple-fire disappears from the GHA schedule; and `allday-unmapped-resolver` starts reporting `ok: false` when it produces nothing, which is the precondition for anyone noticing that the 44,392-row backlog is growing.
