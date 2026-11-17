# 📋 `snapshot-institutional-wallets` — the gate is merged and NOT deployed; here is the one command, and the drift hazard is **narrower than "unknown"**

*Filed 2026-09-14 ~10:35 AM PT by Cowork (cloud). **READ-ONLY — nothing deployed.** Exists so the remaining step is an action, not a re-derivation. Pairs with `ba3366040` (the writer gate) and Claude Code's DB-side trigger.*

## Why this is still open

`ba3366040` added `shouldPersistSnapshot()` and gated the snapshot upsert on it, so a partial `wallet_moments_cache` walk can no longer be written as the day's holdings. **That is in the repo and not in production.** Nothing auto-deploys edge functions — `edge-fn-drift.yml` is a nightly READ-ONLY sweep, and its own header names this exact state: *"an edge function can be fixed, reviewed, tested, merged — and still never run, silently."* **Expect that sweep to flag this function tonight. That flag is correct.**

⛔ **I did not deploy, for two reasons and the second is the stronger one.** (1) I cannot run the §5 positive control: the next scheduled fire is 06:00 UTC and invoking it by hand needs the `INGEST_SECRET_TOKEN` bearer, which I will not handle. (2) Claude Code's 09-14 entry: this function is in the **content-drifted set (#23 / R63)** — the deployed build is not this repo's source, so a redeploy ships **every** unshipped change in that file, not just the gate.

## ⭐ The hazard is narrower than "unknown diff", and this is the new fact

**I read the deployed source today** via `get_edge_function` (version **31**, `verify_jwt: false`, `import_map: true`). Against it I can say, from the text rather than from inference:

| claim about the DEPLOYED build | verdict |
|---|---|
| carries the `ORDER BY collection_id, moment_id` paging fix **and its full comment**, incl. the 161,366-fabricated-buybacks case | ✅ **present** — the biggest prior fix is already live |
| `PAGE_SIZE = 250` · `MAX_PAGES = 500` · `FUNCTION_VERSION = 2` | ✅ match repo |
| `captureSnapshot` still has the bare `if (rows.length === 0)` and **no gate** | ✅ confirms the defect is live in prod |
| imports from `_shared` are exactly `aggregateHoldingsByCollection, isTransientErr` | ✅ so `shouldPersistSnapshot` is absent there too |

⚠ **What that does NOT establish:** I did not byte-diff the deployed file against repo HEAD. **The drift, whatever it is, is not in the paging loop, the page constants or the aggregation import — those match.** Anyone deploying still owes the diff, but it is now a diff of the remainder, not of the whole file.

## The deploy, exactly

The CLI is documented as **unavailable on Trevor's box** (both auth traps live, 2026-08-15) — go straight to the MCP fallback. ⚠ There is **no `?key=` gate** on this function (it authenticates `Authorization: Bearer INGEST_SECRET_TOKEN`), so §1's secret-before-deploy ordering hazard does **not** apply here.

`mcp__Supabase__deploy_edge_function`, project `bxcqstmqfzmuolpuynti`:

- `name`: `snapshot-institutional-wallets`
- `verify_jwt`: **`false`** ⛔ (the tool defaults to `true`; leaving the default 401s every caller)
- `import_map_path`: `functions/deno.json`
- `entrypoint_path`: `functions/snapshot-institutional-wallets/index.ts`
- `files` — **all three, named exactly as the deployed build names them:**
  - `functions/snapshot-institutional-wallets/index.ts`
  - `functions/_shared/institutional-snapshot.ts` ← **the gate lives here; omitting it breaks the import**
  - `functions/deno.json` ← **must be resupplied on every deploy once a function carries an import map**

## Verifying it, in the only order that proves anything

1. `list_edge_functions` → `verify_jwt` must still read **`false`**. A deploy that flipped it 401s every caller and writes **no** `pipeline_runs` row, so it looks like silence, not failure.
2. Then the positive control, **after the next 06:00 UTC fire** (or a hand-invoked run by someone who holds the token):

```sql
select started_at, ok, left(coalesce(error,''),160), extra->>'function_version'
from pipeline_runs where pipeline = 'snapshot-institutional-wallets'
order by started_at desc limit 5;
```

⭐ **The success shape to look for is specific, not just `ok = true`:** on a wallet whose walk fails mid-page you should now see the run report `snapshot_skipped: incomplete_load (N row(s) read before the walk failed)` and **write no snapshot row for that wallet**, rather than upserting a shrunken one. On a clean day it is indistinguishable from before — which is the point.

⚠ **Do not read a green run on 09-15 as proof the gate works.** 09-15's diff is 52,120 vs 09-14's 52,120 = **0 arrivals**, so the lane goes green on its own whether or not anything was deployed. **The gate is only exercised by the next partial load.**

## What is already handled elsewhere, so nobody does it twice

- **The corrupt 09-13 row is deleted** (with a backup) and `trg_whs_refuse_same_day_collapse` is live on INSERT **and** UPDATE — Claude Code, 09-14. **That trigger is the reason this deploy is not urgent:** it refuses the write even from a caller that is not this function, so the repo gate and the DB trigger are belt and braces, not duplicates.
- **Zero fabricated buybacks landed** — verified: no `metadata->>'detected_via' = 'snapshot_diff'` rows exist in the last 10 days. The statement timeout rolled both attempts back.
