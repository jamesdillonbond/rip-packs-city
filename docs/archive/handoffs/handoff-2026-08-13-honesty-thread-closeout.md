# Handoff — Aug 12–13 honesty thread, closeout

Claude Code (web), 2026-08-13 ~08:20 PT. Thread being archived. Everything below is
**pushed, CI-green and deployed READY**; nothing is half-landed. This document exists for
the items I could NOT close, and for who should pick each one up.

---

## Where the tree is

Tip `ddbc750b`, clean, in sync with origin. Both gates green (primary 1150 files, component
185 / 1560), `tsc` clean. Ledger at 1271 entries.

**Live health at handoff:** `check_cursor_stall_threshold_drift()` → `[]` · board snapshots
warm · DB quiet (4 IO waiters, 3 long-running) · **`check_edge_fn_http_failures()` → 1 alert,
which is item 1 below.**

---

## 1. OPERATOR — finish the edge-fn gate-key rotation (jobid 16) ⏰ clock running

**Who:** Trevor, from a machine that holds the Supabase secrets. Not doable from any sandbox.

pg_cron jobid 16 `rpc-backfill-pack-pool` is 403ing **100% of its dispatches (288/day)**. It is
the residue of the 2026-08-11 half-rotation: the `?key=` values were rotated but the edge
functions were never redeployed and the secrets never set.

**Do it as ONE window — any subset reproduces the 08-11 outage:**

1. set the 8 `*_GATE_KEY` secrets → 2. deploy the env-var edge functions → 3. repoint every
pg_cron `?key=` together.

⚠ **The seven jobs currently repaired use the PRE-rotation literals, which are public in this
repo's git history.** No NEW exposure (the deployed fns already accept them), but the rotation
is genuinely unfinished.

⚠ **Why this is urgent beyond the data:** `check_edge_fn_http_failures()` is wired into
`get_pipeline_alerts()` at **`critical`** and has been firing on every evaluation since 08-12.
It was built on 08-11 specifically to catch the next silent-403 outage. This repo has recorded
twice what a permanently-red arm does (`ufc_fmv_stale_hours`; the 08-11 outage dismissed five
times behind a stale annotation). **An always-on critical arm is worse than no arm.**

⚠ **Do NOT retire jobid 16.** I retracted that option after measuring: **545 of 4,639 dists
(11.7%) are covered ONLY by `pool_source='gql_historical'`**, with exactly zero overlap, and
that flag is load-bearing in `v_pack_remaining_basis` (it emits `original_supply_mislabelled`,
the disclosure that stops pack-EV presenting an original-mint-share pool as remaining supply).
Full reasoning: `docs/overnight/inbox/2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md`.

## 2. OPERATOR — one `wrangler deploy` for `rpc-mcp-proxy`

Committed but **inert**. The worker's `get_badge_data` tool description tells every LLM agent
that a WORKING RPC is broken (it claims an `unaccent` error; verified live, the fn carries
`search_path=public, extensions, pg_temp` and returns real badges). Tool descriptions are
agent-facing config — stale text there actively routes agents away from working tools.

## 3. CLAUDE CODE (terminal, next quiet-DB window) — the board-view timeouts

**This is the only remaining piece of the thread's actual subject, and it is now fully
diagnosed.** Read `docs/overnight/inbox/2026-08-12T2330Z-board-view-timeouts-now-named.md`
first — the telemetry that produced it shipped 08-12 and its first harvest is in there.

- Failing: `cross_collection_deals_board` (deals), and BOTH first-mint views. `deals` warms
  19% of the time, `first-mint` 16%.
- `service_role` carries **`statement_timeout=30s`**, and `topshot_first_mint_trophy_stats`
  measured **2,047 ms** on a quiet instance with its covering index alive and in use (591
  scans). A ~2s query crossing a 30s ceiling is a **~15× throttling multiplier, not a plan
  defect.**
- ⚠ **Do NOT respond with another index on `sales_2026`.** The 08-11 index did its job. The
  lever is the shared **materialize-latest-FMV** item CLAUDE.md already names, which closes
  `cross_collection_deals_board` and `/api/market` together.
- **User impact today is NIL** — all five board snapshots exist and serve; the cache is doing
  its job. This is worth fixing for cost and for deploy reliability, not because anything is
  visibly broken.

## 4. CLAUDE CODE (terminal, needs a genuinely quiet instance) — deep-audit D25

128 wmc rows render an impossible serial ("#500 / 499"). Already characterised: **34 are
stale-denorm and correctable** (wmc disagrees with `editions.circulation_count`, which is
authoritative), 94 are upstream-wrong with no local fix. ⚠ `backfill_wmc_metadata_from_editions`
will NOT fix them — it is COALESCE fill-only by design, so this needs a deliberate targeted
UPDATE. I never got a quiet enough window; every attempt to re-measure timed out and I stopped
rather than hammer prod.

## 5. TREVOR — two product/exposure calls, deliberately not taken

- **The wmc STALE-label denorm** (`docs/overnight/inbox/2026-08-12T0358Z-stale-label-lost-in-wmc-denorm.md`).
  `fmv_current` carries `confidence`; `wallet_moments_cache` does not, so a 2-year-old print
  renders as current value on the anon-public `/share/[wallet]`. Options A (carry `confidence`
  onto wmc) / B (null the denorm — loses real information) / C (disclose at the surface) are
  costed there; recommendation is **A then C**. It touches a hot 2.2M-row table and 34
  consumers, so it is an owner's call.
- **`panini-ingest` severity raise** — unchanged, still yours.

---

## What was closed, so nobody re-opens it

The "a failed read must not render as an answer" class is now shut at **every layer I can
reach**, each with a mutation-proven guard:

| layer | helper | guard |
|---|---|---|
| any anon-reachable API route | `lib/api-error.ts` → `apiErrorResponse()` | executes the real `isPublicPath` from `proxy.ts` over every route file |
| server page | `lib/insights/board-status.ts` | directory-driven over `app/insights/**` |
| client dashboard | `lib/analytics/fetch-json.ts` | directory-driven |
| **the concierge** (renderer is a model) | a CRITICAL rule in the system prompt | asserts the rule AND that the tools still emit the shape |

Plus, in this subsystem: the build-killing slow board (`BOARD_LIVE_TIMEOUT_MS`), the board-warm
telemetry, panini's page cap, candy's row caps, and — the third instance of one shape — the
`summarizeDegraded` primitive itself.

⚠ **The one thing to carry forward:** *slow* and *broken* are equally unservable, and this
subsystem modelled only *broken* in three separate places. If you find a fourth guard here,
check whether it covers the failure its author was thinking of, or all of them.

⚠ **`cont. N` in the ledger is NOT session-unique** — two sessions increment the same counter.
Cite shas in cross-references.
