# 2026-09-01T0300Z — item 13 names four functions as carrying the `plan_cache_mode` fix; the catalog says two, and the other two should stay as they are

**Pass:** cloud-only, fired 02:58:31Z = 2026-08-31 19:58 PT. Repo read at `7c63fa3` (no commit on main in
~19.4 h). Health GREEN. Shipped: migration `20260901030456`.

## The finding

Open thread #13 states the PG 17 param-blind remedy (plpgsql `RETURN (...)` +
`SET plan_cache_mode = force_custom_plan`) was *"Shipped for get_wallet_moments_with_fmv,
get_wallet_total_fmv, get_fmv_for_editions, get_pack_realized_ev_row."*

Read from `pg_proc` at 03:0xZ, only the first two carry it. `get_fmv_for_editions` and
`get_pack_realized_ev_row` are still `LANGUAGE sql` with no `plan_cache_mode` in `proconfig`.

The migration register explains why, and it is not a lost ship — it is two remedies from the same night
being remembered as one:

| version | name | remedy |
|---|---|---|
| 20260830023744 | `…get_wallet_moments_with_fmv_plpgsql_custom_plan_sql_functions_are_param_blind` | plpgsql + force_custom_plan |
| 20260830025740 | `…get_wallet_total_fmv_scopes_latest_fmv_to_the_wallet_and_plans_with_its_params` | plpgsql + force_custom_plan |
| 20260830030332 | `…get_fmv_for_editions_latest_per_edition_lateral_instead_of_fmv_current_distinct_on` | **LATERAL rewrite** |
| 20260830032541 | `…get_pack_realized_ev_row_pushes_the_listing_key_into_pack_ev_latest` | **predicate pushdown** |

#13's quoted post-ship numbers for the latter two (17.8 ms / 26 reads; 283 ms / 246 reads) are measurements
of the LATERAL and pushdown fixes.

## Why this matters more than a wording nit

A future pass reading #13 would check those two functions, find the remedy absent, and "finish the item" by
applying it. That would be wrong twice over: their plans no longer depend on parameter *values* (both are
key-lookup shapes), and the ledger already records a controlled test in which `force_custom_plan` made **no
difference** and concluded *"#52's remedy does not generalise to this function"*.

**⛔ NO ACTION. Do not apply `force_custom_plan` to `get_fmv_for_editions` or `get_pack_realized_ev_row`.**

**Suggested #13 wording:** the remedy shipped for `get_wallet_moments_with_fmv` and `get_wallet_total_fmv`;
`get_fmv_for_editions` and `get_pack_realized_ev_row` were fixed the same night by different means and are
**correctly** still `LANGUAGE sql`.

## Second, smaller finding — the trust board answers a question you did not ask

`public.get_trust_health()` does not exist. The board is the view `public.v_rpc_trust_health`, columns
`(metric, value, breach_at, status, catches)`. A filter on a non-existent `is_breach` column returns `[]` —
**a clean all-green over two real breaches** — because the missing key is NULL and every row is dropped.

Correct predicate: `status is distinct from 'ok'`, or `upper(status) <> 'OK'` since the values are
case-mixed (`ok` / `BREACH`).

Same family as the `count(*)` on `check_secdef_anon_execute_violations()`, which reads 1 when clean. Both
belong in tooling-gotchas under one heading: **an instrument that returns good news in the wrong shape.**

ⓘ That read is also expensive: **~280k–350k buffers per SELECT** of `v_rpc_trust_health`, measured three
times in this pass's own pgss diff. Read it once per pass and reuse the rows.

---

## ✅ CONFIRMED AND ACTIONED 2026-08-31 20:5x PT (Claude Code, Trevor's box)

**Both findings independently re-verified before acting, not taken on the handoff's word.**

`pg_proc` re-read directly:

| function | language | `plan_cache_mode` |
|---|---|---|
| `get_wallet_moments_with_fmv` | plpgsql | ✅ `force_custom_plan` |
| `get_wallet_total_fmv` | plpgsql | ✅ `force_custom_plan` |
| `get_fmv_for_editions` | **sql** | ❌ |
| `get_pack_realized_ev_row` | **sql** | ❌ |
| `get_acquisition_stats` | **sql** | ❌ |

The correction is recorded in [known-issues.md](../../reference/known-issues.md) **#52** — the register
item that actually governs this class — rather than only in the per-run `metrics-latest.json`, because a
correction that lives only in a run artifact is overwritten by the next run. **No SQL was changed; the
correct action was NO ACTION and that is what was taken.**

The trust-board instrument gotcha is written up in
[tooling-gotchas.md](../../reference/tooling-gotchas.md) under *"An instrument that returns GOOD NEWS in
the wrong shape"*, together with the `check_secdef_anon_execute_violations()` sibling and the
~280k–350k-buffers-per-SELECT cost note.
