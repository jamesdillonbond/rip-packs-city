> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The Pinnacle buyer resolver has been blind for 17 days, and its status board reported **0 unresolved** the whole time

**Filed** 2026-08-30 03:10Z / 20:10 PT (Sat 08-29) · cloud autonomous pass · **SHIPPED (DB)** migration `20260830030857`

> ⚠ **Scope of the no-push note below:** the inability to commit the migration file is specific to **this cloud session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit the file as usual.**

---

## The signal, and why it named the wrong thing

`detect_stalled_pipelines()` reported `pinnacle-resolve-buyers` **silent 1,536 min** against a 1,440 min arm — `medium`. The watchlist note says *"hourly cron-job.org … 3 missed runs trigger alert"*, and the ledger's only prior entry for this pipeline (2026-06-06, P3-BUYERS) diagnosed an earlier dropout as *"flaky external trigger … watch for a third occurrence."*

**This is the third occurrence and the trigger is not the cause.**

`app/api/pinnacle/resolve-buyers/route.ts` returns `{status:"no_work"}` **before** it calls `log_pipeline_run`. So an empty claim writes **no `pipeline_runs` row at all**, and a queue that is empty *because the claim predicate can no longer see its work* is indistinguishable, from the outside, from a cron that stopped firing.

⭐ This is the platform's own recorded defect class arriving in mirror image. Tonight's counterparty-backfill filing named a zero that makes an instrument read **idle** when it is **blind**; this one makes an instrument read **broken** when the system is **starved**.

## The mechanism, measured

`public.claim_pinnacle_resolver_batch()` claimed **only** rows whose `buyer_address` equals the Disney Pinnacle trade contract `0xedf9df96c92f4595` (`docs/reference/apis-and-cadence.md`). `public.pinnacle_resolver_status` used the **same** predicate.

Since **2026-08-13T01:11:42Z** the `pinnacle-sales-indexer` writes `buyer_address = NULL` instead of that placeholder. Measured on `pinnacle_sales`, 35 days by day:

| window | trade-contract rows | NULL-buyer rows |
|---|---:|---:|
| 07-27 → 08-12 (17 d) | **0** | **0** — every row arrived with a real buyer |
| 2026-08-13 | 0 | 197 of 406 (48.5%) |
| 08-14 → 08-29 | 0 | 65% → 98% of each day |
| 2026-08-30 | 0 | **16 of 16 (100%)** |

**6,671 of 7,872 sales since 08-13 (84.7%) have NULL buyer AND NULL seller**, `resolution_status` NULL. Estate-wide the unclaimable pile is **15,714 rows**, oldest `2025-12-29`.

🚨 **And `pinnacle_resolver_status` reported `total_still_unresolved: 0` throughout** — a clean board over a 92%-blind population.

## Positive control — the buyers are recoverable, the predicate was hiding them

Three NULL-buyer rows from 02:45–03:01Z tonight, `tx_hash = split_part(id,'_',1)`, fetched from `rest-mainnet.onflow.org` and run through **the route's own regex**:

| tx (head) | buyer | seller |
|---|---|---|
| `e8172f26…0107` | `0x834b160178840864` | `0xb830d5c9d3ae4cd8` |
| `8d701b9d…9229` | `0x23dde701491082ad` | `0xab2092d281a9248b` |
| `12b1fd2b…6b82` | `0x23dde701491082ad` | `0x8e655887a360cc3f` |

**3 of 3.** The data was always there.

## What shipped, and what deliberately did not

✅ **`20260830030857`** widens both the claim predicate and the status view to `(buyer_address = '0xedf9df96c92f4595' OR buyer_address IS NULL)`, and adds `unresolved_null_buyer` / `unresolved_trade_contract` to the view so the two populations can never merge into one number again. Guarded (RAISEs unless the live function is the pre-widening shape), `security_invoker=on` re-asserted, grants unchanged (`service_role`, `postgres`), exactly one overload, `check_secdef_anon_execute_violations()` → `[]`. Full revert SQL in the migration header.

**Precedent, not invention:** the sibling AllDay/Golazos backfill already treats NULL and the trade contract as the *same* unresolved state — ledger 2026-07-06, `/api/admin/backfill-allday-buyers`: *"gated on the buyer still being unresolved (NULL or an intermediary in {… trade contract `0xedf9df96c92f4595`})"*.

**Cost, warm:** Parallel Seq Scan on `pinnacle_sales` (195,529 rows / 151 MB), **6,651 buffers, all shared-hit, zero reads, 43.7 ms**, 15,708 candidates. Cold it reads the table once. Self-limiting: batch 50, `resolution_attempts < 5`, 1-hour re-attempt backoff, `pre_spork` terminal.

⛔ **This is a compensating control, not the root fix.** The root cause is upstream in `pinnacle-sales-indexer`, which filled buyers inline through 08-12 and stopped — route/worker code this cloud session cannot push. **Not shipped, and not guessed at:** why it stopped. That needs the indexer's diff around 2026-08-13T01:11Z.

**Masking is prevented by construction.** Rows the *resolver* fixes carry `resolution_status='resolved'`; rows the *indexer* fills inline carry NULL. So

```sql
SELECT count(*) FROM pinnacle_sales
 WHERE resolution_status = 'resolved' AND sold_at > '2026-08-13';
```

measures exactly how much the indexer is failing to do inline. If it keeps climbing after the backlog drains, the indexer is still broken.

## Open, and NOT claimed as understood

⚠ **15,456 of the 15,714 unclaimable rows have `last_resolution_attempt_at` set while `resolution_attempts = 0`.** The claim function increments `attempts` whenever it stamps that timestamp, so **something other than the claim function is writing it** — newest stamp `2026-08-30 02:37:07.190232Z`. This does not block the fix (the `attempts < 5` gate passes and the 1-hour backoff releases every row within the hour), but the writer is unidentified. **Do not assume it is the claim path.**

## Watch / falsifier

- **Exit:** `pinnacle_resolver_status.total_still_unresolved` falls from 15,714 and `resolved` rises above 35,152; `pipeline_runs` shows `pinnacle-resolve-buyers` rows again.
- **Falsifier:** if no `pipeline_runs` row appears within ~1 h of a claimable queue, then the **trigger really is dead too** and the cron-job.org entry needs re-arming — a console job this session cannot reach.
- **Second falsifier:** if rows come back `regex_miss`/`fetch_error` at a high rate, the 3/3 control was unrepresentative and the walk is hitting a spork floor; the route already classifies `404 → pre_spork`.
