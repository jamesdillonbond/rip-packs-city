# Spec — make `unmapped_resolution_backlog_max` exclude the permanent AllDay V1 class by REASON

**Date:** 2026-08-05 (PT) · **Author:** Claude Code (interactive) · **Ships nothing** — this is a decision-ready spec. The metric-arm edit is a small, safe additive view change; the row-marking is **resolver-domain logic** (ingest path), which is off-limits to autonomous shipping and, more importantly, is only safe once the "permanently unresolvable" classification is signed off — a wrong classification silently hides real sales undercount. So this is written for Trevor / a scoped resolver change, not an autonomous push.

---

## The problem in one line

`unmapped_resolution_backlog_max` is **BREACHED at 105** (breach_at 100) while the AllDay resolver is **healthy** — the count is the continuously-replenished **permanent** AllDay V1-Dapper class, not a new resolver stall, and the metric's age filter cannot tell them apart. The sentinel's own note is explicit: **do NOT raise breach_at** — fix it by excluding the permanent class *by reason*, exactly as the tx-hash-collision class already is.

## Exact metric definition (verbatim, `v_rpc_trust_health`, 2026-08-05)

```sql
unmapped_resolution_backlog_max :=
  ( SELECT COALESCE(max(z.cnt), 0)
      FROM ( SELECT count(*) AS cnt
               FROM unmapped_sales us
              WHERE us.resolved_at IS NULL
                AND COALESCE(us.price_usd, 0) > 0
                AND us.sold_at > now() - interval '30 days'      -- recent window
                AND us.sold_at < now() - interval '24 hours'     -- in-flight grace
                AND COALESCE(us.resolution_hint ->> 'promote_blocked','')
                    <> 'sales_tx_hash_unique_collision'          -- reason-based exclusion (the precedent)
              GROUP BY us.collection_id ) z );                    -- max across collections
```

The metric already **excludes one permanent class by a reason marker in `resolution_hint`**. That is the whole template — the fix adds a second reason for the AllDay V1 class.

## Live backlog shape (open `unmapped_sales`, 2026-08-05)

| collection | source | open rows | recent (30d) | buyer = AllDay contract | oldest sale |
|---|---|---:|---:|---:|---|
| nfl_all_day | **onchain_dapper_v1** | **68,050** | **341** | 10,453 | 2026-01-13 |
| nfl_all_day | onchain | 8,645 | 0 | 0 | 2026-01-13 |
| ufc_strike | onchain | 1,546 | 0 | 0 | 2025-12-30 |
| nfl_all_day | onchain_dapper_v2 | 16 | 14 | 0 | 2026-03-18 |
| ufc_strike | onchain_dapper_v2 | 8 | 0 | 0 | 2026-02-11 |
| laliga_golazos | onchain | 6 | 0 | 0 | 2025-12-29 |

The breach is driven entirely by `nfl_all_day / onchain_dapper_v1`: its **341 recent-30d** rows land in the metric window and push the per-collection count past 100. The other 67,709 v1 rows are older than 30d and already fall out by age — proving the class is permanent and **replenishing** (~100–350 new per 30d), which is why age alone will keep re-breaching. **Only 2 of 68,050 rows have `onchain_attempts >= 3`** — the resolver is not repeatedly probing these; they sit outside its candidate window, so an attempt-counter threshold will NOT mark them. The marking must be a **classification pass**, not an attempt cap.

## The fix (two parts)

### Part A — resolver marks the permanent class with a reason (the real work, needs sign-off)
Stamp `resolution_hint = jsonb_set(coalesce(resolution_hint,'{}'), '{promote_blocked}', '"v1_dapper_unrecoverable"')` on rows the resolver **proves** are permanently unresolvable — mirroring how the collision class is stamped at promote-time. The classification is the crux and must be **conservative** (mark only provably-dead rows; anything marked is removed from the stall signal forever):

- **Strong signal, safe:** `source = 'onchain_dapper_v1'` **and** the on-chain resolution attempt returns a stable terminal state — the NFT sits in Dapper custody / storefront escrow with no derivable current edition, or `buyer_address = '0xe4cf4bdc1751c65d'` (the AllDay contract, not a wallet: 10,453 rows) with no recoverable transfer. These cannot yield an `nft_edition_map` row by any resolver pass.
- **Do NOT** blanket-mark by age or by source alone — a fresh v1 sale can still be resolvable; marking it would drop a real sale from both the store and the stall signal.
- Set it where the resolver already decides a row is done — the `allday-resolve-unmapped` / `allday-resolve-unmapped-tail` routes' terminal branch, or a dedicated one-shot classify pass over the aged v1 backlog for the existing 68k, then ongoing at resolve-time for the ~100–350/mo new arrivals.

### Part B — metric excludes the new reason (small, safe, additive)
Extend the one predicate in the arm:

```sql
AND COALESCE(us.resolution_hint ->> 'promote_blocked','')
    NOT IN ('sales_tx_hash_unique_collision', 'v1_dapper_unrecoverable')
```

Rebuild `v_rpc_trust_health` with the guarded-`regexp_replace` → `CREATE OR REPLACE VIEW` → re-assert `security_invoker=on` pattern (the same one used for other arm edits), so the other ~22 arms stay byte-identical. This half is genuinely low-risk on its own, but it is **inert until Part A marks rows** — shipping B alone changes nothing, and shipping B without A's conservative classification would be equivalent to hiding the metric.

## Guardrails (from the sentinel's own note + this analysis)

- **Do NOT raise `breach_at`.** It only defers the next crossing; the class replenishes.
- **Marking is one-way for the signal** — only stamp rows that are provably unrecoverable. When uncertain, leave unmarked; a real stall breaching is the safe failure mode, a hidden one is not.
- The metric already carries a **24h in-flight grace** and a **30d window**, so fresh sales (p50 6.6min / p99 34min to resolve) cannot mask a stall — the fix does not touch those.
- `v_sales_tx_collision_loss` measures the structurally-unstorable class separately; the new `v1_dapper_unrecoverable` class deserves the same treatment if you want it visible — an optional companion view, not required.

## Grounding (verified live 2026-08-05 PT)
- Metric arm read verbatim from `pg_get_viewdef('v_rpc_trust_health')`.
- Backlog table from `unmapped_sales` grouped by collection/source (open rows, recent-30d, buyer=contract, oldest).
- `unmapped_sales` schema: reason home is `resolution_hint jsonb`; also has `onchain_attempts`, `last_onchain_attempt_at`, `resolved_at`, `resolved_sale_id`.
- Resolver components: `app/api/cron/allday-resolve-unmapped/route.ts`, `app/api/cron/allday-resolve-unmapped-tail/route.ts`, `promote_unmapped_sales` (promote RPC), `backfill_nft_edition_map_from_sales`.
- Precedent: the collision exclusion `resolution_hint->>'promote_blocked' = 'sales_tx_hash_unique_collision'` is live in the metric today.
