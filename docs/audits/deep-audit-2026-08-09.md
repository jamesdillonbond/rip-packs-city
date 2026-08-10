# RPC monthly deep audit — 2026-08-09 (16:34–18:0x PT)

First run of the monthly deep audit. Persistent findings register created at [deep-audit-register.md](deep-audit-register.md) — **that file is the durable artifact; this one is the run log.**

## Run conditions (these bound every claim below)

- **NO GIT.** `mcp__workspace__bash` failed identically on resume/create/re-resume (`useradd … /sessions no space left on device`) — the **third consecutive** autonomous run blocked this way (08-08 night, 08-09 night, now). No clone, no commit, no push, no CI, no deploy. DB (Supabase MCP), Vercel, Sentry and the Windows file tools all worked.
- **Active disk-IO saturation window.** The 14:10 PT daytime monitor recorded one; it was still live at 16:40 PT. Multiple queries in this pass hit `57014` at the default statement timeout and succeeded on retry with an elevated one. **Every duration in this report is a saturated-window figure and understates healthy performance.**
- No `docs/FREEZE.md`.
- Six read-only sweeps (security, pipelines, data integrity, rendered-DOM QA, codebase/backlog, growth/SEO) ran concurrently as subagents.

## What shipped

**One fix, DB-side, verified in production: the wmc metadata denorm backlog — 56,898 → 197.**

56,898 rows in `wallet_moments_cache` rendered a **nameless, mintless moment** — 47,498 NFL All Day across 49 wallets, plus 9,400 LaLiga Golazos in a single wallet. This was not missing data: **99.6% of the AllDay rows and 100% of the Golazos rows resolved to an edition that already held both a player name and a circulation count.** We had the data and rendered nothing.

Mechanism (read from the code, not inferred): `runAllDayDetailsBackfill` inserts rows with `player_name: null` *by design* (`lib/wallet-backfill-helpers.ts:978-992`) and fills them in a post-pass call to `backfill_wmc_metadata_from_editions` at `:1004`. That post-pass failure is only `console.warn`'d (`:1009`) — never written to `pipeline_runs` — and a route killed at `maxDuration` never reaches it at all. Rows then never self-heal, because the next walk's `skipCached` filter treats any row with an `edition_key` as already enriched. The Golazos case is the clean signature: all 9,400 rows created inside a single 60-second window on 2026-08-04 and untouched for 5 days.

Fix: ran the existing pinned SECDEF `backfill_wmc_metadata_from_editions(wallet, collection)` per wallet — COALESCE fill-only, idempotent, no deletes, no schema change, cannot overwrite a non-null value.

**Verified after, not assumed:**
- `56,898 → 197` on sweep C's canonical re-probe.
- The 197 residue is **fully explained and genuinely unfixable by this path**: 59 rows have a NULL `edition_key` (no join key), 138 point at an edition that itself has no `player_name` and no `team_name`. That is now an honest gap, not a defect.
- Golazos `mint_count` NULLs went **9,400 → 0** as a side effect (same COALESCE).
- Spot-checked 5 filled Golazos rows against `editions` — player, set, tier and mint count match **exactly** (Santi Cazorla / Capture the Flag / RARE / 375, etc.). Non-null was not accepted as proof of correct.
- Post-change security invariants re-run: `rls_off 0`, `check_public_security_invariants() 0`, `check_anon_write_surface() 0`, secdef drift `0`.

**Revert:** none needed or possible — fill-only, nothing deleted, no prior value overwritten, no DDL.

⚠ **This repair will decay.** 47,305 of the 47,498 AllDay rows were created within the last 7 days, so the generator is live. The durable fix is D8 in the register and is code-side.

## Method notes worth keeping

1. ⚠ **`select count(*) from check_secdef_anon_exec_drift()` returns 1 when the surface is CLEAN.** The function returns a single row containing a JSON array, so `count(*)` counts the row, not the findings. My opening health probe used it and produced a **false security alarm** that I chased before the sweep disproved it. Correct probe: `jsonb_array_length((select check_secdef_anon_exec_drift()))` → expect `0`. Recorded at the top of the register.
2. ⚠ **"The connector's server isn't responding" is a CLIENT timeout — the server keeps running and commits.** Two batches returned that error; one had genuinely committed (verified: 8 wallets, 2 rows left) and one had rolled back (verified: 24,253 rows untouched). **Never infer either outcome — re-probe the actual state.** The difference was that the rolled-back batch was a single `DO` block (one transaction, all-or-nothing) containing a 24k-row mega-wallet that exceeded the server-side 280s.
3. **Under saturation, a `DO`-block loop is the wrong unit of work.** All-or-nothing means one slow wallet discards the whole batch's completed work. Small batches excluding known-large wallets, each its own transaction, drained the backlog with no wasted IO.
4. **Plain `EXPLAIN` is safe on a throttled instance** (planning only, no execution) and settled a design question that would otherwise have been a guess — see below.
5. **Sweep D's method finding:** `get_page_text` **silently drops KPI stat values** on this site — a Top Shot Overview read as blank KPIs twice while the screenshot showed `19,667 / 32% / $32,584`. Screenshots are the arbiter for numbers, and pages routinely need 20–28s to settle, so a 10s wait manufactures false "empty" readings.

## What I deliberately did NOT do

**Did not install a pg_cron self-heal for the wmc denorm**, even though it is the obvious durable fix and the repair will decay without it. I measured it rather than guessing: plain `EXPLAIN` on the unscoped fill gives **cost 131,420, seq-scan-bound on `wallet_moments_cache`** (126,991 of the cost is a full scan of the 2.2M-row table; the `editions` side is only 2,874). The scan is paid every run no matter how few rows match.

The obvious optimisation — a partial index on `WHERE player_name IS NULL` mirroring the existing `idx_wmc_fmv_null` / `idx_wmc_image_url_null` — is **the wrong fix here**: partial-index predicates block HOT updates exactly like keys, and wmc write amplification was only just closed on 2026-08-09. Adding a third such index on the platform's hottest table would reopen it.

So this needs a judgment call with measurement I cannot safely take right now (no `EXPLAIN ANALYZE` budget under saturation, no ability to test or revert via git). Installing an unmeasured nightly full scan on the hottest table during a documented IO crisis is how an audit becomes an incident. Handed off with the cost figure and the index tension spelled out.

**Did not make any code edits.** With no git, no CI and no deploy, blind edits would leave Trevor a dirty tree of unverified changes. Every code finding is in the handoff instead.

## Headline numbers

**Traction** (the number that matters, per the accuracy-is-the-gate framing):

| metric | value | window |
|---|---|---|
| **`wallet_paste`** | **5** | 7d |
| **`wallet_paste`** | **9** | 30d (30 lifetime) |
| New accounts | **1** | 30d |
| Signed-in WAU | **1** | 7d |
| Engaged anonymous sessions | **~8–20** | 7d (105 raw sessions, but 1.53 events/session — mostly one-hit crawlers) |
| `email_subscribers` | **0** | all time |
| Concierge messages (real) | **0** | 7d — last real message 2026-07-21 |
| Outbound listing clicks | **0** | 7d |

⚠ **Any concierge figure read without `WHERE NOT is_smoke_test` overstates by ~74×** (1,681 of 1,704 30d rows are smoke tests).

**Platform health:** security 4/4 clean · `detect_stalled_pipelines()` `[]` · pipeline failure rate 2.20% (320/14,569 in 24h), ~80% saturation-class · 8 pg_cron jobs timing out, all the known self-recovering MV/aggregate class · 0 security or performance advisor ERRORs.

**Data quality:** FMV HIGH+MED share TS 46.6% · AllDay 22.1% · Candy 58.4% · Pinnacle 29.7% (untracked) · Golazos 0.35% · UFC 0.0%. ⚠ The TS figure **oscillates 55.8–71.0 across 7 days with no trend** — the apparent decline from CLAUDE.md's 54.9 is a sampling artifact of where the daily sweep sits, not a regression. Quote a 7-day mean.

## Findings summary

38 findings recorded (D1–D38 in the register). **5 are P0:**

- **D1** — unauthenticated service-role write IDOR on `/api/support-chat/feedback` (anon can flip feedback on any of 4,932 rows by sequential id; signed-in can overwrite attribution on the 18 rows carrying a real email).
- **D2** — 8 hardcoded cron gate keys in a **public** repo, sole auth on ingest/backfill/compute edge functions, mirrored in ~9 committed docs.
- **D3** — `/nba-top-shot/sets` renders a raw Postgres error to end users on the flagship collection.
- **D4** — TS Sniper shows `0 deals` by default while 200 exist (default-on "VERIFIED FMV ONLY"), while Overview advertises those same deals.
- **D5** — four user-facing copy claims the product no longer honours: homepage "buy / skip recommendations", `/privacy` wallet-connect + purchases, `/pricing` selling a 404ing `/rewards`, and the concierge denying two boards public for 9–10 days.

Full detail, evidence and per-item re-probes are in the register.

## Correction to a prior ledger entry

The 2026-08-09 migration-parity entry states *"the 3-day window is now clean (0 missing)"* and gives that as the precondition for making `migration-parity.yml` enforcing. **That is no longer true.** Three prod migrations applied later the same day have no committed file: `20260809200134`, `20260809200600` (both redefine `mv_topshot_perfect_mint_premiums_board`, a **public** board MV) and `20260809203055`. The ledger separately asserts two of them were *not* shipped — prod disagrees. `docs/wrapup-2026-08-09-ledger-and-claudemd.md` holds a paste-ready entry that was never spliced. Recovery is lossless: `supabase_migrations.schema_migrations.statements` holds the exact applied body. Tracked as D14; the 14-day backlog is now 223 (was ~114).

---

## Paste-ready ledger entry

Not spliced by this session: `ledger.md` is append-at-top and concurrently written, the shell was down so I could not re-read-then-splice atomically, and a prior session already welded a heading onto line 9 doing exactly this. **Splice this manually, re-reading the file from disk first, and confirm `grep -c '^### '` goes UP by exactly 1.**

```
### 2026-08-09 · SHIPPED — DATA REPAIR (Cowork, monthly deep audit) · 56,898 wallet rows rendered a nameless, mintless moment while the name sat in `editions`

**Not missing data — a denorm failure.** 47,498 NFL All Day rows across 49 wallets + 9,400 Golazos rows in one wallet had NULL `player_name`/`mint_count`; **99.6%/100% of them resolved to an edition that already held both a player name and a circulation count.** `runAllDayDetailsBackfill` inserts NULL by design (`wallet-backfill-helpers.ts:978-992`) and fills via a post-pass `backfill_wmc_metadata_from_editions` at `:1004` — whose failure is only `console.warn`'d (`:1009`), never logged to `pipeline_runs`, and which a route killed at `maxDuration` never reaches. Rows never self-heal: the next walk's `skipCached` treats any row with an `edition_key` as enriched. Golazos signature: all 9,400 created in one 60-second window on 08-04, untouched 5 days.

**Fix:** ran the existing pinned SECDEF `backfill_wmc_metadata_from_editions(wallet, collection)` per wallet (COALESCE fill-only, idempotent, no deletes, cannot overwrite a non-null). **Verified 56,898 → 197**, and the 197 are fully explained: 59 have a NULL `edition_key`, 138 point at an edition with no name of its own — an honest gap now. Golazos `mint_count` NULLs 9,400 → 0. Spot-checked 5 filled rows against `editions`: player/set/tier/mint match exactly.

⚠ **This decays** — 47,305 of the 47,498 AllDay rows were created within 7 days, so the generator is live. Durable fix is code-side (log the post-pass failure) — queued as D8.

⚠ **Deliberately did NOT install a pg_cron self-heal.** Plain `EXPLAIN` on the unscoped fill: **cost 131,420, seq-scan-bound on wmc** (126,991 of it a full scan of 2.2M rows), paid every run regardless of how few rows match. The obvious partial index on `player_name IS NULL` is the WRONG fix — partial-index predicates block HOT exactly like keys, and wmc write amplification was only just closed on 08-09.

⚠ **Method, durable:** "The connector's server isn't responding" is a CLIENT timeout — the server keeps running and commits. Two batches returned it; one had committed, one had rolled back. **Re-probe the actual state, never infer.** A `DO`-block loop is one transaction, so one slow mega-wallet discards the whole batch's completed work.

⚠ **`select count(*) from check_secdef_anon_exec_drift()` returns 1 when CLEAN** (single row containing a JSON array) — it produced a false security alarm this session. Use `jsonb_array_length((select check_secdef_anon_exec_drift()))` → 0.

**Revert:** none needed — fill-only, nothing deleted, no DDL, no prior value overwritten.

**QUEUED:** 38 findings (D1–D38) in the new persistent register `docs/audits/deep-audit-register.md`, 5 of them P0 — an unauthenticated service-role write IDOR on `/api/support-chat/feedback`, 8 hardcoded cron gate keys in the public repo, `/nba-top-shot/sets` rendering a raw Postgres error, TS Sniper showing 0 of 200 deals by default, and 4 user-facing copy claims the product no longer honours. Handoff: `docs/handoff-2026-08-09d-deep-audit.md`.

⚠ **Corrects this file:** the 08-09 migration-parity entry's "3-day window is now clean (0 missing)" is STALE — 3 prod migrations from later the same day have no committed file (`20260809200134`, `20260809200600`, `20260809203055`), two of which redefine a public board MV, and this file asserts two of them were never shipped. 14-day backlog now 223 (was ~114).
```
